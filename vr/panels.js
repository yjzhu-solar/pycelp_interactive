/* Fe XIII Stokes VR: the 2D panels (guide, controls, spectra, telescope view), drawn on canvases.
 *
 * Written for a general audience: plain words first, the Stokes names only as small subtitles.
 * The scene maps each canvas onto a flat panel and turns ray hits into canvas pixels; everything here is
 * plain canvas 2D, with no three.js, so the panels can also be drawn and checked in an ordinary page.
 * Plot scaling and colours follow the Stokes Explorer (../index.html).
 *
 * Classic script. Needs globalThis.VRGeom; exposes globalThis.VRPanels.
 */
(function (root) {
  "use strict";
  const G = root.VRGeom;

  // ---- dark palette of the explorer ----
  const C = {
    panel: "rgba(13,18,26,0.95)", edge: "rgba(255,255,255,0.13)", band: "rgba(255,255,255,0.045)",
    ink: "#e7ebf1", ink2: "#a9b2c0", ink3: "#7c8697", rule: "#222b38", axis: "#3d4858",
    accent: "#f06595", control: "#1a212d", controlHi: "#252e3d", onAccent: "#1c0711",
    s1074: "#3987e5", s1079: "#d95926",
    B: "#ff4f9a", Bp: "#ff9cc6", r: "#ffc145", los: "#3ee0c5", ref: "#e8ecf2",
    closedLine: "#b4a7ff", openLine: "#cdeb7a",
    good: "#2fbf4a", warn: "#fab219", crit: "#e05252", space: "#05080f",
  };
  const FONT = '"Fira Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
  const COND = '"Fira Sans Condensed", "Fira Sans", system-ui, sans-serif';
  const MONO = '"Fira Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const HDR = 76;                          // header band: the grab handle for moving a panel
  const RSUN_KM = 695700;
  const EARTH_FIELD_G = 0.5;               // typical strength of Earth's field at the surface

  // ---- formatting ----
  function signed(v, d) { const s = v.toFixed(d); return (v > 0 && Number(s) !== 0 ? "+" : "") + s.replace("-", "−"); }
  function smart(v) {
    if (v === 0) return "0";
    const a = Math.abs(v);
    const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : Math.min(6, 2 - Math.floor(Math.log10(a)));
    return signed(v, d);
  }
  function thousands(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function kmText(h) {                     // 3 significant figures, e.g. "139,000 km"
    const km = h * RSUN_KM, p = Math.pow(10, Math.max(0, Math.floor(Math.log10(km)) - 2));
    return thousands(Math.round(km / p) * p) + " km";
  }
  const SUP = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  function sci(v, d) {
    const e = Math.floor(Math.log10(Math.abs(v))), m = v / Math.pow(10, e);
    return m.toFixed(d) + " × 10" + String(e).split("").map((c) => SUP[c] || c).join("");
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function decimalsFor(step) {
    const e = Math.floor(Math.log10(step) + 1e-9);
    return Math.max(0, -e + (Math.abs(step / Math.pow(10, e) - 2.5) < 1e-6 ? 1 : 0));
  }
  function tickLabel(v, step) { return Math.abs(v) < step * 1e-6 ? "0" : v.toFixed(decimalsFor(step)).replace("-", "−"); }

  // ---- canvas helpers ----
  function makeCanvas(w, h) {
    const c = (typeof document !== "undefined") ? document.createElement("canvas") : new OffscreenCanvas(w, h);
    c.width = w; c.height = h;
    return c;
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  /** Panel background and header band with a title, an optional subtitle and a grip mark. */
  function frame(ctx, W, H, title, sub) {
    ctx.clearRect(0, 0, W, H);
    rr(ctx, 2, 2, W - 4, H - 4, 30); ctx.fillStyle = C.panel; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = C.edge; ctx.stroke();
    ctx.save(); rr(ctx, 2, 2, W - 4, H - 4, 30); ctx.clip();
    ctx.fillStyle = C.band; ctx.fillRect(0, 0, W, HDR);
    ctx.restore();
    ctx.fillStyle = C.ink; ctx.font = "600 34px " + FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(title, 32, HDR / 2 + 1);
    if (sub) {
      const tw = ctx.measureText(title).width;
      ctx.fillStyle = C.ink3; ctx.font = "400 25px " + FONT;
      ctx.fillText(sub, 32 + tw + 18, HDR / 2 + 2);
    }
    ctx.fillStyle = C.ink3;                // grip: "grab here to move"
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { ctx.beginPath(); ctx.arc(W - 40 - i * 15, HDR / 2 - 7 + j * 14, 3.6, 0, 2 * Math.PI); ctx.fill(); }
  }
  /** Draws text runs [[text, {font, color}]] left to right; returns the end x. */
  function runs(ctx, x, y, parts) {
    parts.forEach(function (p) {
      const st = p[1] || {};
      if (st.font) ctx.font = st.font;
      if (st.color) ctx.fillStyle = st.color;
      ctx.fillText(p[0], x, y);
      x += ctx.measureText(p[0]).width;
    });
    return x;
  }
  function runsWidth(ctx, parts) {
    let w = 0;
    parts.forEach(function (p) { if (p[1] && p[1].font) ctx.font = p[1].font; w += ctx.measureText(p[0]).width; });
    return w;
  }
  /** Word-wrapped paragraph; returns the y below it. */
  function para(ctx, text, x, y, w, lh) {
    const words = text.split(" ");
    let line = "";
    words.forEach(function (wd) {
      const t = line ? line + " " + wd : wd;
      if (ctx.measureText(t).width > w && line) { ctx.fillText(line, x, y); y += lh; line = wd; } else line = t;
    });
    if (line) { ctx.fillText(line, x, y); y += lh; }
    return y;
  }
  function swatchLine(ctx, x, y, color, w) {
    ctx.strokeStyle = color; ctx.lineWidth = w || 6; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 34, y); ctx.stroke();
  }
  function shown(s, n) { return s.show === "both" || s.show === (n === 0 ? "1074" : "1079"); }
  /** Where the blob sits, in words; the colour dot only repeats it. */
  function visibilityText(v) {
    return { "off-limb": [C.good, "Above the Sun's edge"], "on-disk": [C.warn, "In front of the Sun"],
      "occulted": [C.crit, "Behind the Sun, hidden from Earth"] }[v];
  }

  // =====================================================================================================
  // Controls
  // =====================================================================================================
  const SLIDERS = [
    { key: "height", label: "Height above the surface", min: 0.005, max: 1.5, step: 0.005,
      fmt: (v) => v.toFixed(2) + " R☉ · " + kmText(v) },
    { key: "lat", label: "Latitude", min: -90, max: 90, step: 0.5,
      fmt: (v) => Math.abs(v) < 0.25 ? "0° (equator)" : Math.abs(v).toFixed(0) + "° " + (v > 0 ? "north" : "south") },
    { key: "lon", label: "Longitude (0° faces Earth, 90° right edge)", min: -180, max: 180, step: 0.5,
      fmt: (v) => v.toFixed(0).replace("-", "−") + "°" },
    { key: "B", label: "Magnetic field strength", min: 0, max: 100, step: 0.5,
      fmt: (v) => v > 0 ? v.toFixed(1) + " gauss · " + thousands(v / EARTH_FIELD_G) + "× Earth's" : "0 · no field" },
    { key: "inc", label: "Field tilt from straight up", min: 0, max: 180, step: 0.5, dir: true,
      fmt: (v) => v.toFixed(0) + "°" },
    { key: "azi", label: "Field direction around the vertical", min: -180, max: 180, step: 0.5, dir: true,
      fmt: (v) => v.toFixed(0).replace("-", "−") + "°" },
    { key: "logNe", label: "Plasma density", min: 7, max: 10, step: 0.05,
      fmt: (v) => sci(Math.pow(10, v), 1) + " electrons/cm³" },
    { key: "vnt", label: "Turbulent motions", min: 0, max: 50, step: 0.5,
      fmt: (v) => v.toFixed(0) + " km/s" },
    { key: "vdop", label: "Moving away (+) or toward (−) Earth", min: -50, max: 50, step: 0.5,
      fmt: (v) => Math.abs(v) < 0.25 ? "0 km/s" : Math.abs(v).toFixed(0) + " km/s " + (v > 0 ? "away" : "toward") },
  ];
  const SEGS = [
    { key: "show", label: "Light shown", options: [["both", "Both colours"], ["1074", "1074.7 nm"], ["1079", "1079.8 nm"]] },
    { key: "fieldLines", label: "The Sun's field lines, 8 April 2024 (model)", options: [["all", "All"], ["closed", "Closed"], ["open", "Open"], ["off", "Off"]],
      dots: { closed: C.closedLine, open: C.openLine } },
  ];
  const TOGGLES = [["cone", "Magic angle"], ["arcs", "Tilt angle"], ["labels", "Labels"], ["guide", "Guide"]];
  const VIEWS = [["view:earth", "Earth"], ["view:side", "The side"], ["view:north", "Above the pole"]];
  const PLACES = [["place:west", "Right edge"], ["place:east", "Left edge"], ["place:north", "North pole"], ["place:front", "In front"]];

  function ControlPanel(state, opts) {
    this.W = 1536; this.H = 1024;
    this.canvas = makeCanvas(this.W, this.H);
    this.ctx = this.canvas.getContext("2d");
    this.state = state;
    this.onChange = opts.onChange || function () {};
    this.onAction = opts.onAction || function () {};
    this.info = null; this.fps = ""; this.hover = null; this.active = null; this.flash = null;
    this.widgets = [];
    const W = this.widgets, xr = 800, wr = 700, xl = 36, wl = 712;
    SLIDERS.forEach(function (s, i) { W.push(Object.assign({ type: "slider", x: xr, y: 96 + i * 98, w: wr, h: 98 }, s)); });
    let y = 476;
    SEGS.forEach(function (s) { W.push(Object.assign({ type: "seg", x: xl, y, w: wl, h: 84 }, s)); y += 90; });
    W.push({ type: "chips", label: "Show", x: xl, y, w: wl, h: 84, items: TOGGLES }); y += 90;
    W.push({ type: "buttons", label: "Look from", x: xl, y, w: wl, h: 84, items: VIEWS }); y += 90;
    W.push({ type: "buttons", label: "Move the blob to", x: xl, y, w: wl, h: 84, items: PLACES }); y += 90;
    W.push({ type: "buttons", label: "", x: xl, y: y + 4, w: 470, h: 60, items: [["reset", "Start over"], ["recenter", "Bring panels to me"]], bare: true });
  }
  function items(wd) {
    const top = wd.bare ? wd.y : wd.y + 30, h = wd.bare ? wd.h : 50;
    const list = wd.options || wd.items, n = list.length, gap = 10;
    const w = (wd.w - gap * (n - 1)) / n;
    return list.map((it, i) => ({ v: it[0], t: it[1], x: wd.x + i * (w + gap), y: top, w, h }));
  }
  function sliderTrack(wd) { return { x: wd.x + 18, y: wd.y + 68, w: wd.w - 36 }; }

  ControlPanel.prototype.hit = function (px, py) {
    for (let i = 0; i < this.widgets.length; i++) {
      const wd = this.widgets[i];
      if (px < wd.x - 6 || px > wd.x + wd.w + 6 || py < wd.y || py > wd.y + wd.h) continue;
      if (wd.type === "slider") return { wd, key: wd.key };
      const it = items(wd).find((r) => px >= r.x - 5 && px <= r.x + r.w + 5 && py >= r.y - 6 && py <= r.y + r.h + 6);
      if (it) return { wd, item: it.v, key: (wd.key || wd.label) + ":" + it.v };
    }
    return null;
  };
  ControlPanel.prototype.setSlider = function (wd, px) {
    const tr = sliderTrack(wd);
    const f = Math.min(1, Math.max(0, (px - tr.x) / tr.w));
    let v = Math.round((wd.min + f * (wd.max - wd.min)) / wd.step) * wd.step;
    v = Number(Math.min(wd.max, Math.max(wd.min, v)).toFixed(6));
    if (v !== this.state[wd.key]) { this.state[wd.key] = v; this.onChange(wd.key); }
  };
  /** Pointer pressed at canvas pixel (px, py). Returns true if a control took it. */
  ControlPanel.prototype.down = function (px, py) {
    const h = this.hit(px, py);
    if (!h) return false;
    const wd = h.wd;
    if (wd.type === "slider") { this.active = wd; this.setSlider(wd, px); }
    else if (wd.type === "seg") { if (this.state[wd.key] !== h.item) { this.state[wd.key] = h.item; this.onChange(wd.key); } }
    else if (wd.type === "chips") { this.state[h.item] = !this.state[h.item]; this.onChange(h.item); }
    else { this.flash = { v: h.item, until: Date.now() + 250 }; this.onAction(h.item); }
    this.draw();
    return true;
  };
  ControlPanel.prototype.move = function (px) { if (!this.active) return false; this.setSlider(this.active, px); this.draw(); return true; };
  ControlPanel.prototype.up = function () { const was = !!this.active; this.active = null; if (was) this.draw(); };
  /** Hover highlight; returns true if it changed (the caller then redraws). */
  ControlPanel.prototype.setHover = function (px, py) {
    const h = px == null ? null : this.hit(px, py);
    const key = h ? h.key : null;
    if (key === this.hover) return false;
    this.hover = key; return true;
  };
  ControlPanel.prototype.setInfo = function (res, s) { this.info = { res, s }; };

  /** One sentence per line on how its polarization lies relative to the field seen on the sky. */
  function polSentence(res, ln) {
    if (res.zeroField) return "bars point around the Sun";
    if (!(res.geo.bPerp > 0.02)) return "field points along our view";
    const rel = G.polVsBperp(res, ln).rel;
    return rel === "parallel" ? "bars along the field" : rel === "perpendicular" ? "bars across the field" : "";
  }

  ControlPanel.prototype.drawReadout = function (ctx) {
    const x = 36, y0 = 96, w = 712, h = 350;
    rr(ctx, x, y0, w, h, 18); ctx.fillStyle = "rgba(255,255,255,0.03)"; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = C.rule; ctx.stroke();
    if (!this.info) return;
    const { res, s } = this.info, g = res.geo;
    const F = "400 27px " + FONT, FB = "600 27px " + FONT, FM = "500 27px " + MONO;
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    let y = y0 + 36;
    const st = visibilityText(g.visibility);
    ctx.fillStyle = st[0]; ctx.beginPath(); ctx.arc(x + 30, y, 9, 0, 2 * Math.PI); ctx.fill();
    runs(ctx, x + 52, y, [["The blob: ", { font: F, color: C.ink2 }], [st[1], { font: FB, color: C.ink }]]);
    y += 44;
    runs(ctx, x + 22, y, [[kmText(s.height) + " above the surface", { font: F, color: C.ink2 }]]);
    y += 52;
    if (res.zeroField) {
      runs(ctx, x + 22, y, [["No magnetic field", { font: FB, color: C.ink }]]);
      y += 44;
      runs(ctx, x + 22, y, [["The light is still polarized by sunlight from below", { font: F, color: C.ink2 }]]);
    } else {
      const t = g.thetaB, fromAxis = Math.min(t, 180 - t), vv = G.VAN_VLECK;
      runs(ctx, x + 22, y, [["Field tilt from straight up  ", { font: F, color: C.ink2 }], [t.toFixed(0) + "°", { font: FM, color: C.r }]]);
      y += 44;
      runs(ctx, x + 22, y, [[fromAxis < vv ? "Closer to vertical than the magic angle, 54.7°" : "Farther from vertical than the magic angle, 54.7°",
        { font: F, color: C.ink2 }]]);
    }
    res.lines.forEach(function (ln, n) {
      y += n ? 44 : 54;
      swatchLine(ctx, x + 22, y, n ? C.s1079 : C.s1074, n ? 5 : 8);
      runs(ctx, x + 70, y, [[n ? "1079.8 nm" : "1074.7 nm", { font: FB, color: C.ink }]]);
      let fs = 27, parts;
      do {
        parts = [[(100 * ln.L_I).toFixed(1) + "%", { font: "500 " + fs + "px " + MONO, color: C.ink }], [" polarized, " + polSentence(res, ln), { font: "400 " + fs + "px " + FONT, color: C.ink2 }]];
      } while (runsWidth(ctx, parts) > w - 228 - 14 && --fs > 19);
      runs(ctx, x + 228, y, parts);
    });
    y += 46;
    ctx.fillStyle = C.ink3; ctx.font = "400 24px " + FONT;
    ctx.fillText("Brightness of 1079.8 vs 1074.7: " + (res.lines[1].eps.I / res.lines[0].eps.I).toFixed(2) + " (rises with density)", x + 22, y);
  };

  ControlPanel.prototype.draw = function () {
    const ctx = this.ctx, s = this.state, self = this, now = Date.now();
    frame(ctx, this.W, this.H, "Controls", "grab a bar like this to move a panel");
    this.drawReadout(ctx);
    this.widgets.forEach(function (wd) {
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      if (wd.type === "slider") {
        const hov = self.hover === wd.key || self.active === wd;
        const unused = wd.dir && !(s.B > 0);
        const val = unused ? "no field" : wd.fmt(Number(s[wd.key]));
        let vs = 26; ctx.font = "500 " + vs + "px " + MONO;
        while (vs > 19 && ctx.measureText(val).width > wd.w * 0.56) { vs--; ctx.font = "500 " + vs + "px " + MONO; }
        const vw = ctx.measureText(val).width;
        let ls = 27; ctx.font = "400 " + ls + "px " + FONT;
        while (ls > 19 && ctx.measureText(wd.label).width > wd.w - vw - 30) { ls--; ctx.font = "400 " + ls + "px " + FONT; }
        ctx.fillStyle = unused ? C.ink3 : C.ink2;
        ctx.fillText(wd.label, wd.x + 4, wd.y + 30);
        ctx.textAlign = "right"; ctx.font = "500 " + vs + "px " + MONO; ctx.fillStyle = unused ? C.ink3 : C.ink;
        ctx.fillText(val, wd.x + wd.w - 4, wd.y + 30);
        ctx.textAlign = "left";
        const tr = sliderTrack(wd), f = (s[wd.key] - wd.min) / (wd.max - wd.min);
        rr(ctx, tr.x, tr.y - 6, tr.w, 12, 6); ctx.fillStyle = C.control; ctx.fill();
        rr(ctx, tr.x, tr.y - 6, Math.max(12, tr.w * f), 12, 6); ctx.fillStyle = unused ? C.axis : C.accent; ctx.fill();
        ctx.beginPath(); ctx.arc(tr.x + tr.w * f, tr.y, hov ? 21 : 17, 0, 2 * Math.PI);
        ctx.fillStyle = C.ink; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = C.panel; ctx.stroke();
        return;
      }
      if (wd.label) {
        ctx.fillStyle = C.ink3; ctx.font = "600 22px " + COND;
        ctx.fillText(wd.label.toUpperCase(), wd.x + 4, wd.y + 14);
      }
      items(wd).forEach(function (it) {
        let on = false;
        if (wd.type === "seg") on = s[wd.key] === it.v;
        else if (wd.type === "chips") on = !!s[it.v];
        else on = !!(self.flash && self.flash.v === it.v && self.flash.until > now);
        const hov = self.hover === (wd.key || wd.label) + ":" + it.v;
        rr(ctx, it.x, it.y, it.w, it.h, 12);
        ctx.fillStyle = on ? C.accent : hov ? C.controlHi : C.control; ctx.fill();
        if (!on) { ctx.lineWidth = 2; ctx.strokeStyle = hov ? C.ink3 : C.rule; ctx.stroke(); }
        const txt = (wd.type === "chips" && on ? "✓ " : "") + it.t;
        let fs = 25; ctx.font = (on ? "600 " : "500 ") + fs + "px " + FONT;
        while (fs > 18 && ctx.measureText(txt).width > it.w - 16) { fs--; ctx.font = (on ? "600 " : "500 ") + fs + "px " + FONT; }
        ctx.fillStyle = on ? C.onAccent : C.ink; ctx.textAlign = "center";
        const dot = wd.dots && wd.dots[it.v];
        ctx.fillText(txt, it.x + it.w / 2 + (dot ? 12 : 0), it.y + it.h / 2 + 1);
        if (dot) {                                // the colour key for the lines in the scene
          ctx.beginPath(); ctx.arc(it.x + it.w / 2 - ctx.measureText(txt).width / 2 - 8, it.y + it.h / 2, 9, 0, 2 * Math.PI);
          ctx.fillStyle = dot; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = on ? C.onAccent : C.panel; ctx.stroke();
        }
        ctx.textAlign = "left";
      });
    });
    if (this.fps) { ctx.fillStyle = C.ink3; ctx.font = "400 22px " + MONO; ctx.textAlign = "right"; ctx.fillText(this.fps, 748, 960); ctx.textAlign = "left"; }
  };

  // =====================================================================================================
  // Guide
  // =====================================================================================================
  const GUIDE = { W: 1024, H: 1560 };
  function GuidePanel(opts) {
    this.W = GUIDE.W; this.H = GUIDE.H;
    this.canvas = makeCanvas(this.W, this.H);
    this.ctx = this.canvas.getContext("2d");
    this.onClose = opts.onClose || function () {};
    this.close = { x: this.W - 232, y: this.H - 96, w: 200, h: 64 };
    this.hover = false;
  }
  GuidePanel.prototype.hit = function (px, py) { const b = this.close; return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h; };
  GuidePanel.prototype.down = function (px, py) { if (!this.hit(px, py)) return false; this.onClose(); return true; };
  GuidePanel.prototype.setHover = function (px, py) { const h = px != null && this.hit(px, py); if (h === this.hover) return false; this.hover = h; return true; };
  GuidePanel.prototype.draw = function () {
    const ctx = this.ctx, W = this.W, x = 40, w = W - 80;
    frame(ctx, W, this.H, "Hidden magnetism", "");
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    let y = HDR + 58;
    ctx.fillStyle = C.ink; ctx.font = "400 29px " + FONT;
    y = para(ctx, "The Sun's outer atmosphere, the corona, is threaded by magnetic fields we cannot see. Iron atoms there glow in two infrared colours, at 1074.7 and 1079.8 nanometres, invisible to our eyes.", x, y, w, 40);
    y += 8;
    y = para(ctx, "Sunlight from below lines the atoms up, so their light comes out polarized, and the magnetic field turns that polarization. Telescopes such as the Daniel K. Inouye Solar Telescope measure it to map the field.", x, y, w, 40);
    y += 8;
    y = para(ctx, "The thin lines are a model of the Sun's magnetic field on 8 April 2024, the day of a total solar eclipse, calculated from maps of the field on its surface. Closed loops return to the Sun. Open lines reach out into space.", x, y, w, 40);
    y += 20;
    ctx.fillStyle = C.ink3; ctx.font = "600 23px " + COND; ctx.fillText("HOW TO PLAY", x, y); y += 44;
    ctx.font = "400 28px " + FONT;
    [["Point and pull the trigger, or pinch your fingers, to grab."],
      ["Grab the glowing ", "blob", " to move it around the Sun."],
      ["Grab the ", "pink ball", " to turn the magnetic field."],
      ["Grab empty space to move the Sun. Use both hands to resize it."]].forEach(function (parts) {
      ctx.fillStyle = C.ink3; ctx.fillText("•", x + 4, y);
      let xx = x + 34;
      parts.forEach(function (t, i) {
        ctx.font = (i % 2 ? "600 " : "400 ") + "28px " + FONT;
        ctx.fillStyle = i % 2 ? (t === "pink ball" ? C.B : "#ffffff") : C.ink;
        ctx.fillText(t, xx, y); xx += ctx.measureText(t).width;
      });
      y += 42;
    });
    y += 18;
    ctx.fillStyle = C.ink3; ctx.font = "600 23px " + COND; ctx.fillText("TRY THIS", x, y); y += 44;
    [["Tilt the field past 54.7°, the magic angle.", "The polarization bars flip by 90°."],
      ["Point the field straight at Earth.", "The circular polarization is strongest and the bars shrink away."],
      ["Turn the field strength down to zero.", "The light stays polarized, with the bars pointing around the Sun: sunlight alone does that."],
      ["Turn the plasma density down.", "Fewer collisions jostle the atoms, so the light gets far more polarized, and the 1079.8 nm colour fades."],
      ["Put the blob on a thin line and turn the pink arrow to follow it.", "The bars now show the polarization this one spot would give, if the model is right there."]].forEach(function (t, i) {
      ctx.fillStyle = C.accent; ctx.font = "600 28px " + FONT; ctx.fillText(String(i + 1), x + 2, y);
      ctx.fillStyle = C.ink; ctx.font = "600 28px " + FONT; y = para(ctx, t[0], x + 34, y, w - 34, 38);
      ctx.fillStyle = C.ink2; ctx.font = "400 27px " + FONT; y = para(ctx, t[1], x + 34, y, w - 34, 38);
      y += 12;
    });
    y += 6;
    ctx.fillStyle = C.ink3; ctx.font = "400 24px " + FONT;
    y = para(ctx, "This shows the light of one blob. A real telescope sees the glow of everything along its line of sight, added together.", x, y, w - 220, 32);
    const b = this.close;
    rr(ctx, b.x, b.y, b.w, b.h, 12); ctx.fillStyle = this.hover ? C.controlHi : C.control; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = this.hover ? C.ink3 : C.rule; ctx.stroke();
    ctx.fillStyle = C.ink; ctx.font = "500 26px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Hide guide", b.x + b.w / 2, b.y + b.h / 2 + 1);
    ctx.textAlign = "left";
  };

  // =====================================================================================================
  // Spectra: brightness, linear polarization (amount) and circular polarization against wavelength
  // =====================================================================================================
  const PLOTS = [
    { key: "I", title: "Brightness", tech: "Stokes I", unit: "relative to the 1074.7 nm peak", pct: false },
    { key: "L", title: "Linear polarization", tech: "√(Q² + U²)", unit: "% of the 1074.7 nm peak", pct: true },
    { key: "V", title: "Circular polarization", tech: "Stokes V", unit: "% of the 1074.7 nm peak", pct: true },
  ];
  const SPEC = { W: 1536, H: 1152, top: 124, pad: 26, gap: 22, title: 40, M: { l: 104, r: 18, t: 10, b: 40 } };
  function spectraRects() {
    const ch = (SPEC.H - SPEC.top - SPEC.pad - 30 - SPEC.gap * (PLOTS.length - 1)) / PLOTS.length, cw = SPEC.W - 2 * SPEC.pad;
    return PLOTS.map(function (p, i) {
      const x = SPEC.pad, y = SPEC.top + i * (ch + SPEC.gap), M = SPEC.M;
      return { x, y, w: cw, h: ch, px: x + M.l, py: y + SPEC.title + M.t, pw: cw - M.l - M.r, ph: ch - SPEC.title - M.t - M.b };
    });
  }
  function seriesFor(res, s, p) {
    const out = [], ref = res.lines[0].Ipeak, f = (p.pct ? 100 : 1) / ref;
    res.lines.forEach(function (ln, n) {
      if (!shown(s, n)) return;
      const P = ln.prof, m = P.I.length, y = new Float64Array(m);
      for (let i = 0; i < m; i++) y[i] = (p.key === "L" ? Math.hypot(P.Q[i], P.U[i]) : P[p.key][i]) * f;
      out.push({ y, color: n ? C.s1079 : C.s1074, width: n ? 3.5 : 4.5, name: n ? "1079.8" : "1074.7" });
    });
    return out;
  }
  function rangeFor(p, series) {
    let mx = 0;
    series.forEach((sr) => { for (let i = 0; i < sr.y.length; i++) mx = Math.max(mx, Math.abs(sr.y[i])); });
    if (p.key === "I") { const top = Math.max(1, mx); const st = niceStep(top / 4); return { lo: 0, hi: Math.ceil(top * 1.06 / st) * st, step: st }; }
    if (p.key === "L") { const m = Math.max(mx * 1.08, 1e-2), st = niceStep(m / 3); return { lo: 0, hi: Math.ceil(m / st) * st, step: st }; }
    const m = Math.max(mx * 1.1, 1e-3), st = niceStep(m / 2), hi = Math.ceil(m / st) * st;
    return { lo: -hi, hi, step: st };
  }
  /** Which plot and wavelength sample a canvas pixel falls on, or null. */
  function spectraHit(px, py, n) {
    const R = spectraRects();
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
      const f = (px - r.px) / r.pw;
      if (f < -0.03 || f > 1.03) return null;
      return { plot: i, idx: Math.round(Math.min(1, Math.max(0, f)) * (n - 1)) };
    }
    return null;
  }

  function drawSpectra(ctx, d) {
    const { res, dlam, s, hover } = d;
    const W = SPEC.W;
    frame(ctx, W, SPEC.H, "The blob's light", "");
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    let lx = 360;
    [["1074.7 nm", C.s1074, 8, 0], ["1079.8 nm", C.s1079, 5, 1]].forEach(function ([t, c, w, n]) {
      if (!shown(s, n)) return;
      swatchLine(ctx, lx, HDR / 2, c, w);
      ctx.fillStyle = C.ink; ctx.font = "500 27px " + FONT; ctx.fillText(t, lx + 46, HDR / 2 + 1);
      lx += 220;
    });
    ctx.fillStyle = C.ink2; ctx.font = "400 25px " + FONT;
    ctx.fillText("Each colour spread out by wavelength, as a spectrograph sees it", 32, HDR + 24);
    const vis = res.geo.visibility;
    if (vis !== "off-limb") {
      ctx.fillStyle = vis === "occulted" ? C.crit : C.warn; ctx.font = "600 25px " + FONT; ctx.textAlign = "right";
      ctx.fillText(vis === "occulted" ? "Hidden behind the Sun" : "In front of the bright Sun (not shown)", W - 32, HDR + 24);
      ctx.textAlign = "left";
    }
    const x0 = dlam[0], x1 = dlam[dlam.length - 1];
    const rects = spectraRects();
    PLOTS.forEach(function (p, pi) {
      const r = rects[pi];
      const series = seriesFor(res, s, p), R = rangeFor(p, series);
      const X = (x) => r.px + (x - x0) / (x1 - x0) * r.pw;
      const Y = (y) => r.py + (1 - (y - R.lo) / (R.hi - R.lo)) * r.ph;
      ctx.textBaseline = "middle"; ctx.textAlign = "left";
      runs(ctx, r.x + 8, r.y + 18, [[p.title, { font: "600 28px " + FONT, color: C.ink }], ["   " + p.unit, { font: "400 23px " + FONT, color: C.ink3 }],
        ["   " + p.tech, { font: "400 22px " + MONO, color: C.ink3 }]]);
      ctx.font = "400 22px " + MONO; ctx.lineWidth = 1.5; ctx.textAlign = "right";
      for (let v = R.lo; v <= R.hi + R.step * 1e-6; v += R.step) {
        const yy = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < R.step * 1e-6 ? C.axis : C.rule;
        ctx.beginPath(); ctx.moveTo(r.px, yy); ctx.lineTo(r.px + r.pw, yy); ctx.stroke();
        ctx.fillStyle = C.ink3; ctx.fillText(tickLabel(v, R.step) + (p.pct && Math.abs(v) > R.step * 1e-6 ? "%" : ""), r.px - 10, yy);
      }
      const xs = niceStep((x1 - x0) / 8);
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + 1e-9; v += xs) {
        const xx = Math.round(X(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < 1e-9 ? C.axis : C.rule;
        ctx.beginPath(); ctx.moveTo(xx, r.py); ctx.lineTo(xx, r.py + r.ph); ctx.stroke();
        if (pi === PLOTS.length - 1) { ctx.fillStyle = C.ink3; ctx.fillText(tickLabel(v, xs), xx, r.py + r.ph + 8); }
      }
      if (pi === PLOTS.length - 1) {
        ctx.fillStyle = C.ink2; ctx.font = "400 23px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText("bluer ←   wavelength shift from the line centre (Å)   → redder", r.px, r.y + r.h + 4);
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(r.px, r.py - 3, r.pw, r.ph + 6); ctx.clip();
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      for (let k = series.length - 1; k >= 0; k--) {
        const ys = series[k].y;
        ctx.lineWidth = series[k].width; ctx.strokeStyle = series[k].color;
        ctx.beginPath();
        for (let i = 0; i < ys.length; i++) { const xx = X(dlam[i]), yy = Y(ys[i]); if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy); }
        ctx.stroke();
      }
      ctx.restore();
      if (hover) {
        const xx = Math.round(X(dlam[hover.idx])) + 0.5;
        ctx.strokeStyle = C.ink3; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(xx, r.py); ctx.lineTo(xx, r.py + r.ph); ctx.stroke();
        series.forEach(function (sr) {
          const yy = Y(sr.y[hover.idx]);
          if (yy < r.py - 3 || yy > r.py + r.ph + 3) return;
          ctx.beginPath(); ctx.arc(xx, yy, 8, 0, 2 * Math.PI);
          ctx.fillStyle = sr.color; ctx.fill(); ctx.lineWidth = 3.5; ctx.strokeStyle = C.panel; ctx.stroke();
        });
        if (hover.plot === pi) {
          ctx.textBaseline = "middle"; ctx.textAlign = "left";
          const parts = [[signed(dlam[hover.idx], 2) + " Å", { font: "500 24px " + MONO, color: C.ink2 }]];
          series.forEach(function (sr) {
            parts.push(["   " + sr.name + " ", { font: "400 23px " + FONT, color: C.ink3 }]);
            parts.push([smart(sr.y[hover.idx]) + (p.pct ? "%" : ""), { font: "600 24px " + MONO, color: C.ink }]);
          });
          runs(ctx, r.x + r.w - runsWidth(ctx, parts) - 8, r.y + 18, parts);
        }
      }
    });
  }

  // =====================================================================================================
  // Telescope view: the plane of the sky, orthographic, north up and west right
  // =====================================================================================================
  const TEL = { W: 1024, H: 1270, map: 1024, fov: 3.15 };

  /** The field lines as the telescope sees them, on a transparent layer that is redrawn only when the choice of
   *  lines changes. Parts behind the Sun's disk are left out. */
  let telLayer = null, telLayerKey = null;
  function fieldLineLayer(lines, mode, cx, cy, k) {
    if (telLayer && telLayerKey === mode) return telLayer;
    telLayer = telLayer || makeCanvas(TEL.W, TEL.map);
    telLayerKey = mode;
    const g = telLayer.getContext("2d");
    g.clearRect(0, 0, TEL.W, TEL.map);
    g.lineWidth = 2.2; g.lineJoin = "round"; g.lineCap = "round"; g.globalAlpha = 0.72;
    [["closed", C.closedLine], ["open", C.openLine]].forEach(function ([kind, col]) {
      if (mode !== "all" && mode !== kind) return;
      g.strokeStyle = col;
      lines[kind].forEach(function (p) {
        g.beginPath();
        let pen = false;
        for (let i = 0; i < p.length; i += 3) {
          if (p[i] < 0 && Math.hypot(p[i + 1], p[i + 2]) < 1) { pen = false; continue; }
          const X = cx + p[i + 1] * k, Y = cy - p[i + 2] * k;
          if (pen) g.lineTo(X, Y); else g.moveTo(X, Y);
          pen = true;
        }
        g.stroke();
      });
    });
    return telLayer;
  }

  function drawTelescope(ctx, d) {
    const { res, s, lines } = d;
    const W = TEL.W;
    const showLines = !!lines && s.fieldLines && s.fieldLines !== "off";
    frame(ctx, W, TEL.H, "What a telescope sees", "the Sun from Earth");
    const top = HDR, S = TEL.map, cx = W / 2, cy = top + S / 2, k = S / (2 * TEL.fov);
    const P = (y, z) => [cx + y * k, cy - z * k];
    ctx.save();
    ctx.beginPath(); ctx.rect(2, top, W - 4, S); ctx.clip();
    ctx.fillStyle = C.space; ctx.fillRect(0, top, W, S);
    let g = ctx.createRadialGradient(cx, cy, k * 0.95, cx, cy, k * 2.6);
    g.addColorStop(0, "rgba(255,190,120,0.34)"); g.addColorStop(0.25, "rgba(255,160,90,0.12)"); g.addColorStop(1, "rgba(80,110,200,0)");
    ctx.fillStyle = g; ctx.fillRect(0, top, W, S);
    ctx.setLineDash([7, 9]); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(143,163,196,0.33)";
    ctx.font = "400 21px " + FONT; ctx.fillStyle = "rgba(170,186,212,0.8)"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    [[1.5, "0.5"], [2, "1"], [2.5, "1.5"], [3, "2"]].forEach(function ([rad, h]) {
      ctx.beginPath(); ctx.arc(cx, cy, rad * k, 0, 2 * Math.PI); ctx.stroke();
      const a = -0.62; ctx.fillText(h + " R☉ up", cx + rad * k * Math.cos(a) + 8, cy - rad * k * Math.sin(a));
    });
    ctx.setLineDash([]);
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, k);
    g.addColorStop(0, "#ffdc96"); g.addColorStop(0.7, "#f2a24e"); g.addColorStop(0.93, "#d0661f"); g.addColorStop(1, "#a63c0c");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, k, 0, 2 * Math.PI); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,227,184,0.7)"; ctx.stroke();
    if (showLines) ctx.drawImage(fieldLineLayer(lines, s.fieldLines, cx, cy - top, k), 0, top);
    ctx.fillStyle = C.ink2; ctx.font = "600 26px " + FONT; ctx.textAlign = "center";
    ctx.fillText("north", cx, top + 30); ctx.fillText("south", cx, top + S - 28);
    ctx.fillText("east", 50, cy); ctx.fillText("west", W - 50, cy);

    const geo = res.geo, loc = geo.loc, b = geo.bhat;
    const sp = G.skyPosition(loc), [px, py] = P(sp.y, sp.z);
    const hidden = geo.visibility === "occulted";
    ctx.globalAlpha = hidden ? 0.45 : 1;
    if (geo.rhoPOS > 1.001) {               // radial guide from the limb to the blob
      const [lx, ly] = P(sp.y / geo.rhoPOS, sp.z / geo.rhoPOS);
      ctx.setLineDash([8, 7]); ctx.lineWidth = 2.5; ctx.strokeStyle = C.r;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(px, py); ctx.stroke(); ctx.setLineDash([]);
    }
    const bp = Math.hypot(b[1], b[2]);       // the field as projected on the sky
    if (!res.zeroField && bp > 1e-4) {
      const L = 0.95 * bp, ex = px + b[1] / bp * L * k, ey = py - b[2] / bp * L * k;
      ctx.lineWidth = 4; ctx.strokeStyle = C.Bp; ctx.fillStyle = C.Bp;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
      const ang = Math.atan2(ey - py, ex - px);
      ctx.beginPath(); ctx.moveTo(ex + 6 * Math.cos(ang), ey + 6 * Math.sin(ang));
      ctx.lineTo(ex - 20 * Math.cos(ang - 0.42), ey - 20 * Math.sin(ang - 0.42));
      ctx.lineTo(ex - 20 * Math.cos(ang + 0.42), ey - 20 * Math.sin(ang + 0.42)); ctx.closePath(); ctx.fill();
    }
    const ref = G.refInPOS(geo.refVec);      // polarization bars, same length as in the 3D view
    if (ref) {
      [[1, 7], [0, 11]].forEach(function ([n, w]) {
        const ln = res.lines[n];
        if (!shown(s, n) || !(ln.L_I > 1e-6)) return;
        const dv = G.rotateInPOS(ref, ln.chi), half = G.barHalfLength(ln.L_I) * k;
        const ax = px - dv[1] * half, ay = py + dv[2] * half, bx = px + dv[1] * half, by = py - dv[2] * half;
        ctx.lineCap = "round";
        ctx.lineWidth = w + 5; ctx.strokeStyle = C.space; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.lineWidth = w; ctx.strokeStyle = n ? C.s1079 : C.s1074; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      });
    }
    ctx.beginPath(); ctx.arc(px, py, 11, 0, 2 * Math.PI);  // filled: near side; ring: far side
    if (sp.front) { ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = C.space; ctx.stroke(); }
    else { ctx.lineWidth = 4; ctx.strokeStyle = "#ffffff"; ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.restore();
    const ly0 = top + S;                     // legend below the map
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let x = 28;
    [[C.s1074, 8, 0], [C.s1079, 5, 1]].forEach(function ([c, w, n]) { if (shown(s, n)) { swatchLine(ctx, x, ly0 + 34, c, w); x += 50; } });
    ctx.fillStyle = C.ink2; ctx.font = "400 24px " + FONT; ctx.fillText("direction of polarization", x, ly0 + 35);
    swatchLine(ctx, 560, ly0 + 34, C.Bp, 4); ctx.fillStyle = C.ink2; ctx.fillText("magnetic field on the sky", 606, ly0 + 35);
    ctx.fillStyle = C.ink3; ctx.font = "400 23px " + FONT;
    ctx.fillText((sp.front ? "Dot: the blob, on the near side of the Sun" : "Ring: the blob, on the far side of the Sun") +
      (hidden ? ", hidden from Earth" : ""), 28, ly0 + 84);
    if (showLines) {
      let lx = 28;
      [[C.closedLine, "closed loops", "closed"], [C.openLine, "open lines", "open"]].forEach(function ([c, t, kind]) {
        if (s.fieldLines !== "all" && s.fieldLines !== kind) return;
        swatchLine(ctx, lx, ly0 + 132, c, 4); ctx.fillStyle = C.ink2; ctx.font = "400 24px " + FONT; ctx.fillText(t, lx + 46, ly0 + 133); lx += 230;
      });
      ctx.fillStyle = C.ink3; ctx.font = "400 23px " + FONT; ctx.fillText("Model for 8 April 2024", 700, ly0 + 133);
    }
  }

  root.VRPanels = { C, FONT, MONO, ControlPanel, GuidePanel, drawSpectra, drawTelescope, spectraHit, SPEC, TEL, GUIDE, HDR, makeCanvas, kmText };
})(typeof globalThis !== "undefined" ? globalThis : this);
