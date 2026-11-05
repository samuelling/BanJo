// BanJo — the space around the banjo: where it sits, how it is held, the microphones, and the room.
//
// The banjo radiates from its head (five regions: centre, neck side, bass side, tail side, treble side), from its rim
// and tone ring, and from behind: the open back of the pot, or the gap around a resonator's flange. For the DIRECT
// sound every region reaches every mic at its own distance and angle (spherical spreading, mic polar pattern, the
// proximity effect of pressure-gradient mics, shadowing by the pot and by the player's head). For the ROOM, an
// image-source model traces wall reflections with per-band absorption, source directivity in the direction each ray
// leaves the banjo and mic directivity in the direction it arrives; a statistical late tail follows the Eyring decay of
// each band. Both are baked into impulse responses for ConvolverNodes, one per source side (front / back).
// (Adapted from Acoustic's space model. No measured banjo directivity is used: the region model alone sets it.)

(function (root) {
'use strict';
const C = 343;               // speed of sound, m/s
const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];

// ---------------- materials: absorption per octave band 125..8k (8k extrapolated where not tabulated) ----------------
const MATERIALS = {
  concrete:   { name: 'Painted concrete', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.03] },
  brick:      { name: 'Brick', a: [0.03, 0.03, 0.03, 0.04, 0.05, 0.07, 0.08] },
  stone:      { name: 'Stone', a: [0.02, 0.02, 0.03, 0.04, 0.05, 0.05, 0.06] },
  plaster:    { name: 'Plaster / drywall', a: [0.29, 0.10, 0.05, 0.04, 0.07, 0.09, 0.10] },
  woodFloor:  { name: 'Wood floor', a: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07, 0.07] },
  woodPanel:  { name: 'Wood paneling', a: [0.30, 0.25, 0.20, 0.17, 0.15, 0.10, 0.09] },
  plasterHard:{ name: 'Plaster on masonry', a: [0.013, 0.015, 0.02, 0.03, 0.04, 0.05, 0.06] },
  pews:       { name: 'Wooden pews', a: [0.10, 0.12, 0.14, 0.16, 0.17, 0.17, 0.17] },
  carpet:     { name: 'Carpet on concrete', a: [0.02, 0.06, 0.14, 0.37, 0.60, 0.65, 0.66] },
  carpetPad:  { name: 'Carpet on pad', a: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73, 0.74] },
  curtain:    { name: 'Heavy curtains', a: [0.14, 0.35, 0.55, 0.72, 0.70, 0.65, 0.62] },
  glass:      { name: 'Window glass', a: [0.35, 0.25, 0.18, 0.12, 0.07, 0.04, 0.03] },
  tile:       { name: 'Ceramic tile', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02, 0.03] },
  foam:       { name: 'Acoustic foam', a: [0.08, 0.25, 0.60, 0.90, 0.95, 0.98, 0.98] },
  wool:       { name: 'Mineral wool panels', a: [0.45, 0.95, 1.0, 1.0, 1.0, 1.0, 1.0] },
  sofa:       { name: 'Upholstered furniture', a: [0.70, 0.76, 0.81, 0.84, 0.84, 0.81, 0.78] },
  audience:   { name: 'Seated audience', a: [0.60, 0.74, 0.88, 0.96, 0.93, 0.85, 0.80] },
  books:      { name: 'Bookshelves', a: [0.30, 0.40, 0.40, 0.30, 0.30, 0.30, 0.30] },
  grass:      { name: 'Grass', a: [0.10, 0.25, 0.45, 0.60, 0.70, 0.75, 0.78] },
  // natural ground and rock (typical published ranges; outdoor grounds are porous, so they absorb more as frequency rises)
  leafLitter: { name: 'Leaf litter', a: [0.15, 0.35, 0.55, 0.70, 0.75, 0.80, 0.80] },
  needles:    { name: 'Pine needles', a: [0.10, 0.25, 0.45, 0.60, 0.70, 0.75, 0.75] },
  snow:       { name: 'Fresh snow', a: [0.45, 0.75, 0.90, 0.95, 0.95, 0.95, 0.95] },
  sand:       { name: 'Dry sand', a: [0.10, 0.25, 0.35, 0.45, 0.55, 0.60, 0.65] },
  water:      { name: 'Still water', a: [0.01, 0.01, 0.01, 0.015, 0.02, 0.02, 0.025] },
  sandstone:  { name: 'Sandstone', a: [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08] },
  granite:    { name: 'Granite cliff', a: [0.01, 0.01, 0.02, 0.02, 0.03, 0.03, 0.04] },
  limestone:  { name: 'Wet limestone', a: [0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.06] },
  rubble:     { name: 'Rock rubble', a: [0.05, 0.08, 0.12, 0.18, 0.22, 0.25, 0.28] },
  open:       { name: 'Open air', a: [1, 1, 1, 1, 1, 1, 1] }
};
// air absorption, energy attenuation coefficient m (1/m) at 20 C, 50% RH (ISO 9613-1)
const AIR_M = [0.0001, 0.0003, 0.00063, 0.00107, 0.00227, 0.0065, 0.020]; // effective full-octave (Wenmaekers 2014)

