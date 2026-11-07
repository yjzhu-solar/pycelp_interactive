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

  root.VRGeom = {
    modelToThree, threeToModel, placeFromPoint, fieldFromDirection, refInPOS, rotateInPOS,
    axisAngleDiff, polVsBperp, lineGrid, skyPosition, barHalfLength, VAN_VLECK: SM.VAN_VLECK,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
