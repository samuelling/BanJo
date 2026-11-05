// BanJo — UI, audio graph, MIDI, keyboard, recording.
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const NUMS = ['5th', '4th', '3rd', '2nd', '1st'];
const NOTE = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

let ctx = null, node = null, fallback = null, master = null, wetGain = null, dryGain = null, convF = null, convB = null, recNode = null;
let meters = [0, 1, 2, 3, 4].map(() => ({ e: 0, fret: 0, active: false, bend: 0 }));
let started = false;
let octave = 48;

const store = {
  get(k, d) { try { const v = localStorage.getItem('banjo.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('banjo.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
};

// ---------- audio ----------
function engineTime() { return ctx ? ctx.currentTime : 0; }
function send(evs) {
  if (!evs || !evs.length) return;
  if (node) node.port.postMessage(evs);
  else if (fallback) for (const e of evs) fallback.post(e);
  for (const e of evs) if (e.type === 'pluck') pulse(e);
}
function setEngine(params) { Object.assign(engParams, params); send([{ type: 'params', params, t: engineTime() }]); }
const engParams = {};

// A copy of the engine on the main thread builds the pot (a few hundred modes, ~0.1-0.4 s) so the audio thread never
// stalls; the result is posted to the worklet.
let shadow = null, potTimer = 0;
function shadowEngine() { if (!shadow) shadow = new BanjoEngine(48000); return shadow; }
const setup = {
  preset: store.get('b.preset', 'bluegrass'), strings: store.get('b.strings', null),
  head: store.get('b.head', null), headD: store.get('b.headD', null), dd: store.get('b.dd', null), ring: store.get('b.ring', null),
  back: store.get('b.back', null), bridgeMass: store.get('b.bridgeMass', null), bridgeH: store.get('b.bridgeH', null),
  breakDeg: store.get('b.breakDeg', null), stuff: store.get('b.stuff', null), hold: store.get('b.hold', 'lap')
};
function potOverrides() {
  const o = {};
  for (const k of ['head', 'headD', 'dd', 'ring', 'back', 'bridgeMass', 'bridgeH', 'breakDeg', 'stuff', 'hold']) if (setup[k] != null) o[k] = setup[k];
  return o;
}
function presetPot() { return BANJO_PRESETS[setup.preset].pot; }
function cur(k) { return setup[k] != null ? setup[k] : k === 'hold' ? 'lap' : presetPot()[k]; }
function rebuildPot(now) {
  clearTimeout(potTimer);
  const go = () => {
    const sh = shadowEngine();
    const p = { preset: setup.preset, setup: potOverrides(), strings: setup.strings || BANJO_PRESETS[setup.preset].strings, tuning: tuning(), capo: capo(), spike: spike(), quality };
    sh.setParams(p);
    send([{ type: 'params', params: p, t: engineTime() }, { type: 'pot', pot: sh.pot, t: engineTime() }]);
    Object.assign(engParams, p);
    const f01 = sh.pot.f[0];
    $('potInfo').textContent = `lowest head mode ${Math.round(f01)} Hz (${noteName(f01)}) · ${sh.pot.n} pot modes`;
    if (typeof markDirty === 'function') markDirty();
  };
  if (now) go(); else potTimer = setTimeout(go, 140);
}
function noteName(f) { const m = 69 + 12 * Math.log2(f / 440), r = Math.round(m), c = Math.round((m - r) * 100); return NOTE[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1) + (c ? (c > 0 ? ' +' : ' ') + c + '¢' : ''); }

let quality = 'high';
function benchmark() {
  try {
    const E = shadowEngine();
    for (let s = 0; s < 5; s++) E.post({ t: 0.001 + s * 0.01, type: 'pluck', s, vel: 1, style: 'fpick', dir: 1 });
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0; i < 20; i++) E.render(L, R, 128, 0);
    const t0 = performance.now(); for (let i = 0; i < 94; i++) E.render(L, R, 128, 0);
    E.post({ type: 'panic' });
    return (performance.now() - t0) / 250;
  } catch (e) { return 0; }
}
async function start() {
  if (started) return;
  started = true;
  const load = benchmark();
  quality = load > 0.3 ? 'eco' : 'high';
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive', sampleRate: 48000 });
  master = ctx.createGain(); master.gain.value = 0.8;
  dryGain = ctx.createGain(); wetGain = ctx.createGain();
  convF = ctx.createConvolver(); convB = ctx.createConvolver(); convF.normalize = false; convB.normalize = false;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 14; limiter.attack.value = 0.001; limiter.release.value = 0.12;
  let src;
  try {
    const code = document.getElementById('dsp-src').textContent;
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(ctx, 'banjo-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [4] });
    node.port.onmessage = (m) => { if (m.data.meters) { meters = m.data.meters; markDirty(); } };
    src = node;
  } catch (err) {
    console.warn('AudioWorklet unavailable, using ScriptProcessor', err);
    fallback = new BanjoEngine(ctx.sampleRate, { externalPot: true });
    fallback.clock = Math.round(ctx.currentTime * ctx.sampleRate);
    const sp = ctx.createScriptProcessor(512, 0, 4);
    sp.onaudioprocess = (e) => {
      const ob = e.outputBuffer, L = ob.getChannelData(0), R = ob.getChannelData(1);
      fallback.render(L, R, L.length, 0, ob.numberOfChannels > 2 ? ob.getChannelData(2) : null, ob.numberOfChannels > 3 ? ob.getChannelData(3) : null);
      meters = fallback.meters(); markDirty();
    };
    src = sp;
  }
  const split = ctx.createChannelSplitter(4), merge = ctx.createChannelMerger(2);
  src.connect(split);
  split.connect(merge, 0, 0); split.connect(merge, 1, 1);
  merge.connect(dryGain);
  splitNode = split; wireRoom();
  convF.connect(wetGain); convB.connect(wetGain);
  dryGain.connect(master); wetGain.connect(master); master.connect(limiter); limiter.connect(ctx.destination);
  try { await setupRecorder(limiter); } catch (e) { $('recBtn').disabled = true; }
  if (ctx.state !== 'running') await ctx.resume();
  applyAll();
  $('startOverlay').hidden = true;
  initMidi();
}

// ---------- hands ----------
let shape = [0, 0, 0, 0, 0];
const fingerMarks = [];   // {s, finger, t}
const hands = new BanjoHands({
  send, now: engineTime,
  onShape: (fr) => { shape = fr.slice(); $('shapeText').textContent = shapeLabel(shape); markDirty(); },
  onPluck: (s, finger, t) => { fingerMarks.push({ s, finger, t }); if (fingerMarks.length > 12) fingerMarks.shift(); markDirty(); }
});
function shapeLabel(fr) { const f = fr.slice(1).map(x => x < 0 ? 'x' : x); const s = f.some(x => x > 9) ? f.join('-') : f.join(''); return s + (fr[0] > 0 ? '  5th@' + (5 + fr[0]) : ''); }
function tuning() { return TUN[tuningKey()].t.slice(); }
function tuningKey() { return $('tuning').value || 'openG'; }
function capo() { return +$('capo').value || 0; }
function spike() { return store.get('o.spikeMode', 'follow') === 'follow' ? capo() : 0; }
const TUN = BANJO_TUNINGS;

// ---------- the space: mics and room ----------
const SP = () => window.BanjoSpace;
const scene = {
  room: store.get('sp.room', 'living'), mics: store.get('sp.mics', 'front30'), pattern: store.get('sp.pattern', 'default'),
  dist: store.get('sp.dist', 1), gx: store.get('sp.gx', 0.42), gy: store.get('sp.gy', 0.62), yaw: store.get('sp.yaw', 0),
  trim: store.get('sp.trim', 0)
};
const build = { get hold() { return cur('hold'); } };
function sceneObject() {
  const S = SP(), room = S.ROOMS[scene.room];
  const h = build.hold === 'stand' ? 0.75 : 0.95;
  const [Lx, Ly] = room.open ? [12, 8] : room.dims;   // open ground: place the banjo on the map's 12 x 8 m patch
  const mx = Math.min(1.2, Lx * 0.2), my = Math.min(1.2, Ly * 0.2);
  const pos = [Math.max(mx, Math.min(Lx - mx, Lx * scene.gx)), Math.max(my, Math.min(Ly - my, Ly * scene.gy)), h];
  const sh = shadowEngine(), geom = sh.pot ? sh.sceneGeom() : null;
  return { room: scene.room, mics: S.scaledSetup(scene.mics, scene.dist, scene.pattern), hold: build.hold, guitar: { pos, yaw: scene.yaw }, geom };
}
let irWorker = null, irBusy = false, irPending = false, irSeq = 0;
function ensureWorker() {
  if (irWorker) return irWorker;
  try {
    const code = document.getElementById('dsp-src').textContent + `
      self.onmessage = (e) => { const { id, scene, sr } = e.data; const ir = BanjoSpace.buildIRs(scene, sr);
        const bufs = [ir.front[0], ir.front[1], ir.back[0], ir.back[1]];
        self.postMessage({ id, bufs, rt: ir.rt, V: ir.V }, bufs.map(b => b.buffer)); };`;
    irWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    irWorker.onmessage = (e) => { irBusy = false; applyIR(e.data); if (irPending) { irPending = false; rebuildRoom(); } };
    irWorker.onerror = () => { irWorker = null; };
  } catch (e) { irWorker = null; }
  return irWorker;
}
let cpuMode = store.get('o.cpu', 'light'), splitNode = null;
function wireRoom() {
  if (!splitNode) return;
  try { splitNode.disconnect(convF); } catch (e) {} try { splitNode.disconnect(convB); } catch (e) {}
  splitNode.connect(convF, 2);
  if (cpuMode === 'full') splitNode.connect(convB, 3); else splitNode.connect(convF, 3);
}
function setCpu(m) { cpuMode = m; store.set('o.cpu', m); $('cpuMode').value = m; setEngine({ cpu: m }); wireRoom(); rebuildRoom(); }
function applyIR(d) {
  if (!ctx) return;
  const mk = (a, b) => { const buf = ctx.createBuffer(2, a.length, ctx.sampleRate); buf.copyToChannel(a, 0); buf.copyToChannel(b, 1); return buf; };
  convF.buffer = mk(d.bufs[0], d.bufs[1]);
  convB.buffer = cpuMode === 'full' ? mk(d.bufs[2], d.bufs[3]) : null;
  roomStats = { rt: d.rt, V: d.V };
  drawRoomMap();
}
let roomStats = null, roomTimer = 0;
function rebuildRoom() {
  clearTimeout(roomTimer);
  roomTimer = setTimeout(() => {
    if (!ctx) return;
    const w = ensureWorker(), sc = Object.assign(sceneObject(), cpuMode === 'full' ? {} : { maxDur: 2.5 });
    if (w) { if (irBusy) { irPending = true; return; } irBusy = true; w.postMessage({ id: ++irSeq, scene: sc, sr: ctx.sampleRate }); }
    else { const ir = SP().buildIRs(sc, ctx.sampleRate); applyIR({ bufs: [ir.front[0], ir.front[1], ir.back[0], ir.back[1]], rt: ir.rt, V: ir.V }); }
  }, 120);
}
function applyScene() {
  const sc = sceneObject();
  setEngine({ scene: { mics: sc.mics, hold: build.hold } });
  if (wetGain) wetGain.gain.value = Math.pow(10, scene.trim / 20);
  rebuildRoom();
  drawRoomMap();
}

// ---------- recording (tap after the limiter) ----------
let recording = false, recChunks = [[], []], recLen = 0;
async function setupRecorder(after) {
  const code = `class RecTap extends AudioWorkletProcessor {
    constructor(){ super(); this.on = false; this.port.onmessage = (m) => { this.on = m.data; }; }
    process(inputs, outputs){ const i = inputs[0]; const o = outputs[0];
      if (i.length) { for (let c = 0; c < o.length; c++) o[c].set(i[Math.min(c, i.length - 1)]);
        if (this.on) this.port.postMessage([i[0].slice(0), (i[1] || i[0]).slice(0)]); }
      return true; } }
    registerProcessor('rec-tap', RecTap);`;
  if (!ctx.audioWorklet) throw new Error('no worklet');
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  recNode = new AudioWorkletNode(ctx, 'rec-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  recNode.port.onmessage = (m) => { if (!recording) return; recChunks[0].push(m.data[0]); recChunks[1].push(m.data[1]); recLen += m.data[0].length; };
  after.connect(recNode);
  const sink = ctx.createGain(); sink.gain.value = 0; recNode.connect(sink); sink.connect(ctx.destination);
}
function toggleRecord() {
  if (!started || !recNode) return;
  recording = !recording;
  $('recBtn').setAttribute('aria-pressed', recording);
  $('recBtn').textContent = recording ? '■ Stop' : '● Record';
  recNode.port.postMessage(recording);
  if (recording) { recChunks = [[], []]; recLen = 0; $('recOut').innerHTML = '<span class="note">Recording…</span>'; return; }
  const wav = encodeWav(recChunks, recLen, ctx.sampleRate);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  const secs = (recLen / ctx.sampleRate).toFixed(1);
  const name = 'banjo-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.wav';
  $('recOut').innerHTML = '';
  const audio = document.createElement('audio'); audio.controls = true; audio.src = url;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = `Save WAV (${secs} s)`;
  const n = document.createElement('span'); n.className = 'note';
  b.addEventListener('click', () => saveRecording(wav, name, url, n));
  $('recOut').append(audio, b, n);
}
// Inside Claude's artifact viewer files go through the downloads capability, which takes .zip but not .wav,
// so the lossless WAV travels inside a ZIP there. Anywhere else it is a plain WAV download.
async function saveRecording(wav, name, url, note) {
  const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename: name.replace(/\.wav$/, '.zip'), data: zipStore(name, new Uint8Array(wav)) }); note.textContent = 'Saved as a ZIP containing the WAV.'; }
    catch (e) { note.textContent = e && e.code === 'declined' ? 'Save cancelled.' : 'Saving is not available in this view.'; }
    return;
  }
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
function zipStore(name, data) { // single file, no compression
  let crc = 0xffffffff; for (let i = 0; i < data.length; i++) crc = CRC[(crc ^ data[i]) & 255] ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
  const fn = new TextEncoder().encode(name), L = 30 + fn.length, C = 46 + fn.length;
  const out = new Uint8Array(L + data.length + C + 22), v = new DataView(out.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, fn.length, true);
  out.set(fn, 30); out.set(data, L);
  let o = L + data.length;
  v.setUint32(o, 0x02014b50, true); v.setUint16(o + 4, 20, true); v.setUint16(o + 6, 20, true); v.setUint32(o + 16, crc, true); v.setUint32(o + 20, data.length, true); v.setUint32(o + 24, data.length, true); v.setUint16(o + 28, fn.length, true); v.setUint32(o + 42, 0, true);
  out.set(fn, o + 46); o += C;
  v.setUint32(o, 0x06054b50, true); v.setUint16(o + 8, 1, true); v.setUint16(o + 10, 1, true); v.setUint32(o + 12, C, true); v.setUint32(o + 16, L + data.length, true);
  return out;
}
function encodeWav(ch, n, sr) {
  const buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let k = 0; k < ch[0].length; k++) {
    const L = ch[0][k], R = ch[1][k];
    for (let i = 0; i < L.length; i++) {
      v.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      v.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true); o += 4;
    }
  }
  return buf;
}


