/* Fe XIII Stokes VR: the scene, the WebXR session and the interaction.
 *
 * The physics is the Stokes Explorer's, unchanged: ../stokes_model.js with ../fe13_see_table.js.
 * Scene units are metres; the Sun is drawn with a radius of SUN_R. Everything solar lives in the
 * `solar` group, whose local frame is the model frame of stokes_model.js in solar radii (see vr_geom.js),
 * so object code reads exactly as in the explorer. `world` holds `solar` and is what the visitor moves,
 * turns and resizes; the panels sit outside it.
 *
 * Input: XR controllers (trigger = grab, grip = move the scene) and tracked hands (pinch = grab) through the
 * same target-ray code, and the mouse on a computer (drag handles and panels, orbit elsewhere).
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/addons/webxr/XRHandModelFactory.js";

const SM = window.StokesModel, G = window.VRGeom, P = window.VRPanels;
const statusEl = document.getElementById("xr-status");
const enterBtn = document.getElementById("enter-vr");
function fail(msg) {
  const el = document.getElementById("fallback");
  el.hidden = false; el.querySelector("p").textContent = msg;
  throw new Error(msg);
}
if (!SM || !G || !P || !window.FE13_SEE_TABLE) fail("The model files did not load. Keep this folder next to stokes_model.js and fe13_see_table.js.");

const model = SM.createModel(window.FE13_SEE_TABLE);
const DEG = Math.PI / 180;
const SUN_R = 0.3;                                    // metres per solar radius at scale 1
const DEFAULTS = { height: 0.2, lat: 25, lon: 90, B: 20, inc: 30, azi: -60, logNe: 8.5, vnt: 25, vdop: 0, ref: "radial",
  show: "both", fieldLines: "all", cone: true, arcs: true, labels: true, guide: true };
const state = Object.assign({}, DEFAULTS);
const NPTS = 241;

// ---------------------------------------------------------------------------------------------------
// renderer, scene, camera
// ---------------------------------------------------------------------------------------------------
let renderer;
try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
catch (e) { fail("This browser could not start 3D graphics (WebGL)."); }
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFoveation(1);
document.getElementById("stage").appendChild(renderer.domElement);
renderer.domElement.setAttribute("aria-label", "3D scene: the Sun, a blob of glowing coronal plasma with its magnetic field, and panels showing the blob's light.");
renderer.domElement.setAttribute("role", "img");

const scene = new THREE.Scene();
scene.background = new THREE.Color("#04060c");
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.02, 200);
const HEAD_DESKTOP = new THREE.Vector3(0, 1.45, 0);
const CAM_DESKTOP = new THREE.Vector3(0, 1.55, 1.05);
camera.position.copy(CAM_DESKTOP);
scene.add(camera);

scene.add(new THREE.AmbientLight(0xffffff, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(0.5, 2.5, 2);
scene.add(keyLight);

const COL = {
  B: new THREE.Color(P.C.B), Bp: new THREE.Color(P.C.Bp), r: new THREE.Color(P.C.r), los: new THREE.Color(P.C.los),
  l1074: new THREE.Color(P.C.s1074), l1079: new THREE.Color(P.C.s1079),
  axis: new THREE.Color("#6d7c95"), rings: new THREE.Color("#8fa3c4"), grid: new THREE.Color("#7a2e0e"),
};

// stars and a faint floor, fixed in the room
(function backdrop() {
  const n = 900, pos = new Float32Array(3 * n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const z = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), c = Math.sqrt(1 - z * z), R = 60;
    pos[3 * i] = R * c * Math.cos(ph); pos[3 * i + 1] = R * z; pos[3 * i + 2] = R * c * Math.sin(ph);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xc8d4ff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.7 })));
  const floor = new THREE.PolarGridHelper(2.5, 16, 5, 96, 0x2b3a55, 0x1a2436);
  floor.material.transparent = true; floor.material.opacity = 0.5;
  scene.add(floor);
})();

// ---------------------------------------------------------------------------------------------------
// the solar scene (model frame, solar radii)
// ---------------------------------------------------------------------------------------------------
const world = new THREE.Group();
scene.add(world);
const solar = new THREE.Group();
// model (x, y, z) -> three (X, Y, Z) = (y, z, x)
solar.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1));
solar.scale.setScalar(SUN_R);
world.add(solar);

const sun = new THREE.Mesh(
  new THREE.SphereGeometry(1, 72, 48),
  new THREE.ShaderMaterial({
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV;
      void main(){ float mu = clamp(dot(vN, vV), 0.0, 1.0);
        float ld = 1.0 - 0.62 * (1.0 - mu) - 0.18 * (1.0 - mu * mu);
        vec3 core = vec3(1.0, 0.85, 0.56); vec3 limb = vec3(0.80, 0.27, 0.05);
        vec3 col = mix(limb, core, pow(mu, 0.5)) * (0.42 + 0.7 * ld);
        gl_FragColor = vec4(col, 1.0); }`,
  })
);
solar.add(sun);

function glowTexture(stops) {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const corona = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTexture([[0, "rgba(255,214,160,0.9)"], [0.36, "rgba(255,170,90,0.42)"], [0.5, "rgba(255,150,80,0.16)"], [0.72, "rgba(120,140,220,0.05)"], [1, "rgba(0,0,0,0)"]]),
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
}));
corona.scale.set(5.6, 5.6, 1);
solar.add(corona);

function lineFrom(points, color, opacity, dashed) {
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.05, gapSize: 0.035, depthWrite: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const ln = new THREE.Line(geo, mat);
  if (dashed) ln.computeLineDistances();
  return ln;
}
function setLine(ln, points) {
  ln.geometry.setFromPoints(points);
  ln.geometry.attributes.position.needsUpdate = true;
  ln.geometry.computeBoundingSphere();
  if (ln.material.isLineDashedMaterial) ln.computeLineDistances();
}
// heliographic grid
for (let lon = 0; lon < 180; lon += 30) {
  const pts = [];
  for (let k = 0; k <= 96; k++) { const t = k / 96 * 2 * Math.PI, l = lon * DEG; pts.push(new THREE.Vector3(Math.cos(t) * Math.cos(l), Math.cos(t) * Math.sin(l), Math.sin(t)).multiplyScalar(1.003)); }
  solar.add(lineFrom(pts, COL.grid, 0.55));
}
for (let lat = -60; lat <= 60; lat += 30) {
  const pts = [], la = lat * DEG;
  for (let k = 0; k <= 96; k++) { const t = k / 96 * 2 * Math.PI; pts.push(new THREE.Vector3(Math.cos(la) * Math.cos(t), Math.cos(la) * Math.sin(t), Math.sin(la)).multiplyScalar(1.003)); }
  solar.add(lineFrom(pts, COL.grid, lat === 0 ? 0.8 : 0.5));
}
function circleYZ(r, n = 160) { const pts = []; for (let k = 0; k <= n; k++) { const t = k / n * 2 * Math.PI; pts.push(new THREE.Vector3(0, r * Math.cos(t), r * Math.sin(t))); } return pts; }
solar.add(lineFrom(circleYZ(1.004), new THREE.Color("#ffe3b8"), 0.65));
[1.5, 2, 2.5].forEach((r) => solar.add(lineFrom(circleYZ(r), COL.rings, 0.22)));

// ---- text labels (sprites that face the viewer) ----
const labelGroup = new THREE.Group();
solar.add(labelGroup);
function textSprite(text, color, h, parent) {
  const c = document.createElement("canvas");
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.userData.paint = function () {
    const pad = 14, fs = 64, g = c.getContext("2d");
    g.font = "600 " + fs + "px " + P.FONT;
    const w = Math.ceil(g.measureText(text).width) + 2 * pad;
    c.width = w; c.height = fs + 2 * pad;
    g.font = "600 " + fs + "px " + P.FONT; g.textBaseline = "middle"; g.textAlign = "center";
    g.lineJoin = "round"; g.lineWidth = 10; g.strokeStyle = "rgba(4,6,12,0.85)"; g.strokeText(text, w / 2, c.height / 2);
    g.fillStyle = color; g.fillText(text, w / 2, c.height / 2);
    t.dispose(); t.needsUpdate = true;
    s.scale.set(h * w / c.height, h, 1);
  };
  s.userData.paint();
  (parent || labelGroup).add(s);
  return s;
}

// axes
function cone(color, r, h) { return new THREE.Mesh(new THREE.ConeGeometry(r, h, 20), new THREE.MeshBasicMaterial({ color })); }
const Y_AXIS = new THREE.Vector3(0, 1, 0);
// kept short towards the visitor: the Sun's centre is only ~4 solar radii from their eyes
[[new THREE.Vector3(1, 0, 0), "toward Earth", 2.0, COL.los, P.C.los], [new THREE.Vector3(0, 1, 0), "west", 2.8, COL.axis, "#c3cddc"],
  [new THREE.Vector3(0, 0, 1), "north", 2.8, COL.axis, "#c3cddc"]].forEach(function ([d, txt, L, col, tcol]) {
  solar.add(lineFrom([d.clone(), d.clone().multiplyScalar(L)], col, 0.9));
  const c = cone(col, 0.035, 0.12); c.position.copy(d.clone().multiplyScalar(L)); c.quaternion.setFromUnitVectors(Y_AXIS, d); solar.add(c);
  const l = textSprite(txt, tcol, 0.16); l.position.copy(d.clone().multiplyScalar(L + 0.22));
});

// ---- the Sun's field lines: a PFSS model for 8 April 2024 (pfss_lines.js, built by build_pfss_lines.py) ----
const fieldLineData = window.FE13_PFSS_LINES ? G.decodeFieldLines(window.FE13_PFSS_LINES) : null;
const fieldLines = (function () {
  if (!fieldLineData) return null;
  const mesh = function (list, color) {
    const t = G.tubeMesh(list, 0.008, 3), g = new THREE.BufferGeometry();     // about 2.5 mm radius at scale 1
    g.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
    g.setIndex(new THREE.BufferAttribute(t.indices, 1));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(color) }));
    solar.add(m);
    return m;
  };
  const ring = lineFrom(circleYZ(3), COL.rings, 0.22);     // the model's outer edge, where the open lines stop
  solar.add(ring);
  const L = window.FE13_PFSS_LINES.labels;
  const tClosed = textSprite("closed loop", P.C.closedLine, 0.1), tOpen = textSprite("open line", P.C.openLine, 0.1);
  const out = (a, d) => new THREE.Vector3(a[0], a[1], a[2]).multiplyScalar(1 + d / Math.hypot(a[0], a[1], a[2]));
  tClosed.position.copy(out(L.closed, 0.12)); tOpen.position.copy(out(L.open, 0.12));
  return { closed: mesh(fieldLineData.closed, P.C.closedLine), open: mesh(fieldLineData.open, P.C.openLine), ring, tClosed, tOpen };
})();

// ---- the blob and its field ----
function makeArrow(color, radius = 0.013, headLen = 0.1, headRad = 0.04) {
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.55, metalness: 0, transparent: true });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 18), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(headRad, headLen, 28), mat);
  const g = new THREE.Group(); g.add(shaft, head); g.userData = { shaft, head, headLen, mat };
  solar.add(g); return g;
}
function setArrow(g, origin, dir, length) {
  const { shaft, head, headLen } = g.userData;
  const ok = length > 1e-4 && dir.lengthSq() > 1e-12;
  g.visible = ok; if (!ok) return;
  const L = Math.max(length - headLen, 1e-3);
  shaft.scale.set(1, L, 1); shaft.position.set(0, L / 2, 0);
  head.position.set(0, L + headLen / 2, 0);
  g.position.copy(origin);
  g.quaternion.setFromUnitVectors(Y_AXIS, dir.clone().normalize());
}
function makeBar(color, radius) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 14), new THREE.MeshBasicMaterial({ color }));
  solar.add(m); return m;
}
function setBar(m, center, dir, half) {
  m.visible = half > 1e-4; if (!m.visible) return;
  m.position.copy(center); m.scale.set(1, 2 * half, 1); m.quaternion.setFromUnitVectors(Y_AXIS, dir.clone().normalize());
}
function makeTube(color) { const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color })); solar.add(m); return m; }
function setTube(m, pts, r = 0.009) {
  m.geometry.dispose();
  if (!pts || pts.length < 2) { m.visible = false; m.geometry = new THREE.BufferGeometry(); return; }
  m.visible = true;
  m.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, r, 8, false);
}
function arcBetween(center, a, b, rad, n = 40) {
  const ang = a.angleTo(b);
  if (ang < 1e-3) return null;
  let axis = new THREE.Vector3().crossVectors(a, b);
  if (axis.lengthSq() < 1e-10) { axis = new THREE.Vector3(1, 0, 0).cross(a); if (axis.lengthSq() < 1e-10) axis = new THREE.Vector3(0, 1, 0).cross(a); }
  axis.normalize();
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(a.clone().applyAxisAngle(axis, ang * i / n).multiplyScalar(rad).add(center));
  return pts;
}

const blob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
solar.add(blob);
const blobGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture([[0, "rgba(255,255,255,0.95)"], [0.25, "rgba(190,230,255,0.4)"], [1, "rgba(0,0,0,0)"]]), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
blobGlow.scale.set(0.5, 0.5, 1);
solar.add(blobGlow);
const blobHandle = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
blobHandle.userData.kind = "blob";
solar.add(blobHandle);

const foot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: COL.r }));
solar.add(foot);
const radialGuide = lineFrom([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], COL.r, 0.55, true); solar.add(radialGuide);
const losLine = lineFrom([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], COL.los, 0.38, true); solar.add(losLine);
const bPerpLine = lineFrom([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], COL.Bp, 0.95, true); solar.add(bPerpLine);
const dropLine = lineFrom([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)], COL.Bp, 0.4, true); solar.add(dropLine);
const localPOS = new THREE.Group();
localPOS.add(new THREE.Mesh(new THREE.CircleGeometry(0.6, 64).rotateY(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })));
localPOS.add(lineFrom(circleYZ(0.6, 96), 0xffffff, 0.28));
solar.add(localPOS);

const aB = makeArrow(COL.B, 0.02, 0.13, 0.055);
const aR = makeArrow(COL.r, 0.012, 0.09, 0.035);
const aLOS = makeArrow(COL.los, 0.012, 0.09, 0.035);
const bar1074 = makeBar(COL.l1074, 0.02);
const bar1079 = makeBar(COL.l1079, 0.013);
const arcTilt = makeTube(COL.r);
const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16), new THREE.MeshStandardMaterial({ color: COL.B, emissive: COL.B, emissiveIntensity: 0.6, roughness: 0.4, transparent: true }));
solar.add(tip);
const tipHandle = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
tipHandle.userData.kind = "tip";
solar.add(tipHandle);

// magic-angle (Van Vleck) double cone about the local vertical
const coneGroup = new THREE.Group();
(function () {
  const H = 0.42, rad = H * Math.tan(G.VAN_VLECK * DEG);
  const geo = new THREE.ConeGeometry(rad, H, 64, 1, true).translate(0, -H / 2, 0).rotateX(Math.PI);   // apex at 0, opening to +Y
  const mat = new THREE.MeshBasicMaterial({ color: COL.r, transparent: true, opacity: 0.11, side: THREE.DoubleSide, depthWrite: false });
  const up = new THREE.Mesh(geo, mat), down = new THREE.Mesh(geo, mat);
  down.rotation.x = Math.PI;
  const rim = [];
  for (let k = 0; k <= 96; k++) { const t = k / 96 * 2 * Math.PI; rim.push(new THREE.Vector3(rad * Math.cos(t), H, rad * Math.sin(t))); }
  const rimUp = lineFrom(rim, COL.r, 0.55), rimDown = lineFrom(rim.map((v) => new THREE.Vector3(v.x, -v.y, v.z)), COL.r, 0.55);
  coneGroup.add(up, down, rimUp, rimDown);
})();
solar.add(coneGroup);

const tField = textSprite("magnetic field", P.C.B, 0.12);
const tUp = textSprite("straight up", P.C.r, 0.1);
const tTilt = textSprite("tilt", P.C.r, 0.1);
const tCone = textSprite("magic angle 54.7°", P.C.r, 0.09);
const hintBlob = textSprite("grab the blob", "#ffffff", 0.1);
const hintTip = textSprite("magnetic field · grab to turn it", P.C.B, 0.1);
// the two "grab me" hints stay readable whatever is in front of them; they go away after the first grab
[hintBlob, hintTip].forEach(function (h) { h.material.depthTest = false; h.renderOrder = 5; });
let usedBlob = false, usedTip = false;

const X = new THREE.Vector3(1, 0, 0);
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const LB = 0.95;

function update3D(res) {
  const g = res.geo;
  const loc = v3(g.loc), b = v3(g.bhat).normalize(), r = v3(g.frame.r);
  blob.position.copy(loc); blobGlow.position.copy(loc); blobHandle.position.copy(loc);
  foot.position.copy(r);
  setLine(radialGuide, [r.clone().multiplyScalar(1.004), loc]);
  setLine(losLine, [new THREE.Vector3(-2.8, loc.y, loc.z), new THREE.Vector3(Math.max(loc.x + 0.8, 2.0), loc.y, loc.z)]);
  localPOS.position.copy(loc);

  const zero = !!res.zeroField;
  setArrow(aB, loc, b, LB);
  aB.userData.mat.opacity = zero ? 0.25 : 1;
  tip.material.opacity = zero ? 0.35 : 1;
  const tipPos = loc.clone().add(b.clone().multiplyScalar(LB));
  tip.position.copy(tipPos); tipHandle.position.copy(tipPos);
  setArrow(aR, loc, r, 0.62);
  setArrow(aLOS, loc, X, 0.62);
  tField.position.copy(loc.clone().add(b.clone().multiplyScalar(LB + 0.2)));
  tField.visible = !zero && usedTip;
  tUp.position.copy(loc.clone().add(r.clone().multiplyScalar(0.78)));

  const bp = new THREE.Vector3(0, b.y, b.z);
  const ptip = loc.clone().add(bp.clone().multiplyScalar(LB));
  const hasBp = !zero && bp.length() > 1e-4;
  bPerpLine.visible = hasBp; dropLine.visible = hasBp && Math.abs(b.x) > 1e-3;
  if (hasBp) { setLine(bPerpLine, [loc, ptip]); setLine(dropLine, [tipPos, ptip]); }

  const pTilt = (zero || !state.arcs) ? null : arcBetween(loc, r, b, 0.4);
  setTube(arcTilt, pTilt);
  tTilt.visible = !!pTilt;
  if (pTilt) tTilt.position.copy(pTilt[pTilt.length >> 1].clone().sub(loc).multiplyScalar(1.3).add(loc));

  coneGroup.visible = state.cone && !zero;
  coneGroup.position.copy(loc);
  coneGroup.quaternion.setFromUnitVectors(Y_AXIS, r);
  tCone.visible = coneGroup.visible;
  {
    const H = 0.42, rad = H * Math.tan(G.VAN_VLECK * DEG);
    const side = new THREE.Vector3().crossVectors(r, X); if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
    side.normalize();
    tCone.position.copy(loc.clone().add(r.clone().multiplyScalar(H + 0.06)).add(side.multiplyScalar(rad)));
  }

  const refp = new THREE.Vector3(0, g.refVec[1], g.refVec[2]);
  const hasRef = refp.length() > 1e-9;
  if (hasRef) refp.normalize();
  [[bar1074, res.lines[0], "1074"], [bar1079, res.lines[1], "1079"]].forEach(function ([m, ln, key]) {
    if (!hasRef || !(ln.L_I > 1e-6) || (state.show !== "both" && state.show !== key)) { m.visible = false; return; }
    const dir = refp.clone().applyAxisAngle(X, ln.chi * DEG);
    setBar(m, loc, dir, G.barHalfLength(ln.L_I));
  });

  hintBlob.visible = !usedBlob;
  hintBlob.position.copy(loc.clone().add(r.clone().multiplyScalar(-0.05)).add(new THREE.Vector3(0, 0, -0.24)));
  hintTip.visible = !usedTip && !zero;
  hintTip.position.copy(tField.position);
  labelGroup.visible = state.labels;
  if (fieldLines) {
    const m = state.fieldLines;
    fieldLines.closed.visible = fieldLines.tClosed.visible = m === "all" || m === "closed";
    fieldLines.open.visible = fieldLines.tOpen.visible = m === "all" || m === "open";
    fieldLines.ring.visible = m !== "off";
  }
}

// ---------------------------------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------------------------------
const panels = [];
const anisotropy = renderer.capabilities.getMaxAnisotropy();
function makePanel(name, canvas, widthM, opts) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = anisotropy;
  const hM = widthM * canvas.height / canvas.width;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, hM),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.FrontSide, depthWrite: true, alphaTest: 0.02 }));
  const p = Object.assign({ name, canvas, tex, mesh, wM: widthM, hM, dirty: true, last: 0, minInterval: 33 }, opts);
  mesh.userData.kind = "panel"; mesh.userData.panel = p;
  scene.add(mesh);
  panels.push(p);
  return p;
}
function redraw(p) { p.draw(); p.tex.needsUpdate = true; p.dirty = false; p.last = performance.now(); }

let last = null, dlam = null, physicsDirty = true, spectraHover = null;
function onChange(key) {
  physicsDirty = true;
  if (key === "guide") guideP.mesh.visible = state.guide;
  if (key === "guide" && state.guide) placePanel(guideP, headPose());
}
function onAction(id) {
  if (id === "reset") { Object.assign(state, DEFAULTS); guideP.mesh.visible = true; usedBlob = usedTip = false; physicsDirty = true; layout(headPose(), true); }
  else if (id === "recenter") layout(headPose(), false);
  else if (id.startsWith("view:")) viewFrom(id.slice(5));
  else if (id.startsWith("place:")) {
    const p = id.slice(6);
    if (p === "west") { state.lat = 0; state.lon = 90; }
    else if (p === "east") { state.lat = 0; state.lon = -90; }
    else if (p === "north") { state.lat = 90; state.lon = 90; }
    else if (p === "front") { state.lat = 20; state.lon = -40; }
    physicsDirty = true;
  }
}
const control = new P.ControlPanel(state, { onChange, onAction });
const guide = new P.GuidePanel({ onClose: function () { state.guide = false; guideP.mesh.visible = false; controlP.dirty = true; } });
const specCanvas = P.makeCanvas(P.SPEC.W, P.SPEC.H), specCtx = specCanvas.getContext("2d");
const telCanvas = P.makeCanvas(P.TEL.W, P.TEL.H), telCtx = telCanvas.getContext("2d");

const controlP = makePanel("control", control.canvas, 0.6, {
  draw: () => control.draw(), down: (x, y) => control.down(x, y), move: (x) => control.move(x), up: () => control.up(),
  hover: (x, y) => control.setHover(x, y), local: [-0.66, -0.3, -0.46],
});
const specP = makePanel("spectra", specCanvas, 0.6, {
  draw: () => { if (last) P.drawSpectra(specCtx, { res: last, dlam, s: state, hover: spectraHover }); },
  hover: (x, y) => {
    const h = x == null || !dlam ? null : P.spectraHit(x, y, dlam.length);
    const same = (h && spectraHover) ? h.plot === spectraHover.plot && h.idx === spectraHover.idx : h === spectraHover;
    spectraHover = h; return !same;
  },
  local: [0.66, -0.12, -0.46], minInterval: 90,
});
const telP = makePanel("telescope", telCanvas, 0.36, {
  draw: () => { if (last) P.drawTelescope(telCtx, { res: last, s: state, lines: fieldLineData }); }, local: [-0.6, 0.2, -0.66], minInterval: 90,
});
const guideP = makePanel("guide", guide.canvas, 0.4, {
  draw: () => guide.draw(), down: (x, y) => guide.down(x, y), hover: (x, y) => guide.setHover(x, y), local: [0, -0.12, -0.58],
});

// ---------------------------------------------------------------------------------------------------
// layout: place the Sun and the panels relative to the visitor
// ---------------------------------------------------------------------------------------------------
const WORLD_LOCAL = new THREE.Vector3(0, -0.12, -1.5);       // the 3 solar-radius field lines stop short of the panels
function headPose() {
  if (renderer.xr.isPresenting) {
    const xc = renderer.xr.getCamera();
    const pos = new THREE.Vector3().setFromMatrixPosition(xc.matrixWorld);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(xc.matrixWorld);
    return { pos, yaw: Math.atan2(-fwd.x, -fwd.z) };
  }
  return { pos: HEAD_DESKTOP.clone(), yaw: 0 };
}
function yawQuat(yaw) { return new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw); }
function placePanel(p, head) {
  const q = yawQuat(head.yaw);
  p.mesh.position.copy(new THREE.Vector3().fromArray(p.local).applyQuaternion(q).add(head.pos));
  p.mesh.lookAt(head.pos);
}
let viewTween = null;
function layout(head, includeWorld) {
  panels.forEach((p) => placePanel(p, head));
  if (includeWorld) {
    viewTween = null;
    world.position.copy(WORLD_LOCAL.clone().applyQuaternion(yawQuat(head.yaw)).add(head.pos));
    world.quaternion.copy(yawQuat(head.yaw));
    world.scale.setScalar(1);
    if (!renderer.xr.isPresenting) { controls.target.copy(world.position); controls.update(); }
  }
}
/** Turn the Sun about its centre so the visitor looks from Earth, from solar west, or from above the north pole. */
function viewFrom(which) {
  const head = headPose();
  const d = head.pos.clone().sub(world.position); d.y = 0;
  const yaw = d.lengthSq() > 1e-6 ? Math.atan2(d.x, d.z) : head.yaw;
  const V = which === "side" ? new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -Math.PI / 2)
    : which === "north" ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
      : new THREE.Quaternion();
  viewTween = { from: world.quaternion.clone(), to: yawQuat(yaw).multiply(V), t0: performance.now(), dur: 700 };
}