// surfaces: floor, ceiling, x0 (left), x1 (right), y0 (front, behind the mics), y1 (back, behind the player)
const ROOMS = {
  booth:    { name: 'Vocal booth', dims: [2.0, 1.6, 2.3], walls: { floor: 'carpet', ceiling: 'plaster', x0: 'foam', x1: 'woodPanel', y0: 'foam', y1: 'woodPanel' }, extra: [], scatter: 0.4 },
  living:   { name: 'Living room', dims: [5.6, 4.4, 2.6], walls: { floor: 'woodFloor', ceiling: 'plaster', x0: 'plaster', x1: 'glass', y0: 'plaster', y1: 'books' },
              extra: [{ mat: 'carpet', area: 6, on: 'floor' }, { mat: 'sofa', area: 3, on: 'floor' }, { mat: 'curtain', area: 5, on: 'x1' }], scatter: 0.35 },
  bedroom:  { name: 'Bedroom', dims: [4.0, 3.6, 2.5], walls: { floor: 'carpetPad', ceiling: 'plaster', x0: 'plaster', x1: 'plaster', y0: 'plaster', y1: 'glass' },
              extra: [{ mat: 'sofa', area: 3.5, on: 'floor' }, { mat: 'curtain', area: 3, on: 'y1' }], scatter: 0.35 },
  bathroom: { name: 'Tiled bathroom', dims: [2.6, 2.2, 2.4], walls: { floor: 'tile', ceiling: 'plaster', x0: 'tile', x1: 'tile', y0: 'tile', y1: 'glass' },
              extra: [{ mat: 'curtain', area: 1.2, on: 'x1' }], scatter: 0.15 },
  studio:   { name: 'Studio live room', dims: [8.0, 6.0, 3.4], walls: { floor: 'woodFloor', ceiling: 'woodPanel', x0: 'woodPanel', x1: 'plaster', y0: 'curtain', y1: 'woodPanel' },
              extra: [{ mat: 'wool', area: 4, on: 'ceiling' }], scatter: 0.5 },
  recital:  { name: 'Wooden recital hall', dims: [24, 15, 9], walls: { floor: 'woodFloor', ceiling: 'plasterHard', x0: 'woodPanel', x1: 'woodPanel', y0: 'plasterHard', y1: 'woodPanel' },
              extra: [{ mat: 'audience', area: 230, on: 'floor' }], scatter: 0.5 },
  hall:     { name: 'Concert hall (Boston-like)', dims: [38, 23, 18.6], walls: { floor: 'woodFloor', ceiling: 'plasterHard', x0: 'plasterHard', x1: 'plasterHard', y0: 'woodPanel', y1: 'plasterHard' },
              extra: [{ mat: 'audience', area: 760, on: 'floor' }, { mat: 'audience', area: 160, on: 'x0' }, { mat: 'audience', area: 160, on: 'x1' }], scatter: 0.6 },
  church:   { name: 'Stone church', dims: [42, 16, 18], walls: { floor: 'stone', ceiling: 'stone', x0: 'stone', x1: 'glass', y0: 'stone', y1: 'stone' },
              extra: [{ mat: 'pews', area: 500, on: 'floor' }, { mat: 'audience', area: 110, on: 'floor' }, { mat: 'woodPanel', area: 150, on: 'y1' }], scatter: 0.45 },
  outdoors: { name: 'Outdoors on grass', dims: [200, 200, 200], walls: { floor: 'grass', ceiling: 'open', x0: 'open', x1: 'open', y0: 'open', y1: 'open' }, extra: [], scatter: 0.2, open: true, nature: true },
  // ---- natural places ----
  // Forests: the ground reflects, then sound scattered off trunks (single-scattering cylinders, after Kaneko & Gamper
  // 2021) and foliage fills a reverberant tail. Albert et al. (2015) measured T60 around 2 s in most northeastern US
  // stands, ~1.2 s in a deciduous stand and a pruned spruce grid, ~3 s over very rough ground; scattering from trees
  // is mostly above ~1 kHz (Yang et al. 2013), so the tail is weak in the bass.
  forest:   { name: 'Deciduous forest, summer', dims: [200, 200, 200], walls: { floor: 'leafLitter', ceiling: 'open', x0: 'open', x1: 'open', y0: 'open', y1: 'open' }, extra: [], scatter: 0.3, open: true, nature: true,
              trees: { n: 260, r: [0.08, 0.30], spacing: 4.5, leaves: true }, tail: { rt: [0.9, 1.1, 1.3, 1.4, 1.4, 1.3, 1.0], lvl: [0.05, 0.12, 0.3, 0.6, 0.85, 1.0, 0.9], V: 3500, onset: 0.02 } },
  pines:    { name: 'Pine forest', dims: [200, 200, 200], walls: { floor: 'needles', ceiling: 'open', x0: 'open', x1: 'open', y0: 'open', y1: 'open' }, extra: [], scatter: 0.3, open: true, nature: true,
              trees: { n: 320, r: [0.12, 0.35], spacing: 3.8, leaves: false }, tail: { rt: [1.2, 1.5, 1.8, 2.0, 2.1, 2.0, 1.6], lvl: [0.06, 0.15, 0.35, 0.65, 0.9, 1.0, 0.85], V: 3000, onset: 0.015 } },
  winterwood: { name: 'Winter woods in snow', dims: [200, 200, 200], walls: { floor: 'snow', ceiling: 'open', x0: 'open', x1: 'open', y0: 'open', y1: 'open' }, extra: [], scatter: 0.3, open: true, nature: true,
              trees: { n: 200, r: [0.08, 0.30], spacing: 5.5, leaves: false }, tail: { rt: [0.7, 0.9, 1.1, 1.2, 1.2, 1.1, 0.9], lvl: [0.03, 0.08, 0.2, 0.4, 0.55, 0.6, 0.5], V: 6000, onset: 0.025 } },
  snowfield:{ name: 'Open snowfield', dims: [200, 200, 200], walls: { floor: 'snow', ceiling: 'open', x0: 'open', x1: 'open', y0: 'open', y1: 'open' }, extra: [], scatter: 0.2, open: true, nature: true },
  // Rock: open sky and open ends, so only the rock faces reflect; image sources run long enough to keep the echoes
  slot:     { name: 'Slot canyon, sandstone', dims: [3.2, 80, 30], walls: { floor: 'sand', ceiling: 'open', x0: 'sandstone', x1: 'sandstone', y0: 'open', y1: 'open' }, extra: [], scatter: 0.35, tMix: 0.25, nature: true },
  canyon:   { name: 'Canyon, walls 40 m apart', dims: [40, 400, 120], walls: { floor: 'sand', ceiling: 'open', x0: 'sandstone', x1: 'sandstone', y0: 'open', y1: 'open' }, extra: [], scatter: 0.25, tMix: 1.0, nature: true },
  lake:     { name: 'Mountain lake, cliff across the water', dims: [140, 600, 300], walls: { floor: 'water', ceiling: 'open', x0: 'granite', x1: 'open', y0: 'open', y1: 'open' }, extra: [], scatter: 0.15, tMix: 0.9, nature: true },
  cave:     { name: 'Limestone cave', dims: [16, 34, 9], walls: { floor: 'rubble', ceiling: 'limestone', x0: 'limestone', x1: 'limestone', y0: 'limestone', y1: 'limestone' }, extra: [], scatter: 0.7, nature: true }
};

