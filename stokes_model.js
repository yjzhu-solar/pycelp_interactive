/* Fe XIII Stokes Explorer: physics model.
 *
 * A line-by-line port of pycelp.emissionLine.calc_PolEmissCoeff / calc_stokesSpec (pycelp 0ec0df4)
 * plus the voxel geometry of pycelp_example/single_stokes.ipynb (xyz_to_stokes). The statistical
 * equilibrium is not solved here: C and the upper-level alignment sigma come from the pre-computed
 * table written by build_see_table.py (globalThis.FE13_SEE_TABLE), interpolated trilinearly in
 * (log10 n_e, log10 h, cos^2 theta_B).
 *
 * Frame: +x points from the Sun towards the observer (LOS taken parallel to +x), +z is solar
 * north, +y = z cross x is solar west. Angles follow Schad & Dima (2020, Fig. 1):
 *   theta_B  inclination of B from the local solar vertical (enters the statistical equilibrium)
 *   Theta_B  inclination of B from the LOS, measured from the direction towards the observer
 *   psi_B    counter-clockwise rotation, as seen by the observer, FROM the +Q reference direction TO
 *            the plane-of-sky projection of B (Q/U in the IAU sense, +Q along the reference).
 *   gamma_B  the azimuthBLOSdeg that pycelp needs, 90 deg - psi_B. pycelp's
 *            eps_Q' = C 3/(2 sqrt 2) D sigma sin^2 Theta_B is I(perp B_perp) - I(par B_perp): for sigma > 0
 *            its angular pattern is that of the sigma components (compare eps_I). So pycelp's +Q at
 *            azimuth 0 is perpendicular to B_perp, and Q = Q' cos 2gamma, U = -Q' sin 2gamma.
 *
 * Classic script (no modules) so the page also works from file://. Exposes globalThis.StokesModel.
 *
 * Derived from pyCELP (https://github.com/tschad/pycelp), Copyright (c) 2021, Thomas A Schad,
 * redistributed under its BSD 3-clause licence; see LICENSE-pycelp.txt for the full notice,
 * conditions and disclaimer.
 */