function mapGeom() {
  const map = $('roomMap'); const S = SP(); if (!map || !S) return null;
  const room = S.ROOMS[scene.room], W = map.clientWidth, H = map.clientHeight;
  const Lx = room.open ? 12 : room.dims[0], Ly = room.open ? 8 : room.dims[1];
  const k = Math.min((W - 24) / Lx, (H - 34) / Ly);
  return { W, H, Lx, Ly, k, ox: (W - Lx * k) / 2, oy: 20 + (H - 34 - Ly * k) / 2, room };
}
function drawRoomMap() {
  const map = $('roomMap'); const S = SP(); if (!map || !S) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  map.width = Math.round(map.clientWidth * dpr); map.height = Math.round(map.clientHeight * dpr);
  const g = map.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const G = mapGeom(), room = G.room, cs = getComputedStyle(document.documentElement);
  const col = (v) => cs.getPropertyValue(v).trim();
  g.clearRect(0, 0, G.W, G.H);
  const X = (x) => G.ox + x * G.k, Y = (y) => G.oy + y * G.k;
  // walls, colored by how reflective they are at 1 kHz
  const wall = (key, x0, y0, x1, y1) => {
    if (room.open || room.walls[key] === 'open') return;
    const a = S.MATERIALS[room.walls[key]].a[3];
    g.strokeStyle = a < 0.15 ? col('--brass') : a < 0.5 ? col('--muted') : col('--faint');
    g.lineWidth = a < 0.15 ? 3 : 2; g.beginPath(); g.moveTo(X(x0), Y(y0)); g.lineTo(X(x1), Y(y1)); g.stroke();
  };
  wall('y0', 0, 0, G.Lx, 0); wall('y1', 0, G.Ly, G.Lx, G.Ly); wall('x0', 0, 0, 0, G.Ly); wall('x1', G.Lx, 0, G.Lx, G.Ly);
  if (room.open) { g.fillStyle = col('--panel'); g.fillRect(X(0), Y(0), G.Lx * G.k, G.Ly * G.k); }
  if (room.trees) {
    // a sketch of the stand around the player: trunks at the stand's mean spacing
    let sd = 99; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
    g.fillStyle = 'rgba(120,150,95,0.55)';
    for (let x = 0.5; x < G.Lx; x += room.trees.spacing * 0.5) for (let y = 0.5; y < G.Ly; y += room.trees.spacing * 0.5) {
      const px = x + (rnd() - 0.5) * room.trees.spacing * 0.5, py = y + (rnd() - 0.5) * room.trees.spacing * 0.5;
      if (Math.hypot(px - G.Lx * scene.gx, py - G.Ly * scene.gy) < 1.3) continue;
      g.beginPath(); g.arc(X(px), Y(py), Math.max(1.5, (room.trees.r[0] + (room.trees.r[1] - room.trees.r[0]) * rnd()) * G.k), 0, 7); g.fill();
    }
  }
  g.fillStyle = col('--faint'); g.font = '10px "JetBrains Mono", monospace'; g.textAlign = 'left';
  g.fillText(room.open ? `open air · ground ${S.MATERIALS[room.walls.floor].name.toLowerCase()}${room.trees ? ' · trunks every ~' + room.trees.spacing + ' m' : ''}`
    : room.nature && room.walls.ceiling === 'open' ? `rock walls ${room.dims[0]} m apart · open sky · ground ${S.MATERIALS[room.walls.floor].name.toLowerCase()}`
    : `${room.dims[0]} × ${room.dims[1]} × ${room.dims[2]} m · floor ${S.MATERIALS[room.walls.floor].name.toLowerCase()}`, 8, 12);
  // banjo, player and mics
  const sc = sceneObject();
  const pl = S.placement(sc);
  const P = (p) => { const r = pl.toRoom(p); return [X(r[0]), Y(r[1])]; };
  const big = Math.max(1, 0.9 / (G.k * 0.42)); // draw tiny banjos bigger in large rooms
  const Pz = (p) => { const r = pl.toRoom([p[0] * big, p[1] * big, p[2] * big]); const o = pl.toRoom([0, 0, 0]); return [X(o[0] + (r[0] - o[0])), Y(o[1] + (r[1] - o[1]))]; };
  if (build.hold !== 'stand') { const c = Pz([0.1, 0, -0.3]); g.fillStyle = col('--panel-2'); g.strokeStyle = col('--faint'); g.lineWidth = 1; g.beginPath(); g.arc(c[0], c[1], 0.2 * G.k * big, 0, 7); g.fill(); g.stroke(); }
  const a = Pz([-0.2, 0, 0]), b = Pz([0.33, 0, 0]), neck = Pz([0.7, 0, 0]);
  g.strokeStyle = col('--brass'); g.lineWidth = Math.max(5, 0.1 * G.k * big); g.lineCap = 'round';
  g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  g.lineWidth = Math.max(2, 0.04 * G.k * big); g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(neck[0], neck[1]); g.stroke();
  const face = Pz([0.05, 0, 0.18]), fo = Pz([0.05, 0, 0]);
  g.strokeStyle = col('--accent'); g.lineWidth = 1; g.beginPath(); g.moveTo(fo[0], fo[1]); g.lineTo(face[0], face[1]); g.stroke();
  const mics = S.expandMics(sc.mics);
  let dmin = Infinity;
  for (const m of mics) {
    const p = m.ear ? Pz(m.p) : (big > 1.01 ? Pz(m.p) : P(m.p));
    dmin = Math.min(dmin, Math.hypot(m.p[0] - 0.12, m.p[1], m.p[2]));
    g.fillStyle = col('--fg'); g.beginPath(); g.arc(p[0], p[1], 3.5, 0, 7); g.fill();
    const q = (big > 1.01 || m.ear) ? Pz([m.p[0] + m.axis[0] * 0.12, m.p[1] + m.axis[1] * 0.12, m.p[2] + m.axis[2] * 0.12]) : P([m.p[0] + m.axis[0] * 0.12, m.p[1] + m.axis[1] * 0.12, m.p[2] + m.axis[2] * 0.12]);
    g.strokeStyle = col('--fg'); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
  }
  // stats
  const E = S.eyring(room);
  const rt = room.tail ? (room.tail.rt[2] + room.tail.rt[3]) / 2 : room.open ? null : (E.rt[2] + E.rt[3]) / 2;
  const rc = rt ? 0.057 * Math.sqrt(2 * E.V / rt) : null;
  const gpx = sc.guitar.pos[0], near = room.walls.x1 === 'open' ? gpx : Math.min(gpx, room.dims[0] - gpx);
  const echo = room.nature && !room.open && room.walls.ceiling === 'open' ? ` · first echo after ${2 * near / 343 < 0.1 ? Math.round(2 * near / 0.343) + ' ms' : (2 * near / 343).toFixed(2) + ' s'}` : '';
  $('roomInfo').textContent = room.tail ? `Scattering off the trees: reverb time ${rt.toFixed(1)} s (500 Hz–1 kHz), mostly in the treble. Nearest mic ${dmin.toFixed(2)} m from the head.`
    : room.open ? `No walls: only the ground reflects. Nearest mic ${dmin.toFixed(2)} m from the head.`
    : echo ? `Open sky; the rock faces send the sound back${echo}. Nearest mic ${dmin.toFixed(2)} m from the head.`
    : `Reverb time ${rt.toFixed(2)} s (500 Hz–1 kHz) · critical distance ${rc.toFixed(1)} m · nearest mic ${dmin.toFixed(2)} m`;
}



