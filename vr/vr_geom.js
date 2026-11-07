/* Fe XIII Stokes VR: geometry helpers shared by the scene and the panels.
 *
 * Pure functions, no three.js, so they can be tested outside a browser. Model coordinates are those of
 * stokes_model.js, in solar radii: +x from the Sun towards the observer, +y solar west, +z solar north.
 * The scene maps them to three.js axes as X = y (west, to the right), Y = z (north, up), Z = x (towards
 * the viewer), a proper rotation, so a viewer looking down -Z sees the Sun as the observer does.
 *
 * Classic script. Needs globalThis.StokesModel; exposes globalThis.VRGeom.
 */
(function (root) {
  "use strict";
  const SM = root.StokesModel;
  const DEG = Math.PI / 180;
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

  /** Model (x, y, z) -> three.js (X, Y, Z) = (y, z, x), and back. */
  function modelToThree(a) { return [a[1], a[2], a[0]]; }
  function threeToModel(a) { return [a[2], a[0], a[1]]; }

  /** Height, latitude and longitude of a point given in model coordinates, height clamped to hLim. */
  function placeFromPoint(p, hLim) {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (!(r > 1e-9)) return null;
    return {
      height: clamp(r - 1, hLim[0], hLim[1]),
      lat: Math.asin(clamp(p[2] / r, -1, 1)) / DEG,
      lon: Math.atan2(p[1], p[0]) / DEG,
    };
  }

  /** Local inclination and azimuth of a direction v (model coordinates) at (lat, lon). */
  function fieldFromDirection(lat, lon, v) {
    if (!(Math.hypot(v[0], v[1], v[2]) > 1e-9)) return null;
    return SM.localAngles(SM.localFrame(lat, lon), v);
  }

  /** Unit vector of the +Q reference in the plane of the sky (model coordinates), or null if undefined. */
  function refInPOS(refVec) {
    const n = Math.hypot(refVec[1], refVec[2]);
    return n > 1e-9 ? [0, refVec[1] / n, refVec[2] / n] : null;
  }

  /** Direction in the plane of the sky at angle chi (degrees) counter-clockwise, as the observer sees it,
   *  from the reference: ref rotated about +x, i.e. cos(chi) ref + sin(chi) (x cross ref). */
  function rotateInPOS(ref, chiDeg) {
    const c = Math.cos(chiDeg * DEG), s = Math.sin(chiDeg * DEG);
    return [0, c * ref[1] - s * ref[2], c * ref[2] + s * ref[1]];
  }

  /** Smallest angle between two orientations (axes, not vectors), in [0, 90] degrees. */
  function axisAngleDiff(aDeg, bDeg) {
    let d = ((aDeg - bDeg) % 180 + 180) % 180;
    return d > 90 ? 180 - d : d;
  }

  /** How the linear polarization of one line lies relative to the projected field:
   *  {rel: "parallel" | "perpendicular" | null, diff} with diff in degrees. */
  function polVsBperp(res, ln) {
    const g = res.geo;
    if (res.zeroField || !(g.bPerp > 1e-6) || !g.refDefined || !(ln.L_I > 1e-7)) return { rel: null, diff: NaN };
    const diff = axisAngleDiff(ln.chi, g.psiB);
    return { rel: diff < 45 ? "parallel" : "perpendicular", diff };
  }

  /** Wavelength grid of the explorer's "Line" window: +/- max(3 A, 4.2 sigma + Doppler shift), npts samples. */
  function lineGrid(model, s, npts) {
    const sigMax = Math.max.apply(null, model.lines.map((L) => model.dopplerSigma(L, model.Te, s.vnt)));
    const shift = Math.abs(s.vdop) / 3e5 * 10800;
    const half = Math.max(3, Math.ceil((4.2 * sigMax + shift) * 2) / 2);
    const dl = new Float64Array(npts);
    for (let i = 0; i < npts; i++) dl[i] = -half + 2 * half * i / (npts - 1);
    return dl;
  }

  /** Orthographic plane-of-sky coordinates (y, z) of a model point, and whether it is in front of the
   *  plane of the sky (x > 0). */
  function skyPosition(p) { return { y: p[1], z: p[2], front: p[0] >= 0 }; }

  /** Half-length of a polarization bar in solar radii: 0.6 sqrt(L/I / 5%), capped at 0.6. Longer than the
   *  explorer's bars so the direction reads at room scale, and still zero when the light is unpolarized. */
  function barHalfLength(LI) { return 0.6 * Math.min(1, Math.sqrt(Math.max(0, LI) / 0.05)); }

  /** PFSS field lines from pfss_lines.js: {closed: [Float32Array xyz, ...], open: [...]}, in solar radii. */
  function decodeFieldLines(data) {
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", LUT = new Uint8Array(128);
    for (let i = 0; i < 64; i++) LUT[B64.charCodeAt(i)] = i;
    const s = data.xyz;
    let len = s.length;
    while (len > 0 && s.charAt(len - 1) === "=") len--;
    const bytes = new Uint8Array(Math.floor(len * 3 / 4));
    for (let i = 0, j = 0; i < len; i += 4) {
      const n = (LUT[s.charCodeAt(i)] << 18) | (LUT[s.charCodeAt(i + 1)] << 12) |
        ((i + 2 < len ? LUT[s.charCodeAt(i + 2)] : 0) << 6) | (i + 3 < len ? LUT[s.charCodeAt(i + 3)] : 0);
      if (j < bytes.length) bytes[j++] = (n >> 16) & 255;
      if (j < bytes.length) bytes[j++] = (n >> 8) & 255;
      if (j < bytes.length) bytes[j++] = n & 255;
    }
    const out = { closed: [], open: [] };
    let k = 0;
    data.counts.forEach(function (n, l) {
      const a = new Float32Array(3 * n);
      for (let i = 0; i < 3 * n; i++, k += 2) {
        const v = bytes[k] | (bytes[k + 1] << 8);
        a[i] = (v >= 32768 ? v - 65536 : v) * data.coordScale;
      }
      (l < data.nClosed ? out.closed : out.open).push(a);
    });
    return out;
  }

  /** One merged thin tube per polyline, for a single draw call: {positions, indices}. sides = 3 makes a prism, which
   *  reads as a solid line in stereo for a sixth of the triangles of a round tube. The ring frame is carried along
   *  each line by parallel transport so the tube does not twist. Triangles wind outward. */
  function tubeMesh(lines, radius, sides) {
    let nv = 0, nt = 0;
    lines.forEach(function (p) { const n = p.length / 3; nv += n * sides; nt += (n - 1) * sides * 2; });
    const pos = new Float32Array(3 * nv), idx = nv > 65535 ? new Uint32Array(3 * nt) : new Uint16Array(3 * nt);
    let v = 0, t = 0;
    lines.forEach(function (p) {
      const n = p.length / 3, base = v;
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
        let tx = p[3 * b] - p[3 * a], ty = p[3 * b + 1] - p[3 * a + 1], tz = p[3 * b + 2] - p[3 * a + 2];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        if (i === 0) {                         // any direction not along the tangent
          if (Math.abs(tx) < 0.7) { nx = 1; ny = 0; nz = 0; } else { nx = 0; ny = 1; nz = 0; }
        }
        const d = nx * tx + ny * ty + nz * tz;  // keep the previous normal, minus its part along the tangent
        nx -= d * tx; ny -= d * ty; nz -= d * tz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
        for (let k = 0; k < sides; k++) {
          const ang = 2 * Math.PI * k / sides, c = radius * Math.cos(ang), s = radius * Math.sin(ang);
          pos[v * 3] = p[3 * i] + c * nx + s * bx;
          pos[v * 3 + 1] = p[3 * i + 1] + c * ny + s * by;
          pos[v * 3 + 2] = p[3 * i + 2] + c * nz + s * bz;
          v++;
        }
      }
      for (let i = 0; i < n - 1; i++) {
        for (let k = 0; k < sides; k++) {
          const a = base + i * sides + k, b = base + i * sides + (k + 1) % sides, c = a + sides, d = b + sides;
          idx[t++] = a; idx[t++] = b; idx[t++] = c;
          idx[t++] = b; idx[t++] = d; idx[t++] = c;
        }
      }
    });
    return { positions: pos, indices: idx };
  }

  root.VRGeom = {
    decodeFieldLines, tubeMesh, modelToThree, threeToModel, placeFromPoint, fieldFromDirection, refInPOS, rotateInPOS,
    axisAngleDiff, polVsBperp, lineGrid, skyPosition, barHalfLength, VAN_VLECK: SM.VAN_VLECK,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