// ---------------- microphones ----------------
// pattern: p(theta) = A + B cos(theta); B > 0 parts are pressure-gradient (proximity effect near the source)
const PATTERNS = {
  omni: { name: 'Omni', A: 1, B: 0, diffuse: 1 },
  cardioid: { name: 'Cardioid', A: 0.5, B: 0.5, diffuse: 1 / 3 },
  supercardioid: { name: 'Supercardioid', A: 0.37, B: 0.63, diffuse: 0.27 },
  fig8: { name: 'Figure-8', A: 0, B: 1, diffuse: 1 / 3 }
};

// Banjo-local coordinates (metres): origin at the bridge on the head, x toward the neck along the strings, y across the
// head toward the bass (5th-string) side, z out of the head (toward a listener in front). geom from the pot model:
// cx = head centre's x (the bridge sits behind the centre, toward the tailpiece), rc = centroid radius of the outer
// regions, back: 'open' | 'resonator', potDepth.
const GEOM0 = { cx: 0.049, rc: 0.092, a: 0.134, back: 'resonator', potDepth: 0.07 };
function regionsFor(geom) {
  const g = Object.assign({}, GEOM0, geom || {}), cx = g.cx, rc = g.rc;
  return [
    { id: 'centre', name: 'Head, centre',     p: [cx, 0, 0],      n: [0, 0, 1] },
    { id: 'neck',   name: 'Head, neck side',  p: [cx + rc, 0, 0], n: [0, 0, 1] },
    { id: 'bass',   name: 'Head, bass side',  p: [cx, rc, 0],     n: [0, 0, 1] },
    { id: 'tail',   name: 'Head, tail side',  p: [cx - rc, 0, 0], n: [0, 0, 1] },
    { id: 'treb',   name: 'Head, treble side', p: [cx, -rc, 0],   n: [0, 0, 1] },
    { id: 'rim',    name: 'Rim and tone ring', p: [cx, 0, -0.02], n: [0, 0, 0] },
    g.back === 'resonator'
      ? { id: 'gap', name: 'Resonator flange gap', p: [cx, 0, -0.035], n: [0, 0, 0] }
      : { id: 'back', name: 'Open back of the pot', p: [cx, 0, -g.potDepth], n: [0, 0, -1] }
  ];
}
const REGIONS = regionsFor(GEOM0);

// Mic setups in banjo-local coordinates (aim points too). 'ears' = the player's own head.
const MIC_SETUPS = {
  front30:  { name: 'Head, 30 cm (aimed at the neck joint)', mics: [{ p: [0.16, 0.03, 0.30], aim: [0.15, 0, 0], pattern: 'cardioid' }] },
  close12:  { name: 'Close, 12 cm off the bridge', mics: [{ p: [0.03, 0.02, 0.12], aim: [0.02, 0, 0], pattern: 'cardioid' }] },
  neck20:   { name: 'Neck joint, 20 cm', mics: [{ p: [0.22, 0.04, 0.20], aim: [0.19, 0, 0], pattern: 'cardioid' }] },
  pair:     { name: 'Spaced pair: head + neck joint', mics: [{ p: [0.04, -0.06, 0.28], aim: [0.04, 0, 0], pattern: 'cardioid' }, { p: [0.24, 0.06, 0.26], aim: [0.19, 0, 0], pattern: 'cardioid' }] },
  xy60:     { name: 'XY pair, 60 cm', mics: 'xy', center: [0.08, 0.0, 0.60], aim: [0.06, 0, 0], pattern: 'cardioid', spread: 45 },
  room2m:   { name: 'Room pair, 2 m', mics: [{ p: [0.05, -0.4, 2.0], aim: [0.05, 0, 0], pattern: 'omni' }, { p: [0.05, 0.4, 2.0], aim: [0.05, 0, 0], pattern: 'omni' }] },
  ears:     { name: "Player's ears", mics: 'ears', head: [0.14, 0.42, 0.10] },
  behind:   { name: 'Behind the player, 1.3 m', mics: [{ p: [0.15, -0.15, -1.3], aim: [0.05, 0, -0.05], pattern: 'omni' }, { p: [-0.05, 0.15, -1.3], aim: [0.05, 0, -0.05], pattern: 'omni' }] }
};

// ---------------- small vector helpers ----------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---------------- placement: banjo-local <-> room ----------------
// The banjo faces +Y of the room (its top normal points toward the room's front wall y0 = 0? no: toward -Y),
// its neck points toward -X (player's left for a right-handed player facing -Y), bass side up (+Z).
function placement(scene) {
  const g = scene.guitar; // { pos: [x,y,z] room coords of the saddle point, yaw: radians }
  const cy = Math.cos(g.yaw || 0), sy = Math.sin(g.yaw || 0);
  // local axes in room coords
  const ex = [-cy, sy, 0];          // toward the neck
  const ez = [-sy, -cy, 0];          // out of the top: faces the -Y side of the room
  const ey = [0, 0, 1];              // bass side up
  const toRoom = (p) => add(g.pos, add(add(scl(ex, p[0]), scl(ey, p[1])), scl(ez, p[2])));
  const dirToRoom = (d) => add(add(scl(ex, d[0]), scl(ey, d[1])), scl(ez, d[2]));
  const toLocalDir = (d) => [dot(d, ex), dot(d, ey), dot(d, ez)];
  return { ex, ey, ez, toRoom, dirToRoom, toLocalDir };
}