// ---------- controls ----------
const KIND_DEFAULT = { roll: 'forward', claw: 'claw', vamp: 'vamp' };
const sliders = {
  bpm: { out: v => v, apply: v => hands.set({ bpm: v }) },
  swing: { out: v => +v === 0 ? 'style' : (50 + v * 0.17).toFixed(0) + '%', apply: v => hands.set({ swing: +v === 0 ? null : 0.5 + v * 0.0017 }) },
  skill: { out: v => v, apply: v => hands.set({ skill: v / 100 }) },
  humanize: { out: v => v, apply: v => hands.set({ humanize: v / 100 }) },
  licks: { out: v => v, apply: v => hands.set({ licks: v / 100 }) },
  // picking spot: 0 = the style's own; 1..100 = 20 mm .. 200 mm from the bridge
  spot: { out: v => +v === 0 ? 'style' : Math.round(20 + v * 1.8) + ' mm', apply: v => hands.set({ spot: +v === 0 ? null : (0.020 + v * 0.0018) / 0.667 }) },
  strength: { out: v => v, apply: v => hands.set({ strength: v / 100 }) },
  slide: { out: v => v, apply: v => hands.set({ slide: v / 100 }) },
  gather: { out: v => v + ' ms', apply: v => hands.set({ gather: v / 1000 }) },
  keyvel: { out: v => v, apply: () => {} },
  capo: { out: v => +v ? 'fret ' + v : 'none', apply: () => { applyTuning(); } },
  dd: { out: v => 'DD ' + (+v).toFixed(1).replace('.0', ''), apply: v => { if (+v !== cur('dd')) { setup.dd = +v; store.set('b.dd', setup.dd); rebuildPot(); } } },
  bmass: { out: v => (v / 10).toFixed(1) + ' g', apply: v => { const m = v / 10000; if (Math.abs(m - cur('bridgeMass')) > 1e-6) { setup.bridgeMass = m; store.set('b.bridgeMass', m); rebuildPot(); } } },
  brk: { out: v => v + '°', apply: v => { if (+v !== cur('breakDeg')) { setup.breakDeg = +v; store.set('b.breakDeg', +v); rebuildPot(); } } },
  bright: { out: v => v < 25 ? 'dead' : v < 50 ? 'played in' : v < 80 ? 'fresh' : 'new', apply: v => setEngine({ brightness: v / 100 }) },
  symp: { out: v => v, apply: v => setEngine({ sympathetic: v / 100 }) },
  noise: { out: v => v, apply: v => setEngine({ noise: v / 100 }) },
  vol: { out: v => v, apply: v => setEngine({ gain: Math.pow(v / 100, 1.5) * 1.6 }) }
};
const POT_SLIDERS = ['dd', 'bmass', 'brk'];
function bindSliders() {
  for (const id in sliders) {
    const el = $(id), cfg = sliders[id];
    const saved = store.get('s.' + id, null);
    if (saved != null && !POT_SLIDERS.includes(id)) el.value = saved;
    const upd = () => { $(id + 'Out').textContent = cfg.out(+el.value); cfg.apply(+el.value); if (!POT_SLIDERS.includes(id)) store.set('s.' + id, +el.value); };
    el.addEventListener('input', upd);
    $(id + 'Out').textContent = cfg.out(+el.value);
    if (!POT_SLIDERS.includes(id)) cfg.apply(+el.value);
  }
}
// setup controls show the preset's values unless overridden
function showSetup() {
  $('dd').value = cur('dd'); $('ddOut').textContent = sliders.dd.out(cur('dd'));
  $('bmass').value = Math.round(cur('bridgeMass') * 10000); $('bmassOut').textContent = sliders.bmass.out(+$('bmass').value);
  $('brk').value = cur('breakDeg'); $('brkOut').textContent = sliders.brk.out(cur('breakDeg'));
  $('head').value = cur('head'); $('headD').value = String(cur('headD')); $('ring').value = cur('ring'); $('stuff').value = cur('stuff');
  $('bheight').value = String(cur('bridgeH')); $('hold').value = cur('hold');
  $('strset').value = setup.strings || BANJO_PRESETS[setup.preset].strings;
  segSet('back', cur('back'));
}
function applyTuning() {
  const t = tuning(), c = capo(), sp = spike();
  hands.set({ tuning: t, capo: c, spike: sp });
  setEngine({ tuning: t, capo: c, spike: sp });
  rebuildPot();
  renderChords(); markDirty();
}
function applyAll() {
  for (const id in sliders) if (!POT_SLIDERS.includes(id)) sliders[id].apply(+$(id).value);
  setEngine({ quality, cpu: cpuMode, pick: pickParams() });
  applyTuning(); rebuildPot(true); applyScene();
}
const segs = {};
function segSet(opt, v) { const seg = segs[opt]; if (!seg) return; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v)); }
function bindSegs() {
  document.querySelectorAll('.seg').forEach(seg => {
    const opt = seg.dataset.opt; segs[opt] = seg;
    const def = opt === 'back' ? cur('back') : opt === 'kind' ? 'roll' : seg.querySelector('button').dataset.v;
    const val = opt === 'back' ? def : store.get('o.' + opt, def);
    const set = (v, user) => {
      segSet(opt, v);
      if (opt === 'back') { if (user) { setup.back = v; store.set('b.back', v); rebuildPot(); applyScene(); } return; }
      store.set('o.' + opt, v);
      if (opt === 'kind') return setKind(v, user);
      if (opt === 'spikeMode') { if (user) applyTuning(); return; }
      if (opt === 'picks') { $('fpRow').hidden = v !== 'picks'; $('tpRow').hidden = v !== 'picks'; }
      hands.set({ [opt]: v });
    };
    seg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => set(b.dataset.v, true)));
    set(val, false);
  });
}
function setKind(kind, user) {
  const sel = $('handStyle');
  const list = Object.entries(BanjoHand.STYLES).filter(([, s]) => kind === 'free' ? s.kind !== 'vamp' : s.kind === kind);
  sel.innerHTML = '';
  for (const [k, s] of list) { const o = document.createElement('option'); o.value = k; o.textContent = s.name; sel.appendChild(o); }
  const saved = store.get('o.style.' + kind, kind === 'free' ? 'forward' : KIND_DEFAULT[kind]);
  sel.value = list.some(([k]) => k === saved) ? saved : list[0][0];
  sel.title = kind === 'free' ? 'In Free notes the pattern sets the right-hand technique: rolls use thumb and fingers, clawhammer the nail' : '';
  hands.set({ mode: kind === 'free' ? 'free' : 'pattern', style: sel.value });
  if (kind === 'free') hands.stop();
  // the picks follow the technique unless the player changes them: clawhammer is bare-handed
  if (user) { const pk = BanjoHand.STYLES[sel.value].kind === 'claw' ? 'bare' : 'picks'; segSet('picks', pk); hands.set({ picks: pk }); store.set('o.picks', pk); $('fpRow').hidden = $('tpRow').hidden = pk !== 'picks'; }
}
function bindStyleSel() {
  $('handStyle').addEventListener('change', () => {
    const k = $('handStyle').value, kind = store.get('o.kind', 'roll');
    store.set('o.style.' + kind, k); hands.set({ style: k });
  });
}
function fillSelect(id, entries, val) {
  const el = $(id); el.innerHTML = '';
  for (const [k, v] of entries) { const o = document.createElement('option'); o.value = k; o.textContent = v; el.appendChild(o); }
  if (val != null) el.value = val;
}
function pickParams() { return { finger: $('fingerPick').value || 'ns025', thumb: $('thumbPick').value || 'thumbM', angle: 20 }; }
function bindSetup() {
  fillSelect('preset', Object.entries(BANJO_PRESETS).map(([k, v]) => [k, v.name]), setup.preset);
  fillSelect('tuning', Object.entries(TUN).map(([k, v]) => [k, v.name]), store.get('o.tuning', 'openG'));
  fillSelect('head', Object.entries(BanjoPot.HEADS).map(([k, v]) => [k, v.name]));
  fillSelect('ring', Object.entries(BanjoPot.RINGS).map(([k, v]) => [k, v.name]));
  fillSelect('stuff', Object.entries(BanjoPot.STUFF).map(([k, v]) => [k, v.name]));
  fillSelect('strset', Object.entries(BANJO_STRINGS).map(([k, v]) => [k, v.name]));
  const fp = Object.entries(BANJO_PICKS).filter(([k]) => !k.startsWith('thumb') && k !== 'cell71'), tp = Object.entries(BANJO_PICKS).filter(([k]) => k.startsWith('thumb'));
  fillSelect('fingerPick', fp.map(([k, v]) => [k, v.name]), store.get('pk.finger', 'ns025'));
  fillSelect('thumbPick', tp.map(([k, v]) => [k, v.name]), store.get('pk.thumb', 'thumbM'));
  $('fingerPick').addEventListener('change', () => { store.set('pk.finger', $('fingerPick').value); setEngine({ pick: pickParams() }); });
  $('thumbPick').addEventListener('change', () => { store.set('pk.thumb', $('thumbPick').value); setEngine({ pick: pickParams() }); });
  showSetup();
  $('preset').addEventListener('change', () => {
    // a new banjo: its own setup, strings and (for open-backs) clawhammer by default
    setup.preset = $('preset').value; store.set('b.preset', setup.preset);
    for (const k of ['head', 'headD', 'dd', 'ring', 'back', 'bridgeMass', 'bridgeH', 'breakDeg', 'stuff', 'strings']) { setup[k] = null; store.set('b.' + k, null); }
    showSetup(); rebuildPot(); applyScene();
  });
  $('tuning').addEventListener('change', () => { store.set('o.tuning', $('tuning').value); applyTuning(); });
  const onPot = (id, key, num) => $(id).addEventListener('change', () => { setup[key] = num ? +$(id).value : $(id).value; store.set('b.' + key, setup[key]); rebuildPot(); if (key === 'hold' || key === 'headD') applyScene(); });
  onPot('head', 'head'); onPot('headD', 'headD', true); onPot('ring', 'ring'); onPot('stuff', 'stuff'); onPot('bheight', 'bridgeH', true); onPot('hold', 'hold');
  $('strset').addEventListener('change', () => { setup.strings = $('strset').value; store.set('b.strings', setup.strings); rebuildPot(); });
  $('tapHead').addEventListener('click', async () => { await start(); send([{ type: 'tap', vel: 0.75, t: engineTime() + 0.01 }]); });
  $('legatoMode').value = store.get('o.legatoMode', 'auto'); hands.set({ legato: $('legatoMode').value });
  $('legatoMode').addEventListener('change', () => { hands.set({ legato: $('legatoMode').value }); store.set('o.legatoMode', $('legatoMode').value); });
  $('cpuMode').value = cpuMode; $('cpuMode').addEventListener('change', () => setCpu($('cpuMode').value));
}
function bindSpace() {
  const S = SP();
  fillSelect('micSetup', Object.entries(S.MIC_SETUPS).map(([k, v]) => [k, v.name]), scene.mics);
  fillSelect('roomSel', Object.entries(S.ROOMS).map(([k, v]) => [k, v.name]), scene.room);
  $('micPattern').value = scene.pattern;
  $('micDist').value = Math.round(scene.dist * 100); $('micDistOut').textContent = 'x' + scene.dist.toFixed(1);
  $('roomTrim').value = scene.trim; $('roomTrimOut').textContent = (scene.trim > 0 ? '+' : '') + scene.trim + ' dB';
  const onScene = (id, key) => $(id).addEventListener('change', () => { scene[key] = $(id).value; store.set('sp.' + key, scene[key]); applyScene(); });
  onScene('micSetup', 'mics'); onScene('micPattern', 'pattern'); onScene('roomSel', 'room');
  $('micDist').addEventListener('input', () => { scene.dist = +$('micDist').value / 100; $('micDistOut').textContent = 'x' + scene.dist.toFixed(1); store.set('sp.dist', scene.dist); applyScene(); });
  $('roomTrim').addEventListener('input', () => {
    scene.trim = +$('roomTrim').value; store.set('sp.trim', scene.trim);
    $('roomTrimOut').textContent = (scene.trim > 0 ? '+' : '') + scene.trim + ' dB';
    if (wetGain) wetGain.gain.value = Math.pow(10, scene.trim / 20);
  });
  $('turnGuitar').addEventListener('click', () => { scene.yaw = (scene.yaw + Math.PI / 4) % (2 * Math.PI); store.set('sp.yaw', scene.yaw); applyScene(); });
  const map = $('roomMap');
  const moveTo = (e) => {
    const r = map.getBoundingClientRect(), g = mapGeom(); if (!g) return;
    const x = (e.clientX - r.left - g.ox) / g.k, y = (e.clientY - r.top - g.oy) / g.k;
    scene.gx = Math.max(0, Math.min(1, x / g.Lx)); scene.gy = Math.max(0, Math.min(1, y / g.Ly));
    drawRoomMap();
  };
  map.addEventListener('pointerdown', (e) => { map.setPointerCapture(e.pointerId); moveTo(e); });
  map.addEventListener('pointermove', (e) => { if (e.buttons) moveTo(e); });
  map.addEventListener('pointerup', () => { store.set('sp.gx', scene.gx); store.set('sp.gy', scene.gy); applyScene(); });
  window.addEventListener('resize', drawRoomMap);
  drawRoomMap();
}


