// BanJo — the hands: what a banjo player's left and right hands do with the notes you play.
//
// LEFT HAND. Notes held together (gathered within a short window) are a chord. The fretting hand finds a banjo shape for
// it on the four long strings: every string sounds in banjo rolls, so each one gets a chord tone; span, fingers (a barre
// can't cover an open string), open strings, low position and the distance from the last shape decide. The short 5th
// string is the drone: open, whatever the chord (the banjo's signature dissonance), unless "drone follows the chord".
// Notes played above a held chord while a pattern runs are melody: they take a string and the roll plays them there.
// RIGHT HAND. Patterns are eighth-note cells per bar:
//   Scruggs three-finger rolls (thumbpick + two metal fingerpicks): T = thumb (down), I = index, M = middle (up).
//   Clawhammer / frailing: the back of the nail strikes down on a string (bum), brushes down across the top strings
//   (dit), and the thumb catches the 5th string (ty); drop-thumb sends the thumb to an inner string instead.
//   Backup "chop": a pinch on 2 and 4 in a closed shape, damped at once by easing the fretting fingers.
// FREE PLAYING. Single notes pick a string: "melodic" spreads consecutive notes over different strings so they ring
// into each other (Keith / melodic style, the 5th string included); "single-string" keeps the hand in a position and
// alternates thumb and index (Reno style). A note pressed while the last is held is a hammer-on, pull-off or slide.
// TIMING (shared with Acoustic's hand model): a slow AR(1) drift of the whole hand plus note-to-note jitter that grows
// with the interval; per-pluck level scatter; thumb accents on the beat; a little swing; bluegrass pushes the beat.
// Magnitudes are the guitar measurements Acoustic uses (Heijink & Meulenbroek 2002; Nezio Malta 2012) - no comparable
// banjo measurements are published, so treat them as estimates for banjo.