// Expand a mic setup into concrete mics in banjo-local coords: [{p, axis, pattern, ear?}]
function expandMics(setup, scale) {
  const s = typeof setup === 'string' ? MIC_SETUPS[setup] : setup;
  if (s.mics === 'xy') {
    const c = s.center, ax = nrm(sub(s.aim, c)), half = (s.spread || 45) * Math.PI / 180;
    // rotate the aim around the banjo's y axis (vertical in the room when held) by +-half
    const rot = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
    return [{ p: c, axis: rot(ax, half), pattern: s.pattern }, { p: c, axis: rot(ax, -half), pattern: s.pattern }];
  }
  if (s.mics === 'ears') {
    // head above the bass edge of the upper bout; ears 17.5 cm apart along the neck direction
    const h = s.head;
    return [
      { p: [h[0] + 0.0875, h[1], h[2]], axis: [1, 0, 0], pattern: 'omni', ear: 'L', head: h },
      { p: [h[0] - 0.0875, h[1], h[2]], axis: [-1, 0, 0], pattern: 'omni', ear: 'R', head: h }
    ];
  }
  return s.mics.map(m => ({ p: m.p, axis: nrm(sub(m.aim, m.p)), pattern: m.pattern }));
}

// A concrete setup from a preset with an optional pattern override and distance scaling (mics move along their
// line to the aim point; the player's head does not move).
function scaledSetup(key, dist, pattern) {
  const s = MIC_SETUPS[key] || MIC_SETUPS.front30;
  if (s.mics === 'ears') return s;
  const d = dist || 1;
  const pat = (m) => (pattern && pattern !== 'default') ? pattern : m;
  if (s.mics === 'xy') {
    const c = add(s.aim, scl(sub(s.center, s.aim), d));
    return Object.assign({}, s, { center: c, pattern: pat(s.pattern) });
  }
  return { name: s.name, mics: s.mics.map(m => ({ p: add(m.aim, scl(sub(m.p, m.aim), d)), aim: m.aim, pattern: pat(m.pattern) })) };
}

// No measured banjo directivity: the region model alone sets the pattern.
const DIR = null;

// smooth interpolation over the 32 measured directions (von Mises-Fisher kernel), in dB. The measured pattern uses a
// ~25 deg kernel; the correction a ~45 deg one, so it fixes broad trends and leaves each body's own fine lobes.
const KAPPA_CORR = 4;
function dirInterp(table, u, kappa) {
  const KAPPA = kappa || 12;
  const l = len(u) || 1, x = u[0] / l, y = u[1] / l, z = u[2] / l;
  const out = [0, 0, 0, 0, 0, 0, 0]; let ws = 0;
  if (!DIR) return out;
  for (let j = 0; j < DIR.dirs.length; j++) {
    const d = DIR.dirs[j], w = Math.exp(KAPPA * (x * d[0] + y * d[1] + z * d[2] - 1));
    ws += w; const t = table[j]; for (let b = 0; b < 7; b++) out[b] += w * t[b];
  }
  for (let b = 0; b < 7; b++) out[b] /= ws;
  return out;
}
// The measurement includes the player's body. With the banjo on a stand, directions behind the top (toward where the
// player would be) fall back to the synth's own pattern.
function playerWeight(u, held) { return held ? 1 : Math.min(1, Math.max(0, (u[2] / (len(u) || 1) + 0.25) / 0.5)); }

// ---------------- banjo source directivity (for room reflections) ----------------
// Model shape: the top side is omnidirectional at low frequency and beams forward as frequency rises; the back side is
// the mirror image. The total in each direction is then set to the measured balloon, keeping the model's split
// between the two feeds (so rays leaving backward still carry the back plate's sound) and its total radiated power.
const BEAM = [0.0, 0.1, 0.35, 0.8, 1.3, 1.8, 2.3];
function beamGain(side, u, band) {
  const facing = side === 'front' ? u[2] : -u[2];
  return Math.max(0, Math.pow((1 + facing) / 2 + 0.02, BEAM[band]));
}
const FIB = (() => { const n = 400, p = []; for (let i = 0; i < n; i++) { const z = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - z * z), t = Math.PI * (1 + Math.sqrt(5)) * i; p.push([r * Math.cos(t), r * Math.sin(t), z]); } return p; })();
const srcCache = {};
function srcNorm(held, band) {
  const key = (held ? 'h' : 's') + band;
  if (srcCache[key]) return srcCache[key];
  const rho = DIR ? DIR.backFeed[band] : 1;
  let mAvg = 0; for (const u of FIB) mAvg += beamGain('front', u, band) ** 2 + rho * beamGain('back', u, band) ** 2;
  mAvg /= FIB.length;
  // power-preserving scale for the measured-shape gains
  let p = 0; for (const u of FIB) { const t = shapeFactor(u, band, held, mAvg, rho); p += t * t * (beamGain('front', u, band) ** 2 + rho * beamGain('back', u, band) ** 2); }
  p /= FIB.length;
  return (srcCache[key] = { mAvg, rho, k: Math.sqrt(mAvg / p) });
}
function shapeFactor(u, band, held, mAvg, rho) {
  const M = beamGain('front', u, band) ** 2 + rho * beamGain('back', u, band) ** 2;
  const modelDb = 10 * Math.log10(Math.max(1e-9, M / mAvg));
  const w = playerWeight(u, held);
  const targetDb = w * dirInterp(DIR.db, u)[band] + (1 - w) * modelDb;
  return Math.pow(10, (targetDb - modelDb) / 20);
}
function sourceGain(side, uLocal, band, held, raw) {
  if (!DIR || raw) return beamGain(side, uLocal, band);
  const N = srcNorm(held, band);
  return beamGain(side, uLocal, band) * shapeFactor(uLocal, band, held, N.mAvg, N.rho) * N.k;
}