// ---------- chord pads ----------
const PAD_CHORDS = ['G', 'C', 'D', 'D7', 'Em', 'Am', 'F', 'A', 'E7', 'Bm', 'G7', 'C7', 'A7', 'Dm', 'B7', 'Fmaj7'];
const QUAL = { '': [0, 4, 7], 'm': [0, 3, 7], '7': [0, 4, 7, 10], 'm7': [0, 3, 7, 10], 'maj7': [0, 4, 7, 11], 'sus4': [0, 5, 7], 'dim': [0, 3, 6] };
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function chordNotes(name) {
  const m = /^([A-G])([#b]?)(.*)$/.exec(name); if (!m) return [55, 59, 62];
  let r = PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const iv = QUAL[m[3]] || QUAL[''];
  const root = 48 + ((r + 12) % 12);
  return iv.map(i => root + i);
}
let padHeld = null;
function renderChords() {
  const box = $('chords'); box.innerHTML = '';
  const open = hands.open();
  PAD_CHORDS.forEach((name, i) => {
    const b = document.createElement('div'); b.className = 'chord'; b.tabIndex = 0; b.setAttribute('role', 'button');
    const sh = BanjoHand.shapeFor(chordNotes(name), open, 0, { drone: hands.o.drone });
    b.innerHTML = `${name.replace('#', '♯').replace('b', '♭')}<small>${sh ? sh.frets.slice(1).join('') : ''}${i < 10 ? ' · ' + ((i + 1) % 10) : ''}</small>`;
    b.dataset.name = name;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); padDown(name); });
    b.addEventListener('pointerup', () => padUp(name)); b.addEventListener('pointerleave', () => { if (padHeld === name && !latchPads) padUp(name); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); padDown(name); } });
    b.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') padUp(name); });
    box.appendChild(b);
  });
}
// pads latch: tap a chord and the hand keeps playing it; tap the playing chord again to stop
const latchPads = true;
async function padDown(name) {
  await start();
  if (latchPads && padHeld === name) { padUp(name, true); return; }
  if (padHeld) for (const n of chordNotes(padHeld)) hands.noteOff(n);
  padHeld = name;
  const v = +$('keyvel').value / 100, t = engineTime();
  for (const n of chordNotes(name)) hands.noteOn(n, v, t);
  document.querySelectorAll('.chord').forEach(c => c.classList.toggle('on', c.dataset.name === name));
}
function padUp(name, force) {
  if (latchPads && !force) return;
  if (padHeld !== name) return;
  for (const n of chordNotes(name)) hands.noteOff(n);
  padHeld = null;
  document.querySelectorAll('.chord').forEach(c => c.classList.remove('on'));
}

