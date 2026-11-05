// BanJo — the pot: a tensioned membrane head, the three-footed bridge standing on it, the air behind it
// (an open-backed pot or a closed resonator), and the tone ring at its edge. Pure math: runs in the worklet, on the main
// thread and in Node, and returns the coupled modes the string engine needs.
//
//   membrane      phi_mn = J_m(j_mn r / a) {cos, sin}(m theta),  K_n = T_h (j_mn / a)^2 N_n,  N_n = int phi^2 dA
//                 air loading adds areal mass rho alpha_m / k_mn (calibrated: bare 11" head, open back, 5.33 kN/m
//                 -> lowest mode ~290 Hz as Woodhouse, Politzer & Mansour 2021 measured; ~380 Hz in vacuo)
//   bridge        a rigid bar on three feet: heave z, roll psi about the string axis, first free-free bending b
//                 (shape 1 - 3 s^2), and the top swaying sideways U on its legs. Strings press on it at their own
//                 positions across it, so the 1st and 5th strings rock it most and the 3rd not at all (Politzer).
//                 Static springs: string stretching and tension over the break angle (Woodhouse et al. eqs. 15-16)
//                 plus the stiffening of the head under the bridge's down-force.
//   air           open back: the air in the pot is a short pipe closed by the head, lumped as a mass plug in the
//                 opening on the pot's air spring, radiating from the back. Resonator: a closed cavity whose air
//                 leaves through the gap around the flange (a Helmholtz resonator that splits the head's lowest mode).
//   coupled       M x'' + C x' + K x = f over [membrane modes, z, psi, b, U, air]; M is diagonal, so the eigenproblem
//                 is symmetric after M^-1/2 scaling (Householder + QL). Modal damping from each part's own losses.
//   above ~5 kHz  the membrane's modal overlap is high: statistical modes continue the dense model's trend.