// mic sensitivity for a wave arriving from unit direction `from` (pointing from the mic toward the source)
function micGain(mic, from, band) {
  if (mic.ear) {
    // spherical head (Brown & Duda): the far side is shadowed, more so at high frequencies
    const side = mic.ear === 'L' ? 1 : -1;
    const c = from[0] * side; // cos of angle to the ear axis (local x)
    const shadow = [0.0, 0.1, 0.25, 0.45, 0.65, 0.8, 0.9][band];
    return (1 - shadow) + shadow * (0.5 + 0.5 * c) * (c > 0 ? 1.25 : 1);
  }
  const P = PATTERNS[mic.pattern] || PATTERNS.omni;
  return Math.abs(P.A + P.B * dot(mic.axis, from));
}

// ---------------- direct path coefficients for the worklet ----------------
// For each mic and region: delay (samples), gain for the pressure term, gain for the near-field gradient term
// (pressure-gradient mics: p_grad = B cos(theta) (p + (c/d) * velocity_integral)), and a shadow amount (0 = clear line
// of sight, 1 = region faces away from the mic: heard only by diffraction, low-passed).
function directCoefs(scene, sr) {
  const mics = expandMics(scene.mics, scene.scale || 0.667);
  const held = scene.hold !== 'stand', regs = regionsFor(scene.geom);
  return mics.map(mic => regs.map(r => {
    const v = sub(mic.p, r.p), d = Math.max(0.05, len(v)), u = scl(v, 1 / d);
    const facing = dot(u, r.n);                    // >0: mic in front of this region's surface
    const from = scl(u, -1);
    const P = PATTERNS[mic.pattern] || PATTERNS.omni;
    let A = P.A, B = P.B * dot(mic.axis, from);
    if (mic.ear) { A = 1; B = 0; }
    // body shadow: smooth step from facing (0) to facing away (1)
    let shadow = Math.min(1, Math.max(0, 0.5 - facing * 1.6));
    // the player's body sits behind the back: back radiation reaching the front is further absorbed
    let g = 1 / d;
    // the player's lap or belly sits behind an open back: part of what leaves it is soaked up before reaching the front
    if (r.id === 'back') g *= scene.hold === 'belly' ? 0.3 : held ? 0.6 : 1;
    // head shadow for the player's ears: far ear gets the head's diffraction lowpass
    let earShadow = 0;
    if (mic.ear) {
      const side = mic.ear === 'L' ? 1 : -1;
      const toSrc = nrm(sub(r.p, mic.head));
      earShadow = Math.max(0, Math.min(1, 0.5 - toSrc[0] * side * 0.9));
      shadow = Math.max(shadow, earShadow * 0.8);
    }
    return { delay: d / C * sr, gP: g * A, gB: g * B, gNear: g * B * C / d, shadow, d };
  }));
}

// Far-field correction of the direct sound: the region model is right where geometry dominates (a mic a hand's width
// from the soundhole), the measurement is right at a distance (it includes the player's body and the real diffraction
// around the instrument). Each mic gets the measured-minus-model difference in its direction, faded in between 0.3 m
// and 1.2 m from the banjo's acoustic centre. Returns per-mic octave-band gains in dB (125 Hz .. 8 kHz).
const ACOUSTIC_CENTER = [0.05, 0, -0.03]; // middle of the pot
function directEQ(scene) {
  const mics = expandMics(scene.mics, scene.scale || 0.667);
  return mics.map(m => {
    if (!DIR || scene.rawRadiation) return [0, 0, 0, 0, 0, 0, 0];
    const v = sub(m.p, ACOUSTIC_CENTER), d = len(v);
    const t = Math.min(1, Math.max(0, (d - 0.3) / 0.9)), fade = t * t * (3 - 2 * t);
    const w = playerWeight(v, held) * fade;
    return dirInterp(DIR.corr, v, KAPPA_CORR).map(x => Math.max(-12, Math.min(12, x * w)));
  });
}