// ---------- keyboard ----------
const QWERTY = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j', 'k', 'o', 'l', 'p', ';'];
const keyEls = new Map();
function buildKeys() {
  const box = $('keys'); box.innerHTML = ''; keyEls.clear();
  const whites = [], N = 29, lo = octave;
  for (let m = lo; m < lo + N; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
  const ww = 100 / whites.length;
  let wi = 0;
  for (let m = lo; m < lo + N; m++) {
    const black = [1, 3, 6, 8, 10].includes(m % 12);
    const el = document.createElement('div'); el.className = 'key ' + (black ? 'black' : 'white');
    if (black) { el.style.left = (wi * ww - ww * 0.32) + '%'; el.style.width = (ww * 0.64) + '%'; }
    else { el.style.left = (wi * ww) + '%'; el.style.width = ww + '%'; wi++; }
    const qi = m - octave; if (qi >= 0 && qi < QWERTY.length) el.innerHTML = `<span class="kb">${QWERTY[qi].toUpperCase()}</span>`;
    el.dataset.midi = m; box.appendChild(el); keyEls.set(m, el);
  }
  $('octLabel').textContent = 'C' + (Math.floor(octave / 12) - 1);
}
const pointerNote = new Map();
function bindKeys() {
  const box = $('keys');
  const at = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.closest('.key') ? +el.closest('.key').dataset.midi : null; };
  box.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); box.setPointerCapture(e.pointerId); await start();
    const m = at(e); if (m == null) return;
    const r = e.target.getBoundingClientRect(), v = Math.max(0.25, Math.min(1, (e.clientY - r.top) / r.height * 0.9 + 0.2));
    pointerNote.set(e.pointerId, m); noteOn(m, v);
  });
  box.addEventListener('pointermove', (e) => {
    if (!pointerNote.has(e.pointerId)) return;
    const m = at(e), old = pointerNote.get(e.pointerId);
    if (m != null && m !== old) { noteOff(old); pointerNote.set(e.pointerId, m); noteOn(m, +$('keyvel').value / 100); }
  });
  const up = (e) => { if (pointerNote.has(e.pointerId)) { noteOff(pointerNote.get(e.pointerId)); pointerNote.delete(e.pointerId); } };
  box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
  $('octDown').addEventListener('click', () => shiftOct(-12)); $('octUp').addEventListener('click', () => shiftOct(12));
}
const litKeys = new Map();
function noteOn(midi, vel, t) {
  hands.noteOn(midi, vel, t);
  litKeys.set(midi, true); const el = keyEls.get(midi); if (el) el.classList.add('down');
}
function noteOff(midi) {
  hands.noteOff(midi);
  litKeys.delete(midi); const el = keyEls.get(midi); if (el) el.classList.remove('down');
}
const downKeys = new Map();
function keyOf(e) {
  const c = e.code || '';
  if (c.startsWith('Key')) return c.slice(3).toLowerCase();
  if (c.startsWith('Digit')) return c.slice(5);
  if (c === 'Semicolon') return ';';
  if (c === 'Space') return ' ';
  return (e.key || '').toLowerCase();
}
let choking = false;
function bindQwerty() {
  window.addEventListener('keydown', async (e) => {
    if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = keyOf(e);
    if (e.repeat) { if (QWERTY.includes(k) || k === ' ') e.preventDefault(); return; }
    if (k === ' ') { e.preventDefault(); hands.setSustain(true); return; }
    if (k === 'z') { shiftOct(-12); return; }
    if (k === 'x') { shiftOct(12); return; }
    if (k === 'c') { choking = true; chokeRamp(1); return; }
    if (/^[0-9]$/.test(k)) { const i = k === '0' ? 9 : +k - 1; if (PAD_CHORDS[i]) padDown(PAD_CHORDS[i]); return; }
    const i = QWERTY.indexOf(k);
    if (i < 0) return;
    e.preventDefault();
    await start();
    const midi = octave + i; downKeys.set(k, midi);
    noteOn(midi, +$('keyvel').value / 100);
  });
  window.addEventListener('keyup', (e) => {
    const k = keyOf(e);
    if (k === ' ') { hands.setSustain(false); return; }
    if (k === 'c') { choking = false; chokeRamp(0); return; }
    if (downKeys.has(k)) { noteOff(downKeys.get(k)); downKeys.delete(k); }
  });
  window.addEventListener('blur', () => { for (const [, m] of downKeys) noteOff(m); downKeys.clear(); });
}
// the C key pushes the string across the fret to a whole step over ~0.15 s, and lets it back
let chokeAmt = 0, chokeTimer = 0;
function chokeRamp(target) {
  clearInterval(chokeTimer);
  chokeTimer = setInterval(() => {
    chokeAmt += (target * 2 - chokeAmt) * 0.35;
    if (Math.abs(chokeAmt - target * 2) < 0.02) { chokeAmt = target * 2; clearInterval(chokeTimer); }
    hands.choke(chokeAmt); markDirty();
  }, 16);
}
function shiftOct(d) {
  for (const [m] of litKeys) noteOff(m);
  octave = Math.max(24, Math.min(72, octave + d));
  buildKeys();
}