// ---------------------------------------------------------------------------------------------------
// pointers: XR controllers / hands and the mouse share one code path
// ---------------------------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointers = [];
const grabbers = [];
let grabBase = null;
function pickables() {
  const out = [];
  panels.forEach((p) => { if (p.mesh.visible) out.push(p.mesh); });
  out.push(blobHandle, tipHandle);
  return out;
}
function pick(ray) {
  raycaster.ray.copy(ray); raycaster.near = 0; raycaster.far = 30;
  const hits = raycaster.intersectObjects(pickables(), false);
  return hits.length ? hits[0] : null;
}
function panelPx(p, uv) { return [uv.x * p.canvas.width, (1 - uv.y) * p.canvas.height]; }
function rayOnPanel(p, ray) {
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(p.mesh.quaternion);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p.mesh.position);
  const hit = ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return null;
  const l = p.mesh.worldToLocal(hit.clone());
  return [(l.x / p.wM + 0.5) * p.canvas.width, (0.5 - l.y / p.hM) * p.canvas.height];
}
function pulse(p, strength, ms) {
  try { const h = p.source && p.source.gamepad && p.source.gamepad.hapticActuators; if (h && h[0]) h[0].pulse(strength, ms); } catch (e) { /* no haptics */ }
}
function handPos(p) { return new THREE.Vector3().setFromMatrixPosition(p.ctrl.matrixWorld); }