(function (root) {
'use strict';
const NS = 5, MAXFRET = 15;
const IDX = (n) => 5 - n;                    // banjo string number (1..5) -> engine string index
const NUM = (i) => 5 - i;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const gauss = (r) => (r() + r() + r() + r() - 2) * 1.7321;
const dB = (x) => Math.pow(10, x / 40);   // velocity scatter: output level is steeper than vel^1.3 here (pick model + release time)
function makeRng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// ---------- right-hand patterns: 8 eighth-notes per bar ----------
// tokens: T/I/M + string number (b = the chord's bass: 3rd or 4th, whichever carries the root), P = pinch (T+M, or
// listed fingers), '-' rest. Clawhammer: S = nail strike (m = melody string, b = bass), B = brush, H = thumb on the
// 5th, D<n> = drop-thumb to string n. Vamp: C = chop pinch, X = release (damp).
const STYLES = {
  forward:   { name: 'Forward roll (T I M T I M T M)', kind: 'roll', steps: ['Tb', 'I2', 'M1', 'T5', 'I2', 'M1', 'T5', 'M1'], swing: 0.52, push: -0.004, spot: 0.06 },
  backward:  { name: 'Backward roll (M I T M I T M I)', kind: 'roll', steps: ['M1', 'I2', 'T5', 'M1', 'I2', 'T5', 'M1', 'I2'], swing: 0.52, push: -0.004, spot: 0.06 },
  fwdrev:    { name: 'Forward-reverse roll (T I M T M I T M)', kind: 'roll', steps: ['Tb', 'I2', 'M1', 'T5', 'M1', 'I2', 'Tb', 'M1'], swing: 0.52, push: -0.004, spot: 0.06 },
  altthumb:  { name: 'Alternating-thumb roll (T I T M T I T M)', kind: 'roll', steps: ['T3', 'I2', 'T5', 'M1', 'T4', 'I2', 'T5', 'M1'], swing: 0.53, push: -0.004, spot: 0.06 },
  foggy:     { name: 'Foggy Mountain roll (I M T M I M T M)', kind: 'roll', steps: ['I2', 'M1', 'T5', 'M1', 'I2', 'M1', 'T5', 'M1'], swing: 0.52, push: -0.004, spot: 0.06 },
  pinchroll: { name: 'Pinch and roll (P I T M P I T M)', kind: 'roll', steps: ['Pb1', 'I2', 'T5', 'M1', 'Pb1', 'I2', 'T5', 'M1'], swing: 0.52, push: -0.003, spot: 0.06 },
  pinches:   { name: 'Pinches on the beat', kind: 'roll', steps: ['Pb21', '-', 'P521', '-', 'Pb21', '-', 'P521', '-'], swing: 0.5, push: -0.002, spot: 0.07 },
  claw:      { name: 'Clawhammer bum-ditty', kind: 'claw', steps: ['Sm', '-', 'B', 'H', 'Sb', '-', 'B', 'H'], swing: 0.58, push: 0, spot: 0.25 },
  clawdouble:{ name: 'Clawhammer, double thumbing', kind: 'claw', steps: ['Sm', 'H', 'Sb', 'H', 'Sm', 'H', 'B', 'H'], swing: 0.57, push: 0, spot: 0.25 },
  clawdrop:  { name: 'Clawhammer, drop thumb', kind: 'claw', steps: ['Sm', '-', 'B', 'D2', 'Sb', '-', 'B', 'H'], swing: 0.58, push: 0, spot: 0.25 },
  frail:     { name: 'Frailing strum (bum-ditty brushes)', kind: 'claw', steps: ['B', '-', 'B', 'H', 'B', '-', 'B', 'H'], swing: 0.58, push: 0, spot: 0.25 },
  vamp:      { name: 'Backup chop (2 and 4)', kind: 'vamp', steps: ['-', '-', 'C', 'X', '-', '-', 'C', 'X'], swing: 0.5, push: -0.006, spot: 0.07 }
};
const MOTOR = {
  driftSd: [0.016, 0.006], jitK: [0.07, 0.025], velSdDb: [3.0, 1.9],
  repeat: { T: 0.11, I: 0.14, M: 0.15, S: 0.13 }
};
const lerp = (p, k) => p[0] + (p[1] - p[0]) * k;

// ---------- left hand ----------
function fingersNeeded(fr) {
  const f = fr.filter(x => x > 0); if (!f.length) return 0;
  const min = Math.min(...f), at = []; fr.forEach((x, s) => { if (x === min) at.push(s); });
  let barre = at.length >= 2;
  for (let s = at[0]; barre && s <= at[at.length - 1]; s++) if (fr[s] === 0) barre = false;
  return barre ? 1 + f.length - at.length : f.length;
}
function spanOf(fr) { const f = fr.filter(x => x > 0); return f.length ? Math.max(...f) - Math.min(...f) : 0; }
// Banjo shape for a chord: frets for engine strings 1..4 (4th..1st); index 0 is the 5th string (drone).
function shapeFor(notes, open, prevPos, opts) {
  const pcs = [...new Set(notes.map(n => ((n % 12) + 12) % 12))];
  if (!pcs.length) return null;
  const root0 = ((Math.min(...notes) % 12) + 12) % 12;
  const closed = opts && opts.closed;
  let best = null, bestC = Infinity;
  const fr = [0, 0, 0, 0, 0];
  const cand = [];
  for (let s = 1; s < 5; s++) {
    const list = [];
    for (let f = 0; f <= MAXFRET; f++) if (pcs.includes((open[s] + f) % 12)) list.push(f);
    cand.push(list);
  }
  const rec = (k) => {
    if (k === 4) {
      const f4 = fr.slice(1);
      const sp = spanOf(f4); if (sp > 4) return;
      if (fingersNeeded(f4) > 4) return;
      const opens = f4.filter(x => x === 0).length;
      if (closed && opens) return;
      const fz = f4.filter(x => x > 0), pos = fz.length ? Math.min(...fz) : 0;
      const got = new Set(f4.map((f, i) => (open[i + 1] + f) % 12));
      let c = 0;
      for (const p of pcs) if (!got.has(p)) c += p === root0 ? 6 : 3;
      c += sp * sp * 0.25 + pos * 0.25 - opens * (closed ? 0 : 0.6);
      // the bass strings (4th, 3rd) ideally carry the root
      if ((open[1] + fr[1]) % 12 !== root0 && (open[2] + fr[2]) % 12 !== root0) c += 0.4;
      if (prevPos != null) c += Math.abs(pos - prevPos) * (closed ? 0.25 : 0.12);
      if (closed) c += Math.abs(pos - 5) * 0.12;   // backup shapes sit in the middle of the neck
      if (c < bestC) { bestC = c; best = fr.slice(); }
      return;
    }
    for (const f of cand[k]) { fr[k + 1] = f; rec(k + 1); }
  };
  rec(0);
  if (!best) return null;
  // the drone: open, or (if asked) nudged up to the nearest chord tone within four frets of its pip
  best[0] = 0;
  if (opts && opts.drone === 'follow' && !pcs.includes(open[0] % 12)) {
    for (let f = 1; f <= 4; f++) if (pcs.includes((open[0] + f) % 12)) { best[0] = f; break; }
  }
  const fz = best.slice(1).filter(x => x > 0);
  return { frets: best, pos: fz.length ? Math.min(...fz) : 0, root: root0, rootString: (open[1] + best[1]) % 12 === root0 ? 1 : (open[2] + best[2]) % 12 === root0 ? 2 : 2 };
}
// exact notes -> strings (as played); unfilled strings are left damped
function shapePlayed(notes, open, prevPos) {
  notes = [...new Set(notes)].sort((a, b) => a - b).slice(-5);
  let best = null, bestC = Infinity;
  const strs = [0, 1, 2, 3, 4];
  const rec = (i, used, fr, c) => {
    if (c >= bestC) return;
    if (i === notes.length) {
      const f4 = fr.slice(1).map(x => x < 0 ? -1 : x);
      if (spanOf(f4.filter(x => x >= 0)) > 4 || fingersNeeded(f4.map(x => Math.max(0, x))) > 4) return;
      if (c < bestC) { bestC = c; best = fr.slice(); }
      return;
    }
    for (const s of strs) {
      if (used & (1 << s)) continue;
      const f = notes[i] - open[s];
      if (f < 0 || f > MAXFRET) continue;
      if (s === 0 && f !== 0 && f < 1) continue;
      fr[s] = f;
      const cc = c + (f === 0 ? -0.5 : 0.2 * f) + (prevPos != null && f > 0 ? 0.1 * Math.abs(f - prevPos) : 0) + (s === 0 && f > 0 ? 2 : 0);
      rec(i + 1, used | (1 << s), fr, cc);
      fr[s] = -1;
    }
  };
  rec(0, 0, [-1, -1, -1, -1, -1], 0);
  if (!best) return null;
  const fz = best.filter(x => x > 0);
  return { frets: best, pos: fz.length ? Math.min(...fz) : 0, root: ((notes[0] % 12) + 12) % 12, rootString: 2, played: true };
}

class BanjoHands {
  constructor(opts) {
    this.send = opts.send; this.now = opts.now;
    this.onShape = opts.onShape || (() => {}); this.onPluck = opts.onPluck || (() => {});
    this.timers = opts.timers || { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h) };
    this.rng = makeRng(opts.seed || 777);
    this.o = { style: 'forward', mode: 'pattern', picks: 'picks', bpm: 132, skill: 0.6, humanize: 0.6, licks: 0.3, spot: null,
      drone: 'open', voicing: 'banjo', legato: 'auto', swing: null, gather: 0.018, tuning: [67, 50, 55, 59, 62], capo: 0, spike: 0,
      freeStyle: 'melodic', strength: 0.62, slide: 0.5 };
    this.held = new Map();            // midi -> {vel, t}
    this.pending = []; this.gTimer = null;
    this.shape = { frets: [0, 0, 0, 0, 0], pos: 0, root: 7, rootString: 2 };
    this.melody = new Map();          // string idx -> midi
    this.running = false; this.step = 0; this.tGrid = 0; this.drift = 0; this.timer = null;
    this.sustain = false; this.lastFinger = {}; this.lastNote = null; this.lastString = null; this.freeHeld = new Map();
    this.chop = false;
  }
  set(o) { Object.assign(this.o, o); if (o.style && this.running) { this.step = this.step % 8; } }
  open() { const t = this.o.tuning; return [t[0] + (this.o.spike | 0), t[1] + this.o.capo, t[2] + this.o.capo, t[3] + this.o.capo, t[4] + this.o.capo]; }
  style() { return STYLES[this.o.style] || STYLES.forward; }
  skill() { return clamp(this.o.skill ?? 0.6, 0, 1); }
  hum() { return (this.o.humanize ?? 0.6) / 0.6; }
  stepDur() { return 60 / Math.max(30, this.o.bpm || 120) / 2; }
  spot() { return this.o.spot != null ? this.o.spot : this.style().spot; }

  // ---------- input ----------
  noteOn(midi, vel, t) {
    this.held.set(midi, { vel, t: t ?? this.now() });
    if (this.o.mode === 'free') { this.freeNote(midi, vel, t ?? this.now()); return; }
    // over a running pattern a new note above the chord is melody
    if (this.running && this.pending.length === 0 && this.chordNotes && midi > Math.max(...this.chordNotes)) { this.addMelody(midi, vel); return; }
    this.pending.push(midi);
    if (!this.gTimer) this.gTimer = this.timers.set(() => this.flush(), this.o.gather * 1000);
  }
  noteOff(midi) {
    this.held.delete(midi);
    if (this.o.mode === 'free') { this.freeOff(midi); return; }
    for (const [s, m] of this.melody) if (m === midi) { this.melody.delete(s); this.applyFret(s, this.shape.frets[s], true); }
    if (!this.sustain && this.chordNotes && this.chordNotes.every(n => !this.held.has(n)) && !this.pending.length) this.stopSoon();
  }
  // a released chord keeps the pattern going for a moment, so changing chords doesn't restart the roll
  stopSoon() {
    if (this.stopTimer) this.timers.clear(this.stopTimer);
    this.stopTimer = this.timers.set(() => { this.stopTimer = null; if (!this.sustain && (!this.chordNotes || this.chordNotes.every(n => !this.held.has(n))) && !this.pending.length) this.stop(); }, this.stepDur() * 1500);
  }
  setSustain(on) {
    this.sustain = on;
    if (!on && this.running && (!this.chordNotes || this.chordNotes.every(n => !this.held.has(n)))) this.stopSoon();
  }
  flush() {
    this.timers.clear(this.gTimer); this.gTimer = null;
    const notes = this.pending.splice(0);
    if (!notes.length) return;
    const heldNow = [...this.held.keys()];
    const chordSet = notes.length >= 2 ? notes : heldNow.length >= 2 ? heldNow : notes;
    this.setChord(chordSet, Math.max(...notes.map(n => (this.held.get(n) || { vel: 0.7 }).vel)));
  }
  setChord(notes, vel) {
    const st = this.style(), open = this.open();
    const sh = this.o.voicing === 'played' ? shapePlayed(notes, open, this.shape.pos)
      : shapeFor(notes, open, this.shape.pos, { drone: this.o.drone, closed: st.kind === 'vamp' });
    if (!sh) return;
    if (this.stopTimer) { this.timers.clear(this.stopTimer); this.stopTimer = null; }
    const old = this.shape;
    this.chordNotes = notes.slice();
    this.melody.clear();
    this.shape = sh;
    // fretting-hand change: strings whose fret changes lose their old note (fingers lift or press)
    const t = this.now();
    for (let s = 0; s < NS; s++) if (old.frets[s] !== sh.frets[s]) this.send([{ type: 'damp', s, time: 0.03, amt: 30, t: t + 0.005 }]);
    this.onShape(sh.frets.slice());
    this.vel = vel;
    if (this.o.mode === 'pattern') { if (!this.running) this.start(t + 0.03); }
    else this.pinchNow(vel, t + 0.01);
  }
  addMelody(midi, vel) {
    // a string that reaches the note close to the hand's position; prefer the 1st and 2nd strings, then the 5th
    const open = this.open(), pos = this.shape.pos;
    let best = -1, bc = Infinity;
    for (let s = 0; s < NS; s++) {
      const f = midi - open[s]; if (f < 0 || f > MAXFRET) continue;
      if (s === 0 && f !== 0) continue;
      const c = (f === 0 ? -0.3 : Math.abs(f - Math.max(1, pos)) * 0.5) + (s === 4 ? 0 : s === 3 ? 0.4 : s === 0 ? 0.6 : 1.2);
      if (c < bc) { bc = c; best = s; }
    }
    if (best < 0) return;
    this.melody.set(best, midi); this.melodyAccent = { s: best, vel };
    this.applyFret(best, midi - open[best], false);
    this.forceNext = best;
  }
  applyFret(s, f, lift) { void s; void f; void lift; }

  // ---------- pattern scheduling ----------
  start(t) { this.running = true; this.step = 0; this.tGrid = t; this.drift = 0; this.sched(); }
  stop() { this.running = false; if (this.timer) this.timers.clear(this.timer); this.timer = null; this.melody.clear(); }
  sched() {
    if (!this.running) return;
    const look = 0.12, now = this.now();
    while (this.tGrid < now + look) {
      this.emitStep(this.step, this.tGrid);
      this.step = (this.step + 1) % 8;
      this.tGrid += this.stepDur();
      if (this.tGrid < now - 0.05) this.tGrid = now + 0.01;   // fell behind (tab hidden): resync
    }
    this.timer = this.timers.set(() => this.sched(), 25);
  }
  swingRatio() { const s = this.o.swing != null ? this.o.swing : this.style().swing; const bpm = this.o.bpm || 120; return 0.5 + (s - 0.5) * clamp(1.5 - bpm / 240, 0.3, 1); }
  emitStep(k, tGrid) {
    const st = this.style(), tok = st.steps[k % st.steps.length];
    const d = this.stepDur();
    const sw = this.swingRatio(), off = k % 2 === 1 ? (sw - 0.5) * 2 * d : 0;
    const sk = this.skill(), hum = this.hum();
    this.drift = 0.9 * this.drift + Math.sqrt(1 - 0.81) * gauss(this.rng) * lerp(MOTOR.driftSd, sk) * hum;
    const t = tGrid + off + st.push + this.drift;
    if (tok === '-') return;
    const evs = [];
    this.action(tok, t, k, d, evs);
    if (evs.length) this.send(evs);
  }
  jit(ioi) { const sd = Math.sqrt(0.004 ** 2 + (lerp(MOTOR.jitK, this.skill()) * ioi) ** 2) * this.hum(); return gauss(this.rng) * sd; }
  velN() { return dB(gauss(this.rng) * lerp(MOTOR.velSdDb, this.skill()) * this.hum()); }
  midiOf(s) { const open = this.open(); if (this.melody.has(s)) return this.melody.get(s); const f = this.shape.frets[s]; return f < 0 ? null : open[s] + f; }
  bassString() { return this.shape.rootString === 1 ? 1 : 2; }
  // string number token -> engine string, honouring the forced melody string and the bass
  resolve(ch) { if (ch === 'b') return this.bassString(); return IDX(+ch); }
  action(tok, t, k, d, evs) {
    const st = this.style(), picks = this.o.picks === 'picks';
    const accentBeat = k % 2 === 0 ? (k % 4 === 0 ? 1.12 : 1.05) : 0.95;
    const base = (this.vel ?? 0.7) * this.o.strength / 0.75;
    const f0 = tok[0];
    if (st.kind === 'roll') {
      if (f0 === 'P') {
        // pinch: thumb plus fingers together (the thumb leads a few ms)
        const list = tok.slice(1).split('');
        const fingers = list.length === 2 ? ['T', 'M'] : list.length === 3 ? ['T', 'I', 'M'] : ['T', 'I', 'M'];
        list.forEach((ch, i) => this.pluckFinger(evs, fingers[i] || 'M', this.resolve(ch), t + (i ? 0.004 + 0.003 * this.rng() : 0) + this.jit(d), base * accentBeat * (i === 0 ? 1.05 : 0.95), picks));
        return;
      }
      let s = this.resolve(tok.slice(1));
      // melody: the step after a new melody note goes to its string with the finger that reaches it
      let acc = 1;
      if (this.forceNext != null && (f0 === 'M' || f0 === 'I' || (f0 === 'T' && this.forceNext <= 2))) { s = this.forceNext; this.forceNext = null; acc = 1.25; }
      else if (this.melody.has(s)) acc = 1.15;
      const fing = f0;
      // licks: a thumb note on a fretted chord tone sometimes slides or hammers in from below (Scruggs vocabulary)
      const f = this.melody.has(s) ? this.melody.get(s) - this.open()[s] : this.shape.frets[s];
      if (this.o.licks > 0 && s !== 0 && f != null && f >= 0 && k % 4 === 0 && this.rng() < this.o.licks * 0.5) {
        const m = this.midiOf(s);
        if (f >= 2 && this.rng() < 0.55) { this.slideIn(evs, fing, s, m, f, t + this.jit(d), base * accentBeat * acc, picks, d); return; }
        if (f >= 1 || this.rng() < 0.6) { this.hammerIn(evs, fing, s, m, f, t + this.jit(d), base * accentBeat * acc, picks, d); return; }
      }
      this.pluckFinger(evs, fing, s, t + this.jit(d), base * accentBeat * acc, picks);
      return;
    }
    if (st.kind === 'claw') {
      const tt = t + this.jit(d);
      if (f0 === 'S') {
        // strike: melody string (1st, or a held melody string) or the bass (3rd / 4th), alternating
        let s = tok[1] === 'm' ? (this.forceNext != null ? this.forceNext : [...this.melody.keys()][0] ?? 4) : this.bassString();
        if (tok[1] === 'm') this.forceNext = null;
        this.strike(evs, s, tt, base * (k % 4 === 0 ? 1.12 : 1.02));
        return;
      }
      if (f0 === 'B') { this.brush(evs, tt, base * 0.82, k); return; }
      if (f0 === 'H') { this.thumb5(evs, tt, base * 0.78); return; }
      if (f0 === 'D') { this.dropThumb(evs, IDX(+tok[1]), tt, base * 0.85); return; }
    }
    if (st.kind === 'vamp') {
      if (f0 === 'C') {
        // chop: pinch the three top strings (and the bass) of the closed shape...
        const tt = t + this.jit(d);
        [this.bassString(), 3, 4].forEach((s, i) => this.pluckFinger(evs, ['T', 'I', 'M'][i], s, tt + i * 0.003, base * 0.95, picks));
        this.chopAt = tt;
      } else if (f0 === 'X' && this.chopAt != null) {
        // ...and ease the fretting fingers off right away so it stops short
        const tt = this.chopAt + Math.min(0.11, d * 0.55);
        for (let s = 1; s < NS; s++) evs.push({ type: 'damp', s, time: 0.02, amt: 60, t: tt });
        this.chopAt = null;
      }
    }
  }
  // a single right-hand finger plucks string s
  pluckFinger(evs, finger, s, t, vel, picks) {
    const midi = this.midiOf(s);
    if (midi == null) { evs.push({ type: 'pluck', s, vel: vel * 0.5, dead: true, style: finger === 'T' ? (picks ? 'tpick' : 'tflesh') : (picks ? 'fpick' : 'flesh'), dir: finger === 'T' ? -1 : 1, pickPos: this.spot(), t }); return; }
    // the same finger can't repeat faster than it can recover: it arrives late and softer
    const lf = this.lastFinger[finger];
    const minGap = MOTOR.repeat[finger] || 0.13;
    if (lf != null && t - lf < minGap) { t = lf + minGap * (0.9 + 0.2 * this.rng()); vel *= 0.85; }
    this.lastFinger[finger] = t;
    const style = finger === 'T' ? (picks ? 'tpick' : 'tflesh') : (picks ? 'fpick' : 'flesh');
    const v = clamp(vel * this.velN() * (finger === 'T' ? 1.0 : finger === 'M' ? 1.03 : 0.97), 0.05, 1);
    evs.push({ type: 'pluck', s, midi, vel: v, style, dir: finger === 'T' ? -1 : 1, pickPos: this.spot() * (1 + 0.1 * (this.rng() - 0.5)), t });
    this.onPluck(s, finger, t);
  }
  slideIn(evs, finger, s, midi, f, t, vel, picks, d) {
    const from = midi - 2;
    const style = finger === 'T' ? (picks ? 'tpick' : 'tflesh') : (picks ? 'fpick' : 'flesh');
    evs.push({ type: 'pluck', s, midi: from, vel: clamp(vel * this.velN(), 0.05, 1), style, dir: finger === 'T' ? -1 : 1, pickPos: this.spot(), t });
    evs.push({ type: 'glide', s, from, to: midi, dur: Math.min(0.16, d * 0.9) * (0.8 + 0.4 * this.rng()), pressure: 0.8, t: t + 0.02 });
    this.lastFinger[finger] = t; this.onPluck(s, finger, t);
    void f;
  }
  hammerIn(evs, finger, s, midi, f, t, vel, picks, d) {
    const from = f >= 1 ? midi - (f >= 2 ? 2 : 1) : midi;
    const to = f >= 1 ? midi : midi + 2;
    const style = finger === 'T' ? (picks ? 'tpick' : 'tflesh') : (picks ? 'fpick' : 'flesh');
    evs.push({ type: 'pluck', s, midi: from, vel: clamp(vel * this.velN(), 0.05, 1), style, dir: finger === 'T' ? -1 : 1, pickPos: this.spot(), t });
    evs.push({ type: 'hammer', s, from, to, vel: 0.7, t: t + Math.min(0.09, d * 0.5) });
    // an open-string hammer (G -> A on the 3rd) pulls back off on the next eighth
    if (f === 0) evs.push({ type: 'pulloff', s, from: to, to: midi, vel: 0.6, t: t + d * 1.0 });
    this.lastFinger[finger] = t; this.onPluck(s, finger, t);
  }
  // clawhammer strike: the nail falls down through the string toward the head
  strike(evs, s, t, vel) {
    const midi = this.midiOf(s); if (midi == null) return;
    evs.push({ type: 'pluck', s, midi, vel: clamp(vel * this.velN(), 0.05, 1), style: 'nail', dir: -1, pickPos: this.spot() * (1 + 0.08 * (this.rng() - 0.5)), t });
    // the thumb has landed on the 5th string and rests there (a light touch)
    this.onPluck(s, 'S', t);
  }
  brush(evs, t, vel, k) {
    // down across the 1st..3rd (sometimes the 4th) strings, toward the floor: bass side first
    const n = this.rng() < 0.25 ? 4 : 3, dur = 0.012 + 0.012 * this.rng();
    const order = []; for (let s = NS - n; s < NS; s++) order.push(s);
    order.forEach((s, i) => {
      const midi = this.midiOf(s); if (midi == null) return;
      evs.push({ type: 'pluck', s, midi, vel: clamp(vel * (0.8 + 0.25 * (i / n)) * this.velN(), 0.05, 1), style: 'brushnail', dir: -1, pickPos: this.spot(), t: t + dur * i / n });
    });
    this.onPluck(4, 'S', t); void k;
  }
  thumb5(evs, t, vel) {
    const midi = this.midiOf(0); if (midi == null) return;
    evs.push({ type: 'pluck', s: 0, midi, vel: clamp(vel * this.velN(), 0.05, 1), style: 'tflesh', dir: -1, pickPos: this.spot() * 0.9, t });
    this.onPluck(0, 'T', t);
  }
  dropThumb(evs, s, t, vel) {
    const midi = this.midiOf(s); if (midi == null) return;
    evs.push({ type: 'pluck', s, midi, vel: clamp(vel * this.velN(), 0.05, 1), style: 'tflesh', dir: -1, pickPos: this.spot(), t });
    this.onPluck(s, 'T', t);
  }
  pinchNow(vel, t) {
    const evs = [], picks = this.o.picks === 'picks';
    if (this.style().kind === 'claw') { this.strike(evs, 4, t, vel); this.brush(evs, t + 0.004, vel * 0.7, 0); }
    else [this.bassString(), 3, 4].forEach((s, i) => this.pluckFinger(evs, ['T', 'I', 'M'][i], s, t + i * 0.004, vel, picks));
    this.send(evs);
  }

  // ---------- free playing: single notes ----------
  pickString(midi) {
    const open = this.open(), melodic = this.o.freeStyle === 'melodic';
    const pos = this.freePos ?? 0, last = this.lastString;
    let best = -1, bc = Infinity, bf = 0;
    for (let s = 0; s < NS; s++) {
      const f = midi - open[s];
      if (f < 0 || f > MAXFRET) continue;
      if (s === 0 && f > 0) continue;                       // the 5th string plays its open note (spikes aside)
      let c = 0;
      if (melodic) {
        // a different string from the last note so they ring together; open strings and the 5th string are gold
        if (s === last) c += 3;
        if (f === 0) c -= 1.2;
        c += Math.abs(f - pos) * 0.35 + (f > 7 ? 0.3 : 0);
        if (this.freeHeld.has(s)) c += 2.5;
      } else {
        // single-string: stay in position, move across adjacent strings, few open strings
        c += Math.abs(f - pos) * 0.6 + (f === 0 ? 0.6 : 0) + (last != null ? Math.abs(s - last) * 0.5 : 0) + (s === 0 ? 2 : 0);
      }
      if (c < bc) { bc = c; best = s; bf = f; }
    }
    return best < 0 ? null : { s: best, f: bf };
  }
  freeNote(midi, vel, t) {
    // legato: a new note on the string that still holds the last one, within reach
    const lg = this.o.legato;
    if (lg !== 'off' && this.lastNote != null && this.held.has(this.lastNote.midi) && this.lastNote.midi !== midi) {
      const s = this.lastNote.s, open = this.open(), fNew = midi - open[s], fOld = this.lastNote.midi - open[s];
      const dist = Math.abs(fNew - fOld);
      if (s !== 0 && fNew >= 0 && fNew <= MAXFRET && dist <= 7) {
        const evs = [];
        const hammer = (lg === 'hammer' || (lg === 'auto' && dist <= 4)) && lg !== 'slide';
        if (hammer) evs.push({ type: fNew > fOld ? 'hammer' : 'pulloff', s, from: this.lastNote.midi, to: midi, vel, t: t + 0.003 });
        else evs.push({ type: 'glide', s, from: this.lastNote.midi, to: midi, dur: (0.07 + 0.03 * dist) * (1.6 - this.o.slide) * (1.2 - 0.4 * vel), pressure: 0.6 + 0.4 * vel, t: t + 0.003 });
        this.send(evs);
        this.freeHeld.delete(this.lastNote.s); this.freeHeld.set(s, midi);
        this.lastNote = { midi, s }; this.freePos = Math.max(0, fNew - 1);
        this.onShape(this.freeShape());
        return;
      }
    }
    const pick = this.pickString(midi); if (!pick) return;
    const { s, f } = pick;
    // finger: thumb on the 3rd-5th strings, index on the 2nd-3rd, middle on the 1st; never the same finger twice in a row
    let finger = s === 0 ? 'T' : s === 4 ? 'M' : s === 3 ? 'I' : 'T';
    if (this.o.freeStyle !== 'melodic') finger = this.lastFreeFinger === 'T' ? 'I' : 'T';
    else if (finger === this.lastFreeFinger && s !== 0) finger = finger === 'T' ? 'I' : finger === 'I' ? 'M' : 'I';
    this.lastFreeFinger = finger;
    const picks = this.o.picks === 'picks';
    const evs = [];
    if (this.style().kind === 'claw') evs.push({ type: 'pluck', s, midi, vel, style: s === 0 ? 'tflesh' : 'nail', dir: -1, pickPos: this.spot(), t: t + 0.004 });
    else {
      const style = finger === 'T' ? (picks ? 'tpick' : 'tflesh') : (picks ? 'fpick' : 'flesh');
      evs.push({ type: 'pluck', s, midi, vel, style, dir: finger === 'T' ? -1 : 1, pickPos: this.spot(), t: t + 0.004 });
    }
    this.send(evs);
    this.onPluck(s, finger, t);
    this.freeHeld.set(s, midi); this.lastString = s; this.lastNote = { midi, s };
    if (f > 0) this.freePos = Math.max(0, f - 1);
    this.onShape(this.freeShape());
  }
  freeOff(midi) {
    for (const [s, m] of this.freeHeld) if (m === midi) {
      this.freeHeld.delete(s);
      // fretted notes stop when the finger lifts; open strings ring on unless the sustain pedal is up and they're re-struck
      const f = midi - this.open()[s];
      if (f > 0 && !this.sustain) this.send([{ type: 'damp', s, time: 0.06, amt: 35, t: this.now() + 0.01 }]);
    }
    this.onShape(this.freeShape());
  }
  freeShape() { const fr = [0, 0, 0, 0, 0], open = this.open(); for (const [s, m] of this.freeHeld) fr[s] = m - open[s]; return fr; }
  // choke: bend the most recent melody/free string (pitch wheel), semitones
  choke(semi) {
    const s = this.lastNote ? this.lastNote.s : this.melody.size ? [...this.melody.keys()][0] : 3;
    if (s == null || s === 0) return;
    this.send([{ type: 'bendTo', s, amount: semi, t: this.now() }]);
  }
  allOff() { this.stop(); this.held.clear(); this.pending = []; this.freeHeld.clear(); const t = this.now(); this.send([0, 1, 2, 3, 4].map(s => ({ type: 'damp', s, time: 0.08, t }))); }
}

// Offline performance for tests: hold chords for bars in a style, return engine events.
function renderScript(o) {
  const events = []; let clock = 0; const q = [];
  const timers = { set: (f, ms) => { const h = { at: clock + ms / 1000, f }; q.push(h); return h; }, clear: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); } };
  const H = new BanjoHands({ send: (evs) => events.push(...evs), now: () => clock, timers, seed: o.seed || 1 });
  H.set({ style: o.style || 'forward', bpm: o.bpm || 120, picks: o.picks || (STYLES[o.style || 'forward'].kind === 'claw' ? 'bare' : 'picks'), licks: o.licks ?? 0.3, skill: o.skill ?? 0.7, tuning: o.tuning || [67, 50, 55, 59, 62], drone: o.drone || 'open' });
  const chords = o.chords || [[55, 59, 62], [48, 52, 55], [50, 54, 57], [55, 59, 62]];
  const barDur = 8 * H.stepDur(), bars = o.bars || chords.length;
  const run = (until) => { while (true) { q.sort((a, b) => a.at - b.at); if (!q.length || q[0].at > until) break; const h = q.shift(); clock = h.at; h.f(); } clock = until; };
  let t = 0.05;
  for (let b = 0; b < bars; b++) {
    const ch = chords[b % chords.length];
    run(t);
    if (b > 0) for (const n of chords[(b - 1) % chords.length]) H.noteOff(n);
    for (const n of ch) H.noteOn(n, 0.75, t);
    t += barDur;
  }
  run(t);
  for (const n of chords[(bars - 1) % chords.length]) H.noteOff(n);
  run(t + 0.2);
  return { events, seconds: t + 2.5 };
}

root.BanjoHands = BanjoHands;
root.BanjoHand = { renderScript, shapeFor, shapePlayed, STYLES, IDX, NUM };
})(typeof globalThis !== 'undefined' ? globalThis : this);