// Graphic EQ for those octave gains: low shelf (125), five peaking filters (250..4k, one octave wide), high shelf (8k),
// RBJ cookbook biquads. The bands overlap, so the requested gains are refined until the realized response at the
// band centres matches.
function biquad(type, f, gDb, sr) {
  const A = Math.pow(10, gDb / 40), w = 2 * Math.PI * f / sr, cs = Math.cos(w), sn = Math.sin(w);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peak') {
    const al = sn * Math.sinh(Math.LN2 / 2 * 1.0 * w / sn);
    b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
  } else {
    const al = sn / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al, s = type === 'low' ? 1 : -1;
    b0 = A * ((A + 1) - s * (A - 1) * cs + sA); b1 = s * 2 * A * ((A - 1) - s * (A + 1) * cs); b2 = A * ((A + 1) - s * (A - 1) * cs - sA);
    a0 = (A + 1) + s * (A - 1) * cs + sA; a1 = -s * 2 * ((A - 1) + s * (A + 1) * cs); a2 = (A + 1) + s * (A - 1) * cs - sA;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function biquadDb(c, f, sr) {
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
  const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}
function designEQ(gDb, sr) {
  const fc = BANDS, types = ['low', 'peak', 'peak', 'peak', 'peak', 'peak', 'high'];
  const edge = (b) => b === 0 ? 177 : b === 6 ? 5657 : fc[b];
  let req = gDb.slice(), cs = [];
  for (let it = 0; it < 6; it++) {
    cs = req.map((g, b) => biquad(types[b], edge(b), g, sr));
    for (let b = 0; b < 7; b++) {
      let got = 0; for (const c of cs) got += biquadDb(c, fc[b], sr);
      req[b] += 0.8 * (gDb[b] - got);
    }
  }
  return cs;
}

// "Preamp gain": normalize each setup by its mics' mean distance to the banjo's regions, as an engineer would
// set gain. Applied equally to direct sound and room, so the direct-to-reverberant balance stays physical.
function micNorm(scene) {
  const mics = expandMics(scene.mics);
  let s = 0, n = 0;
  for (const m of mics) for (const r of regionsFor(scene.geom)) { if (r.id === 'back' || r.id === 'gap') continue; s += len(sub(m.p, r.p)); n++; }
  return (s / n) / 0.3;
}

// ---------------- impulse responses ----------------
function eyring(room) {
  const [Lx, Ly, Lz] = room.dims;
  const V = Lx * Ly * Lz;
  const areas = { floor: Lx * Ly, ceiling: Lx * Ly, x0: Ly * Lz, x1: Ly * Lz, y0: Lx * Lz, y1: Lx * Lz };
  const S = Object.values(areas).reduce((a, b) => a + b, 0);
  const alpha = {}; // per surface per band, extras blended in by area
  for (const k in areas) alpha[k] = MATERIALS[room.walls[k]].a.slice();
  for (const e of room.extra || []) {
    const f = Math.min(1, e.area / areas[e.on]);
    for (let b = 0; b < 7; b++) alpha[e.on][b] = alpha[e.on][b] * (1 - f) + MATERIALS[e.mat].a[b] * f;
  }
  const rt = [], abar = [];
  for (let b = 0; b < 7; b++) {
    let A = 0; for (const k in areas) A += areas[k] * alpha[k][b];
    const a = Math.min(0.999, A / S); abar.push(a);
    rt.push(0.161 * V / (-S * Math.log(1 - a) + 4 * AIR_M[b] * V));
  }
  return { V, S, areas, alpha, rt, abar };
}

// radix-2 complex FFT (in place)
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / size, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = i + k, b = a + size / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// interpolate 7 band gains (linear amplitude) onto FFT bin frequencies, in dB over log-frequency
function bandCurve(g, nfft, sr, out) {
  const lg = g.map(x => Math.log(Math.max(1e-6, x)));
  for (let k = 0; k <= nfft / 2; k++) {
    const f = Math.max(20, k * sr / nfft);
    const x = Math.log2(f / 125);
    let v;
    if (x <= 0) v = lg[0]; else if (x >= 6) v = lg[6];
    else { const i = Math.floor(x), t = x - i; v = lg[i] * (1 - t) + lg[i + 1] * t; }
    out[k] = Math.exp(v);
  }
  return out;
}

// A short linear-phase FIR (centered) realising 7 band gains; cached by rounded gains
const FIRN = 128;
function bandFir(g, sr, cache) {
  const key = g.map(x => Math.round(x * 400)).join(',');
  if (cache && cache.has(key)) return cache.get(key);
  const re = new Float64Array(FIRN), im = new Float64Array(FIRN), mag = new Float64Array(FIRN / 2 + 1);
  bandCurve(g, FIRN, sr, mag);
  for (let k = 0; k <= FIRN / 2; k++) { re[k] = mag[k]; if (k > 0 && k < FIRN / 2) re[FIRN - k] = mag[k]; }
  fft(re, im, true);
  const h = new Float32Array(FIRN);
  for (let i = 0; i < FIRN; i++) {
    const j = (i + FIRN / 2) % FIRN;                 // center the zero-phase response
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / FIRN);
    h[i] = re[j] * w;
  }
  if (cache) cache.set(key, h);
  return h;
}

function rng32(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; for (let i = 0; i < 6; i++) u += r(); return (u - 3) * 1.4142; }

// Build stereo IRs (reflections + late tail, no direct sound) for the top ('front') and back source sides.
// scene: { room (key or object), guitar: {pos, yaw}, mics (setup key or object), hold, scale }
// Trunks as single-scattering cylinders (Kaneko & Gamper 2021): every trunk within reach adds one scattered arrival,
// delayed by source -> trunk -> mic, spreading 1/(d1 d2). A cylinder of radius a scatters weakly while ka < 1 (Rayleigh,
// ~ (ka)^2 in power) and like a mirror strip above; foliage adds a little more at the top. Trunks are placed at random
// with the stand's mean spacing, but none closer than ~1.5 m to the player.
function scatterTrees(out, room, src, mics, pl, held, scene, sr, N, cache) {
  const T = room.trees, r = rng32(4242), centre = src.front;
  const R = Math.min(60, T.spacing * Math.sqrt(T.n / Math.PI));
  for (let i = 0; i < T.n; i++) {
    const ang = r() * 2 * Math.PI, rad = Math.max(1.5, R * Math.sqrt(r()));
    const tx = centre[0] + rad * Math.cos(ang), ty = centre[1] + rad * Math.sin(ang), a = T.r[0] + (T.r[1] - T.r[0]) * r();
    for (const side of ['front', 'back']) {
      const S = src[side], tp = [tx, ty, Math.max(0.5, S[2])];
      const d1 = len(sub(tp, S)), dep = pl.toLocalDir(nrm(sub(tp, S)));
      for (let mi = 0; mi < Math.min(2, mics.length); mi++) {
        const M = mics[mi], d2 = len(sub(M.room, tp)), t = (d1 + d2) / C;
        if (t * sr >= N - FIRN) continue;
        const arr = pl.toLocalDir(nrm(sub(tp, M.room)));
        const g = new Array(7);
        for (let b = 0; b < 7; b++) {
          const ka = 2 * Math.PI * BANDS[b] / C * a;
          const eff = Math.sqrt(Math.min(1, ka * ka)) * Math.sqrt(a) * 0.9 + (T.leaves ? 0.04 * Math.min(1, BANDS[b] / 2000) : 0);
          g[b] = eff / (d1 * d2) * Math.exp(-AIR_M[b] * (d1 + d2) / 2) * sourceGain(side, dep, b, held, scene.rawRadiation) * micGain(M, arr, b);
        }
        const amp = Math.max(...g); if (amp < 1e-6) continue;
        const h = bandFir(g.map(x => x / amp), sr, cache), at = Math.round(t * sr), buf = out[side][mi];
        for (let k = 0; k < FIRN; k++) { const j = at + k - FIRN / 2; if (j >= 0 && j < N) buf[j] += h[k] * amp; }
      }
    }
  }
}