// ---------- MIDI ----------
let midiAccess = null;
async function initMidi() {
  if (!navigator.requestMIDIAccess) { midiMsg('This browser has no Web MIDI. Chrome, Edge and Firefox support it; Safari does not.'); return; }
  try { midiAccess = await navigator.requestMIDIAccess({ sysex: false }); }
  catch (e) { midiMsg('MIDI access was refused here. Open the GitHub Pages version to use a MIDI keyboard.'); return; }
  midiAccess.onstatechange = listInputs;
  listInputs();
}
function midiMsg(t) { $('midiNote').textContent = t; }
function listInputs() {
  const sel = $('midiIn'), cv = sel.value;
  sel.innerHTML = '<option value="all">All inputs</option>';
  let n = 0;
  for (const inp of midiAccess.inputs.values()) {
    const o = document.createElement('option'); o.value = inp.id; o.textContent = inp.name; sel.appendChild(o);
    inp.onmidimessage = onMidi; n++;
  }
  sel.value = [...sel.options].some(o => o.value === cv) ? cv : 'all';
  $('midiDot').classList.toggle('on', n > 0);
  $('midiStatus').textContent = n ? `${n} MIDI in` : 'no MIDI';
}
const clockTicks = [];
function onClock(st, ts) {
  if (st === 0xfa) { clockTicks.length = 0; return; }
  if (st !== 0xf8) return;
  clockTicks.push(ts); if (clockTicks.length > 25) clockTicks.shift();
  if (clockTicks.length === 25) {
    const bpm = 60000 / (clockTicks[24] - clockTicks[0]);
    if (bpm > 30 && bpm < 320 && Math.abs(bpm - (hands.o.bpm || 0)) > 0.3) { hands.set({ bpm }); $('bpm').value = Math.round(bpm); $('bpmOut').textContent = Math.round(bpm) + ' (clock)'; }
  }
}
function onMidi(e) {
  const sel = $('midiIn').value;
  if (sel !== 'all' && e.target.id !== sel) return;
  const [st, d1, d2] = e.data; const cmd = st & 0xf0;
  if (st >= 0xf8) { onClock(st, e.timeStamp); return; }
  const t = ctx ? ctx.currentTime + Math.min(0, (e.timeStamp - performance.now()) / 1000) : undefined;
  if (cmd === 0x90 && d2 > 0) { start(); noteOn(d1, Math.pow(d2 / 127, 0.9), t); }
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(d1);
  else if (cmd === 0xb0) {
    if (d1 === 64) hands.setSustain(d2 >= 64);
    else if (d1 === 1) { const v = Math.round(d2 / 127 * 100); $('licks').value = v; $('licksOut').textContent = v; hands.set({ licks: v / 100 }); }
    else if (d1 === 123 || d1 === 120) hands.allOff();
  } else if (cmd === 0xe0) {
    // pitch bend: a choke on the last string, up to a whole step (banjo bends go up)
    const v = ((d2 << 7) | d1) - 8192;
    hands.choke(Math.max(0, v / 8192) * 2); markDirty();
  }
}