function startWorldGrab(p) {
  if (grabbers.indexOf(p) < 0) grabbers.push(p);
  p.drag = { kind: "world" };
  resetGrabBase();
}
function endWorldGrab(p) {
  const i = grabbers.indexOf(p);
  if (i >= 0) grabbers.splice(i, 1);
  resetGrabBase();
}
function resetGrabBase() {
  grabBase = grabbers.length ? { pos: world.position.clone(), quat: world.quaternion.clone(), scale: world.scale.x, hands: grabbers.slice(0, 2).map(handPos) } : null;
}
function updateWorldGrab() {
  if (!grabBase || !grabbers.length) return;
  viewTween = null;
  if (grabbers.length === 1) {
    world.position.copy(grabBase.pos).add(handPos(grabbers[0]).sub(grabBase.hands[0]));
    return;
  }
  const a0 = grabBase.hands[0], b0 = grabBase.hands[1], a1 = handPos(grabbers[0]), b1 = handPos(grabbers[1]);
  const m0 = a0.clone().add(b0).multiplyScalar(0.5), m1 = a1.clone().add(b1).multiplyScalar(0.5);
  const s = Math.min(4, Math.max(0.25, grabBase.scale * a1.distanceTo(b1) / Math.max(a0.distanceTo(b0), 1e-3)));
  const d0 = b0.clone().sub(a0), d1 = b1.clone().sub(a1);
  const dq = yawQuat(Math.atan2(d1.x, d1.z) - Math.atan2(d0.x, d0.z));
  world.scale.setScalar(s);
  world.quaternion.copy(dq).multiply(grabBase.quat);
  world.position.copy(grabBase.pos.clone().sub(m0).multiplyScalar(s / grabBase.scale).applyQuaternion(dq).add(m1));
}

