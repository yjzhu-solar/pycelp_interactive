/* Fe XIII Stokes Explorer: optional observation effects.
 *
 * Turns the coronal Stokes profiles of one voxel into a schematic observed spectrum, in the order
 * light meets them:
 *   0. the voxel's own Thomson-scattered K corona, a flat continuum (per A), as in pyCELP's
 *      Example_PSI_model_synthesis notebook:
 *        eps_I  = sigma_T n_e J00 (1 + omega/2 - (3/4) omega sin^2 chi)
 *        eps_pB = -(3/4) sigma_T n_e omega J00 sin^2 chi        (Q in the radial frame; < 0 = tangential)
 *      chi = angle between the local vertical and the line of sight; J00 [per A] and omega from
 *      pycelp.allenSolRad (tabulated in obs_atlas.js);
 *   1. scattered photospheric light (sky aureole + instrument) is added to the coronal signal:
 *        I_s = a S(lambda),   a = level x (1074 coronal I peak)
 *        V_s = -C lambda^2 gB a dS/dlambda                       (weak-field Zeeman, B_LOS x Lande g)
 *        Q_s + i U_s = -(1/4) (C lambda^2 B_perp)^2 e^{2i phi} a d2S/dlambda2   (transverse Zeeman, G = 1)
 *      with S the disk-integrated solar spectrum (Toon) and C = 4.6686e-13 A^-1 G^-1;
 *   2. telluric absorption multiplies all four Stokes parameters by T(lambda)^scale;
 *   3. polarimetric crosstalk, Q' = Q + x_IQ I + x_VQ V, U' = U + x_IU I + x_VU V,
 *      V' = V + x_IV I + x_QV Q + x_UV U;
 *   4. the spectrograph line-spread function, a Gaussian of FWHM lambda / R.
 * This follows the DKIST/Cryo-NIRSP spectral model of T. Schad (Schad et al. 2024, Sci. Adv. 10,
 * eadq1604) as reproduced in the Cryo_Line_Artifact notebook, without its per-line amplitude factors,
 * dilution term, atlas velocity shifts and noise; its constant coronal continuum is replaced by step 0.
 *
 * Steps 1 and 3 are instrumental and act in a fixed sky frame, taken as solar north (+Q north); the
 * caller passes rot = 2 beta, beta being the counter-clockwise angle from north to the displayed +Q
 * reference, and gets Q/U back in the displayed frame.
 *
 * Classic script (no modules) so the page also works from file://. Exposes globalThis.StokesObserve.
 */