// ---------- the banjo picture ----------
const cv = $('banjo'), g2 = cv.getContext('2d');
let W = 0, H = 0, dpr = 1, dirty = true;
const flash = [0, 0, 0, 0, 0];
function pulse(e) { if (e.s >= 0 && e.s < 5) flash[e.s] = Math.max(flash[e.s], e.dead ? 0.3 : 0.4 + e.vel * 0.6); markDirty(); }
function markDirty() { dirty = true; }
function resize() { dpr = Math.min(2, window.devicePixelRatio || 1); const r = cv.getBoundingClientRect(); W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); markDirty(); }
// Geometry: the neck on the left compressed to fit, the pot drawn to scale on the right. Physical positions along the
// strings (m from the nut) map to x piecewise: nut .. neck joint (fret ~22 at the rim), then over the head to the bridge.
function geom() {
  const sh = shadow && shadow.pot ? shadow.pot : null;
  const headD = cur('headD'), a = headD / 2;
  const R = Math.min(H * 0.44, W * 0.24);
  const k = R / a;                                   // px per metre on the pot
  const cx = W - R - Math.max(14, W * 0.03), cy = H * 0.5;
  const bridgeX = cx + (0.185 - a) * k;              // the bridge stands behind the centre, toward the tailpiece
  const rimL = cx - R, peg = Math.max(56, W * 0.07), nutX = peg + 6;
  const Lj = 0.667 - 0.185;                          // nut to the neck-side edge of the head
  const px = (x) => x <= Lj ? nutX + x / Lj * (rimL - nutX) : rimL + (x - Lj) / 0.185 * (bridgeX - rimL);
  const fx = (f) => px(0.667 * (1 - Math.pow(2, -f / 12)));
  // string y at the nut (4th..1st), at the bridge (all five), 5th string from its pip at fret 5
  const halfNut = Math.min(H * 0.07, 22), halfBridge = 0.0191 * k * 1.15;
  const yNut = [0, -0.75, -0.25, 0.25, 0.75].map(u => cy + u * halfNut * 1.6 / 1.5);
  const yBr = [-1, -0.5, 0, 0.5, 1].map(u => cy + u * halfBridge);
  const x5 = fx(5);
  const sy = (s, x) => {
    if (s === 0) { const t = (x - x5) / (bridgeX - x5); return (cy - halfNut * 1.25) + (yBr[0] - (cy - halfNut * 1.25)) * Math.max(0, t); }
    const t = (x - nutX) / (bridgeX - nutX); return yNut[s] + (yBr[s] - yNut[s]) * t;
  };
  const neckHalf = (x) => { const t = Math.min(1, (x - nutX) / (rimL - nutX)); return halfNut * 1.45 + t * halfNut * 0.45; };
  return { R, k, cx, cy, a, bridgeX, rimL, nutX, peg, px, fx, sy, x5, neckHalf, sh, tail: cx + R * 0.98 };
}
function noteLabel(m) { return NOTE[((m % 12) + 12) % 12]; }
function draw() {
  requestAnimationFrame(draw);
  const live = meters.some(m => m.e > 0.002) || flash.some(f => f > 0.01) || fingerMarks.some(m => engineTime() - m.t < 0.25);
  if (!dirty && !live) return;
  if (live && performance.now() - (draw.last || 0) < 30) return;
  draw.last = performance.now(); dirty = false;
  const G = geom(), g = g2, cs = getComputedStyle(document.documentElement), col = (v) => cs.getPropertyValue(v).trim();
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const back = cur('back'), headType = cur('head'), ring = cur('ring');
  // resonator flange and rim
  if (back === 'resonator') {
    const gr = g.createRadialGradient(G.cx, G.cy, G.R * 0.9, G.cx, G.cy, G.R * 1.17);
    gr.addColorStop(0, '#3b2615'); gr.addColorStop(1, '#5c3b1e');
    g.fillStyle = gr; g.beginPath(); g.arc(G.cx, G.cy, G.R * 1.16, 0, 7); g.fill();
    g.strokeStyle = '#8c6a3c'; g.lineWidth = 1; g.beginPath(); g.arc(G.cx, G.cy, G.R * 1.16, 0, 7); g.stroke();
  }
  // neck (drawn first so the pot overlaps its heel)
  const nx0 = G.nutX, nx1 = G.rimL + G.R * 0.2;
  g.fillStyle = '#2b1d12';
  g.beginPath(); g.moveTo(nx0, G.cy - G.neckHalf(nx0)); g.lineTo(nx1, G.cy - G.neckHalf(nx1)); g.lineTo(nx1, G.cy + G.neckHalf(nx1)); g.lineTo(nx0, G.cy + G.neckHalf(nx0)); g.closePath(); g.fill();
  // peghead with four tuners
  g.fillStyle = '#3a2716';
  g.beginPath(); g.moveTo(nx0, G.cy - G.neckHalf(nx0)); g.lineTo(6, G.cy - G.neckHalf(nx0) * 1.5); g.lineTo(6, G.cy + G.neckHalf(nx0) * 1.5); g.lineTo(nx0, G.cy + G.neckHalf(nx0)); g.closePath(); g.fill();
  g.fillStyle = col('--nickel') || '#c9ccd1';
  for (const [x, y] of [[0.35, -1.25], [0.7, -1.25], [0.35, 1.25], [0.7, 1.25]]) { g.beginPath(); g.arc(6 + (nx0 - 6) * x, G.cy + y * G.neckHalf(nx0), 3.2, 0, 7); g.fill(); }
  // frets and inlays
  for (let f = 1; f <= 22; f++) {
    const x = G.fx(f); if (x > G.rimL + 2) break;
    g.strokeStyle = f === 5 ? '#b9b1a0' : '#8e8676'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(x, G.cy - G.neckHalf(x)); g.lineTo(x, G.cy + G.neckHalf(x)); g.stroke();
    if ([3, 5, 7, 10, 12, 15, 17, 19, 22].includes(f)) {
      const xm = (x + G.fx(f - 1)) / 2; g.fillStyle = '#d9cfbb';
      g.beginPath(); if (f === 12) { g.arc(xm, G.cy - 6, 2.4, 0, 7); g.arc(xm, G.cy + 6, 2.4, 0, 7); } else { g.moveTo(xm, G.cy - 4); g.lineTo(xm + 3, G.cy); g.lineTo(xm, G.cy + 4); g.lineTo(xm - 3, G.cy); }
      g.fill();
    }
  }
  g.fillStyle = '#e9e0cc'; g.fillRect(nx0 - 3, G.cy - G.neckHalf(nx0), 3, G.neckHalf(nx0) * 2);
  // 5th-string peg on the side of the neck at the 5th fret
  const p5 = G.fx(5) - 6; g.fillStyle = col('--nickel') || '#c9ccd1';
  g.beginPath(); g.arc(p5, G.cy - G.neckHalf(p5) - 5, 4, 0, 7); g.fill();
  g.fillStyle = '#e9e0cc'; g.beginPath(); g.arc(G.x5, G.sy(0, G.x5), 2, 0, 7); g.fill();
  // rim with brackets and the head
  g.fillStyle = ring === 'none' ? '#6b4a2a' : '#b98d3a';
  g.beginPath(); g.arc(G.cx, G.cy, G.R * 1.04, 0, 7); g.fill();
  const headCol = { frosted: '#ece6d8', clear: '#cfd3cf', smooth: '#efe8d4', fibre: '#e6d6ad', calf: '#d9c08c' }[headType] || '#ece6d8';
  const hg = g.createRadialGradient(G.cx - G.R * 0.25, G.cy - G.R * 0.3, G.R * 0.1, G.cx, G.cy, G.R);
  hg.addColorStop(0, headCol); hg.addColorStop(1, shade(headCol, -0.12));
  g.fillStyle = hg; g.beginPath(); g.arc(G.cx, G.cy, G.R, 0, 7); g.fill();
  // head motion: a faint ring pulse when the strings are loud
  const eTot = meters.reduce((s, m) => s + m.e, 0);
  if (eTot > 0.01) { g.strokeStyle = `rgba(226,176,74,${Math.min(0.35, eTot * 0.6)})`; g.lineWidth = 2; g.beginPath(); g.arc(G.cx, G.cy, G.R * (0.5 + 0.05 * Math.sin(performance.now() / 40)), 0, 7); g.stroke(); }
  // tension hoop and 24 hooks
  g.strokeStyle = '#c9ccd1'; g.lineWidth = 3; g.beginPath(); g.arc(G.cx, G.cy, G.R * 1.015, 0, 7); g.stroke();
  for (let i = 0; i < 24; i++) {
    const th = i / 24 * Math.PI * 2 + Math.PI / 24, c = Math.cos(th), s = Math.sin(th);
    g.strokeStyle = '#b8bcc2'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(G.cx + c * G.R * 1.02, G.cy + s * G.R * 1.02); g.lineTo(G.cx + c * G.R * 1.11, G.cy + s * G.R * 1.11); g.stroke();
  }
  // armrest over the lower rim
  g.strokeStyle = '#d5d8dc'; g.lineWidth = 4; g.beginPath(); g.arc(G.cx, G.cy, G.R * 1.07, Math.PI * 0.2, Math.PI * 0.62); g.stroke();
  // tailpiece
  const yb0 = G.sy(0, G.bridgeX), yb4 = G.sy(4, G.bridgeX);
  g.fillStyle = '#c3c6cb';
  g.beginPath(); g.moveTo(G.tail - G.R * 0.28, yb0 - 4); g.lineTo(G.tail + 4, G.cy - 10); g.lineTo(G.tail + 4, G.cy + 10); g.lineTo(G.tail - G.R * 0.28, yb4 + 4); g.closePath(); g.fill();
  // the picking spot (where the right hand is set)
  const spot = hands.o.spot != null ? hands.o.spot : (BanjoHand.STYLES[hands.o.style] || {}).spot || 0.06;
  const spotX = G.px(0.667 - spot * 0.667);
  g.fillStyle = 'rgba(226,176,74,0.10)'; g.fillRect(spotX - 10, yb0 - 16, 20, yb4 - yb0 + 32);
  // strings
  for (let s = 0; s < 5; s++) {
    const m = meters[s] || { e: 0 };
    const x0 = s === 0 ? G.x5 : G.nutX, wire = s === 1;
    const amp = Math.min(5, m.e * 30) + flash[s] * 2.5;
    const lw = wire ? 1.9 : s === 0 || s === 4 ? 1.1 : 1.3;
    g.strokeStyle = wire ? '#c7bfae' : '#dfe2e6'; g.lineWidth = lw;
    g.beginPath(); g.moveTo(x0, G.sy(s, x0)); g.lineTo(G.bridgeX, G.sy(s, G.bridgeX)); g.lineTo(G.tail - G.R * 0.28, G.sy(s, G.bridgeX) * 0.8 + G.cy * 0.2); g.stroke();
    if (amp > 0.15) {
      // vibration envelope between the stopping point and the bridge
      const fr = (shape[s] > 0 ? shape[s] : 0) + (s === 0 ? 5 : 0), xs = s === 0 ? G.fx(5 + Math.max(0, shape[0])) : G.fx(Math.max(0, shape[s]));
      g.strokeStyle = `rgba(226,176,74,${Math.min(0.85, 0.25 + amp * 0.15)})`; g.lineWidth = 1;
      for (const sg of [-1, 1]) { g.beginPath(); for (let q = 0; q <= 24; q++) { const x = xs + (G.bridgeX - xs) * q / 24; g.lineTo(x, G.sy(s, x) + sg * amp * Math.sin(Math.PI * q / 24)); } g.stroke(); }
      void fr;
    }
    flash[s] *= 0.8;
  }
  // bridge (three feet)
  g.fillStyle = '#d7b88a'; g.strokeStyle = '#7b5b33'; g.lineWidth = 1;
  g.fillRect(G.bridgeX - 2.5, yb0 - 8, 5, yb4 - yb0 + 16); g.strokeRect(G.bridgeX - 2.5, yb0 - 8, 5, yb4 - yb0 + 16);
  // left-hand fingers
  const open = hands.open();
  for (let s = 0; s < 5; s++) {
    const f = shape[s]; if (!(f > 0)) continue;
    const fret = s === 0 ? 5 + f : f, x = (G.fx(fret) + G.fx(fret - 1)) / 2 + 2, y = G.sy(s, x);
    g.fillStyle = col('--brass'); g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
    g.fillStyle = '#2a1d05'; g.font = '600 9px Figtree, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(noteLabel(open[s] + f), x, y + 0.5);
  }
  // right-hand fingers as they pluck
  const now = engineTime();
  for (const fm of fingerMarks) {
    const age = now - fm.t; if (age < -0.02 || age > 0.25) continue;
    const x = spotX + (fm.finger === 'T' ? -7 : fm.finger === 'I' ? 2 : 9), y = G.sy(fm.s, x) + (fm.finger === 'T' ? -11 : 11);
    g.globalAlpha = Math.max(0, 1 - age / 0.25);
    g.fillStyle = fm.finger === 'T' ? '#8fc7e8' : fm.finger === 'S' ? '#e88f7a' : '#e2b04a';
    g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill();
    g.fillStyle = '#111'; g.font = '600 9px Figtree, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(fm.finger === 'S' ? 'n' : fm.finger, x, y + 0.5);
    g.globalAlpha = 1;
  }
  // string names at the nut
  g.fillStyle = col('--muted'); g.font = '10px "JetBrains Mono", monospace'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let s = 1; s < 5; s++) g.fillText(noteLabel(open[s]), G.nutX - 6, G.sy(s, G.nutX));
  g.textAlign = 'left'; g.fillText(noteLabel(open[0]), G.x5 + 4, G.sy(0, G.x5) - 9);
}
function shade(hex, amt) { const n = parseInt(hex.slice(1), 16); let r = n >> 16, gg = (n >> 8) & 255, b = n & 255; r = Math.round(r * (1 + amt)); gg = Math.round(gg * (1 + amt)); b = Math.round(b * (1 + amt)); return `rgb(${r},${gg},${b})`; }