function selectStart(p) {
  p.selecting = true;
  const hit = pick(p.ray);
  if (!hit) { if (p.kind === "xr") startWorldGrab(p); return; }
  const kind = hit.object.userData.kind;
  if (kind === "blob" || kind === "tip") {
    const anchor = (kind === "blob" ? blob : tip).getWorldPosition(new THREE.Vector3());
    p.drag = { kind, dist: hit.distance, offset: anchor.sub(hit.point) };
    if (kind === "blob") usedBlob = true; else usedTip = true;
    physicsDirty = true;
    pulse(p, 0.35, 25);
    return;
  }
  const panel = hit.object.userData.panel, [px, py] = panelPx(panel, hit.uv);
  if (py < P.HDR) {
    p.drag = { kind: "panelMove", panel, dist: hit.distance, offset: panel.mesh.position.clone().sub(hit.point) };
    pulse(p, 0.25, 20);
  } else if (panel.down && panel.down(px, py)) {
    p.drag = { kind: "press", panel };
    panel.dirty = true;
    pulse(p, 0.2, 15);
  } else p.drag = { kind: "inert" };          // the panel background: neither orbit nor grab the scene
}
function selectEnd(p) {
  p.selecting = false;
  if (!p.drag) return;
  if (p.drag.kind === "press" && p.drag.panel.up) { p.drag.panel.up(); p.drag.panel.dirty = true; }
  if (p.drag.kind === "world") endWorldGrab(p);
  p.drag = null;
}
function updateDrag(p) {
  const d = p.drag;
  if (!d || d.kind === "world" || d.kind === "inert") return;
  if (d.kind === "press") {
    const px = rayOnPanel(d.panel, p.ray);
    if (px && d.panel.move && d.panel.move(px[0], px[1])) d.panel.dirty = true;
    return;
  }
  const target = p.ray.at(d.dist, new THREE.Vector3()).add(d.offset);
  if (d.kind === "panelMove") { d.panel.mesh.position.copy(target); d.panel.mesh.lookAt(headPose().pos); return; }
  const m = solar.worldToLocal(target.clone());
  if (d.kind === "blob") {
    const q = G.placeFromPoint([m.x, m.y, m.z], model.limits.height);
    if (q && (q.height !== state.height || q.lat !== state.lat || q.lon !== state.lon)) {
      state.height = Number(q.height.toFixed(4)); state.lat = q.lat; state.lon = q.lon; physicsDirty = true;
    }
  } else if (d.kind === "tip" && last) {
    const loc = last.geo.loc, v = [m.x - loc[0], m.y - loc[1], m.z - loc[2]];
    if (Math.hypot(v[0], v[1], v[2]) > 0.08) {
      const a = G.fieldFromDirection(state.lat, state.lon, v);
      if (a) { state.inc = a.inc; state.azi = a.azi; physicsDirty = true; }
    }
  }
}

