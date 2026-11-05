// BanJo — coupled string/pot modal banjo engine.
// Runs in an AudioWorklet, on the main thread (ScriptProcessor fallback), or in Node for offline tests.
//
// Five steel strings, each a sum of its transverse modes, two per partial (one per polarization). The short 5th string
// starts at its peg pip at the 5th fret. Nothing about a mode's decay or pitch is hand-tuned: both come from the
// string's own losses (Woodhouse et al. 2012) plus what the bridge drains, evaluated at that mode's frequency:
//
//   frequency     f_k = k f0 sqrt(1 + B k^2),   B = pi^2 EI / (T L^2)
//   bridge        ds = -(T/L) Y2_s(w_k): Y2_s is the 2x2 admittance at string s's own place on the bridge (pot.js):
//                 the bridge heaves, rolls, bends and sways on a drumhead, so each string feels a different bridge.
//                 Banjo admittance runs ~10-20 dB above a guitar's: that is the banjo's bright, fast-fading voice.
//
// The same coupled pot modes that drain the strings also radiate: generalized bridge forces (vertical sum, rolling
// moment, bending, sideways push) drive each mode; its velocity becomes volume velocity in five head regions and the
// opening behind (open back, or the resonator's flange gap), which reach the mics at their own distances.
// The strings' tension changes push down on the bridge over the break angle (string stretching; Politzer 2014).
(function (root) {
'use strict';
const TAU = Math.PI * 2;
const NS = 5;                       // string order: 5th (drone), 4th, 3rd, 2nd, 1st

// ---------------- strings ----------------
// Gauges (inches) per set, string order 5th..1st; the 4th is wound (nickel on a steel core).
// Plain steel: E 200 GPa, rho 7850. Wound .022 / .020: linear density from published banjo-set tensions at 26.25";
// bending and axial stiffness mostly from the core (+25% / +15% for the wrap).
const STRING_SETS = {
  light:  { name: 'Light (.0095-.020w)', g: [0.0095, 0.020, 0.013, 0.011, 0.0095], wound: [0, 1, 0, 0, 0], core: 0.0095, wmu: 1.29e-3 },
  medium: { name: 'Medium (.010-.022w)', g: [0.010, 0.022, 0.013, 0.012, 0.010], wound: [0, 1, 0, 0, 0], core: 0.010, wmu: 1.56e-3 },
  heavy:  { name: 'Medium-heavy (.0105-.023w)', g: [0.0105, 0.023, 0.013, 0.012, 0.0105], wound: [0, 1, 0, 0, 0], core: 0.0105, wmu: 1.70e-3 }
};
function stringData(set, i) {
  const S = STRING_SETS[set] || STRING_SETS.medium, inch = 0.0254, E = 200e9;
  const wound = !!S.wound[i];
  const d = (wound ? S.core : S.g[i]) * inch, A = Math.PI * d * d / 4, I = Math.PI * d ** 4 / 64;
  const mu = wound ? S.wmu : 7850 * A;
  // Woodhouse et al. 2012 damping, plain-steel and wound rows; thinner strings lose more to the air (etaA ~ 1/d^2)
  const dPlain = S.g[i] * inch, airK = Math.pow(0.33e-3 / Math.max(0.2e-3, dPlain), 2);
  return wound
    ? { mu, EI: E * I * 1.25, EA: E * A * 1.15, wound: 1, etaF: 9e-5, etaBn: 1.1e-2, etaBu: 4.1e-2, etaA: 1.3, gauge: S.g[i] }
    : { mu, EI: E * I, EA: E * A, wound: 0, etaF: 7e-5, etaBn: 0.8e-2, etaBu: 1.2e-2, etaA: 2.5 * airK, gauge: S.g[i] };
}

// ---------------- banjos ----------------
// pot: see pot.js. Scale 26.25" (667 mm). Bridge heights 1/2", 5/8", 11/16".
const BANJOS = {
  bluegrass: { name: 'Bluegrass resonator, flathead ring', scale: 0.667, strings: 'medium',
    pot: { headD: 0.268, head: 'frosted', dd: 90, ring: 'flathead', back: 'resonator', potDepth: 0.070, bridgeMass: 0.0022, bridgeH: 0.0159, breakDeg: 13, stuff: 'none' } },
  archtop: { name: 'Resonator, archtop ring', scale: 0.667, strings: 'medium',
    pot: { headD: 0.268, head: 'frosted', dd: 91, ring: 'archtop', back: 'resonator', potDepth: 0.070, bridgeMass: 0.0021, bridgeH: 0.0159, breakDeg: 12, stuff: 'none' } },
  openback: { name: 'Open-back 12", brass hoop', scale: 0.667, strings: 'light',
    pot: { headD: 0.293, head: 'fibre', dd: 86, ring: 'hoop', back: 'open', potDepth: 0.064, bridgeMass: 0.0020, bridgeH: 0.0175, breakDeg: 8, stuff: 'rag' } },
  oldtime: { name: 'Old-time 11", wood rim, calfskin', scale: 0.667, strings: 'light',
    pot: { headD: 0.268, head: 'calf', dd: 84, ring: 'none', back: 'open', potDepth: 0.060, bridgeMass: 0.0018, bridgeH: 0.0159, breakDeg: 6, stuff: 'none' } }
};
// Tunings, string order 5th, 4th, 3rd, 2nd, 1st (MIDI)
const TUNINGS = {
  openG:   { name: 'Open G (gDGBD)', t: [67, 50, 55, 59, 62] },
  doubleC: { name: 'Double C (gCGCD)', t: [67, 48, 55, 60, 62] },
  sawmill: { name: 'G modal / sawmill (gDGCD)', t: [67, 50, 55, 60, 62] },
  openD:   { name: 'Open D (f#DF#AD)', t: [66, 50, 54, 57, 62] },
  doubleD: { name: 'Double D (aDADE)', t: [69, 50, 57, 62, 64] },
  standC:  { name: 'Standard C (gCGBD)', t: [67, 48, 55, 59, 62] },
  gMinor:  { name: 'G minor (gDGBbD)', t: [67, 50, 55, 58, 62] },
  openA:   { name: 'Open A (aEAC#E)', t: [69, 52, 57, 61, 64] }
};
const OPEN_G = TUNINGS.openG.t;

// ---------------- picks ----------------
// A pick is a short cantilever between the string and the finger (pickModel below). Metal fingerpicks: nickel silver
// (E ~130 GPa) or brass (~105 GPa); blade thickness by gauge; worn with ~3 mm of blade past the fingertip.
// Thumbpicks: celluloid or heavier plastic, ~1-1.4 mm at the blade. Values from material handbooks; the effects are
// taken relative to a medium celluloid flatpick (the reference the engine's pluck levels are calibrated to).
const PICKS = {
  ns018:    { name: 'Nickel-silver fingerpick .018', E: 130e9, rho: 8700, eta: 0.002, mu: 0.30, t: 0.46e-3, w: 5e-3, edge: 0.30e-3, scrape: 1.4, ell: 0.65 },
  ns025:    { name: 'Nickel-silver fingerpick .025', E: 130e9, rho: 8700, eta: 0.002, mu: 0.30, t: 0.64e-3, w: 5e-3, edge: 0.32e-3, scrape: 1.4, ell: 0.65 },
  brass:    { name: 'Brass fingerpick .022',         E: 105e9, rho: 8500, eta: 0.003, mu: 0.33, t: 0.56e-3, w: 5e-3, edge: 0.32e-3, scrape: 1.3, ell: 0.65 },
  plastic:  { name: 'Plastic fingerpick',            E: 2.4e9, rho: 1300, eta: 0.03,  mu: 0.32, t: 0.9e-3, w: 6e-3, edge: 0.25e-3, scrape: 0.8, ell: 0.7 },
  thumbM:   { name: 'Celluloid thumbpick, medium',   E: 2.0e9, rho: 1350, eta: 0.030, mu: 0.35, t: 1.0e-3, w: 7e-3, edge: 0.20e-3, scrape: 1.0, ell: 1.1 },
  thumbH:   { name: 'Heavy plastic thumbpick',       E: 2.9e9, rho: 1410, eta: 0.012, mu: 0.25, t: 1.4e-3, w: 7e-3, edge: 0.22e-3, scrape: 0.8, ell: 1.1 },
  thumbMet: { name: 'Metal thumbpick',               E: 130e9, rho: 8700, eta: 0.002, mu: 0.30, t: 0.5e-3, w: 6e-3, edge: 0.30e-3, scrape: 1.4, ell: 0.8 },
  cell71:   { name: 'Celluloid .71 (reference)',     E: 2.0e9, rho: 1350, eta: 0.030, mu: 0.35, t: 0.71e-3, w: 8e-3, edge: 0.15e-3, scrape: 1.0 }
};
const GRIPS = { tight: 3.5e-3, normal: 5e-3, loose: 7.5e-3 };
// Pitch of the outer winding (wrap-wire diameter), m: the 4th string's wrap on a .010 core
const WIND_PITCH = [0, 0.15e-3, 0, 0, 0];
let TR_GAIN = 1;
const FINGER = { delta: 0.0015, skinHz: 4000, axSide: 1.5, bump: 0.004, ridgeHz: 1400 };
let FRIC_GAIN = 0.03, FRIC_AIR = 0.02, FRIC_NORMAL = 1.2, FRIC_MU = [0.56, 0.5, 0.03, 1.0];

// Quasi-static release (from Acoustic's pick model):
// Quasi-static release: the string (lateral stiffness Ks = T L / (x (L - x))) pushes on the pick face; the pick bends
// (tip stiffness Kp = 3 E I / l^3, end slope 1.5 delta / l), tilting its face. With the player's attack angle psi0 and
// friction angle atan(mu), the string is pushed at alpha = psi0 + phi - atan(mu) from the stroke direction and slides
// toward the tip; it is released when it reaches the tip, which dips D0 past the string and rises along the stroke at
// the escape angle beta. Release time = edge radius / slip speed (stroke speed + the bent pick's recoil).
function pickModel(pk, T, L, xp, vel, angleDeg, grip, EsOverride) {
  const Ks = T * L / (xp * (L - xp));
  const ell = (GRIPS[grip] || GRIPS.normal) * (pk.ell || 1);
  const I = pk.w * pk.t ** 3 / 12, Kp = 3 * pk.E * I / ell ** 3;
  const D0 = (0.22 + 0.6 * vel) * 1e-3, beta = 8 * Math.PI / 180, psi0 = (angleDeg ?? 20) * Math.PI / 180, phiF = Math.atan(pk.mu);
  let d = 0.002, delta = 0, phi = 0, alpha = 0;
  for (let it = 0; it < 40; it++) {
    delta = Ks * d / Kp;
    phi = Math.min(0.75, 1.5 * delta / ell);
    alpha = Math.max(0.06, psi0 + phi - phiF);
    d = 0.5 * d + 0.5 * D0 / (Math.sin(alpha) + Math.cos(alpha) * Math.tan(beta));
  }
  const fp = 0.5596 * Math.sqrt(pk.E * pk.t * pk.t / (12 * pk.rho)) / (ell * ell);
  // recoil of the bent pick is along the stroke; only its component along the face (sin of the face tilt) speeds the slip
  const v = 0.4 + 1.8 * vel, vSnap = 0.5 * delta * 2 * Math.PI * fp * Math.sin(psi0 + phi);
  // Hertz contact between the string (radius ~0.2 mm) and the edge, crossed cylinders ~ a sphere of radius sqrt(r R):
  // the string presses a dent of depth dc = (9 F^2 / (16 R E*^2))^(1/3) into the tip. A soft tip (rubber, felt) takes
  // up part of the pick's travel in the dent (less string displacement), lets go over the time it takes the dent to
  // unload (longer, gentler release) and touches a wider stretch of string (fewer high harmonics). Hard tips: microns.
  const Es = EsOverride || pk.Es || pk.E, Estar = Es / (1 - 0.45 * 0.45);
  const R = Math.sqrt(2e-4 * pk.edge), F = Ks * d;
  const dc = Math.min(0.6 * pk.t, Math.cbrt(9 * F * F / (16 * R * Estar * Estar)));
  const aC = Math.sqrt(R * dc);
  d = Math.max(0.25 * d, d - dc);
  const tau = (pk.edge + dc) / (v + vSnap), width = 2 * pk.edge + 2 * aC + 2 * dc;
  const area = pk.w * ell, hard = Math.min(1, Math.sqrt(Es / 1e9));
  return { d, alpha, tau, width, fp, delta, Ks, Kp, dc, Es,
    click: Es < 5e8 ? 0 : delta * fp * fp * area, decay: 1 / (Math.PI * fp * pk.eta), scrape: pk.mu * pk.scrape * hard, hard, hold: d / v };
}
const PICK_REF = { type: 'cell71', angle: 20, grip: 'normal' };

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function gaussFrom(rng) { return (rng() + rng() + rng() + rng() - 2) * 1.2247; }
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------- string voice: a set of modal components ----------------
const MAXC = 2 * 200;
class Voice {
  constructor() {
    this.n = 0;
    this.k = new Int32Array(MAXC);
    this.w = new Float64Array(MAXC);
    this.sig = new Float64Array(MAXC);
    this.vy = new Float64Array(MAXC); this.vz = new Float64Array(MAXC);
    this.c1 = new Float64Array(MAXC); this.c2 = new Float64Array(MAXC);
    this.y1 = new Float64Array(MAXC); this.y2 = new Float64Array(MAXC);
    this.wy = new Float64Array(MAXC); this.wz = new Float64Array(MAXC);
    this.gin = new Float64Array(MAXC);
    this.single = new Uint8Array(MAXC);
    this.act = new Int32Array(MAXC); this.nact = 0;
    this.L = 0.667; this.T = 60; this.EA = 1e4; this.midi = 50;
    this.extra = 0; this.extraTarget = 0; this.extraRate = 0;
    this.detune = 0; this.appliedDetune = 0; this.appliedExtra = -1;
    this.energy = 0; this.live = false;
  }
}
class BString {
  constructor(idx) {
    this.idx = idx;
    this.voices = [new Voice(), new Voice(), new Voice()];
    this.cur = 0;
    this.open = OPEN_G[idx]; this.midi = OPEN_G[idx]; this.fret = 0;
    this.releaseAt = -1; this.env = 0; this.out = 0;
    this.lonN = 0; this.lonC1 = new Float64Array(4); this.lonC2 = new Float64Array(4);
    this.lonY1 = new Float64Array(4); this.lonY2 = new Float64Array(4); this.lonG = 0;
    this.lonIn = new Float64Array(4); this.lonT = 60; this.lonEA = 1e4;
    this.f2lp = 0; this.f2hp = 0;
    this.ownRing = new Float64Array(128);
  }
  get v() { return this.voices[this.cur]; }
}

const RHO_4PI = 1.2 / (4 * Math.PI);

class BanjoEngine {
  constructor(sr, opts) {
    this.sr = sr;
    this.rng = makeRng(12345);
    this.strings = []; for (let i = 0; i < NS; i++) this.strings.push(new BString(i));
    this.clock = 0; this.queue = [];
    this.params = {
      preset: 'bluegrass', tuning: OPEN_G.slice(), capo: 0, spike: 0, brightness: 0.6, body: 1.0,
      sympathetic: 0.5, noise: 0.5, gain: 1.0, quality: 'high', strings: null,
      setup: {},                       // pot overrides: head, dd, ring, back, bridgeMass, bridgeH, breakDeg, stuff, hold, headD
      scene: { mics: 'front30', hold: 'lap' },
      pick: { finger: 'ns025', thumb: 'thumbM', angle: 20 },
      cpu: 'light', fingerAmt: 1, fingerPress: 1
    };
    this.potExternal = !!(opts && opts.externalPot);
    this.bend = 0; this.bendTarget = 0;
    this.RING = 16384; this.RMASK = this.RING - 1;
    this.bodyIn = new Float64Array(this.RING);
    this.dirL = new Float64Array(this.RING); this.dirR = new Float64Array(this.RING);
    this.lonExt = [0, 1, 2, 3, 4].map(() => new Float64Array(this.RING));
    this.trExt = [0, 1, 2, 3, 4].map(() => new Float64Array(this.RING));
    this.trDelta = [0.004, 0.004, 0.004, 0.004, 0.004];
    this.trOn = [false, false, false, false, false]; this.W = new Float64Array(4096);
    this.staticZ = 0; this.staticY = 0;
    this.yTmp = new Float64Array(6);
    this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0;
    this.airL = 0; this.airR = 0;
    this.rh = new Float64Array(8);
    this.cplLP = 0; this.cplHP = 0;
    this.cplRing = new Float64Array(128); this.U = new Float64Array(64);
    this.RL = 2048; this.regRing = new Float64Array(7 * this.RL); this.regW = 0;
    this.regS = new Float64Array(7); this.regPrev = new Float64Array(7); this.regX = new Float64Array(7);
    this.mD = new Float64Array(14); this.mG = new Float64Array(14); this.mN = new Float64Array(14); this.mS = new Float64Array(14);
    this.mC = new Float64Array(14); this.mI = new Float64Array(14); this.mLP = new Float64Array(14); this.nm = 1;
    this.rhF = new Float64Array(8); this.feedF = 0; this.feedB = 0; this.sceneDirty = true;
    this.FY = []; this.FZ = []; for (let j = 0; j < NS; j++) { this.FY.push(new Float64Array(64)); this.FZ.push(new Float64Array(64)); }
    this.gIn = new Float64Array(4); this.gX1 = new Float64Array(4); this.gX2 = new Float64Array(4);
    this.setPreset('bluegrass');
  }

  // ---------- parameters ----------
  setParams(p) {
    let rebuild = false, retune = false;
    for (const k in p) {
      if (k === 'preset' || k === 'quality' || k === 'setup' || k === 'strings') rebuild = true;
      if (k === 'scene' || k === 'setup' || k === 'preset') this.sceneDirty = true;
      if (k === 'tuning' || k === 'capo' || k === 'spike' || k === 'brightness') retune = true;
      this.params[k] = p[k];
    }
    if (rebuild) this.setPreset(this.params.preset);
    else if (retune) { this.modeCache = new Map(); this.retuneAll(); }
  }
  // the pot spec for the current preset + overrides (also used by the app to build the pot off the audio thread)
  potSpec() {
    const base = BANJOS[this.params.preset] || BANJOS.bluegrass;
    const s = Object.assign({}, base.pot, this.params.setup || {});
    s.strings = [0, 1, 2, 3, 4].map(i => { const ph = this.stringPhys(i); return { T: ph.T, EA: ph.EA, L: this.scaleOf(i) }; });
    if (this.params.quality === 'eco') { s.fCut = 4600; s.fKeep = 3900; s.fMax = 9000; s.statSpacing = 70; }
    s.hold = (this.params.setup && this.params.setup.hold) || (this.params.scene && this.params.scene.hold) || 'lap';
    return s;
  }
  setPreset(name) {
    const base = BANJOS[name] || BANJOS.bluegrass;
    this.params.preset = BANJOS[name] ? name : 'bluegrass';
    const setName = this.params.strings || base.strings;
    this.P = { name: base.name, scale: base.scale, set: setName, strings: [0, 1, 2, 3, 4].map(i => stringData(setName, i)),
      damp: { fretted: 0.3 }, polDetune: 0.0012, airScale: 0.75, plainEtaF: 2.0e-4, radHP: 70, air: 12000, out: 0.12, lonQ: 300, lonGain: 0.05 };
    const sp = this.potSpec();
    this.P.breakSin = Math.sin((sp.breakDeg ?? 13) * Math.PI / 180) + Math.sin(2 * Math.PI / 180);
    const sr = this.sr;
    { const w = TAU * this.P.radHP / sr, q = 0.75, al = Math.sin(w) / (2 * q), a0 = 1 + al, cw = Math.cos(w);
      this.rhb0 = (1 + cw) / 2 / a0; this.rhb1 = -(1 + cw) / a0; this.rhb2 = this.rhb0; this.rha1 = -2 * cw / a0; this.rha2 = (1 - al) / a0; }
    this.airC = Math.exp(-TAU * this.P.air / sr);
    this.Ybuf = new Float64Array(6);
    this.modeCache = new Map();
    if (!this.potExternal || !this.pot) this.installPot(root.BanjoPot.buildPot(sp));
    else this.retuneAll();
  }
  // Install a pot (from BanjoPot.buildPot, possibly built off the audio thread): admittance data and the radiating bank.
  installPot(pot) {
    this.pot = pot; this.sceneDirty = true;
    const sr = this.sr, n = pot.n, eco = this.params.quality === 'eco';
    // admittance set: modes that the bridge actually drives (others neither drain the strings nor radiate)
    let pmax = 0; for (let k = 0; k < n; k++) { const P = pot.P[k]; pmax = Math.max(pmax, P[0] * P[0] + 1e-4 * P[1] * P[1] + 0.3 * P[2] * P[2] + P[3] * P[3]); }
    const drv = (k) => { const P = pot.P[k]; return P[0] * P[0] + 3e-4 * P[1] * P[1] + 0.5 * P[2] * P[2] + P[3] * P[3]; };
    const use = []; for (let k = 0; k < n; k++) if (drv(k) > 1e-7 * pmax) use.push(k);
    const nu = use.length;
    this.yF = new Float64Array(nu); this.yQ = new Float64Array(nu);
    this.yP = new Float64Array(nu * 4);
    use.forEach((k, q) => { this.yF[q] = pot.f[k]; this.yQ[q] = pot.Q[k]; for (let d = 0; d < 4; d++) this.yP[q * 4 + d] = pot.P[k][d]; });
    this.yN = nu;
    // radiating bank: every mode below 1.5 kHz, every 2nd to 4 kHz, every 4th above (each stands in for those skipped)
    const keep = [], stride = [];
    for (let q = 0; q < nu; q++) {
      const f = this.yF[q], st = f < 1500 ? 1 : f < 4000 ? (eco ? 3 : 2) : (eco ? 8 : 4);
      if (st === 1 || q % st === 0) { keep.push(q); stride.push(st); }
    }
    const nr = keep.length;
    const B = { nr, nLow: 0, b0: new Float64Array(nr), a1: new Float64Array(nr), a2: new Float64Array(nr), z1: new Float64Array(nr), z2: new Float64Array(nr),
      pz: new Float64Array(nr), pp: new Float64Array(nr), pb: new Float64Array(nr), pu: new Float64Array(nr),
      lowW: null, hw: new Float64Array(nr), hreg: new Int32Array(nr), ew: new Float64Array(nr) };
    let nLow = 0; for (let q = 0; q < nr; q++) if (this.yF[keep[q]] < 1200) nLow = q + 1;
    B.nLow = nLow; B.lowW = new Float64Array(nLow * 7);
    for (let q = 0; q < nr; q++) {
      const u = keep[q], k = use[u], f = pot.f[k], Q = pot.Q[k];
      const w = TAU * Math.min(f, sr * 0.45) / sr, al = Math.sin(w) / (2 * Q), a0 = 1 + al;
      B.b0[q] = al / a0; B.a1[q] = -2 * Math.cos(w) / a0; B.a2[q] = (1 - al) / a0;
      // normalized bandpass x Q / w = modal velocity per unit generalized force (mass-normalized modes)
      const vel = Q / (TAU * f) * Math.sqrt(stride[q]) * (stride[q] > 1 ? 1.15 : 1);
      B.pz[q] = pot.P[k][0]; B.pp[q] = pot.P[k][1]; B.pb[q] = pot.P[k][2]; B.pu[q] = pot.P[k][3];
      const R = pot.R[k];
      if (q < nLow) for (let r = 0; r < 7; r++) B.lowW[q * 7 + r] = R[r] * vel;
      else {
        let best = 0, s2 = 0; for (let r = 0; r < 7; r++) { s2 += R[r] * R[r]; if (Math.abs(R[r]) > Math.abs(R[best])) best = r; }
        B.hw[q] = Math.sign(R[best] || 1) * Math.sqrt(s2) * 0.8 * vel; B.hreg[q] = best;
      }
      // edge force into the tone ring (summed over ring orders; each ring mode picks its own band)
      let e = 0; const E = pot.E[k]; if (E) for (let m = 2; m < E.length; m++) e += E[m];
      B.ew[q] = e * vel;
    }
    // tone ring: displacement resonators driven by the head's edge force, radiating from the rim
    const ring = pot.ring || [];
    B.rn = ring.length; B.rc1 = new Float64Array(B.rn); B.rc2 = new Float64Array(B.rn); B.rg = new Float64Array(B.rn); B.ry1 = new Float64Array(B.rn); B.ry2 = new Float64Array(B.rn); B.rw = new Float64Array(B.rn);
    ring.forEach((rm, i) => {
      const w = TAU * rm.f / sr, r = Math.exp(-Math.PI * rm.f / rm.Q / sr);
      B.rc1[i] = 2 * r * Math.cos(w); B.rc2[i] = r * r; B.rg[i] = 1 / (rm.m * sr * sr) * 0.05; B.rw[i] = rm.area * sr * 0.02;   // u'' = F/m, velocity out
    });
    this.body = B;
    this.br = pot.bridge;
    this.modeCache = new Map();
    this.retuneAll();
  }
  scaleOf(i) { return i === 0 ? this.P.scale * Math.pow(2, -5 / 12) : this.P.scale; }
  capoOf(i) { return i === 0 ? (this.params.spike | 0) : (this.params.capo | 0); }
  retuneAll() {
    const tun = this.params.tuning;
    for (let i = 0; i < NS; i++) {
      const s = this.strings[i];
      s.open = tun[i] + this.capoOf(i);
      if (!s.v.live) { s.midi = s.open; s.fret = 0; this.loadModes(s.v, i, s.open); }
    }
  }
  // Physical string data for string i at its open (tuned) pitch over its own full length
  stringPhys(i) {
    const sp = this.P.strings[i];
    const fopen = mtof(this.params.tuning[i]), L = this.scaleOf(i);
    const T = sp.mu * Math.pow(2 * L * fopen, 2);
    return Object.assign({}, sp, { T, fopen });
  }
  setupLongitudinal(s, midi) {
    const ph = this.stringPhys(s.idx), sr = this.sr;
    const L = this.scaleOf(s.idx) * Math.pow(2, -(midi - this.params.tuning[s.idx]) / 12);
    const cL = Math.sqrt(ph.EA / ph.mu), f1 = cL / (2 * L);
    s.lonN = 0;
    for (let n = 1; n <= 4; n++) {
      const f = n * f1; if (f > sr * 0.42) break;
      const r = Math.exp(-Math.PI * f / (this.P.lonQ || 300) / sr);
      s.lonC1[n - 1] = 2 * r * Math.cos(TAU * f / sr); s.lonC2[n - 1] = r * r; s.lonN = n;
      s.lonIn[n - 1] = (1 - r) / n;
    }
    s.lonG = (this.P.lonGain || 0) * (ph.wound ? 1 : 0.35);
    s.lonT = ph.T; s.lonEA = ph.EA;
  }
  // 2x2 bridge admittance seen by string s
  potY(s, w, out) {
    const ys = this.br.y[s], cs = this.br.chi[s], F = this.yF, Qa = this.yQ, Pa = this.yP;
    let yyR = 0, yyI = 0, yzR = 0, yzI = 0, zzR = 0, zzI = 0;
    const w2 = w * w;
    for (let k = 0; k < this.yN; k++) {
      const wk = TAU * F[k], o = k * 4;
      const pz = Pa[o] + ys * Pa[o + 1] + cs * Pa[o + 2], py = Pa[o + 3];
      const re = wk * wk - w2, im = w * wk / Qa[k], den = re * re + im * im;
      const yr = (w * im) / den, yi = (w * re) / den;
      zzR += yr * pz * pz; zzI += yi * pz * pz; yyR += yr * py * py; yyI += yi * py * py; yzR += yr * py * pz; yzI += yi * py * pz;
    }
    out[0] = yyR; out[1] = yyI; out[2] = yzR; out[3] = yzI; out[4] = zzR; out[5] = zzI;
    return out;
  }
  loadModes(v, i, midi) {
    const key = i + ':' + midi.toFixed(3) + ':' + this.params.tuning[i] + ':' + this.params.brightness;
    let M = this.modeCache.get(key);
    if (!M) { M = this.computeModes(i, midi); if (this.modeCache.size > 400) this.modeCache.clear(); this.modeCache.set(key, M); }
    const n = M.n;
    v.n = n; v.L = M.L; v.T = M.T; v.EA = M.EA; v.midi = midi;
    v.k.set(M.k.subarray(0, n)); v.w.set(M.w.subarray(0, n)); v.sig.set(M.sig.subarray(0, n));
    v.vy.set(M.vy.subarray(0, n)); v.vz.set(M.vz.subarray(0, n));
    v.wy.set(M.wy.subarray(0, n)); v.wz.set(M.wz.subarray(0, n)); v.gin.set(M.gin.subarray(0, n)); v.single.set(M.single.subarray(0, n));
    v.y1.fill(0, 0, n); v.y2.fill(0, 0, n);
    v.shift = 0; v.extra = 0; v.extraTarget = 0; v.appliedExtra = -1; v.detune = 0; v.appliedDetune = 0;
    v.nact = 0; v.energy = 0;
    this.updateCoefs(v, true);
    this.setupLongitudinal(this.strings[i], midi);
  }
  computeModes(i, midi) {
    const P = this.P, sr = this.sr, ph = this.stringPhys(i);
    const fret = midi - this.params.tuning[i];
    const L = this.scaleOf(i) * Math.pow(2, -fret / 12);
    const f0 = mtof(midi), T = ph.T;
    const B = Math.PI * Math.PI * ph.EI / (T * L * L);
    const fmax = Math.min(sr * 0.45, this.params.quality === 'eco' ? 8000 : 12000);
    const out = { n: 0, L, T, EA: ph.EA, B, f0, k: new Int32Array(MAXC), w: new Float64Array(MAXC), sig: new Float64Array(MAXC),
      vy: new Float64Array(MAXC), vz: new Float64Array(MAXC), wy: new Float64Array(MAXC), wz: new Float64Array(MAXC), gin: new Float64Array(MAXC), single: new Uint8Array(MAXC) };
    const br = this.params.brightness, age = Math.max(0, Math.min(1, 1 - br));
    const etaB = ph.etaBn * Math.pow(ph.etaBu / ph.etaBn, age);
    const Y = this.Ybuf;
    const fretted = fret - this.capoOf(i) > 0.5;
    const pd = P.polDetune || 0, D = P.damp;
    let c = 0;
    for (let k = 1; c < MAXC - 1; k++) {
      const f = k * f0 * Math.sqrt(1 + B * k * k);
      if (f > fmax) break;
      const w = TAU * f;
      const kk = k * Math.PI / L, bend = ph.EI * kk * kk;
      const etaF = ph.wound ? ph.etaF : Math.max(ph.etaF, (P.plainEtaF || 0) * (0.6 + 0.8 * age));
      const eta = (T * (etaF + (P.airScale ?? 1) * ph.etaA / w) + bend * etaB) / (T + bend);
      let sInt = w * eta / 2;
      if (fretted) sInt += D.fretted * (1 + f / 2000);
      this.potY(i, w, Y);
      const s = -T / L;
      const aR = s * Y[0], aI = s * Y[1], bR = s * Y[2], bI = s * Y[3], dR = s * Y[4], dI = s * Y[5] + pd * w;
      const hR = (aR - dR) / 2, hI = (aI - dI) / 2;
      const qR = hR * hR - hI * hI + bR * bR - bI * bI, qI = 2 * hR * hI + 2 * bR * bI;
      const mag = Math.sqrt(Math.hypot(qR, qI)), ang = Math.atan2(qI, qR) / 2;
      const rR = mag * Math.cos(ang), rI = mag * Math.sin(ang);
      const mR = (aR + dR) / 2, mI = (aI + dI) / 2;
      const lam = [[mR + rR, mI + rI], [mR - rR, mI - rI]];
      const single = f > 2500;
      const jOrder = single ? (lam[0][0] > lam[1][0] ? [0] : [1]) : [0, 1];
      for (const j of jOrder) {
        const lR = lam[j][0], lI = Math.max(-0.08 * w, Math.min(0.08 * w, lam[j][1]));
        let e1R = bR, e1I = bI, e2R = lR - aR, e2I = lI - aI;
        const n1 = e1R * e1R + e1I * e1I + e2R * e2R + e2I * e2I;
        const f1R = lR - dR, f1I = lI - dI;
        const n2 = f1R * f1R + f1I * f1I + bR * bR + bI * bI;
        if (n2 > n1) { e1R = f1R; e1I = f1I; e2R = bR; e2I = bI; }
        if (Math.max(n1, n2) < 1e-40) { e1R = j === 0 ? 1 : 0; e2R = j === 0 ? 0 : 1; e1I = e2I = 0; }
        const dom = Math.hypot(e1R, e1I) >= Math.hypot(e2R, e2I) ? [e1R, e1I] : [e2R, e2I];
        const ph2 = -Math.atan2(dom[1], dom[0]), cr = Math.cos(ph2), ci = Math.sin(ph2);
        let vy = e1R * cr - e1I * ci, vz = e2R * cr - e2I * ci;
        const nn = Math.hypot(vy, vz) || 1; vy /= nn; vz /= nn;
        out.k[c] = k; out.w[c] = w + lI; out.sig[c] = Math.max(0.02, sInt - lR);
        out.vy[c] = vy; out.vz[c] = vz;
        const Fk = T * k * Math.PI / L;
        out.wy[c] = Fk * vy; out.wz[c] = Fk * vz;
        out.gin[c] = 2 * w * w / (k * Math.PI) / (sr * sr) * vz * (k % 2 ? 1 : -1);
        out.single[c] = single ? 1 : 0;
        if (single) { out.vy[c] = Math.SQRT1_2; out.vz[c] = Math.SQRT1_2; out.wy[c] = Fk * Math.SQRT1_2; out.wz[c] = Fk * Math.SQRT1_2; }
        c++;
      }
    }
    out.n = c;
    return out;
  }
  updateCoefs(v, force) {
    if (!force && Math.abs(v.detune - v.appliedDetune) < 2e-6 && Math.abs(v.extra - v.appliedExtra) < 0.05) return;
    const sr = this.sr, bendR = this.bend === 0 ? 1 : Math.pow(2, this.bend / 12);
    const sh = (v.shift || 0) + (v.vibShift || 0) + (v.bendShift || 0);
    const dt = (1 + v.detune) * bendR * (sh ? Math.pow(2, sh / 12) : 1);
    const ex = v.extra;
    for (let c = 0; c < v.n; c++) {
      const f = v.w[c] / TAU;
      const sig = v.sig[c] + ex * (0.35 + f / 1000);
      const r = v.w[c] * dt < 0.92 * Math.PI * sr ? Math.exp(-sig / sr) : 0;
      v.c1[c] = 2 * r * Math.cos(v.w[c] * dt / sr);
      v.c2[c] = r * r;
    }
    v.appliedDetune = v.detune; v.appliedExtra = ex; v.appliedBend = this.bend;
  }

  // ---------- events ----------
  post(ev) {
    ev = Object.assign({}, ev);
    const at = ev.t == null ? this.clock : Math.max(this.clock, Math.round(ev.t * this.sr));
    ev._at = at;
    const q = this.queue; let i = q.length;
    while (i > 0 && q[i - 1]._at > at) i--;
    q.splice(i, 0, ev);
  }
  post2(ev) { const q = this.queue; let i = q.length; while (i > 0 && q[i - 1]._at > ev._at) i--; q.splice(i, 0, ev); }
  pickFor(style, ev) {
    const pk = this.params.pick || {};
    if (ev && ev.pickType) return PICKS[ev.pickType] || PICKS.cell71;
    return style === 'tpick' ? (PICKS[pk.thumb] || PICKS.thumbM) : (PICKS[pk.finger] || PICKS.ns025);
  }
  // a pick slides along the string for a few ms before it slips off; returns that lead time in samples
  preScrape(ev) {
    const style = ev.style || 'fpick';
    const vel = Math.max(0.02, Math.min(1, ev.vel == null ? 0.7 : ev.vel));
    const isPick = style === 'fpick' || style === 'tpick';
    const pre = Math.round((isPick ? 0.002 : style === 'nail' ? 0.0006 : 0.0012) * this.sr);
    const wound = this.P.strings[ev.s] && this.P.strings[ev.s].wound;
    let scr = 1;
    if (isPick) { const pk = this.pickFor(style, ev); scr = (pk.mu * pk.scrape) / (PICKS.cell71.mu * PICKS.cell71.scrape); }
    const amt = this.params.noise * vel * (isPick ? 0.10 * Math.min(4, scr) : style === 'nail' ? 0.06 : 0.03) * (wound ? 1 : 0.5);
    if (amt <= 0) return pre;
    const start = this.clock & this.RMASK;
    let p1 = 0, p2 = 0;
    for (let i = 0; i < pre; i++) {
      const r = this.rng() * 2 - 1, hp = r - 2 * p1 + p2; p2 = p1; p1 = r;
      this.bodyIn[(start + i) & this.RMASK] += hp * amt * (i / pre);
    }
    return pre;
  }
  handle(ev) {
    switch (ev.type) {
      case 'pluck':
        if (!ev._staged) { ev._staged = true; const pre = this.preScrape(ev); if (pre > 0) { ev.t = null; ev._at = this.clock + pre; this.post2(ev); break; } }
        this.pluck(ev); break;
      case 'damp': this.dampString(ev); break;
      case 'touch': this.touchString(ev); break;
      case 'untouch': { const st = this.strings[ev.s]; if (st && st.touchId === ev.id) for (const v of st.voices) { v.extraTarget = 0; v.extraRate = 0.25; } break; }
      case 'tap': this.tap(ev); break;
      case 'sbend': { const st = this.strings[ev.s]; if (st) st.sbend = { at: this.clock + Math.round((ev.delay || 0) * this.sr), amount: ev.amount ?? 1, rise: ev.rise || 0.12, release: ev.release }; break; }
      case 'bendTo': { const st = this.strings[ev.s]; if (st) { st.sbend = null; st.v.bendShift = ev.amount || 0; this.updateCoefs(st.v, true); } break; }
      case 'vibrato': { const st = this.strings[ev.s]; if (st) st.vib = { at: this.clock + Math.round((ev.delay || 0) * this.sr), rate: ev.rate || 5.5, depth: ev.depth ?? 0.4, dur: ev.dur || 0.6, attack: ev.attack || 0.12, jit: (this.rng() - 0.5) * 0.6 }; break; }
      case 'palm':
        for (const st of this.strings) for (const v of st.voices) {
          if (ev.on) { if (v.extraTarget < 9) { v.extraTarget = 9; v.extraRate = 0.5; v.palmed = true; } }
          else if (v.palmed) { v.palmed = false; if (v.extraTarget === 9) { v.extraTarget = 0; v.extraRate = 0.3; } }
        }
        break;
      case 'friction': this.friction(ev); break;
      case 'glide': this.glide(ev); break;
      case 'hammer': this.legatoNote(ev, true); break;
      case 'pulloff': this.legatoNote(ev, false); break;
      case 'fretstep': this.fretStep(ev); break;
      case 'bend': this.bendTarget = ev.value; break;
      case 'params': this.setParams(ev.params); break;
      case 'pot': this.installPot(ev.pot); break;
      case 'allOff': for (const s of this.strings) this.dampString({ s: s.idx, time: 0.08 }); break;
      case 'panic': for (const s of this.strings) for (const v of s.voices) { v.y1.fill(0); v.y2.fill(0); v.nact = 0; v.live = false; } this.bodyReset(); break;
    }
  }

  // ---------- plucks ----------
  // styles: 'fpick' metal (or plastic) fingerpick, 'tpick' thumbpick, 'flesh' bare finger, 'tflesh' bare thumb,
  // 'nail' the back of the fingernail striking down (clawhammer / frailing), 'brushnail' a nail sweeping several strings.
  pluck(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const sr = this.sr;
    const vel = Math.max(0.02, Math.min(1, ev.vel == null ? 0.7 : ev.vel));
    const midi = ev.midi == null ? s.open : ev.midi;
    let v = s.v;
    if (Math.abs(midi - v.midi) > 0.01 || !v.n) {
      const old = v;
      old.extraTarget = Math.max(old.extraTarget, 70); old.extraRate = 0.5; old.extra = Math.max(old.extra, 25);
      this.updateCoefs(old, true);
      s.cur = this.quietestVoice(s); v = s.v;
      this.loadModes(v, ev.s, midi);
    } else {
      // the pick or nail lands on a ringing string and stops part of its motion; a sweeping nail only skims it
      const style0 = ev.style || 'fpick';
      const kc = ev.keep ?? (style0 === 'brushnail' ? 0.85 : style0 === 'fpick' || style0 === 'tpick' ? 0.55 - 0.3 * vel : 0.5 - 0.3 * vel);
      for (let c = 0; c < v.n; c++) { v.y1[c] *= kc; v.y2[c] *= kc; }
    }
    s.midi = midi; s.fret = Math.round(midi - s.open);
    s.releaseAt = -1; v.bendShift = 0; v.vibShift = 0;
    if (s.sbend && s.sbend.at <= this.clock) s.sbend = null;
    if (s.vib && s.vib.at <= this.clock) s.vib = null;
    v.live = true;
    if (ev.dead) { v.extraTarget = 140; v.extra = 140; v.extraRate = 1; }
    else if (ev.palm) { v.extraTarget = 9; v.extra = 9; v.extraRate = 1; }
    else { v.extraTarget = 0; v.extra = Math.min(v.extra, 2); v.extraRate = 0.3; }
    this.updateCoefs(v, true);

    const style = ev.style || 'fpick';
    const isPick = style === 'fpick' || style === 'tpick';
    const dir = ev.dir < 0 ? -1 : 1;
    const L = v.L, Lfull = this.P.scale;
    const pickPos = (ev.pickPos == null ? 0.08 : ev.pickPos) * Lfull * (1 + (this.rng() - 0.5) * 0.08);
    const xp = Math.max(0.02 * L, Math.min(0.5 * L, pickPos));
    // string displacement at release: plucks pull ~0.3-3.5 mm; the striking nail pushes less but adds momentum
    let h = (0.0003 + 0.0030 * Math.pow(vel, 1.3)) * (ev.dead ? 0.5 : 1);
    const br = this.params.brightness;
    let tau, width, theta, pm = null, strike = 0;
    if (isPick) {
      tau = 1.4e-4 * (1.5 - vel) * (1.3 - 0.6 * br); width = 0.0012;
      // fingers pull the strings up and a little away from the head; the thumb pushes down and slightly into it
      theta = style === 'fpick' ? 0.32 + 0.14 * this.rng() : 0.38 + 0.14 * this.rng();
      const pc = Object.assign({}, PICK_REF, { angle: (this.params.pick || {}).angle ?? 20 });
      const pk = this.pickFor(style, ev), T = v.T;
      pm = pickModel(pk, T, L, xp, vel, pc.angle, 'normal', null);
      const p0 = pickModel(PICKS.cell71, T, L, xp, vel, PICK_REF.angle, PICK_REF.grip);
      pm.rel = { d: pm.d / p0.d, tau: pm.tau / p0.tau, width: pm.width / p0.width, alpha: pm.alpha - p0.alpha,
        click: pm.click / p0.click, scrape: pm.scrape / p0.scrape, hard: pm.hard / p0.hard };
      tau *= Math.min(12, Math.max(0.1, pm.rel.tau));
      width *= pm.rel.width;
      theta = Math.min(1.2, Math.max(0.05, theta + 0.5 * pm.rel.alpha));
    }
    else if (style === 'tflesh') { tau = 1.0e-3 * (1.4 - 0.6 * vel); width = 0.012; theta = 0.5 + 0.2 * this.rng(); }
    else if (style === 'nail' || style === 'brushnail') {
      // clawhammer: the back of the nail falls through the string toward the head. Short hard contact (keratin),
      // mostly normal to the head, and part of the excitation is the nail's momentum (velocity-like: brighter, 1/k)
      tau = (style === 'brushnail' ? 5e-4 : 3.5e-4) * (1.35 - 0.5 * vel); width = 0.003;
      theta = (style === 'brushnail' ? 0.75 : 0.95) + 0.2 * this.rng();
      strike = style === 'brushnail' ? 0.25 : 0.45;
      h *= style === 'brushnail' ? 0.75 : 1.15;
    }
    else { tau = 6e-4 * (1.4 - 0.6 * vel); width = 0.008; theta = 0.6 + 0.25 * this.rng(); }
    if (pm) h *= Math.min(2, Math.max(0.3, pm.rel.d));
    if (ev.bright != null) tau /= Math.max(0.2, ev.bright);
    if (ev.dead) tau *= 2;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const base = 2 * h * L * L / (Math.PI * Math.PI * xp * (L - xp)) * dir;
    // velocity part: an impulse I at xp gives mode k velocity 2 I sin(k pi x / L) / (mu L); expressed as an equal-energy
    // share of the pluck, scaled so its first mode matches the displacement part's
    for (let c = 0; c < v.n;) {
      const k = v.k[c];
      const sk = Math.sin(k * Math.PI * xp / L);
      let a = base * sk / (k * k);
      const sx = k * width / (2 * L);
      const sinc = sx > 1e-6 ? Math.sin(Math.PI * sx) / (Math.PI * sx) : 1;
      a *= sinc;
      const x = v.w[c] * tau / 2.2, lp = 1 / Math.sqrt(1 + x * x * x * x);
      a *= lp;
      // struck share: amplitude ~ 1/k rather than 1/k^2, started in sine phase
      const as = strike ? base * strike * sk / k * sinc * lp * 0.35 : 0;
      if (v.single[c]) { this.addOsc(v, c, a * (1 - strike * 0.5)); if (as) this.addOscSin(v, c, as); c += 1; continue; }
      const y1 = v.vy[c], z1 = v.vz[c], y2 = v.vy[c + 1], z2 = v.vz[c + 1];
      const det = y1 * z2 - y2 * z1;
      let p1, p2;
      if (Math.abs(det) > 1e-6) { p1 = (ct * z2 - st * y2) / det; p2 = (st * y1 - ct * z1) / det; }
      else { p1 = ct * y1 + st * z1; p2 = 0; }
      const ad = a * (1 - strike * 0.5);
      this.addOsc(v, c, ad * p1); this.addOsc(v, c + 1, ad * p2);
      if (as) { this.addOscSin(v, c, as * p1); this.addOscSin(v, c + 1, as * p2); }
      c += 2;
    }
    this.rebuildActive(v);
    // the bridge load the pick held is released (a step of -F_static into the head) - or, for a nail, the knock of it
    const Fs = v.T * h / xp * dir;
    this.staticZ -= Fs * st; this.staticY -= Fs * ct;
    const nAmt = this.params.noise * vel * (isPick ? 0.4 * Math.min(4, pm ? Math.sqrt(pm.rel.scrape) * pm.rel.hard : 1) : style === 'nail' || style === 'brushnail' ? 0.3 : 0.12) * (ev.dead ? 2 : 1);
    if (nAmt > 0) {
      const start = this.clock & this.RMASK, nl = Math.round(0.004 * sr);
      const wound = this.P.strings[ev.s].wound;
      let p1 = 0, p2 = 0;
      for (let i = 0; i < nl; i++) {
        const r = this.rng() * 2 - 1, hp = r - 2 * p1 + p2; p2 = p1; p1 = r;
        this.bodyIn[(start + i) & this.RMASK] += hp * nAmt * Math.exp(-i / (0.0009 * sr)) * (wound ? 1 : 0.6);
      }
      // metal fingerpicks ring briefly as they spring off: a decaying tick at the blade's cantilever frequency
      if (pm && pm.click > 0) {
        const f = Math.min(0.42 * sr, pm.fp), rel = Math.min(10, pm.rel.click);
        const amp = this.params.noise * vel * 0.006 * rel, dec = Math.max(0.0004, Math.min(0.03, pm.decay));
        const n2 = Math.min(this.RING - 64, Math.round(dec * 5 * sr)), w = TAU * f / sr, pan = (2 - ev.s) / 8;
        for (let i = 0; i < n2; i++) {
          const val = amp * Math.sin(w * i) * Math.exp(-i / (dec * sr)) * Math.min(1, i / 6);
          this.dirL[(start + i) & this.RMASK] += val * (1 - pan); this.dirR[(start + i) & this.RMASK] += val * (1 + pan);
        }
      }
    }
  }
  quietestVoice(s) {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < s.voices.length; i++) {
      if (i === s.cur) continue;
      const v = s.voices[i]; let e = 0;
      for (let q = 0; q < v.nact; q++) { const c = v.act[q]; e += v.y1[c] * v.y1[c] + v.y2[c] * v.y2[c]; }
      if (e < bestE) { bestE = e; best = i; }
    }
    return best;
  }
  addOsc(v, c, a) {
    if (a === 0) return;
    const r = Math.sqrt(v.c2[c]), cw = v.c1[c] / (2 * r);
    v.y1[c] += a; v.y2[c] += a * cw / r;
  }
  // start a component in sine phase (struck: zero displacement, initial velocity)
  addOscSin(v, c, a) {
    if (a === 0) return;
    const r = Math.sqrt(v.c2[c]), cw = Math.max(-1, Math.min(1, v.c1[c] / (2 * r))), sw = Math.sqrt(1 - cw * cw);
    // x(n) = a r^n sin(n w): x(-1) = -a sin(w) / r, x(-2) = -a sin(2w) / r^2
    v.y1[c] += -a * sw / r; v.y2[c] += -a * 2 * sw * cw / (r * r);
  }
  rebuildActive(v) {
    let n = 0;
    for (let c = 0; c < v.n; c++) { const y1 = v.y1[c], y2 = v.y2[c]; if (y1 * y1 + y2 * y2 > 2e-15) v.act[n++] = c; }
    v.nact = n;
  }
  touchString(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const amt = ev.amt == null ? 30 : ev.amt, dur = ev.dur == null ? 0.08 : ev.dur;
    s.touchId = (s.touchId || 0) + 1;
    for (const v of s.voices) { v.extraTarget = Math.max(v.extraTarget, amt); v.extraRate = 0.6; }
    this.post2({ type: 'untouch', s: ev.s, id: s.touchId, _at: this.clock + Math.round(dur * this.sr), _staged: true });
    const na = this.params.noise * 0.02 * Math.min(1, s.env * 10 + 0.15) * (ev.nail ? 1.6 : 1);
    if (na > 1e-4) {
      const at = this.clock & this.RMASK; let p = 0;
      for (let k = 0; k < 240; k++) { const r = this.rng() * 2 - 1; this.bodyIn[(at + k) & this.RMASK] += (r - p) * na * Math.exp(-k / 50); p = r; }
    }
  }

  // ---------- the fretting hand's own sounds ----------
  // A finger pad sliding along a string, simulated as contact mechanics rather than played as a sound:
  //  - the string's surface: on a wound string, a corrugation of round wrap wires (pitch = wire diameter), with a
  //    little wire-to-wire variation and wear that stay put along the string; on any string, micro-roughness;
  //  - the pad touches the string only along its fingerprint ridges (~0.46 mm apart, Scheibert et al. 2009), which
  //    cross the string at an angle, spread over a 5-8 mm contact, loaded most in the middle (elliptical pressure);
  //  - each ridge is a small viscoelastic finger of skin: normally it presses into the corrugation but can't follow
  //    it quickly (a lowpass of the skin's own stiffness and damping); tangentially it is a spring-mass that sticks
  //    to the string until the force exceeds static friction, then slips with kinetic friction, and climbing a wire
  //    pushes back on it;
  //  - the hand moves on a minimum-jerk path (Flash & Hogan 1985) with physiological tremor (8-12 Hz) in its
  //    position and pressure.
  // The forces of all ridges are summed. Because ridges and wires are spaced differently, their contributions
  // partly cancel and partly beat, and stick-slip makes each crossing different: a rough rub whose pitch follows the
  // speed, as Pakarinen, Penttinen & Bank (2007) measured, rather than a clean buzz. The axial force drives the
  // string's longitudinal modes (and so the bridge, body, mics and room); the fluctuating pressure into the string
  // pushes on the bridge transversally. Gestures run block by block inside the render loop.
  // ev: s, x0, x1 (m from the nut), dur (s, whole movement), seg [from, to] (part rendered), p0, p1 (pressure 0..1).
  friction(ev) {
    const st = this.strings[ev.s]; if (!st) return;
    const sr = this.sr, ph = this.P.strings[ev.s], rng = () => this.rng();
    const wound = !!ph.wound;
    const seg = ev.seg || [0, 1], dur = Math.max(0.02, ev.dur || 0.15);
    const n = Math.round(dur * (seg[1] - seg[0]) * sr);
    const amt = this.params.noise * (ev.amt ?? 1);
    if (n < 8 || this.params.noise <= 0) return;
    const pw = WIND_PITCH[ev.s] || 0;
    // the winding's profile over one wire, as a lookup table: round wires side by side, seen through a ridge's
    // ~0.18 mm contact width (which smooths the corrugation: Fourier terms times sinc(n w / p))
    const TB = 256, prof = new Float64Array(TB + 1), slope = new Float64Array(TB + 1);
    if (wound) {
      const rw = pw / 2, wr = 0.18e-3, c = [0.42, -0.09, 0.04];
      for (let i = 0; i <= TB; i++) {
        const u = i / TB; let h = 0, d = 0;
        for (let m = 1; m <= 3; m++) {
          const z = Math.PI * m * wr / pw, sc = Math.abs(Math.sin(z) / z), b = rw * c[m - 1] * sc;
          h += b * Math.cos(TAU * m * (u - 0.5)); d += -b * TAU * m / pw * Math.sin(TAU * m * (u - 0.5));
        }
        prof[i] = h; slope[i] = d;
      }
    }
    // the pad: contact length grows with load; ridges at their spacing along the string, slightly irregular
    const pMean = Math.max(0.05, ((ev.p0 ?? 0.5) + (ev.p1 ?? 0.5)) / 2);
    const a = 0.005 + 0.003 * Math.cbrt(pMean), lamS = 0.46e-3 * (0.95 + 0.1 * rng()) / Math.sin((50 + 40 * rng()) * Math.PI / 180);
    const ridges = [];
    for (let o = -a / 2 + lamS * rng(); o < a / 2; o += lamS * (0.92 + 0.16 * rng())) {
      const w = Math.sqrt(Math.max(0, 1 - (2 * o / a) ** 2));
      const fr = FINGER.ridgeHz * (0.8 + 0.4 * rng()), kt = 160, mt = kt / (TAU * fr) ** 2;
      ridges.push({ o, w, kt, mt, ct: 2 * (FRIC_MU[3] ?? 0.8) * Math.sqrt(kt * mt), y: 0, vy: 0, stick: true, h1: 0, h2: 0 });
    }
    // Light CPU mode: at most 6 ridges, each standing for the ones it replaces (same total contact force)
    if (this.params.cpu !== 'full' && ridges.length > 6) {
      const keep = []; const step = ridges.length / 6;
      for (let q = 0; q < 6; q++) { const r = ridges[Math.floor(q * step + step / 2)]; r.w *= step; keep.push(r); }
      ridges.length = 0; ridges.push(...keep);
    }
    const wsum = ridges.reduce((t, r) => t + r.w, 0) || 1;
    for (const r of ridges) r.w /= wsum;
    if (!this.fric) this.fric = [];
    this.fric.push({ s: ev.s, n, k: 0, seg, dur, x0: ev.x0 ?? 0.03, dx: (ev.x1 ?? 0.08) - (ev.x0 ?? 0.03),
      p0: ev.p0 ?? 0.5, p1: ev.p1 ?? 0.5, amt, wound, pw, prof, slope, ridges, gam: ev.gam || 1,
      wearSeed: (ev.s + 1) * 7919, trF: 8 + 4 * rng(), trP: rng() * TAU, trA: 15e-6 + 25e-6 * rng(),
      // a corrective sub-movement near the end of the reach (Meyer et al. 1988), and the skin's grab-and-give
      subA: (rng() - 0.3) * 0.06, subC: 0.78 + 0.12 * rng(), vn: 0, vn2: 0, vnC: 1 - Math.exp(-TAU * 35 / (2 * sr)),
      scale: this.scaleOf(ev.s),
      fc: 1 - Math.exp(-TAU * FINGER.skinHz * (0.8 + 0.4 * rng()) / sr), hpA: 0, hpN: 0, xA: 0, xN: 0, delta: FINGER.delta * (0.7 + 0.6 * rng()),
      pan: (2 - ev.s) / 10 });
  }
  // wear and wire-to-wire variation, fixed along each string (smoothly interpolated between wraps)
  wear(seed, k) { const h = (x) => { let t = (x * 374761393 + seed * 668265263) | 0; t = (t ^ (t >>> 13)) * 1274126177 | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; return 0.82 + 0.33 * h(k); }
  runFriction(nBlock) {
    // live modulation (smoothed per block): fingerAmt scales the level; fingerPress scales how hard the finger
    // presses the string, which changes the contact itself (more ridges catch, grittier and louder)
    const P = this.params;
    this.fAmt = (this.fAmt ?? 1) + ((P.fingerAmt ?? 1) - (this.fAmt ?? 1)) * 0.25;
    this.fPress = (this.fPress ?? 1) + ((P.fingerPress ?? 1) - (this.fPress ?? 1)) * 0.25;
    const lvl = this.fAmt, prs = this.fPress;
    const sr = this.sr, OS = 1, dt = 1 / (sr * OS), t0 = this.clock;   // ridges are heavily damped: stable at the audio rate
    const muS = FRIC_MU[0], muK = FRIC_MU[1], vS = FRIC_MU[2];   // skin on metal: small static-kinetic gap, Stribeck speed
    for (let g = this.fric.length - 1; g >= 0; g--) {
      const G = this.fric[g], ext = this.lonExt[G.s];
      const cnt = Math.min(nBlock, G.n - G.k);
      for (let i = 0; i < cnt; i++, G.k++) {
        let Fax = 0, Fn = 0;
        for (let q = 0; q < OS; q++) {
          const u = (G.k + q / OS) / G.n, tau = G.seg[0] + (G.seg[1] - G.seg[0]) * u, tt = (G.k + q / OS) / sr;
          // minimum-jerk path plus tremor
          const tw = G.gam === 1 ? tau : Math.pow(tau, G.gam), dw = G.gam === 1 ? 1 : G.gam * Math.pow(Math.max(1e-6, tau), G.gam - 1);
          const sm = 10 * tw ** 3 - 15 * tw ** 4 + 6 * tw ** 5, dsm = 30 * tw * tw * (1 - tw) * (1 - tw) * dw;
          const trem = Math.sin(TAU * G.trF * tt + G.trP);
          const zb = (tau - G.subC) / 0.12, bump = Math.exp(-zb * zb), dbump = -2 * zb / 0.12 * bump;
          G.vn += ((this.rng() * 2 - 1) - G.vn) * G.vnC; G.vn2 += (G.vn - G.vn2) * G.vnC;   // slow speed wobble
          const xf = G.x0 + G.dx * (sm + G.subA * bump) + G.trA * trem;
          const vf = (G.dx * (dsm + G.subA * dbump) / G.dur) * (1 + 2.5 * G.vn2) + G.trA * TAU * G.trF * Math.cos(TAU * G.trF * tt + G.trP);
          const press = (G.p0 + (G.p1 - G.p0) * u) * (1 + 0.06 * trem) * prs;
          const N0 = 0.1 + 1.8 * Math.max(0, press);                  // total normal force, N
          const d0 = 1.5e-4 * Math.cbrt(Math.max(0.02, press));       // skin indentation, m
          // nearest fret wire to the finger (worn patches of winding sit there)
          const fn = Math.round(Math.log2(G.scale / Math.max(1e-3, G.scale - xf)) * 12);
          const fxw = fn >= 1 && fn <= 9 ? G.scale * (1 - Math.pow(2, -fn / 12)) : -1, wd = 0.75 - 0.06 * fn;
          for (const r of G.ridges) {
            const xs = xf + r.o + r.y;
            // surface height and slope under this ridge (corrugation x wear, plus micro-roughness)
            let h = 0, hp = 0;
            if (G.wound) {
              const pos = xs / G.pw, kk = Math.floor(pos), fr = pos - kk, ti = fr * 256, i0 = ti | 0, f = ti - i0;
              let wv = this.wear(G.wearSeed, kk) + (this.wear(G.wearSeed, kk + 1) - this.wear(G.wearSeed, kk)) * fr;
              // the winding is worn flat where the strings are pressed onto the frets (most on the first frets)
              if (fxw > 0) { const dfx = (xs - fxw) / 1.5e-3; if (dfx > -4 && dfx < 4) wv *= 1 - wd * Math.exp(-dfx * dfx); }
              h = (G.prof[i0] + (G.prof[i0 + 1] - G.prof[i0]) * f) * wv;
              hp = (G.slope[i0] + (G.slope[i0 + 1] - G.slope[i0]) * f) * wv;
            }
            const rk = Math.floor(xs / 4e-5), rf = xs / 4e-5 - rk, ra = this.wear(G.wearSeed + 31, rk), rb = this.wear(G.wearSeed + 31, rk + 1);
            h += 1.2e-6 * (ra + (rb - ra) * rf - 0.985); hp += 1.2e-6 * (rb - ra) / 4e-5;
            // the skin follows the surface sluggishly
            r.h1 += (h - r.h1) * G.fc; r.h2 += (r.h1 - r.h2) * G.fc;
            const Nj = N0 * r.w * Math.max(0, 1 + r.h2 / d0);
            const Fg = Nj * hp;                                         // a wire's flank pushes back on the ridge
            let Fs;                                                     // force the ridge puts on the string, axially
            if (r.stick) {
              r.vy = -vf; r.y += r.vy * dt;
              const hold = r.kt * r.y + r.ct * r.vy;                    // friction needed to keep the ridge in place
              Fs = -hold;
              if (Math.abs(hold + Fg) > muS * Nj) r.stick = false;
            }
            if (!r.stick) {
              // just broken free (relative speed 0): it moves the way the finger is going
              const vt = vf + r.vy, sg = Math.abs(vt) > 1e-7 ? (vt > 0 ? 1 : -1) : (vf >= 0 ? 1 : -1);
              const mu = muK + (muS - muK) * Math.exp(-((vt / vS) ** 2));
              const Ff = -sg * mu * Nj;
              r.vy += (-r.kt * r.y - r.ct * r.vy - Fg + Ff) / r.mt * dt;
              r.y += r.vy * dt;
              const vt2 = vf + r.vy;
              if (Math.abs(vt) > 1e-7 && vt2 * vt <= 0) { r.stick = true; r.vy = -vf; }
              Fs = Fg - Ff;
            }
            Fax += Fs; Fn += Nj;
          }
        }
        Fax /= OS; Fn /= OS;
        // remove the steady parts (constant drag, constant pressure), keep what fluctuates
        G.hpA = 0.995 * (G.hpA + Fax - G.xA); G.xA = Fax;
        G.hpN = 0.995 * (G.hpN + Fn - G.xN); G.xN = Fn;
        const env = Math.min(1, G.k / 64, (G.n - G.k) / 64);
        const idx = (t0 + i) & this.RMASK, ax = G.hpA * env * G.amt * lvl, nn = G.hpN * env * G.amt * lvl;
        ext[idx] += ax * FRIC_GAIN;
        // the pressing-force fluctuations and the sideways jerk of ridges catching on the helical wraps shake the
        // string transversally at the finger
        this.trExt[G.s][idx] += (nn + FINGER.axSide * ax) * FRIC_NORMAL;   // N
        this.dirL[idx] += ax * FRIC_AIR * (1 - G.pan); this.dirR[idx] += ax * FRIC_AIR * (1 + G.pan);
      }
      this.trOn[G.s] = true; this.trDelta[G.s] = G.delta || 0.004;
      if (G.k >= G.n) { this.fric.splice(g, 1); if (!this.fric.some(x => x.s === G.s)) this.trOn[G.s] = false; }
    }
  }

  // A fretted glide: the finger slides along the string under pressure. The string is stopped by whichever fret
  // lies just ahead of the finger, so the pitch moves in semitone steps as the finger crosses each fret wire, with a
  // little energy lost and a small bump at every crossing. ev: s, from, to (midi), dur (s), pressure.
  glide(ev) {
    const st = this.strings[ev.s]; if (!st) return;
    const v = st.v, L = this.scaleOf(ev.s), sr = this.sr;
    const fretOf = (m) => Math.round(m - st.open);
    const a = fretOf(ev.from ?? st.midi), b = fretOf(ev.to), dur = Math.max(0.04, ev.dur || 0.15);
    if (a === b || a < 0 || b < 0) return;
    const xf = (k) => L * (1 - Math.pow(2, -k / 12));                    // fret wire k, from the nut
    const fingerAt = (k) => k <= 0 ? 0.005 : xf(k) - 0.3 * (xf(k) - xf(k - 1));
    const x0 = fingerAt(a), x1 = fingerAt(b), up = b > a;
    // when does the finger cross each wire? invert the minimum-jerk path numerically
    // minimum-jerk path, time-warped so the hand's peak speed falls at `skew` of the move (0.5 = symmetric)
    const gam = Math.log(0.5) / Math.log(Math.min(0.67, Math.max(0.33, ev.skew ?? 0.5)));
    const pos = (t) => { const tau = Math.pow(t, gam); return x0 + (x1 - x0) * (10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5); };
    const base = v.shift || 0;
    for (let k = up ? a : a - 1; up ? k < b : k >= b; k += up ? 1 : -1) {
      const wire = xf(k);
      let lo = 0, hi = 1;
      for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if ((pos(m) - wire) * (up ? 1 : -1) < 0) lo = m; else hi = m; }
      const newFret = up ? k + 1 : k;
      // the string rolls over the fret wire under a pad several mm wide: the length changes over w / speed, not at
      // once (done in six small steps; an instant jump splatters energy across the spectrum)
      const tw = Math.min(1, Math.max(1e-3, lo)) ** gam, spd = Math.abs(x1 - x0) / dur * 30 * tw * tw * (1 - tw) * (1 - tw) * gam * Math.pow(Math.max(1e-3, lo), gam - 1);
      const tCross = Math.min(0.015, Math.max(0.002, 0.003 / Math.max(0.05, spd)));
      for (let q = 1; q <= 6; q++) {
        const at = this.clock + Math.round((lo * dur + (q / 6 - 0.5) * tCross) * sr);
        this.post2({ type: 'fretstep', s: ev.s, shift: base + newFret - a - (up ? 1 : -1) * (1 - q / 6), midi: st.open + newFret,
          _at: Math.max(this.clock, at), _staged: true, p: ev.pressure ?? 0.8, final: q === 6 });
      }
    }
    // the finger presses as it slides: a touch more damping, and the winding sings under it
    for (const vv of st.voices) { vv.extraTarget = Math.max(vv.extraTarget, 2.5); vv.extraRate = 0.3; }
    this.friction({ s: ev.s, x0, x1, dur, seg: [0, 1], p0: ev.pressure ?? 0.8, p1: ev.pressure ?? 0.8, amt: 0.8, gam });
  }
  // Hammer-on / pull-off. The ringing string keeps its motion and changes length at once (that is the legato).
  //  hammer-on: the fretting finger strikes the string down onto a higher fret: a short, soft (fingertip, ~1.5 ms,
  //    ~8 mm wide) push into the top, right at the new end of the vibrating length, and a knock of the fingertip on
  //    the fretboard that reaches the body through the neck;
  //  pull-off: the finger leaves by plucking the string sideways (along the top) where it was pressing - on the
  //    now-longer string that point is close to the end: a thin, bright pluck.
  // ev: s, from, to (midi), vel
  legatoNote(ev, hammer) {
    const st = this.strings[ev.s]; if (!st) return;
    const v = st.v, vel = Math.max(0.05, Math.min(1, ev.vel ?? 0.6)), P = this.P;
    const fOld = Math.round((ev.from ?? st.midi) - st.open), fNew = Math.round(ev.to - st.open);
    if (fOld === fNew || fNew < 0) return;
    if (!v.n) { this.loadModes(v, ev.s, st.open + fOld); }
    v.shift = (v.shift || 0) + (fNew - fOld);
    st.midi = st.open + fNew; st.fret = fNew; st.releaseAt = -1; v.live = true;
    for (const vv of st.voices) if (vv === v) { vv.extraTarget = 0; vv.extraRate = 0.3; }
    this.updateCoefs(v, true);
    const Ls = this.scaleOf(ev.s) * Math.pow(2, -fNew / 12);                  // the new vibrating length
    const xf = (k) => this.scaleOf(ev.s) * (1 - Math.pow(2, -k / 12));       // fret wire k from the nut
    let d, h, tau, width, theta;
    if (hammer) {
      d = 0.003; h = 0.0006 * Math.pow(vel, 1.2); tau = 0.0015 * (1.3 - 0.5 * vel); width = 0.008; theta = 1.35;
      // the fingertip knocks the fretboard
      const at = this.clock & this.RMASK, n = Math.round(0.003 * this.sr), amp = 0.05 * vel;
      for (let k = 0; k < n; k++) this.bodyIn[(at + k) & this.RMASK] += amp * Math.sin(Math.PI * (k + 0.5) / n);
    } else {
      const fingerX = xf(fOld) - 0.3 * (xf(fOld) - xf(Math.max(0, fOld - 1)));
      d = Math.max(0.004, fingerX - xf(fNew)); h = 0.0021 * Math.pow(vel, 1.1); tau = 0.0005 * (1.3 - 0.5 * vel); width = 0.006; theta = 0.4;
    }
    // excite the voice's modes as a pluck at distance d from the stopping end of the new length
    const L = v.L * Math.pow(2, -(v.shift || 0) / 12), xp = Math.min(0.5 * L, Math.max(0.002, d * L / Ls));
    const ct = Math.cos(theta), sn = Math.sin(theta), dir = this.rng() < 0.5 ? 1 : -1;
    const base = 2 * h * L * L / (Math.PI * Math.PI * xp * (L - xp)) * dir, dt = Math.pow(2, (v.shift || 0) / 12);
    for (let c = 0; c < v.n;) {
      const k = v.k[c];
      let a = base * Math.sin(k * Math.PI * xp / L) / (k * k);
      const sx = k * width / (2 * L); a *= sx > 1e-6 ? Math.sin(Math.PI * sx) / (Math.PI * sx) : 1;
      const x = v.w[c] * dt * tau / 2.2; a /= Math.sqrt(1 + x * x * x * x);
      if (v.single[c]) { this.addOsc(v, c, a); c += 1; continue; }
      const y1 = v.vy[c], z1 = v.vz[c], y2 = v.vy[c + 1], z2 = v.vz[c + 1], det = y1 * z2 - y2 * z1;
      let p1, p2;
      if (Math.abs(det) > 1e-6) { p1 = (ct * z2 - sn * y2) / det; p2 = (sn * y1 - ct * z1) / det; } else { p1 = ct * y1 + sn * z1; p2 = 0; }
      this.addOsc(v, c, a * p1); this.addOsc(v, c + 1, a * p2); c += 2;
    }
    this.rebuildActive(v);
  }

  fretStep(ev) {
    const st = this.strings[ev.s]; if (!st) return;
    const v = st.v;
    v.shift = ev.shift;
    this.updateCoefs(v, true);
    if (!ev.final) return;
    st.midi = ev.midi; st.fret = Math.round(ev.midi - st.open);
    // the string settles on the next fret: a small loss, and a bump into the bridge
    for (let q = 0; q < v.nact; q++) { const c = v.act[q]; v.y1[c] *= 0.94; v.y2[c] *= 0.94; }
    const at = this.clock & this.RMASK, amp = FINGER.bump * (ev.p ?? 0.8) * Math.min(1, st.env * 6 + 0.1);
    for (let k = 0; k < 48; k++) this.bodyIn[(at + k) & this.RMASK] += amp * Math.sin(Math.PI * k / 48) * (this.rng() * 0.6 + 0.7);
  }


  // ---------- per-block control: tension modulation, damping ramps, culling ----------
  control() {
    this.bend += (this.bendTarget - this.bend) * 0.25;
    for (const s of this.strings) {
      // finger vibrato on this string: the fretting finger bends the string and lets it back (pitch moves up from
      // the note, not around it), with the width easing in; a wide, violin-like vibrato needs a scalloped board
      const bd = s.sbend;
      if (bd) {
        const t = (this.clock - bd.at) / this.sr, v = s.v;
        if (t >= 0) {
          const u = Math.min(1, t / bd.rise), sm = u * u * (3 - 2 * u);
          const rel = bd.release != null && t > bd.release ? Math.min(1, (t - bd.release) / bd.rise) : 0;
          v.bendShift = bd.amount * sm * (1 - rel);
          if (rel >= 1) { v.bendShift = 0; s.sbend = null; }
          this.updateCoefs(v, true);
        }
      }
      const vb = s.vib;
      if (vb) {
        const t = (this.clock - vb.at) / this.sr, v = s.v;
        if (t >= vb.dur || v.midi === undefined) { v.vibShift = 0; s.vib = null; this.updateCoefs(v, true); }
        else if (t >= 0) {
          const ramp = Math.min(1, t / vb.attack), fade = Math.min(1, (vb.dur - t) / 0.08);
          const ph = TAU * vb.rate * t + vb.jit * Math.sin(TAU * 0.7 * t);
          v.vibShift = vb.depth * ramp * fade * (0.5 - 0.5 * Math.cos(ph));
          this.updateCoefs(v, true);
        }
      }
      let envSum = 0;
      for (const v of s.voices) {
        if (!v.nact) continue;
        // amplitude of each active component from its two states; tension rises with sum of slope^2
        let slope2 = 0, n = 0;
        const sr = this.sr;
        for (let i = 0; i < v.nact; i++) {
          const c = v.act[i];
          const y1 = v.y1[c], y2 = v.y2[c];
          const r = Math.sqrt(v.c2[c]), cw = v.c1[c] / (2 * r), sw2 = Math.max(1e-6, 1 - cw * cw);
          const yp = y2 * r;
          const a2 = (y1 * y1 + yp * yp - 2 * y1 * yp * cw) / sw2;
          if (a2 > 2e-15) v.act[n++] = c;
          const kk = v.k[c] * Math.PI / v.L;
          slope2 += kk * kk * a2;
        }
        v.nact = n;
        if (!n) { if (v !== s.v) v.live = false; continue; }
        // dT = EA/8 * sum (k pi/L)^2 A^2 ; df/f = dT / 2T
        v.detune = v.EA * slope2 / 8 / (2 * v.T);
        if (v.detune > 0.02) v.detune = 0.02;
        envSum += Math.sqrt(slope2) * v.T;
        if (v.extra !== v.extraTarget) {
          v.extra += (v.extraTarget - v.extra) * v.extraRate;
          if (Math.abs(v.extra - v.extraTarget) < 0.05) v.extra = v.extraTarget;
        }
        const bendChanged = v.appliedBend !== this.bend && Math.abs(this.bend - (v.appliedBend || 0)) > 1e-4;
        this.updateCoefs(v, bendChanged);
      }
      s.env = s.env * 0.7 + 0.3 * envSum * 0.03;
      // finger lifted: string becomes a free open string again
      if (s.releaseAt >= 0 && this.clock >= s.releaseAt) {
        s.releaseAt = -1;
        const v = s.v;
        if (Math.abs(v.midi - s.open) > 0.01) { s.cur = this.quietestVoice(s); this.loadModes(s.v, s.idx, s.open); s.midi = s.open; s.fret = 0; }
        else { v.extraTarget = 0; v.extraRate = 0.2; }
        s.v.live = false;
      }
    }
  }

  // A tap on the head (fingertip or knuckle): a half-sine force pulse into the pot, so its own modes ring. Players tap
  // near the rim to hear the head's pitch when setting tension.
  tap(ev) {
    const sr = this.sr, vel = Math.max(0.05, Math.min(1, ev.vel ?? 0.7));
    const dur = (ev.nail ? 0.0012 : 0.0035) * (1.2 - 0.4 * vel), n = Math.max(4, Math.round(dur * sr));
    const F = (ev.amt ?? 1) * 0.6 * vel, at = this.clock & this.RMASK;
    for (let k = 0; k < n; k++) this.bodyIn[(at + k) & this.RMASK] += F * Math.sin(Math.PI * (k + 0.5) / n);
  }
  dampString(ev) {
    const s = this.strings[ev.s]; if (!s) return;
    const time = ev.time == null ? 0.07 : ev.time;
    for (const v of s.voices) { v.extraTarget = ev.amt ?? 45; v.extraRate = Math.min(1, 128 / (Math.max(0.005, time) * this.sr)); }
    s.releaseAt = this.clock + Math.round((0.45 + time * 3) * this.sr);
    const amt = this.params.noise * 0.05 * Math.min(1, s.env * 10);
    if (amt > 1e-4) {
      const at = this.clock & this.RMASK; let p = 0;
      for (let k = 0; k < 400; k++) { const r = this.rng() * 2 - 1; this.bodyIn[(at + k) & this.RMASK] += (r - p) * amt * Math.exp(-k / 90); p = r; }
    }
  }

  // ---------- render ----------
  render(outL, outR, n, offset = 0, outF = null, outB = null) {
    if (this.sceneDirty) this.setupScene();
    let done = 0;
    while (done < n) {
      while (this.queue.length && this.queue[0]._at <= this.clock) this.handle(this.queue.shift());
      let seg = n - done;
      if (this.queue.length) seg = Math.max(1, Math.min(seg, this.queue[0]._at - this.clock));
      const toCtl = 64 - (this.clock & 63);
      seg = Math.min(seg, toCtl);
      if (this.isQuiet(seg)) {
        outL.fill(0, offset + done, offset + done + seg); outR.fill(0, offset + done, offset + done + seg);
        if (outF) outF.fill(0, offset + done, offset + done + seg); if (outB) outB.fill(0, offset + done, offset + done + seg);
        this.regW = (this.regW + seg) % this.RL; this.clock += seg;
      } else this.renderSeg(outL, outR, offset + done, seg, outF, outB);
      done += seg;
      if ((this.clock & 63) === 0) this.control();
    }
  }

  renderSeg(outL, outR, off, n, outF, outB) {
    const S = this.strings, B = this.body, nb = B.nr;
    const b0 = B.b0, a1 = B.a1, a2 = B.a2, z1 = B.z1, z2 = B.z2, pz = B.pz, pp = B.pp, pb = B.pb, pu = B.pu, ew = B.ew;
    const gy = 0.3, bodyAmt = this.params.body, gain = this.params.gain * this.P.out;
    const symp = this.params.sympathetic * 5e-6;   // bridge compliance seen by the other strings, m/N (banjo: ~4x a guitar's)
    const sr = this.sr, CD = 64, CM = 127;
    const stDecay = Math.exp(-1 / (0.5 * sr));
    const lpC = 1 - Math.exp(-TAU * 3000 / sr), hpC = Math.exp(-TAU * 60 / sr);
    const ring = this.cplRing, t0 = this.clock;
    const by = this.br.y, bc = this.br.chi, sB = this.P.breakSin;
    if (this.fric && this.fric.length) this.runFriction(n);
    // 1) strings, oscillator-major
    for (let j = 0; j < NS; j++) {
      const s = S[j], FY = this.FY[j], FZ = this.FZ[j], U = this.U;
      FY.fill(0, 0, n); FZ.fill(0, 0, n);
      const own = s.ownRing;
      let anyU = false;
      if (symp > 0) for (let i = 0; i < n; i++) {
        const k = (t0 + i - CD) & CM;
        const u = symp * (ring[k] - own[k]); U[i] = u; if (u !== 0) anyU = true;
      }
      let anyW = false; const W = this.W;
      if (this.trOn[j]) { const tr = this.trExt[j]; for (let i = 0; i < n; i++) { const k = (t0 + i) & this.RMASK; W[i] = tr[k]; tr[k] = 0; if (W[i] !== 0) anyW = true; } }
      for (let vv = 0; vv < 3; vv++) {
        const v = s.voices[vv];
        if (!v.nact && !(anyW && v === s.v)) continue;
        if (anyW && v === s.v && v.nact < v.n) { for (let c = 0; c < v.n; c++) v.act[c] = c; v.nact = v.n; }
        const act = v.act, c1a = v.c1, c2a = v.c2, y1a = v.y1, y2a = v.y2, wya = v.wy, wza = v.wz, gina = v.gin;
        const drive = anyW && v === s.v, kd = Math.PI * this.trDelta[j] / (v.L || 0.667);
        const fGain = drive ? 2 / (sr * sr * this.P.strings[j].mu * (v.L || 0.667)) * TR_GAIN : 0;
        for (let q = 0; q < v.nact; q++) {
          const c = act[q];
          const c1 = c1a[c], c2 = c2a[c], wy = wya[c], wz = wza[c];
          let y1 = y1a[c], y2 = y2a[c];
          if (drive) {
            const g = gina[c], gw = Math.sin(v.k[c] * kd) * fGain;
            for (let i = 0; i < n; i++) { const y = c1 * y1 - c2 * y2 + (anyU ? g * U[i] : 0) + gw * W[i]; y2 = y1; y1 = y; FY[i] += wy * y; FZ[i] += wz * y; }
          } else if (anyU) {
            const g = gina[c];
            for (let i = 0; i < n; i++) { const y = c1 * y1 - c2 * y2 + g * U[i]; y2 = y1; y1 = y; FY[i] += wy * y; FZ[i] += wz * y; }
          } else {
            for (let i = 0; i < n; i++) { const y = c1 * y1 - c2 * y2; y2 = y1; y1 = y; FY[i] += wy * y; FZ[i] += wz * y; }
          }
          y1a[c] = y1; y2a[c] = y2;
        }
      }
    }
    // 2) per sample: string stretching, coupling ring, pot, radiation, mics
    const gIn = this.gIn, gX1 = this.gX1, gX2 = this.gX2, RS = this.regS;
    const nLow = B.nLow, lowW = B.lowW, hw = B.hw, hreg = B.hreg;
    const rn = B.rn, rc1 = B.rc1, rc2 = B.rc2, rg = B.rg, ry1 = B.ry1, ry2 = B.ry2, rw = B.rw;
    for (let i = 0; i < n; i++) {
      const tIdx = (t0 + i) & this.RMASK;
      let Ftot = 0, Fv = 0, Mr = 0, Bn = 0, FU = 0;
      for (let j = 0; j < NS; j++) {
        const s = S[j];
        const sy = this.FY[j][i], sz = this.FZ[j][i];
        let own = sz + gy * sy, lo = 0, dyn = 0;
        // tension change from the string's own motion (slope at the bridge squared), its fluctuating part, and the
        // longitudinal modes it drives; over the break angle both push down on the bridge
        const sl = own / s.lonT, f2 = s.lonEA * 0.25 * sl * sl;
        s.f2lp += (f2 - s.f2lp) * 0.002; dyn = f2 - s.f2lp;
        if (s.lonN && s.lonG) {
          const drive = dyn * s.lonG * 2 + this.lonExt[j][tIdx]; this.lonExt[j][tIdx] = 0;
          for (let q = 0; q < s.lonN; q++) {
            const y = s.lonC1[q] * s.lonY1[q] - s.lonC2[q] * s.lonY2[q] + drive * s.lonIn[q];
            s.lonY2[q] = s.lonY1[q]; s.lonY1[q] = y; lo += y;
          }
        }
        s.ownRing[(t0 + i) & CM] = own; s.out = own;
        const vz = sz + (lo + dyn) * sB;
        Fv += vz; Mr += by[j] * vz; Bn += bc[j] * vz; FU += sy; Ftot += own + lo;
      }
      this.cplLP += (Ftot - this.cplLP) * lpC;
      this.cplHP = hpC * this.cplHP + (1 - hpC) * this.cplLP;
      ring[(t0 + i) & CM] = this.cplLP - this.cplHP;
      this.staticZ *= stDecay; this.staticY *= stDecay;
      gIn[0] = Fv + this.staticZ + this.bodyIn[tIdx]; gIn[1] = Mr; gIn[2] = Bn; gIn[3] = FU + this.staticY; this.bodyIn[tIdx] = 0;
      const d0 = gIn[0] - gX2[0], d1 = gIn[1] - gX2[1], d2 = gIn[2] - gX2[2], d3 = gIn[3] - gX2[3];
      for (let d = 0; d < 4; d++) { gX2[d] = gX1[d]; gX1[d] = gIn[d]; }
      RS.fill(0);
      let edge = 0;
      for (let q = 0; q < nb; q++) {
        const y = b0[q] * (pz[q] * d0 + pp[q] * d1 + pb[q] * d2 + pu[q] * d3) - a1[q] * z1[q] - a2[q] * z2[q];
        z2[q] = z1[q]; z1[q] = y;
        if (q < nLow) { const o = q * 7; RS[0] += lowW[o] * y; RS[1] += lowW[o + 1] * y; RS[2] += lowW[o + 2] * y; RS[3] += lowW[o + 3] * y; RS[4] += lowW[o + 4] * y; RS[5] += lowW[o + 5] * y; RS[6] += lowW[o + 6] * y; }
        else RS[hreg[q]] += hw[q] * y;
        edge += ew[q] * y;
      }
      // the tone ring, driven at its edge by the head
      for (let r = 0; r < rn; r++) { const y = rc1[r] * ry1[r] - rc2[r] * ry2[r] + rg[r] * edge; ry2[r] = ry1[r]; ry1[r] = y; RS[5] += rw[r] * (y - ry2[r]); }
      // volume velocity -> monopole source strength rho/(4 pi) dU/dt (pressure x distance)
      const RL = this.RL, wpos = this.regW, kd = sr * RHO_4PI * bodyAmt;
      let front = 0, back = 0;
      for (let k = 0; k < 7; k++) {
        const u = RS[k], x = (u - this.regPrev[k]) * kd; this.regPrev[k] = u;
        this.regRing[k * RL + wpos] = x;
        if (k === 6) back = x; else front += x;
      }
      let L = 0, R = 0;
      const nm = this.nm, mD = this.mD, mG = this.mG, mN = this.mN, mS = this.mS, mI = this.mI, mLP = this.mLP, mC = this.mC;
      for (let m = 0; m < nm; m++) {
        let acc = 0;
        for (let k = 0; k < 7; k++) {
          const j = m * 7 + k;
          let pos = wpos - mD[j]; if (pos < 0) pos += RL;
          const i0 = pos | 0, fr = pos - i0, i1 = i0 + 1 === RL ? 0 : i0 + 1;
          const x = this.regRing[k * RL + i0] * (1 - fr) + this.regRing[k * RL + i1] * fr;
          mI[j] = mI[j] * 0.9993 + x / sr;
          const y = mG[j] * x + mN[j] * mI[j];
          mLP[j] += (y - mLP[j]) * mC[j];
          acc += y + (mLP[j] - y) * mS[j];
        }
        if (m === 0) L = acc; else R = acc;
      }
      if (nm === 1) R = L;
      this.regW = wpos + 1 === RL ? 0 : wpos + 1;
      this.feedF = front; this.feedB = back;
      { const r = this.rh;
        const yl = this.rhb0 * L + this.rhb1 * r[0] + this.rhb2 * r[1] - this.rha1 * r[2] - this.rha2 * r[3];
        r[1] = r[0]; r[0] = L; r[3] = r[2]; r[2] = yl; L = yl;
        const yr = this.rhb0 * R + this.rhb1 * r[4] + this.rhb2 * r[5] - this.rha1 * r[6] - this.rha2 * r[7];
        r[5] = r[4]; r[4] = R; r[7] = r[6]; r[6] = yr; R = yr; }
      this.airL = this.airC * this.airL + (1 - this.airC) * L;
      this.airR = this.airC * this.airR + (1 - this.airC) * R;
      L = this.airL + this.dirL[tIdx]; R = this.airR + this.dirR[tIdx];
      this.dirL[tIdx] = 0; this.dirR[tIdx] = 0;
      const yL = L - this.dcxL + 0.9995 * this.dcL; this.dcxL = L; this.dcL = yL;
      const yR = R - this.dcxR + 0.9995 * this.dcR; this.dcxR = R; this.dcR = yR;
      let oL = yL * gain, oR = yR * gain;
      if (!(oL === oL) || !(oR === oR)) { this.panicReset(); oL = oR = 0; }
      outL[off + i] = oL; outR[off + i] = oR;
      if (outF) {
        const r = this.rhF; const F = this.feedF, Bk = this.feedB;
        const yf = this.rhb0 * F + this.rhb1 * r[0] + this.rhb2 * r[1] - this.rha1 * r[2] - this.rha2 * r[3];
        r[1] = r[0]; r[0] = F; r[3] = r[2]; r[2] = yf;
        const yb = this.rhb0 * Bk + this.rhb1 * r[4] + this.rhb2 * r[5] - this.rha1 * r[6] - this.rha2 * r[7];
        r[5] = r[4]; r[4] = Bk; r[7] = r[6]; r[6] = yb;
        outF[off + i] = yf * gain; outB[off + i] = yb * gain;
      }
    }
    this.clock += n;
  }

  isQuiet(n) {
    if (this.fric && this.fric.length) return false;
    for (const s of this.strings) for (const v of s.voices) if (v.nact) return false;
    if (Math.abs(this.staticZ) + Math.abs(this.staticY) > 1e-7) return false;
    const t0 = this.clock, M = this.RMASK;
    for (let i = 0; i < n; i++) { const k = (t0 + i) & M; if (this.bodyIn[k] !== 0 || this.dirL[k] !== 0 || this.dirR[k] !== 0) return false; }
    if ((this.clock & 63) === 0 || this.bodyQuiet === undefined) {
      const B = this.body; let e = 0;
      for (let q = 0; q < B.nr; q++) e += B.z1[q] * B.z1[q] + B.z2[q] * B.z2[q];
      for (let r = 0; r < B.rn; r++) e += B.ry1[r] * B.ry1[r] * 1e6;
      let r = 0; for (let k = 0; k < 7; k++) r += Math.abs(this.regPrev[k]);
      this.bodyQuiet = e < 1e-18 && r < 1e-12 && Math.abs(this.dcL) + Math.abs(this.dcR) < 1e-7;
    }
    return this.bodyQuiet;
  }
  sceneGeom() {
    const pot = this.pot, sp = this.potSpec();
    return { cx: -pot.xb, rc: 0.684 * pot.a, a: pot.a, back: sp.back, potDepth: sp.potDepth };
  }
  setupScene() {
    this.sceneDirty = false;
    const sc = Object.assign({}, this.params.scene || {}, { hold: (this.params.setup || {}).hold || (this.params.scene || {}).hold || 'lap', geom: this.sceneGeom() });
    const SP = root.BanjoSpace;
    const coefs = SP ? SP.directCoefs(sc, this.sr)
      : [[0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.35].map((d, k) => ({ delay: d / 343 * this.sr, gP: 1 / d, gB: 0, gNear: 0, shadow: k === 6 ? 0.8 : 0 }))];
    this.nm = Math.min(2, coefs.length);
    const ears = SP && SP.expandMics(sc.mics || 'front30').some(m => m.ear);
    const norm = SP ? SP.micNorm(sc) : 1;
    for (let m = 0; m < this.nm; m++) for (let k = 0; k < 7; k++) {
      const c = coefs[m][k], j = m * 7 + k;
      this.mD[j] = Math.min(this.RL - 4, Math.max(1, c.delay));
      this.mG[j] = (c.gP + c.gB) * norm;
      this.mN[j] = c.gNear * norm;
      this.mS[j] = c.shadow;
      this.mC[j] = 1 - Math.exp(-TAU * (ears ? 1400 : 420) / this.sr);
    }
  }
  bodyReset() {
    const B = this.body; B.z1.fill(0); B.z2.fill(0); B.ry1.fill(0); B.ry2.fill(0);
    this.gX1.fill(0); this.gX2.fill(0); this.regPrev.fill(0);
  }
  panicReset() {
    for (const s of this.strings) for (const v of s.voices) { v.y1.fill(0); v.y2.fill(0); v.nact = 0; }
    this.bodyReset(); this.staticZ = this.staticY = 0; this.cplLP = this.cplHP = 0; this.rh.fill(0);
    this.regRing.fill(0); this.mI.fill(0); this.mLP.fill(0); this.rhF.fill(0); this.fric = [];
  }
  meters() {
    return this.strings.map(s => ({ e: Math.min(1, s.env), fret: s.fret, midi: s.midi, active: s.v.live, bend: s.v.bendShift || 0 }));
  }
}

root.BanjoEngine = BanjoEngine;
root.BANJO_PRESETS = BANJOS;
root.BANJO_TUNINGS = TUNINGS;
root.BANJO_STRINGS = STRING_SETS;
root.BANJO_PICKS = PICKS;
root.banjoPickModel = pickModel;
root.banjoFriction = (g, a, n, mu, tr) => { FRIC_GAIN = g; FRIC_AIR = a; if (n != null) FRIC_NORMAL = n; if (mu) FRIC_MU = mu; if (tr != null) TR_GAIN = tr; };

if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor !== 'undefined') {
  class BanjoProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.eng = new BanjoEngine(sampleRate, { externalPot: true });
      this.meterCount = 0;
      this.port.onmessage = (m) => { const d = m.data; if (Array.isArray(d)) for (const ev of d) this.eng.post(ev); else this.eng.post(d); };
    }
    process(inputs, outputs) {
      const out = outputs[0], L = out[0], R = out[1] || out[0];
      if (this.eng.clock === 0) this.eng.clock = Math.round(currentTime * sampleRate);
      this.eng.render(L, R, L.length, 0, out[2] || null, out[3] || null);
      if (++this.meterCount >= 12) { this.meterCount = 0; this.port.postMessage({ meters: this.eng.meters() }); }
      return true;
    }
  }
  registerProcessor('banjo-engine', BanjoProcessor);
}
})(typeof globalThis !== 'undefined' ? globalThis : this);