(function (root) {
  "use strict";

  // ---- constants exactly as used in pycelp/emissionLine.py ----
  const HH = 6.626176e-27;          // erg s
  const CC = 2.99792458e10;         // cm s^-1
  const LARMOR = 1399612.2;         // s^-1 G^-1
  const SR2ARCSEC = Math.pow(180 / Math.PI, 2) * 3600 * 3600;
  const KB = 1.380648e-23;          // J K^-1
  const AMU_G = 1.6605655e-24;      // g
  const DEG = Math.PI / 180;
  const VAN_VLECK = Math.acos(Math.sqrt(1 / 3)) / DEG;   // 54.7356 deg

  // ---- base64 -> Float32Array (little endian); no dependency on atob ----
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const LUT = new Uint8Array(128);
  for (let i = 0; i < 64; i++) LUT[B64.charCodeAt(i)] = i;
  function b64ToFloat32(s) {
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
    const dv = new DataView(bytes.buffer);
    const out = new Float32Array(nbytes / 4);
    for (let k = 0; k < out.length; k++) out[k] = dv.getFloat32(4 * k, true);
    return out;
  }

  // ---- small vector helpers ----
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => Math.sqrt(dot(a, a));
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
  const angleDeg = (a, b) => Math.acos(clamp(dot(a, b) / (norm(a) * norm(b)), -1, 1)) / DEG;

  /** psi_B: CCW (seen by the observer) rotation from ref_perp to B_perp, degrees; 0 if either vanishes. */
  function fieldPositionAngleDeg(b, ref, los) {
    const l = scale(los, 1 / norm(los));
    const bp = sub(b, scale(l, dot(b, l)));
    const rp = sub(ref, scale(l, dot(ref, l)));
    return Math.atan2(dot(l, cross(rp, bp)), dot(rp, bp)) / DEG;
  }
  /** azimuthBLOSdeg for pycelp so that +Q lies along ref: 90 deg - psi_B, wrapped to (-180, 180]. */
  function pycelpAzimuthDeg(b, ref, los) {
    let g = 90 - fieldPositionAngleDeg(b, ref, los);
    if (g > 180) g -= 360;
    return g;
  }

  /** Local unit vectors at heliographic (lat, lon) in the observer frame. lon is measured from the
   *  sub-observer meridian, positive towards solar west; lon = +/-90 deg is the plane of the sky. */
  function localFrame(latDeg, lonDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG;
    const r = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const west = [-Math.sin(lo), Math.cos(lo), 0];                       // increasing longitude
    const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    return { r, north, west };
  }

  /** Field direction from local inclination (from vertical) and azimuth (from local north towards west). */
  function fieldVector(frame, incDeg, aziDeg) {
    const t = incDeg * DEG, p = aziDeg * DEG;
    return add(scale(frame.r, Math.cos(t)),
      add(scale(frame.north, Math.sin(t) * Math.cos(p)), scale(frame.west, Math.sin(t) * Math.sin(p))));
  }

  /** Inverse of fieldVector: local inclination/azimuth of an arbitrary direction. */
  function localAngles(frame, v) {
    const n = norm(v);
    const inc = Math.acos(clamp(dot(v, frame.r) / n, -1, 1)) / DEG;
    const a = dot(v, frame.west), b = dot(v, frame.north);
    const azi = (Math.abs(a) + Math.abs(b) < 1e-12 * n) ? 0 : Math.atan2(a, b) / DEG;
    return { inc, azi };
  }

  /** The irreducible two-line degeneracy of Paraschiv & Judge (2022, CLEDB, their Table 2): mirror the voxel
   *  across the plane of the sky (x -> -x) and turn B_perp by 180 deg, keeping B_LOS. The height, cos^2 theta_B
   *  (B.r flips sign), Theta_B, psi_B mod 180 and the plane-of-sky position are unchanged, so every Stokes
   *  parameter of every line is identical. For a voxel in the plane of the sky this is the 180-degree azimuth
   *  ambiguity. Applying it twice returns the original state. */
  function ambiguousTwin(s) {
    const f = localFrame(s.lat, s.lon);
    const b = fieldVector(f, s.inc, s.azi);
    let lon = 180 - s.lon;
    if (lon > 180) lon -= 360;
    if (lon <= -180) lon += 360;
    const f2 = localFrame(s.lat, lon);
    const a = localAngles(f2, [b[0], -b[1], -b[2]]);
    const r = 1 + s.height;
    return { lat: s.lat, lon, inc: a.inc, azi: a.azi, xFrom: f.r[0] * r, xTo: f2.r[0] * r };
  }

  function createModel(table) {
    const axes = [table.grid.log10_ne, table.grid.log10_h, table.grid.mu2];
    const n1 = axes[1].n, n2 = axes[2].n;
    const lines = table.lines.map((L) => Object.assign({}, L, {
      log10C: b64ToFloat32(L.log10C),
      sigma: b64ToFloat32(L.sigma),
      M_kg: table.atomic_weight * AMU_G / 1000,
    }));
    const limits = {
      logNe: [axes[0].start, axes[0].start + axes[0].step * (axes[0].n - 1)],
      height: [Math.pow(10, axes[1].start), Math.pow(10, axes[1].start + axes[1].step * (n1 - 1))],
    };

    function locate(ax, x) {
      const f = clamp((x - ax.start) / ax.step, 0, ax.n - 1);
      const i = Math.min(Math.floor(f), ax.n - 2);
      return [i, f - i];
    }

    /** Statistical-equilibrium quantities for every line: [{C, sigma}] (C in erg cm^-3 s^-1 sr^-1). */
    function see(logNe, height, thetaBDeg) {
      const mu2 = Math.pow(Math.cos(thetaBDeg * DEG), 2);
      const h = clamp(height, limits.height[0], limits.height[1]);
      const [i, fi] = locate(axes[0], logNe), [j, fj] = locate(axes[1], Math.log10(h)), [k, fk] = locate(axes[2], mu2);
      return lines.map((L) => {
        let lc = 0, sg = 0;
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) {
          const w = (a ? fi : 1 - fi) * (b ? fj : 1 - fj) * (c ? fk : 1 - fk);
          if (w === 0) continue;
          const idx = ((i + a) * n1 + (j + b)) * n2 + (k + c);
          lc += w * L.log10C[idx];
          sg += w * L.sigma[idx];
        }
        return { C: Math.pow(10, lc), sigma: sg };
      });
    }

    /** pycelp emissionLine.calc_PolEmissCoeff. I,Q,U in photons cm^-3 s^-1 arcsec^-2; V additionally per Angstrom. */
    function emissionCoefficients(L, C, sigma, Bmag, thetaBLOSDeg, azimuthBLOSDeg) {
      const th = thetaBLOSDeg * DEG, az = azimuthBLOSDeg * DEG;
      const k = 3 / (2 * Math.SQRT2);
      const wvVacCm = L.wv_vac * 1e-8;
      const Vscl = -(wvVacCm * wvVacCm) / CC * 1e8;                       // Angstrom s
      const epsI = C * (1 + k * L.D * sigma * (Math.cos(th) ** 2 - 1 / 3));
      const epsQp = C * k * Math.sin(th) ** 2 * L.D * sigma;
      const epsV = Vscl * C * Math.cos(th) * LARMOR * Bmag * (L.geff + L.E * sigma);
      const epsQ = Math.cos(2 * az) * epsQp;
      const epsU = -Math.sin(2 * az) * epsQp;
      const phergs = HH * 3e8 / (L.wv_vac * 1e-10);
      const f = 1 / SR2ARCSEC / phergs;
      return { I: epsI * f, Q: epsQ * f, U: epsU * f, V: epsV * f, Qprime: epsQp * f };
    }

    /** Gaussian sigma of the line profile [A] (thermal at Te plus non-thermal vnt [km/s]), as in pycelp. */
    function dopplerSigma(L, Te, vnt) {
      return (1 / Math.SQRT2) * (L.wv_air * 1e-10 / 3e8) * Math.sqrt(2 * KB * Te / L.M_kg + (vnt * 1000) ** 2) * 1e10;
    }

    /** pycelp emissionLine.calc_stokesSpec profile synthesis on an arbitrary grid of (lambda - lambda_air) [A]. */
    function profiles(L, eps, Te, vnt, vdop, dlam) {
      const sig = dopplerSigma(L, Te, vnt);
      const shift = (vdop / 3e5) * L.wv_air;
      const n = dlam.length;
      const out = { I: new Float64Array(n), Q: new Float64Array(n), U: new Float64Array(n), V: new Float64Array(n), sigmaA: sig };
      const norm0 = 1 / (Math.sqrt(2 * Math.PI) * sig);
      for (let i = 0; i < n; i++) {
        const d = dlam[i] - shift;
        const w = norm0 * Math.exp(-(d * d) / (2 * sig * sig));
        const wd = (-d / (sig * sig)) * w;
        out.I[i] = eps.I * w;
        out.Q[i] = eps.Q * w;
        out.U[i] = eps.U * w;
        out.V[i] = eps.V * wd;
      }
      return out;
    }

    /** Geometry of one voxel. state: {height, lat, lon, inc, azi, ref} (angles in degrees). */
    function geometry(s) {
      const frame = localFrame(s.lat, s.lon);
      const r = 1 + s.height;
      const loc = scale(frame.r, r);
      const bhat = fieldVector(frame, s.inc, s.azi);
      const los = [1, 0, 0];
      const refVec = s.ref === "north" ? [0, 0, 1] : loc;
      const rhoPOS = Math.hypot(loc[1], loc[2]);
      let visibility = "off-limb";
      if (rhoPOS < 1) visibility = loc[0] > 0 ? "on-disk" : "occulted";
      return {
        frame, loc, bhat, los, refVec, rhoPOS, visibility,
        thetaB: angleDeg(bhat, loc),                 // = s.inc by construction
        ThetaB: angleDeg(bhat, los),
        psiB: fieldPositionAngleDeg(bhat, refVec, los),
        gammaB: pycelpAzimuthDeg(bhat, refVec, los),
        scatteringAngle: angleDeg(loc, los),        // angle between local vertical and LOS
        bPerp: Math.hypot(bhat[1], bhat[2]),
        refDefined: Math.hypot(refVec[1], refVec[2]) > 1e-9,
      };
    }

    /** Everything the page needs for one state. state adds {B, logNe, vnt, vdop} and dlam (A). */
    function compute(s, dlam) {
      const geo = geometry(s);
      const seeVals = see(s.logNe, s.height, geo.thetaB);
      const out = lines.map((L, n) => {
        const { C, sigma } = seeVals[n];
        const eps = emissionCoefficients(L, C, sigma, s.B, geo.ThetaB, geo.gammaB);
        const prof = profiles(L, eps, table.Te, s.vnt, s.vdop, dlam);
        let imax = 0, vmax = 0;
        for (let i = 0; i < dlam.length; i++) {
          if (prof.I[i] > imax) imax = prof.I[i];
          if (Math.abs(prof.V[i]) > Math.abs(vmax)) vmax = prof.V[i];
        }
        const L_I = Math.hypot(eps.Q, eps.U) / eps.I;
        const chi = 0.5 * Math.atan2(eps.U, eps.Q) / DEG;   // polarization angle, CCW from reference
        return { line: L, C, sigma, eps, prof, Ipeak: imax, Vext: vmax, L_I, Q_I: eps.Q / eps.I, U_I: eps.U / eps.I, chi };
      });
      return { geo, lines: out };
    }

    return { lines, limits, Te: table.Te, meta: table.meta, grid: table.grid, see, emissionCoefficients,
      dopplerSigma, profiles, geometry, compute };
  }

  root.StokesModel = {
    createModel, ambiguousTwin, fieldPositionAngleDeg, pycelpAzimuthDeg, localFrame, fieldVector, localAngles, angleDeg,
    vec: { dot, cross, norm, scale, add, sub }, VAN_VLECK, DEG,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