// ---- XR controllers and hands ----
const cmf = new XRControllerModelFactory();
const hmf = new XRHandModelFactory();
const cursorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  const p = { kind: "xr", ctrl, ray: new THREE.Ray(), active: false, selecting: false, drag: null, hit: null, source: null };
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
  ctrl.add(line);
  p.line = line;
  p.cursor = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8), cursorMat);
  p.cursor.renderOrder = 10;
  scene.add(p.cursor);
  ctrl.addEventListener("connected", (e) => { p.active = true; p.source = e.data; });
  ctrl.addEventListener("disconnected", () => { p.active = false; p.source = null; if (p.drag) selectEnd(p); });
  ctrl.addEventListener("selectstart", () => selectStart(p));
  ctrl.addEventListener("selectend", () => selectEnd(p));
  ctrl.addEventListener("squeezestart", () => { if (!p.drag) startWorldGrab(p); });
  ctrl.addEventListener("squeezeend", () => { if (p.drag && p.drag.kind === "world") selectEnd(p); });
  scene.add(ctrl);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(cmf.createControllerModel(grip));
  scene.add(grip);
  const hand = renderer.xr.getHand(i);
  hand.add(hmf.createHandModel(hand, "mesh"));
  scene.add(hand);
  pointers.push(p);
}