(function (root) {
'use strict';
const TAU = Math.PI * 2, RHO = 1.2, C_AIR = 343;

// ---------------- Bessel functions ----------------
// All orders 0..M at x by Miller's backward recurrence, normalized with J0 + 2 sum J_2k = 1.
function besselAll(x, M, out) {
  out = out || new Float64Array(M + 2);
  out.fill(0);
  if (Math.abs(x) < 1e-12) { out[0] = 1; return out; }
  const big = Math.max(M, x);
  const N = 2 * Math.ceil((big + 24 + 3 * Math.sqrt(big)) / 2);
  let jp1 = 0, j = 1e-30, sum = 0;
  for (let k = N; k > 0; k--) {
    const jm1 = (2 * k / x) * j - jp1;
    jp1 = j; j = jm1;                       // j = J_{k-1}
    const o = k - 1;
    if (o <= M + 1) out[o] = j;
    if (o > 0 && (o & 1) === 0) sum += 2 * j;
    if (Math.abs(j) > 1e150) {
      j *= 1e-150; jp1 *= 1e-150; sum *= 1e-150;
      for (let q = o; q <= M + 1; q++) out[q] *= 1e-150;
    }
  }
  sum += j;
  for (let k = 0; k <= M + 1; k++) out[k] /= sum;
  return out;
}
function besselJ(m, x) { return besselAll(x, m)[m]; }

// zeros j_mn of J_m below xMax, for m = 0..
let ZCACHE = null;
function besselZeros(xMax) {
  if (ZCACHE && ZCACHE.xMax >= xMax) return ZCACHE.z;
  const Mmax = Math.ceil(xMax) + 2, z = [];
  for (let m = 0; m <= Mmax; m++) z.push([]);
  const dx = 0.05, buf = new Float64Array(Mmax + 3);
  let prev = null;
  for (let x = 0.05; x <= xMax + dx; x += dx) {
    const cur = Float64Array.from(besselAll(x, Mmax, buf));
    if (prev) for (let m = 0; m <= Mmax; m++) {
      if (x - dx < m * 0.9) continue;
      if (prev[m] === 0 || prev[m] * cur[m] < 0) {
        let lo = x - dx, hi = x, flo = prev[m];
        for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2, fm = besselJ(m, mid); if (fm * flo <= 0) hi = mid; else { lo = mid; flo = fm; } }
        const r = (lo + hi) / 2; if (r <= xMax) z[m].push(r);
      }
    }
    prev = cur;
  }
  ZCACHE = { xMax, z };
  return z;
}

// ---------------- symmetric eigen-decomposition (Householder tridiagonalization + implicit QL) ----------------
// A: n x n symmetric (array of Float64Array rows), destroyed. Returns { d: eigenvalues (ascending), V: rows = components,
// columns = eigenvectors (V[i][k] = component i of vector k) }.
function symEig(A, n) {
  const V = A, d = new Float64Array(n), e = new Float64Array(n);
  for (let j = 0; j < n; j++) d[j] = V[n - 1][j];
  for (let i = n - 1; i > 0; i--) {
    let scale = 0, h = 0;
    for (let k = 0; k < i; k++) scale += Math.abs(d[k]);
    if (scale === 0) {
      e[i] = d[i - 1];
      for (let j = 0; j < i; j++) { d[j] = V[i - 1][j]; V[i][j] = 0; V[j][i] = 0; }
    } else {
      for (let k = 0; k < i; k++) { d[k] /= scale; h += d[k] * d[k]; }
      let f = d[i - 1], g = Math.sqrt(h);
      if (f > 0) g = -g;
      e[i] = scale * g; h -= f * g; d[i - 1] = f - g;
      for (let j = 0; j < i; j++) e[j] = 0;
      for (let j = 0; j < i; j++) {
        f = d[j]; V[j][i] = f; g = e[j] + V[j][j] * f;
        for (let k = j + 1; k <= i - 1; k++) { g += V[k][j] * d[k]; e[k] += V[k][j] * f; }
        e[j] = g;
      }
      f = 0;
      for (let j = 0; j < i; j++) { e[j] /= h; f += e[j] * d[j]; }
      const hh = f / (h + h);
      for (let j = 0; j < i; j++) e[j] -= hh * d[j];
      for (let j = 0; j < i; j++) {
        f = d[j]; g = e[j];
        for (let k = j; k <= i - 1; k++) V[k][j] -= (f * e[k] + g * d[k]);
        d[j] = V[i - 1][j]; V[i][j] = 0;
      }
    }
    d[i] = h;
  }
  for (let i = 0; i < n - 1; i++) {
    V[n - 1][i] = V[i][i]; V[i][i] = 1;
    const h = d[i + 1];
    if (h !== 0) {
      for (let k = 0; k <= i; k++) d[k] = V[k][i + 1] / h;
      for (let j = 0; j <= i; j++) {
        let g = 0;
        for (let k = 0; k <= i; k++) g += V[k][i + 1] * V[k][j];
        for (let k = 0; k <= i; k++) V[k][j] -= g * d[k];
      }
    }
    for (let k = 0; k <= i; k++) V[k][i + 1] = 0;
  }
  for (let j = 0; j < n; j++) { d[j] = V[n - 1][j]; V[n - 1][j] = 0; }
  V[n - 1][n - 1] = 1; e[0] = 0;
  // QL
  for (let i = 1; i < n; i++) e[i - 1] = e[i];
  e[n - 1] = 0;
  let f = 0, tst1 = 0;
  const eps = Math.pow(2, -52);
  for (let l = 0; l < n; l++) {
    tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
    let m = l;
    while (m < n) { if (Math.abs(e[m]) <= eps * tst1) break; m++; }
    if (m > l) {
      let iter = 0;
      do {
        iter++;
        let g = d[l], p = (d[l + 1] - g) / (2 * e[l]), r = Math.hypot(p, 1);
        if (p < 0) r = -r;
        d[l] = e[l] / (p + r); d[l + 1] = e[l] * (p + r);
        const dl1 = d[l + 1]; let h = g - d[l];
        for (let i = l + 2; i < n; i++) d[i] -= h;
        f += h;
        p = d[m];
        let c = 1, c2 = c, c3 = c, el1 = e[l + 1], s = 0, s2 = 0;
        for (let i = m - 1; i >= l; i--) {
          c3 = c2; c2 = c; s2 = s;
          g = c * e[i]; h = c * p; r = Math.hypot(p, e[i]);
          e[i + 1] = s * r; s = e[i] / r; c = p / r;
          p = c * d[i] - s * g;
          d[i + 1] = h + s * (c * g + s * d[i]);
          for (let k = 0; k < n; k++) { h = V[k][i + 1]; V[k][i + 1] = s * V[k][i] + c * h; V[k][i] = c * V[k][i] - s * h; }
        }
        p = -s * s2 * c3 * el1 * e[l] / dl1;
        e[l] = s * p; d[l] = c * p;
      } while (Math.abs(e[l]) > eps * tst1 && iter < 60);
    }
    d[l] = d[l] + f; e[l] = 0;
  }
  return { d, V };
}

// ---------------- materials and parts ----------------
// Heads: areal mass sigma (kg/m2) and the film's own loss (Mylar background ~1.5e-3 from the FE fit's 4e-3 total incl.
// edge losses; the others are estimates scaled from their construction). Diameters in metres.
const HEADS = {
  frosted:  { name: 'Frosted Mylar (7 mil)', sigma: 0.30, eta: 1.5e-3 },
  clear:    { name: 'Clear Mylar (7 mil)', sigma: 0.25, eta: 1.0e-3 },
  smooth:   { name: 'Thick smooth film', sigma: 0.36, eta: 2.6e-3 },
  fibre:    { name: 'Fibre-laminated synthetic skin', sigma: 0.42, eta: 5.5e-3 },
  calf:     { name: 'Calfskin', sigma: 0.40, eta: 9e-3 }
};
// Tone rings: edge loss through the rim, head-edge radius factor (an archtop ring raises the head so it bends over the
// ring's crown, a slightly smaller vibrating disc), and the ring's own out-of-plane modes (estimated from ring theory for
// typical cross-sections: bell brass E 100 GPa, rho 8600). mass kg, section width x height m.
const RINGS = {
  none:     { name: 'Wood rim, no tone ring', edge: 3.2e-3, rf: 1.00, ring: null },
  hoop:     { name: 'Brass hoop (rod on the rim)', edge: 2.2e-3, rf: 0.995, ring: { mass: 0.22, w: 0.0064, h: 0.0064, Q: 60 } },
  archtop:  { name: 'Archtop bell-bronze ring', edge: 0.9e-3, rf: 0.94, ring: { mass: 1.25, w: 0.011, h: 0.016, Q: 110 } },
  flathead: { name: 'Flathead bell-bronze ring', edge: 0.6e-3, rf: 0.985, ring: { mass: 1.6, w: 0.0127, h: 0.0178, Q: 160 } }
};
const STUFF = {
  none: { name: 'Nothing behind the head', a: 0, b: 0 },
  rag:  { name: 'Rag / sock against the head', a: 0.006, b: 0.010 },
  foam: { name: 'Foam or towel pressed in', a: 0.015, b: 0.030 }
};
// String positions across the bridge (m, + toward the bass/5th-string side), string order 5th, 4th, 3rd, 2nd, 1st
const BRIDGE_Y = [0.01905, 0.009525, 0, -0.009525, -0.01905];

// DrumDial reading -> head tension (N/m). Assumed mapping, calibrated so a bare 11" frosted head on an open pot has its lowest mode at the measured 290 Hz
// at DD 90 (6.15 kN/m in this model; Woodhouse et al. estimated 5.33 kN/m from their FE model), about 4% per point (tap tones rising roughly G to A across the usual 85-91 range).
function ddToTension(dd) { return 6150 * Math.exp(0.04 * ((dd ?? 90) - 90)); }

// ---------------- the coupled pot ----------------
// spec: { headD (m), head, tension (N/m) or dd, ring, back: 'open'|'resonator', potDepth (m), bridgeMass (kg),
//         bridgeH (m), breakDeg, strings: [{T, EA, L}], stuff, hold: 'stand'|'lap'|'belly', fCut, fMax, seed }
function buildPot(spec) {
  const S = Object.assign({ headD: 0.268, head: 'frosted', dd: 90, ring: 'flathead', back: 'resonator', potDepth: 0.070,
    bridgeMass: 0.0022, bridgeH: 0.0159, breakDeg: 13, stuff: 'none', hold: 'lap', fCut: 7200, fKeep: 6400, fMax: 11500, seed: 7 }, spec || {});
  const H = HEADS[S.head] || HEADS.frosted, RG = RINGS[S.ring] || RINGS.none, ST = STUFF[S.stuff] || STUFF.none;
  const Th = S.tension || ddToTension(S.dd);
  const a = S.headD / 2 * RG.rf, sigma = H.sigma;
  const cm = Math.sqrt(Th / sigma);
  // bridge stands where the scale length ends: ~0.185 m from the neck-side edge of the head
  const xb = -(0.185 - S.headD / 2);
  const Lb = 0.078, mb = S.bridgeMass, hb = S.bridgeH;
  const feet = [-Lb / 2, 0, Lb / 2];
  const chi = (y) => 1 - 3 * Math.pow(y / (Lb / 2), 2);

  // membrane modes up to fCut (in vacuo)
  const xMax = TAU * S.fCut * a / cm;
  const Z = besselZeros(Math.max(xMax, 10));
  const modes = [];
  for (let m = 0; m < Z.length; m++) for (let n = 0; n < Z[m].length; n++) {
    const j = Z[m][n]; if (j > xMax) break;
    modes.push({ m, n: n + 1, j, o: 0 });
    if (m > 0) modes.push({ m, n: n + 1, j, o: 1 });
  }
  const NM = modes.length;
  const bufJ = new Float64Array(Z.length + 4);
  // per mode: norm, volume, values at the feet, region volume integrals, edge slope
  // regions: 0 centre disc (r < 0.45 a), 1 neck side, 2 bass side, 3 tail side, 4 treble side (annulus quadrants)
  const NR = 40, rho0 = 0.45;
  const sectors = [[-Math.PI / 4, Math.PI / 4], [Math.PI / 4, 3 * Math.PI / 4], [3 * Math.PI / 4, 5 * Math.PI / 4], [-3 * Math.PI / 4, -Math.PI / 4]];
  const angInt = (m, o, t1, t2) => m === 0 ? (o ? 0 : t2 - t1) : (o ? (Math.cos(m * t1) - Math.cos(m * t2)) / m : (Math.sin(m * t2) - Math.sin(m * t1)) / m);
  const footPts = feet.map(y => { const x = xb; return { r: Math.hypot(x, y), t: Math.atan2(y, x) }; });
  for (const md of modes) {
    const J = besselAll(md.j, md.m + 1, bufJ);
    md.norm = (md.m === 0 ? Math.PI : Math.PI / 2) * a * a * J[md.m + 1] * J[md.m + 1];
    md.vol = md.m === 0 ? TAU * a * a * J[1] / md.j : 0;
    md.slope = (md.m === 0 ? -J[1] : (J[md.m - 1] - J[md.m + 1]) / 2) * md.j / a;   // dJ/dr at the rim
    md.foot = footPts.map(p => besselJ(md.m, md.j * p.r / a) * (md.o ? Math.sin(md.m * p.t) : Math.cos(md.m * p.t)));
    // radial integrals: inner disc, outer annulus (midpoint rule on NR points each)
    let inner = 0, outer = 0;
    for (let i = 0; i < NR; i++) {
      const r1 = (i + 0.5) / NR * rho0, r2 = rho0 + (i + 0.5) / NR * (1 - rho0);
      inner += besselJ(md.m, md.j * r1) * r1 * rho0 / NR;
      outer += besselJ(md.m, md.j * r2) * r2 * (1 - rho0) / NR;
    }
    md.reg = [inner * a * a * angInt(md.m, md.o, -Math.PI, Math.PI)];
    for (const [t1, t2] of sectors) md.reg.push(outer * a * a * angInt(md.m, md.o, t1, t2));
    // air loading: theory for a membrane with air on both sides ~ 2 rho / k; the breathing (m = 0) modes carry more
    // (calibrated to the measured 380 -> 290 Hz drop of the lowest mode)
    const k = md.j / a, alpha = md.m === 0 ? (S.alpha0 ?? 0.3) + 0.6 / md.n : 2.0 + (md.m === 1 ? 0.5 / md.n : 0);
    md.sig = sigma + RHO * alpha / k;
    md.M = md.sig * md.norm;
    md.K = Th * k * k * md.norm;
    md.f0 = Math.sqrt(md.K / md.M) / TAU;
  }

  // ---------- static springs on the bridge ----------
  const beta = S.breakDeg * Math.PI / 180, after = 0.115;      // afterlength to the tailpiece (Woodhouse's 2.4 kN/m)
  const strs = S.strings || [{ T: 61, EA: 10130, L: 0.50 }, { T: 60, EA: 12000, L: 0.667 }, { T: 46, EA: 17100, L: 0.667 }, { T: 62, EA: 14600, L: 0.667 }, { T: 61, EA: 10130, L: 0.667 }];
  let kStr = 0, kStrPsi = 0, Ttot = 0;
  strs.forEach((st, i) => {
    const k = st.EA * Math.sin(beta) ** 2 / (st.L + after) + st.T * Math.cos(beta) ** 2 / after;
    kStr += k; kStrPsi += k * BRIDGE_Y[i] ** 2; Ttot += st.T;
  });
  // head stiffening under the down-force: the fitted 20 kN/m total minus the strings' ~7.4 at 13 deg, 5.33 kN/m,
  // proportional to the down-force (string tension x sin of the break angle)
  const Fd = Ttot * Math.sin(beta), Fd0 = 290 * Math.sin(13 * Math.PI / 180);
  const kHead = 12600 * (Fd / Fd0) * Math.sqrt(Th / 5330);
  const ks = kStr + kHead, kPsi = kStrPsi + kHead * (Lb * Lb / 12);

  // ---------- assemble ----------
  const iz = NM, ip = NM + 1, ib = NM + 2, iu = NM + 3, ia = NM + 4, N = NM + 5;
  const Mv = new Float64Array(N), Cv = new Float64Array(N);
  const K = []; for (let i = 0; i < N; i++) K.push(new Float64Array(N));
  for (let i = 0; i < NM; i++) { Mv[i] = modes[i].M; K[i][i] = modes[i].K; }
  const Ib = mb * Lb * Lb / 12, mBend = 0.8 * mb, mSway = 0.3 * mb;
  Mv[iz] = mb; Mv[ip] = Ib; Mv[ib] = mBend; Mv[iu] = mSway;
  // feet: contact springs (wood foot plus the head's local compliance the truncated modes leave out)
  const r0 = 0.004;
  const kWood = 4e6;
  feet.forEach((y, f) => {
    const p = footPts[f];
    // Dirichlet disc Green's function at the foot (regularized over the foot radius) minus what the kept modes supply
    const d2 = p.r * p.r;
    const Ctot = Math.log((a * a - d2) / (a * r0)) / (TAU * Th);
    let Ckept = 0; for (const md of modes) Ckept += md.foot[f] * md.foot[f] / md.K;
    const Cres = Math.max(0.05 * Ctot, Ctot - Ckept);
    const kc = S.bare ? 0 : 1 / (1 / kWood + Cres);
    const g = new Map();
    for (let i = 0; i < NM; i++) if (modes[i].foot[f] !== 0) g.set(i, -modes[i].foot[f]);
    g.set(iz, 1); g.set(ip, y); g.set(ib, chi(y));
    for (const [i, gi] of g) for (const [j, gj] of g) K[i][j] += kc * gi * gj;
  });
  if (!S.bare) { K[iz][iz] += ks; K[ip][ip] += kPsi; }
  // bending: Woodhouse et al. 2021b found the first bending resonance ~5 kHz once on the head (2.5 kHz free); this
  // three-foot bar with point feet is stiffer to bend than the real bridge, so its free value is set to land near 5 kHz
  const kBend = mBend * (TAU * (S.bendHz || 4600)) ** 2; K[ib][ib] += kBend;
  // sway: the top on its legs, relative to the rolled frame
  const kSway = mSway * (TAU * (S.swayHz || 2900)) ** 2;
  K[iu][iu] += kSway; K[iu][ip] -= kSway * hb; K[ip][iu] -= kSway * hb; K[ip][ip] += kSway * hb * hb;
  // air behind the head
  const Sh = Math.PI * a * a;
  let V, So, ell, Rport, airName;
  const hold = S.hold || 'lap';
  if (S.back === 'resonator') {
    V = Sh * (S.potDepth + 0.04);
    So = TAU * (a + 0.03) * 0.006;                                  // annular gap around the flange
    ell = 0.03; airName = 'resonator';
  } else {
    // a belly against the back closes part of the opening and soaks up the air's motion
    const block = hold === 'belly' ? 0.72 : hold === 'lap' ? 0.15 : 0;
    V = Sh * S.potDepth; So = Sh * (1 - block);
    ell = 0.405 * (S.potDepth + 0.6 * a) ** 2 / S.potDepth * (1 + 1.5 * block);
    airName = 'pot';
  }
  const mAir = RHO * ell * So;
  Mv[ia] = mAir;
  const kAir = RHO * C_AIR * C_AIR / V;
  {
    const g = new Map();
    for (let i = 0; i < NM; i++) if (modes[i].vol) g.set(i, modes[i].vol);
    g.set(ia, So);
    for (const [i, gi] of g) for (const [j, gj] of g) K[i][j] += kAir * gi * gj;
  }
  const fAir = Math.sqrt(kAir * So * So / mAir) / TAU;
  {
    const w = TAU * fAir;
    Rport = So * So * RHO * w * w / (4 * Math.PI * C_AIR);         // radiation of a small monopole
    const visc = S.back === 'resonator' ? mAir * w / 12 : mAir * w / 60;   // gap friction / wall losses
    const belly = S.back !== 'resonator' && hold === 'belly' ? mAir * w / 2.5 : 0;
    Cv[ia] = visc + belly;
  }
  // damping of each part
  for (let i = 0; i < NM; i++) {
    const md = modes[i], f = md.f0;
    const stuff = ST.a + ST.b * Math.min(1, f / 2000);
    const holdLoss = S.back !== 'resonator' ? (hold === 'belly' ? 0.004 : 0) : 0;
    md.eta = H.eta + RG.edge + stuff + holdLoss;
    Cv[i] = md.eta * Math.sqrt(md.K * md.M);
  }
  Cv[iz] = 1.0;                                                     // Woodhouse et al.'s added dashpot, N s/m
  Cv[ip] = 1.0 * Lb * Lb / 12;
  Cv[ib] = 0.02 * Math.sqrt(kBend * mBend);
  Cv[iu] = 0.6 * Math.sqrt(kSway * mSway);

  // symmetric scaling and solve
  // region centroids (head centre origin; x toward the neck, y bass side, z out of the head)
  const rc = 0.684 * a, zBack = S.back === 'resonator' ? -0.03 : -S.potDepth;
  const cen = [[0, 0, 0], [rc, 0, 0], [0, rc, 0], [-rc, 0, 0], [0, -rc, 0], [0, 0, -0.02], [0, 0, zBack]];
  const dist = cen.map(p => cen.map(q => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])));
  const sq = Float64Array.from(Mv, Math.sqrt);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) K[i][j] /= sq[i] * sq[j];
  // The bridge sits on the string axis and its feet are symmetric about it, so the problem splits exactly into modes
  // symmetric about that axis (cos modes, heave, bending, air) and antisymmetric ones (sin modes, roll, sway):
  // two half-size eigenproblems.
  const blocks = [[], []];
  for (let i = 0; i < NM; i++) blocks[modes[i].o].push(i);
  blocks[0].push(iz, ib, ia); blocks[1].push(ip, iu);
  const sols = [];
  for (const idx of blocks) {
    const nb = idx.length, A = [];
    for (let r = 0; r < nb; r++) { const row = new Float64Array(nb), Kr = K[idx[r]]; for (let c = 0; c < nb; c++) row[c] = Kr[idx[c]]; A.push(row); }
    const Eb = symEig(A, nb);
    for (let k = 0; k < nb; k++) sols.push({ lam: Eb.d[k], idx, V: Eb.V, k });
  }
  sols.sort((p, q) => p.lam - q.lam);
  const out = { n: 0, f: [], Q: [], P: [], R: [], A: [], E: [], fAir, airName, Th, a, xb, ks, kHead, kStr, NM };
  const keepF = S.fKeep;
  for (const so of sols) {
    const lam = so.lam; if (!(lam > 0)) continue;
    const w = Math.sqrt(lam), f = w / TAU;
    if (f < 40 || f > keepF) continue;
    const phi = new Float64Array(N);
    for (let r = 0; r < so.idx.length; r++) { const i = so.idx[r]; phi[i] = so.V[r][so.k] / sq[i]; }
    let c = 0; for (let i = 0; i < N; i++) c += Cv[i] * phi[i] * phi[i];
    const reg = new Float64Array(7);
    for (let i = 0; i < NM; i++) { const r = modes[i].reg, x = phi[i]; if (x) for (let q = 0; q < 5; q++) reg[q] += r[q] * x; }
    reg[6] = So * phi[ia];
    // radiation damping from the mode's own sources: point monopoles at the region centroids (free field), so front/back
    // and opposite-phase regions cancel as they do at long wavelengths
    const kk = w / C_AIR; let sum = 0;
    for (let p = 0; p < 7; p++) { if (!reg[p]) continue; for (let q = 0; q < 7; q++) { if (!reg[q]) continue; const r = dist[p][q], x = kk * r; sum += reg[p] * reg[q] * (x > 1e-6 ? Math.sin(x) / x : 1); } }
    const cRad = RHO * C_AIR * kk * kk / (4 * Math.PI) * Math.max(0, sum);
    c += cRad;
    const Q = Math.min(800, Math.max(2, w / Math.max(1e-9, c)));
    // edge force per unit modal coordinate on each ring order (one-way drive of the tone ring)
    const edge = new Float64Array(10);
    for (let i = 0; i < NM; i++) { const md = modes[i]; if (md.m >= 2 && md.m < 10 && md.o === 0) edge[md.m] += Th * md.slope * Math.PI * a * phi[i]; }
    if (S.debug) (out.phi = out.phi || []).push(phi);
    out.f.push(f); out.Q.push(Q); out.P.push([phi[iz], phi[ip], phi[ib], phi[iu]]); out.R.push(reg); out.A.push(phi[ia]); out.E.push(edge);
  }
  out.nDense = out.f.length; if (S.debug) { out.modes = modes; out.Mv = Mv; }
  extendStatistical(out, S, { a, cm, sigma, H, RG, ST });
  out.n = out.f.length;
  // tone ring modes (out-of-plane bending of a ring, Hoppe/Rayleigh with torsion term)
  out.ring = [];
  if (RG.ring) {
    const rg = RG.ring, E0 = 100e9, rho = 8600, Rr = S.headD / 2 + 0.004;
    const Aa = rg.w * rg.h, I = rg.w * rg.h ** 3 / 12, base = Math.sqrt(E0 * I / (rho * Aa)) / (TAU * Rr * Rr);
    for (let nn = 2; nn < 10; nn++) {
      const f = base * nn * (nn * nn - 1) / Math.sqrt(nn * nn + 1 + 0.3);
      if (f > 9000) break;
      out.ring.push({ order: nn, f, Q: rg.Q, m: rg.mass / 2, area: TAU * Rr * rg.w * 0.25 });
    }
  }
  out.bridge = { mass: mb, Lb, hb, y: BRIDGE_Y.slice(), chi: BRIDGE_Y.map(chi) };
  return out;
}