function buildIRs(scene, sr) {
  const room = typeof scene.room === 'string' ? ROOMS[scene.room] : scene.room;
  const E = eyring(room);
  const [Lx, Ly, Lz] = room.dims;
  const pl = placement(scene);
  const mics = expandMics(scene.mics, scene.scale || 0.667).map(m => ({ ...m, room: pl.toRoom(m.p), roomAxis: pl.dirToRoom(m.axis) }));
  const held = scene.hold !== 'stand';
  const rg = regionsFor(scene.geom);
  const src = { front: pl.toRoom(rg[0].p), back: pl.toRoom(rg[6].p) };
  const rtMax = Math.max(...E.rt);
  const tailRt = room.tail ? Math.max(...room.tail.rt) : 0;
  const dur = room.tail ? Math.min(scene.maxDur || 6, 6, tailRt * 1.15 + 0.1)
    : room.open ? 0.25 : Math.min(scene.maxDur || 6, 6, Math.max(0.3, rtMax * 1.15, (room.tMix || 0) + 0.3));   // maxDur: Light CPU mode caps the tail
  const N = Math.ceil(dur * sr) + FIRN;
  const tMix = room.open ? 0.25 : room.tMix ? Math.min(room.tMix, dur) : Math.min(0.12, Math.max(0.035, Math.sqrt(E.V) / 1000 * 1.6));
  const scat = room.scatter ?? 0.4;
  const beta = {}; for (const k in E.alpha) beta[k] = E.alpha[k].map(a => Math.sqrt(Math.max(0, 1 - a)));
  const out = { front: [new Float32Array(N), new Float32Array(N)], back: [new Float32Array(N), new Float32Array(N)], rt: E.rt, V: E.V, tMix };
  const cache = new Map();
  const r = rng32(1234);
  const maxOrder = room.open ? 1 : 40;
  // ----- image sources (Allen & Berkley), specular part
  for (const side of ['front', 'back']) {
    const S = src[side];
    for (let mi = 0; mi < Math.min(2, mics.length); mi++) {
      const M = mics[mi], buf = out[side][mi];
      const nmax = Math.ceil(tMix * C / Math.min(Lx, Ly, Lz)) + 1;
      for (let nx = -nmax; nx <= nmax; nx++) for (let ny = -nmax; ny <= nmax; ny++) for (let nz = -nmax; nz <= nmax; nz++)
      for (let px = 0; px < 2; px++) for (let py = 0; py < 2; py++) for (let pz = 0; pz < 2; pz++) {
        if (nx === 0 && ny === 0 && nz === 0 && px === 0 && py === 0 && pz === 0) continue; // direct sound
        const cnt = {
          x0: Math.abs(nx - px), x1: Math.abs(nx), y0: Math.abs(ny - py), y1: Math.abs(ny), floor: Math.abs(nz - pz), ceiling: Math.abs(nz)
        };
        if (room.open && (cnt.x0 + cnt.x1 + cnt.y0 + cnt.y1 + cnt.ceiling > 0)) continue;
        const order = cnt.x0 + cnt.x1 + cnt.y0 + cnt.y1 + cnt.floor + cnt.ceiling;
        if (order > maxOrder) continue;
        const I = [(1 - 2 * px) * S[0] + 2 * nx * Lx, (1 - 2 * py) * S[1] + 2 * ny * Ly, (1 - 2 * pz) * S[2] + 2 * nz * Lz];
        // randomize higher-order images slightly (diffusion; avoids flutter from a perfect lattice)
        if (order > 1) for (let a = 0; a < 3; a++) I[a] += (r() - 0.5) * 0.16 * Math.min(1, order / 4); // randomized image method, <= 8 cm
        const v = sub(M.room, I), d = len(v), t = d / C;
        if (t > tMix) continue;
        const arrive = scl(v, -1 / d);                       // from mic toward the image
        // departure direction at the real source: mirror the arrival back through the same reflections
        const dep = [(px ? -1 : 1) * -arrive[0], (py ? -1 : 1) * -arrive[1], (pz ? -1 : 1) * -arrive[2]];
        const depLocal = pl.toLocalDir(dep);
        const arrLocal = pl.toLocalDir(arrive);
        const micAx = M.axis;
        const g = new Array(7);
        const spec = Math.pow(1 - scat, order / 2);
        for (let b = 0; b < 7; b++) {
          let a = spec / d * Math.exp(-AIR_M[b] * d / 2);
          for (const k in cnt) if (cnt[k]) a *= Math.pow(beta[k][b], cnt[k]);
          a *= sourceGain(side, depLocal, b, held, scene.rawRadiation);
          a *= micGain({ ...M, axis: micAx }, arrLocal, b);
          g[b] = a;
        }
        if (Math.max(...g) < 1e-5) continue;
        const h = bandFir(g.map(x => x / Math.max(1e-9, Math.max(...g))), sr, cache);
        const amp = Math.max(...g);
        const at = Math.round(t * sr);
        for (let i = 0; i < FIRN; i++) { const k = at + i - FIRN / 2; if (k >= 0 && k < N) buf[k] += h[i] * amp; }
      }
    }
  }
  if (room.trees) scatterTrees(out, room, src, mics, pl, held, scene, sr, N, cache);
  if (room.open && !room.tail) return out;
  // ----- late tail: per-band noise with Eyring decay, energy arrival rate 4 pi c / V (relative to a 1/d direct sound),
  // ramping in as scattering turns specular energy diffuse, and fully after the mixing time
  const hop = 256, NF = 512;
  const win = new Float64Array(NF); for (let i = 0; i < NF; i++) win[i] = Math.sin(Math.PI * (i + 0.5) / NF); // sqrt-hann pair
  const nFrames = Math.ceil(N / hop);
  const meanFree = room.tail ? 10 : 4 * E.V / E.S;
  // inter-mic coherence of the diffuse tail: sin(kd)/(kd) for spaced omnis (spacing d); coincident directional pairs
  // keep partial coherence from their overlapping patterns
  const m0 = mics[0], m1 = mics[1] || mics[0];
  const spacing = mics.length > 1 ? len(sub(m0.p, m1.p)) : 0.3;
  const coincident = spacing < 0.05;
  const coh = new Float64Array(NF / 2 + 1);
  for (let k = 0; k <= NF / 2; k++) {
    const f = Math.max(1, k * sr / NF), kd = 2 * Math.PI * f / C * (m0.ear ? 0.22 : spacing);
    coh[k] = coincident ? 0.55 : Math.max(0, Math.sin(kd) / kd);
  }
  for (const side of ['front', 'back']) {
    // fraction of the source's power going into this side's directions (diffuse-field weighting)
    const sidePow = []; for (let b = 0; b < 7; b++) {
      let sp = 0, n = 0;
      for (const u of FIB) { sp += Math.pow(sourceGain(side, u, b, held, scene.rawRadiation), 2); n++; }
      sidePow.push(sp / n);
    }
    const nm = Math.min(2, mics.length);
    const rg = rng32(777 + (side === 'back' ? 999 : 0));
    const curves = [new Float64Array(NF / 2 + 1), new Float64Array(NF / 2 + 1)], gains = new Array(7);
    const r1 = new Float64Array(NF), i1 = new Float64Array(NF), r2 = new Float64Array(NF), i2 = new Float64Array(NF);
    const o1 = new Float64Array(NF), q1 = new Float64Array(NF);
    for (let fI = 0; fI < nFrames; fI++) {
      const t = (fI * hop + NF / 2) / sr;
      const nRef = C * t / meanFree;
      const TL = room.tail;
      const ramp = TL ? Math.min(1, Math.max(0, (t - TL.onset) / 0.06)) ** 2
        : t >= tMix ? 1 : Math.max(0, 1 - Math.pow(1 - scat, nRef)) * 0.9 + 0.1 * Math.min(1, t / tMix) ** 2;
      for (let mi = 0; mi < nm; mi++) {
        const P = mics[mi].ear ? { diffuse: 0.9 } : (PATTERNS[mics[mi].pattern] || PATTERNS.omni);
        for (let b = 0; b < 7; b++) {
          // energy per second 4 pi c / V * exp(-13.8 t / RT) (integrates to Barron's 16 pi / A); per sample / sr
          const e = room.tail
            ? 4 * Math.PI * C / room.tail.V * room.tail.lvl[b] * Math.exp(-13.82 * t / room.tail.rt[b]) * sidePow[b] * P.diffuse / sr
            : 4 * Math.PI * C / E.V * Math.exp(-13.82 * t / E.rt[b]) * sidePow[b] * P.diffuse / sr;
          gains[b] = Math.sqrt(e * ramp);
        }
        bandCurve(gains, NF, sr, curves[mi]);
      }
      for (let k = 0; k < NF; k++) { r1[k] = gauss(rg) * win[k]; i1[k] = 0; r2[k] = gauss(rg) * win[k]; i2[k] = 0; }
      fft(r1, i1, false); fft(r2, i2, false);
      for (let mi = 0; mi < nm; mi++) {
        for (let k = 0; k < NF; k++) {
          const kb = k <= NF / 2 ? k : NF - k;
          let a, b2;
          if (mi === 0) { a = r1[k]; b2 = i1[k]; }
          else { const g = coh[kb], h = Math.sqrt(1 - g * g); a = g * r1[k] + h * r2[k]; b2 = g * i1[k] + h * i2[k]; }
          const c = curves[mi][kb]; o1[k] = a * c; q1[k] = b2 * c;
        }
        fft(o1, q1, true);
        const buf = out[side][mi], o = fI * hop;
        for (let i = 0; i < NF; i++) { const k = o + i; if (k < N) buf[k] += o1[i] * win[i]; }
      }
    }
  }
  if (scene.maxDur && (room.tail ? tailRt : rtMax) * 1.15 > scene.maxDur) {   // a capped tail fades out over its last 0.5 s instead of stopping
    const nf = Math.min(N, Math.round(0.5 * sr));
    for (const side of ['front', 'back']) for (const ch of out[side]) for (let i = 0; i < nf; i++) ch[N - nf + i] *= 0.5 + 0.5 * Math.cos(Math.PI * i / nf);
  }
  return out;
}