(function (root) {
  "use strict";

  const C_WFA = 4.6686e-13;                         // Zeeman splitting: Delta lambda_B = C lambda^2 B  [A, G]
  const SIGMA_T = 0.665e-24;                        // Thomson cross-section [cm^2], as in pyCELP's example
  const HH = 6.626176e-27, CC = 2.99792458e10;      // as in stokes_model.js
  const SR2ARCSEC = Math.pow(180 / Math.PI, 2) * 3600 * 3600;
  const FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2));

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const LUT = new Uint8Array(128);
  for (let i = 0; i < 64; i++) LUT[B64.charCodeAt(i)] = i;
  /** base64 of little-endian uint16 -> Float64Array of value / 65535. */
  function decodeU16(s) {
    let len = s.length;
    while (len > 0 && s.charAt(len - 1) === "=") len--;
    const nbytes = Math.floor((len * 3) / 4);
    const bytes = new Uint8Array(nbytes);
    let j = 0;
    for (let i = 0; i < len; i += 4) {
      const n = (LUT[s.charCodeAt(i)] << 18) | (LUT[s.charCodeAt(i + 1)] << 12) |
        ((i + 2 < len ? LUT[s.charCodeAt(i + 2)] : 0) << 6) | (i + 3 < len ? LUT[s.charCodeAt(i + 3)] : 0);
      if (j < nbytes) bytes[j++] = (n >> 16) & 255;
      if (j < nbytes) bytes[j++] = (n >> 8) & 255;
      if (j < nbytes) bytes[j++] = n & 255;
    }
    const out = new Float64Array(nbytes >> 1);
    for (let k = 0; k < out.length; k++) out[k] = (bytes[2 * k] | (bytes[2 * k + 1] << 8)) / 65535;
    return out;
  }

  /** Gaussian convolution with kernel weights renormalized at the array ends. */
  function convolve(y, sigPix) {
    const r = Math.max(1, Math.ceil(4 * sigPix));
    const k = new Float64Array(2 * r + 1);
    for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-0.5 * (i / sigPix) * (i / sigPix));
    const n = y.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, w = 0;
      const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
      for (let j = a; j <= b; j++) { const kk = k[j - i + r]; s += kk * y[j]; w += kk; }
      out[i] = s / w;
    }
    return out;
  }

  function createObserver(atlas) {
    const lines = atlas.lines.map((L) => ({ key: L.key, rest: L.rest, T: decodeU16(L.T), S: decodeU16(L.S) }));
    const L0 = atlas.lines[0];
    const start = L0.start, step = L0.step, n = L0.n;
    const limit = Math.min(-start, start + step * (n - 1));

    /** Atlas samples covering [lo, hi] (A from the rest wavelength): {i0, dl}. */
    function grid(lo, hi) {
      const i0 = Math.max(0, Math.floor((lo - start) / step - 1e-9));
      const i1 = Math.min(n - 1, Math.ceil((hi - start) / step + 1e-9));
      const dl = new Float64Array(i1 - i0 + 1);
      for (let i = 0; i < dl.length; i++) dl[i] = start + step * (i0 + i);
      return { i0, dl };
    }

    const TH = atlas.thomson || null;
    /** Thomson-scattered K corona of one voxel at line nLine, per A, in the page's units
     *  (photons cm^-3 s^-1 arcsec^-2 A^-1): {I, pB}, pB being Q in the radial frame. */
    function thomson(nLine, height, ne, sin2chi) {
      if (!TH) return null;
      const g = TH.log10_h, T = TH.lines[nLine];
      const f = Math.min(Math.max((Math.log10(Math.max(height, 1e-12)) - g.start) / g.step, 0), g.n - 1);
      const i = Math.min(Math.floor(f), g.n - 2), w = f - i;
      const J = T.J00[i] * (1 - w) + T.J00[i + 1] * w, om = T.omega[i] * (1 - w) + T.omega[i + 1] * w;
      const conv = 1 / SR2ARCSEC / (HH * CC / (lines[nLine].rest * 1e-8));
      return { I: SIGMA_T * ne * J * (1 + om / 2 - 0.75 * om * sin2chi) * conv,
        pB: -0.75 * SIGMA_T * ne * om * J * sin2chi * conv };
    }

    /** LSF Gaussian sigma [A] of line n at resolving power R. */
    function lsfSigma(nLine, R) { return lines[nLine].rest / R * FWHM_TO_SIGMA; }

    /** Observed Stokes spectra of line nLine on atlas samples i0 .. i0 + cor.I.length - 1.
     *  cor: coronal {I, Q, U, V} on those samples, Q/U in the displayed frame.
     *  o: {P, rot, kcor: {I, Q, U} (constants, displayed frame) | null, stray: {level, gB, bperp, phi} | null, telluric: {scale} | null,
     *      xtalk: {IQ, IU, IV, VQ, VU, QV, UV} (fractions) | null, lsf: {R} | null}; angles in radians. */
    function observe(nLine, i0, cor, o) {
      const L = lines[nLine], m = cor.I.length, lam = L.rest;
      const I = Float64Array.from(cor.I), V = Float64Array.from(cor.V);
      const Q = new Float64Array(m), U = new Float64Array(m);
      const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0);
      const k = o.kcor || { I: 0, Q: 0, U: 0 };
      for (let i = 0; i < m; i++) {              // add the K corona, then displayed frame -> north frame
        const q = cor.Q[i] + k.Q, u = cor.U[i] + k.U;
        I[i] += k.I;
        Q[i] = q * c - u * s;
        U[i] = q * s + u * c;
      }
      if (o.stray) {
        const a = o.stray.level * o.P;
        const kV = -C_WFA * lam * lam * o.stray.gB;                             // A
        const dB = C_WFA * lam * lam * o.stray.bperp;
        const kL = -0.25 * dB * dB;                                             // A^2
        const c2 = Math.cos(2 * o.stray.phi), s2 = Math.sin(2 * o.stray.phi);
        const S = L.S, last = S.length - 1;
        for (let i = 0; i < m; i++) {
          const j = i0 + i, jm = Math.max(0, j - 1), jp = Math.min(last, j + 1);
          const d1 = (S[jp] - S[jm]) / ((jp - jm) * step);
          const d2 = (jp - jm === 2) ? (S[jp] - 2 * S[j] + S[jm]) / (step * step) : 0;
          I[i] += a * S[j];
          V[i] += a * kV * d1;
          Q[i] += a * kL * c2 * d2;
          U[i] += a * kL * s2 * d2;
        }
      }
      if (o.telluric) {
        const p = o.telluric.scale;
        for (let i = 0; i < m; i++) {
          const t = Math.pow(L.T[i0 + i], p);
          I[i] *= t; Q[i] *= t; U[i] *= t; V[i] *= t;
        }
      }
      if (o.xtalk) {
        const x = o.xtalk;
        for (let i = 0; i < m; i++) {
          const i_ = I[i], q = Q[i], u = U[i], v = V[i];
          Q[i] = q + x.IQ * i_ + x.VQ * v;
          U[i] = u + x.IU * i_ + x.VU * v;
          V[i] = v + x.IV * i_ + x.QV * q + x.UV * u;
        }
      }
      for (let i = 0; i < m; i++) {              // north frame -> displayed frame
        const q = Q[i], u = U[i];
        Q[i] = q * c + u * s;
        U[i] = -q * s + u * c;
      }
      if (o.lsf) {
        const sp = lsfSigma(nLine, o.lsf.R) / step;
        return { I: convolve(I, sp), Q: convolve(Q, sp), U: convolve(U, sp), V: convolve(V, sp) };
      }
      return { I, Q, U, V };
    }

    return { lines, start, step, n, limit, grid, lsfSigma, thomson, observe, meta: atlas.meta };
  }

  root.StokesObserve = { createObserver, decodeU16, C_WFA };
})(typeof globalThis !== "undefined" ? globalThis : this);