// Statistical continuation above the dense band: representative modes spaced `sp` Hz apart stand for the many real
// ones (membrane modal density ~ 2 pi A f / c^2 per Hz); their projections carry the dense model's top-band mean
// conductance per bridge coordinate, extrapolated along its trend; Q is capped so neighbours overlap as real ones do.
function extendStatistical(out, S, ctx) {
  const nD = out.f.length; if (!nD) return;
  const fTop = out.f[nD - 1], f0 = 0.55 * fTop;
  // mean squared projection per Hz in [f0, fTop] for each coordinate and region strength
  const acc = [0, 0, 0, 0], accLo = [0, 0, 0, 0]; let regS = 0, nTop = 0, nLo = 0, airS = 0;
  const fMid = (f0 + fTop) / 2;
  for (let i = 0; i < nD; i++) {
    const f = out.f[i]; if (f < f0) continue;
    const p = out.P[i];
    const tgt = f > fMid ? acc : accLo;
    for (let d = 0; d < 4; d++) tgt[d] += p[d] * p[d];
    if (f > fMid) nTop++; else nLo++;
    let r2 = 0; for (let q = 0; q < 5; q++) r2 += out.R[i][q] ** 2; regS += r2; airS += out.R[i][6] ** 2;
  }
  const nAll = Math.max(1, nTop + nLo);
  const band = (fTop - fMid) || 1;
  const dens = acc.map(x => x / band), densLo = accLo.map(x => x / band);
  // per-coordinate power-law trend between the two halves of the top band (clamped)
  const slope = dens.map((x, d) => Math.max(-3, Math.min(1.5, Math.log(Math.max(1e-30, x) / Math.max(1e-30, densLo[d])) / Math.log((fTop + fMid) / (fMid + f0)))));
  const regRms = Math.sqrt(regS / nAll), airRms = Math.sqrt(airS / nAll);
  // representative spacing and the number of real modes each stands for
  let rng = (S.seed || 7) >>> 0 || 1;
  const rnd = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 4294967296; };
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2247;
  const sp = S.statSpacing || 45;
  const realSpacing = (f) => (ctx.cm * ctx.cm) / (TAU * Math.PI * ctx.a * ctx.a * f);
  for (let f = fTop + sp * (0.5 + rnd()); f < S.fMax; f += sp * (0.6 + 0.8 * rnd())) {
    const p = [0, 0, 0, 0];
    for (let d = 0; d < 4; d++) {
      const pd = dens[d] * Math.pow(f / ((fTop + fMid) / 2), slope[d]) * sp;   // expected p^2 for this representative
      p[d] = gauss() * Math.sqrt(Math.max(0, pd));
    }
    const eta = ctx.H.eta + ctx.RG.edge + 0.006 * Math.pow(290 / f, 0.9) + ctx.ST.a + ctx.ST.b;
    let Q = Math.min(1 / eta, f / (1.4 * sp));
    // bridge losses grow with the bridge's share of the motion; keep the dense band's typical high-frequency Q range
    Q = Math.max(6, Q);
    const rep = Math.sqrt(sp / realSpacing(f));
    const reg = new Float64Array(7);
    const k = Math.floor(rnd() * 5);
    reg[k] = (rnd() < 0.5 ? -1 : 1) * regRms * Math.sqrt(sp / Math.max(1, nAll / band * sp)) * (0.6 + 0.8 * rnd()) * Math.pow(fTop / f, 0.5);
    reg[6] = gauss() * airRms * 0.3 * Math.pow(fTop / f, 1);
    out.f.push(f); out.Q.push(Q); out.P.push(p); out.R.push(reg); out.A.push(0); out.E.push(new Float64Array(10));
    void rep;
  }
}