function buildIRsNormalized(scene, sr) {
  const g = micNorm(scene), mics = expandMics(scene.mics);
  let sc = scene;
  // single mic: the room is rendered at the mic and at a twin 30 cm to the side (partially coherent tail), so the
  // reflections arrive in stereo while the direct sound stays centred
  if (mics.length === 1) {
    const m = mics[0];
    sc = Object.assign({}, scene, { mics: { mics: [{ p: m.p, aim: add(m.p, m.axis), pattern: m.pattern }, { p: [m.p[0] + 0.3, m.p[1], m.p[2]], aim: add([m.p[0] + 0.3, m.p[1], m.p[2]], m.axis), pattern: m.pattern }] } });
  }
  const out = buildIRs(sc, sr);
  for (const side of ['front', 'back']) for (const ch of out[side]) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  out.norm = g;
  return out;
}

root.BanjoSpace = { regionsFor, ACOUSTIC_CENTER, DIR: () => DIR, dirInterp, sourceGain, directEQ, designEQ, biquadDb, BANDS, MATERIALS, ROOMS, PATTERNS, REGIONS, MIC_SETUPS, AIR_M, expandMics, placement, directCoefs, buildIRs: buildIRsNormalized, buildIRsRaw: buildIRs, micNorm, scaledSetup, eyring, fft };
})(typeof globalThis !== 'undefined' ? globalThis : this);