// ---- mouse ----
const mouse = { kind: "mouse", ray: new THREE.Ray(), active: false, selecting: false, drag: null, hit: null, ndc: new THREE.Vector2() };
pointers.push(mouse);
function setNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(mouse.ndc, camera); mouse.ray.copy(raycaster.ray);
}
// registered before OrbitControls so a press on a handle or panel can switch orbiting off first
renderer.domElement.addEventListener("pointerdown", function (e) {
  if (renderer.xr.isPresenting || e.button !== 0) return;
  setNdc(e); mouse.active = true;
  selectStart(mouse);
  if (mouse.drag) { controls.enabled = false; try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } }
});
renderer.domElement.addEventListener("pointermove", function (e) { if (!renderer.xr.isPresenting) { setNdc(e); mouse.active = true; } });
renderer.domElement.addEventListener("pointerleave", function () { if (!mouse.drag) mouse.active = false; });
window.addEventListener("pointerup", function () { if (mouse.selecting) selectEnd(mouse); controls.enabled = !renderer.xr.isPresenting; });

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 0.4; controls.maxDistance = 6;

// ---------------------------------------------------------------------------------------------------
// hover, recompute, render loop
// ---------------------------------------------------------------------------------------------------
function updatePointers() {
  const hovered = new Map();
  let hoverBlob = false, hoverTip = false;
  pointers.forEach(function (p) {
    const live = p.kind === "mouse" ? (!renderer.xr.isPresenting && p.active) : (renderer.xr.isPresenting && p.active);
    if (p.kind === "xr") {
      p.line.visible = live; p.cursor.visible = false;
      if (!live) return;
      p.ray.origin.setFromMatrixPosition(p.ctrl.matrixWorld);
      p.ray.direction.set(0, 0, -1).transformDirection(p.ctrl.matrixWorld);
    } else if (!live) return;
    else { raycaster.setFromCamera(p.ndc, camera); p.ray.copy(raycaster.ray); }
    updateDrag(p);
    const hit = (p.drag && p.drag.kind !== "press") ? null : pick(p.ray);
    p.hit = hit;
    if (p.kind === "xr") {
      const len = p.drag && p.drag.dist ? p.drag.dist : hit ? hit.distance : 1.2;
      p.line.scale.z = len;
      if (hit) { p.cursor.visible = true; p.cursor.position.copy(hit.point); }
    }
    const k = hit && hit.object.userData.kind;
    if (k === "blob" || (p.drag && p.drag.kind === "blob")) hoverBlob = true;
    if (k === "tip" || (p.drag && p.drag.kind === "tip")) hoverTip = true;
    if (k === "panel" && !hovered.has(hit.object.userData.panel)) hovered.set(hit.object.userData.panel, panelPx(hit.object.userData.panel, hit.uv));
    if (p.drag && p.drag.kind === "press" && !hovered.has(p.drag.panel)) { const px = rayOnPanel(p.drag.panel, p.ray); if (px) hovered.set(p.drag.panel, px); }
  });
  panels.forEach(function (pn) {
    if (!pn.hover) return;
    const at = hovered.get(pn);
    if (pn.hover(at ? at[0] : null, at ? at[1] : null)) pn.dirty = true;
  });
  blobGlow.scale.setScalar(hoverBlob ? 0.75 : 0.5);
  tip.scale.setScalar(hoverTip ? 1.35 : 1);
  document.body.style.cursor = renderer.xr.isPresenting ? "" : (hoverBlob || hoverTip || hovered.size) ? "pointer" : "";
  updateWorldGrab();
}