// tapping and swiping the picture: strings on the head are picked, the neck is fretted, the bare head is tapped
let swipe = null;
function hitString(G, x, y) {
  let best = -1, bd = 1e9;
  for (let s = 0; s < 5; s++) { if (s === 0 && x < G.x5) continue; const d = Math.abs(y - G.sy(s, x)); if (d < bd) { bd = d; best = s; } }
  return bd < 9 ? best : -1;
}
function pickStyleFor(s) {
  const kind = (BanjoHand.STYLES[hands.o.style] || {}).kind, picks = hands.o.picks === 'picks';
  if (kind === 'claw') return s === 0 ? { style: 'tflesh', dir: -1 } : { style: 'nail', dir: -1 };
  const thumb = s <= 2;
  return thumb ? { style: picks ? 'tpick' : 'tflesh', dir: -1 } : { style: picks ? 'fpick' : 'flesh', dir: 1 };
}
function pickString(s, vel) {
  const open = hands.open(), f = Math.max(0, shape[s] || 0), st = pickStyleFor(s);
  send([{ type: 'pluck', s, midi: open[s] + f, vel, style: st.style, dir: st.dir, pickPos: hands.spot(), t: engineTime() + 0.005 }]);
  fingerMarks.push({ s, finger: st.style === 'nail' ? 'S' : st.dir < 0 ? 'T' : s === 4 ? 'M' : 'I', t: engineTime() + 0.005 });
}
function bindBanjo() {
  cv.addEventListener('pointerdown', async (e) => {
    e.preventDefault(); await start(); cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G = geom();
    const onHead = Math.hypot(x - G.cx, y - G.cy) < G.R;
    const s = hitString(G, x, y);
    if (x < G.rimL && s >= 0) {
      // the neck: fret this string here and pick it
      let fret = 0; for (let f = 1; f <= 22; f++) { if (G.fx(f) > x) { fret = f; break; } }
      if (s === 0) fret = Math.max(0, fret - 5);
      shape[s] = fret; $('shapeText').textContent = shapeLabel(shape);
      pickString(s, 0.7); markDirty(); return;
    }
    if (onHead && s >= 0) { swipe = { last: s, y }; pickString(s, 0.72); return; }
    if (onHead) { send([{ type: 'tap', vel: 0.7, t: engineTime() + 0.005 }]); return; }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!swipe || !e.buttons) return;
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G = geom();
    const s = hitString(G, x, y);
    if (s >= 0 && s !== swipe.last) { swipe.last = s; pickString(s, 0.6); }
  });
  const end = () => { swipe = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  window.addEventListener('resize', resize);
}

// ---------- start ----------
function init() {
  bindSegs(); bindStyleSel(); bindSliders(); bindSetup(); bindSpace(); bindKeys(); bindQwerty(); bindBanjo();
  buildKeys(); renderChords(); resize(); requestAnimationFrame(draw);
  const t = tuning(); hands.set({ tuning: t, capo: capo(), spike: spike() });
  $('startBtn').addEventListener('click', start);
  $('recBtn').addEventListener('click', toggleRecord);
  $('panicBtn').addEventListener('click', () => { hands.allOff(); padHeld = null; document.querySelectorAll('.chord').forEach(c => c.classList.remove('on')); send([{ type: 'panic', t: engineTime() }]); });
  $('shapeText').textContent = shapeLabel(shape);
  window.__banjo = { get ctx() { return ctx; }, get meters() { return meters; }, hands, send, get node() { return node; } };
}
init();
})();