// 2x2 bridge admittance seen by string s at angular frequency w: [yyRe, yyIm, yzRe, yzIm, zzRe, zzIm]
// (y along the head across the strings, z normal to the head)
function potAdmittance(pot, s, w, out) {
  const ys = pot.bridge.y[s], cs = pot.bridge.chi[s];
  let yyR = 0, yyI = 0, yzR = 0, yzI = 0, zzR = 0, zzI = 0;
  const w2 = w * w;
  for (let k = 0; k < pot.n; k++) {
    const wk = TAU * pot.f[k], P = pot.P[k];
    const pz = P[0] + ys * P[1] + cs * P[2], py = P[3];
    const re = wk * wk - w2, im = w * wk / pot.Q[k];
    const den = re * re + im * im;
    const yr = (w * im) / den, yi = (w * re) / den;
    zzR += yr * pz * pz; zzI += yi * pz * pz;
    yyR += yr * py * py; yyI += yi * py * py;
    yzR += yr * py * pz; yzI += yi * py * pz;
  }
  out[0] = yyR; out[1] = yyI; out[2] = yzR; out[3] = yzI; out[4] = zzR; out[5] = zzI;
  return out;
}

root.BanjoPot = { buildPot, potAdmittance, besselAll, besselJ, besselZeros, symEig, ddToTension, HEADS, RINGS, STUFF, BRIDGE_Y };
})(typeof globalThis !== 'undefined' ? globalThis : this);