function recompute() {
  dlam = G.lineGrid(model, state, NPTS);
  last = model.compute(state, dlam);
  update3D(last);
  control.setInfo(last, state);
  controlP.dirty = specP.dirty = telP.dirty = true;
  physicsDirty = false;
}

let xrFrames = 0, needRecenter = false, fpsCount = 0, fpsT0 = performance.now(), fpsText = "";
renderer.setAnimationLoop(function (t) {
  const now = performance.now();
  if (renderer.xr.isPresenting) {
    xrFrames++;
    if (needRecenter && xrFrames > 3) { needRecenter = false; layout(headPose(), true); }
  }
  updatePointers();
  if (physicsDirty) recompute();
  if (viewTween) {
    const f = Math.min(1, (now - viewTween.t0) / viewTween.dur), e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
    world.quaternion.slerpQuaternions(viewTween.from, viewTween.to, e);
    if (f >= 1) viewTween = null;
  }
  panels.forEach((p) => { if (p.dirty && p.mesh.visible && now - p.last >= p.minInterval) redraw(p); });
  if (!renderer.xr.isPresenting) controls.update();
  renderer.render(scene, camera);
  fpsCount++;
  if (now - fpsT0 >= 1000) {
    const txt = Math.round(fpsCount * 1000 / (now - fpsT0)) + " fps";
    fpsCount = 0; fpsT0 = now;
    if (txt !== fpsText) { fpsText = txt; control.fps = txt; controlP.dirty = true; }
  }
  void t;
});

