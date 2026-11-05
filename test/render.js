// Offline renders through the real engine: node test/render.js <what> out.wav '{json opts}'
//   what: note  {s, midi, vel, style, seconds, preset, setup}
//         roll  {pattern, bpm, bars, preset, setup}   (uses the banjo hand when present)
//         tap   {seconds}
const fs = require('fs');
for (const f of ['pot.js', 'space.js', 'engine.js']) require('../src/' + f);
const hasHand = fs.existsSync(__dirname + '/../src/hand.js'); if (hasHand) require('../src/hand.js');
const [what = 'note', out = 'out.wav', js = '{}'] = process.argv.slice(2);
const o = JSON.parse(js), sr = o.sr || 48000;
const E = new globalThis.BanjoEngine(sr);
const params = {};
if (o.preset) params.preset = o.preset;
if (o.setup) params.setup = o.setup;
if (o.tuning) params.tuning = o.tuning;
if (o.scene) params.scene = o.scene;
if (o.pick) params.pick = o.pick;
if (o.strings) params.strings = o.strings;
if (Object.keys(params).length) E.setParams(params);
let seconds = o.seconds || 3;
if (what === 'note') {
  E.post({ type: 'pluck', s: o.s ?? 2, midi: o.midi, vel: o.vel ?? 0.7, style: o.style || 'fpick', dir: o.dir ?? 1, pickPos: o.pickPos ?? 0.08, t: 0.05 });
} else if (what === 'strings') {
  for (let s = 0; s < 5; s++) E.post({ type: 'pluck', s, vel: 0.7, style: s === 0 ? 'tpick' : 'fpick', dir: s === 0 ? -1 : 1, t: 0.05 + s * 1.2 });
  seconds = 7;
} else if (what === 'tap') {
  E.post({ type: 'tap', vel: 0.8, t: 0.05 }); seconds = o.seconds || 1.5;
} else if (what === 'events') {
  for (const ev of o.events) E.post(ev);
} else if (what === 'roll' && hasHand) {
  const evs = globalThis.BanjoHand.renderScript(o);
  for (const ev of evs.events) E.post(ev);
  seconds = evs.seconds;
}
const N = Math.round(seconds * sr), L = new Float32Array(N), R = new Float32Array(N);
const t0 = Date.now();
for (let i = 0; i < N; i += 128) { const n = Math.min(128, N - i); E.render(L.subarray(i, i + n), R.subarray(i, i + n), n); }
const dt = (Date.now() - t0) / 1000;
let peak = 0, rms = 0; for (let i = 0; i < N; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); rms += L[i] * L[i]; }
rms = Math.sqrt(rms / N);
console.log(`${what}: peak ${(20 * Math.log10(peak + 1e-12)).toFixed(1)} dBFS, rms ${(20 * Math.log10(rms + 1e-12)).toFixed(1)} dBFS, render ${(dt / seconds * 100).toFixed(1)}% realtime`);
const norm = o.normalize ? 0.5 / Math.max(peak, 1e-9) : 1;
const buf = Buffer.alloc(44 + N * 4), w = (s, o2) => buf.write(s, o2);
w('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); w('WAVE', 8); w('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); w('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * norm * 32767))), 44 + i * 4); buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * norm * 32767))), 46 + i * 4); }
fs.writeFileSync(out, buf);