window.addEventListener("resize", function () {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------------------------------
// entering VR
// ---------------------------------------------------------------------------------------------------
function desktopView() {
  camera.position.copy(CAM_DESKTOP); camera.quaternion.identity();
  layout({ pos: HEAD_DESKTOP.clone(), yaw: 0 }, true);
  controls.target.copy(world.position).add(new THREE.Vector3(0, -0.05, 0.35));
  controls.enabled = true; controls.update();
}
let session = null;
async function enterVR() {
  if (session) { session.end(); return; }
  try {
    const s = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking", "layers"] });
    await renderer.xr.setSession(s);
    session = s; xrFrames = 0; needRecenter = true; controls.enabled = false; mouse.active = false;
    enterBtn.textContent = "Exit VR";
    s.addEventListener("end", function () { session = null; enterBtn.textContent = "Enter VR"; grabbers.length = 0; grabBase = null; desktopView(); });
  } catch (e) {
    statusEl.textContent = "Could not start VR: " + (e && e.message ? e.message : e);
  }
}
(async function xrSupport() {
  if (!window.isSecureContext) { statusEl.textContent = "VR needs a secure (https) page. Open the https link in the Meta Quest Browser."; return; }
  if (!("xr" in navigator)) { statusEl.textContent = "This browser has no VR support. Open this page in the Meta Quest Browser to step inside; here you can explore with the mouse."; return; }
  let ok = false;
  try { ok = await navigator.xr.isSessionSupported("immersive-vr"); } catch (e) { ok = false; }
  if (!ok) { statusEl.textContent = "No VR headset found. Open this page in the Meta Quest Browser to step inside; here you can explore with the mouse."; return; }
  enterBtn.hidden = false;
  enterBtn.addEventListener("click", enterVR);
  statusEl.textContent = "Put on the headset and press Enter VR.";
})();

desktopView();
// Canvas text does not make the browser fetch web fonts, so ask for them, then redraw panels and labels.
if (document.fonts && document.fonts.load) {
  Promise.all(['400 30px "Fira Sans"', '500 30px "Fira Sans"', '600 30px "Fira Sans"', '600 22px "Fira Sans Condensed"',
    '400 22px "Fira Mono"', '500 22px "Fira Mono"'].map((f) => document.fonts.load(f).catch(() => null)))
    .then(function () { panels.forEach((p) => { p.dirty = true; }); labelGroup.children.forEach((s) => s.userData.paint && s.userData.paint()); });
}
window.vrApp = { state, get result() { return last; }, panels, world, solar, blob, tip, fieldLines, camera, renderer, layout, viewFrom };
