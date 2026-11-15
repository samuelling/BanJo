// BanJo as a MEGAjam instrument (https://github.com/samuelling/JamJam).
//
// MEGAjam plays every jammer's instruments in every jammer's browser, so this banjo must make the same sound
// everywhere from the same timestamped notes. Like Acoustic's adapter, it runs BanJo's own code unchanged:
//  - The hands (src/hand.js) gather chords and roll on timers, read the clock and humanize with random numbers.
//    Here they run on a virtual clock in room time (identical in every browser), their timers are virtual, and
//    their random numbers are reseeded from that time before every step. With the room's tempo on, a roll starts on
//    the room's eighth-note grid at the right step of the bar, so "one" lines up with the band's drums.
//  - The banjo engine (src/engine.js) jitters each pluck with a running random generator. Here every event carries a
//    seed taken from its room time, so a bandmate who walked in late still hears the same pluck.
//  - The pot (src/pot.js, a few hundred coupled modes) and the room (src/space.js, image sources) are built in a
//    worker from the same settings everywhere, so they're the same too, and never stall the audio thread.
// Quality is fixed at full and the CPU mode at light for everyone: the cheaper settings would make the banjo sound
// different in a slower bandmate's browser.

const FILES = ['src/space.js', 'src/pot.js', 'src/engine.js', 'src/hand.js'];
const PRESET_IDS = ['bluegrass', 'archtop', 'openback', 'oldtime'];
const TUNING_IDS = ['openG', 'doubleC', 'sawmill', 'openD', 'doubleD', 'standC', 'gMinor', 'openA'];
const ROOMS = ['living', 'studio', 'outdoors', 'recital', 'hall', 'church', 'forest', 'pines', 'winterwood', 'canyon', 'lake', 'cave'];
const LEAD = 0.015;     // the hands think this far ahead of the audio clock (s)
const POT_SR = 48000;   // the pot is built at one rate everywhere (BanJo's own app does the same)

const hash32 = (x) => { let h = (x | 0) ^ 0x9e3779b9; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
const rngFrom = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const seedOf = (tRoom, salt = 0) => hash32(Math.round(tRoom * 96000) + salt * 7919);

export default async function (arg, { base }) {
  const src = {};
  await Promise.all(FILES.map(async (f) => {
    const r = await fetch(new URL(f, base).href, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`BanJo: couldn't load ${f} (${r.status})`);
    src[f] = await r.text();
  }));
  const DSP = src['src/space.js'] + '\n' + src['src/pot.js'] + '\n' + src['src/engine.js'];
  // for the worklet: without BanJo's own processor (this adapter registers its own), the engine's wrapper closed again
  const DSPW = DSP.replace(/if \(typeof registerProcessor[\s\S]*$/, '') + '\n})(typeof globalThis !== \'undefined\' ? globalThis : this);';
  const tag = (hash32(DSP.length * 31 + src['src/hand.js'].length) >>> 0).toString(36);
  const PROC = `megajam-banjo-${tag}`;
  // the hands, compiled once; each banjo gets its own copy with its own virtual timers
  const handsFactory = new Function('globalThis', 'setTimeout', 'clearTimeout', src['src/hand.js'] + '\nreturn globalThis;');
  const probe = handsFactory({}, () => 0, () => {});
  const STYLES = probe.BanjoHand?.STYLES || {}, STYLE_IDS = Object.keys(STYLES);
  const lib = {};
  new Function('globalThis', DSP + '\nreturn globalThis;')(lib);   // names for the labels (no worklet here: registerProcessor is absent)
  const label = (s) => String(s || '').replace(/ \(.*\)$/, '');
  const roomIds = ROOMS.filter((k) => lib.BanjoSpace?.ROOMS?.[k]); if (!roomIds.length) roomIds.push(...Object.keys(lib.BanjoSpace?.ROOMS || { living: 1 }).slice(0, 12));
  const MIC_IDS = Object.keys(lib.BanjoSpace?.MIC_SETUPS || { front30: 1 }).slice(0, 8);

  const PARAMS = [
    { id: 'body', name: 'Banjo', options: PRESET_IDS.map((k) => label(lib.BANJO_PRESETS?.[k]?.name) || k), min: 0, max: PRESET_IDS.length - 1, def: 0, step: 1, group: 'BANJO' },
    { id: 'tuning', name: 'Tuning', options: TUNING_IDS.map((k) => label(lib.BANJO_TUNINGS?.[k]?.name) || k), min: 0, max: TUNING_IDS.length - 1, def: 0, step: 1, group: 'BANJO' },
    { id: 'capo', name: 'Capo', min: 0, max: 7, def: 0, step: 1, unit: 'fret', group: 'BANJO' },
    { id: 'bright', name: 'Strings', min: 0, max: 1, def: 0.6, group: 'BANJO', cc: 74 },
    { id: 'style', name: 'Right hand', options: [...STYLE_IDS.map((k) => label(STYLES[k].name)), 'Free notes'], min: 0, max: STYLE_IDS.length, def: Math.max(0, STYLE_IDS.indexOf('forward')), step: 1, group: 'HANDS' },
    { id: 'sync', name: "Room's tempo", min: 0, max: 1, def: 1, step: 1, group: 'HANDS' },
    { id: 'bpm', name: 'Own tempo', min: 50, max: 280, def: 132, step: 1, unit: 'bpm', group: 'HANDS' },
    { id: 'voicing', name: 'Voicing', options: ['Banjo shape', 'As played'], min: 0, max: 1, def: 0, step: 1, group: 'HANDS' },
    { id: 'drone', name: '5th string', options: ['Open drone', 'Follows the chord'], min: 0, max: 1, def: 0, step: 1, group: 'HANDS' },
    { id: 'free', name: 'Free notes', options: ['Melodic', 'Single-string'], min: 0, max: 1, def: 0, step: 1, group: 'HANDS' },
    { id: 'skill', name: 'Player skill', min: 0, max: 1, def: 0.65, group: 'HANDS' },
    { id: 'humanize', name: 'Humanize', min: 0, max: 1, def: 0.6, group: 'HANDS' },
    { id: 'licks', name: 'Licks', min: 0, max: 1, def: 0.3, group: 'HANDS', cc: 1 },
    { id: 'strength', name: 'Strength', min: 0.1, max: 1, def: 0.62, group: 'HANDS' },
    { id: 'room', name: 'Place', options: roomIds.map((k) => lib.BanjoSpace.ROOMS[k]?.name || k), min: 0, max: roomIds.length - 1, def: 0, step: 1, group: 'SPACE' },
    { id: 'mic', name: 'Mics', options: MIC_IDS.map((k) => lib.BanjoSpace.MIC_SETUPS[k]?.name || k), min: 0, max: MIC_IDS.length - 1, def: 0, step: 1, group: 'SPACE' },
    { id: 'reverb', name: 'Room level', min: 0, max: 1.5, def: 0.6, group: 'SPACE', cc: 91 },
    { id: 'level', name: 'Level', min: 0, max: 1, def: 0.8, group: 'SPACE', cc: 7 },
  ];
  const sty = (k) => Math.max(0, STYLE_IDS.indexOf(k)), pre = (k) => Math.max(0, PRESET_IDS.indexOf(k));
  const PRESETS = {
    scruggs: { body: pre('bluegrass'), style: sty('forward'), voicing: 0 },
    foggy: { body: pre('bluegrass'), style: sty('foggy'), voicing: 0 },
    pinches: { body: pre('archtop'), style: sty('pinchroll') },
    clawhammer: { body: pre('openback'), style: sty('claw'), tuning: 2 },
    frailing: { body: pre('oldtime'), style: sty('frail') },
    backup: { body: pre('bluegrass'), style: sty('vamp') },
    melodic: { body: pre('bluegrass'), style: STYLE_IDS.length, free: 0 },
  };

  // one worker builds pots and rooms for every banjo in this browser, off the audio thread
  let worker = null; const waiters = new Map(); let seq = 0;
  const ask = (msg, transfer) => new Promise((resolve) => {
    if (!worker) {
      worker = new Worker(URL.createObjectURL(new Blob([DSP + `
        let sh = null;
        self.onmessage = (e) => {
          const { id, kind } = e.data;
          if (kind === 'pot') { sh = sh || new BanjoEngine(${POT_SR}); sh.setParams(e.data.params); self.postMessage({ id, pot: sh.pot, geom: sh.sceneGeom ? sh.sceneGeom() : null }); return; }
          const sc = e.data.scene, ir = BanjoSpace.buildIRs(sc, e.data.sr);
          const bufs = [ir.front[0], ir.front[1], ir.back[0], ir.back[1]];
          self.postMessage({ id, bufs }, bufs.map((b) => b.buffer));
        };`], { type: 'text/javascript' })));
      worker.onmessage = (e) => { const w = waiters.get(e.data.id); waiters.delete(e.data.id); if (w) w(e.data); };
    }
    const id = ++seq; waiters.set(id, resolve); worker.postMessage({ ...msg, id }, transfer || []);
  });

  return {
    name: 'BanJo',
    family: 'Physically modelled five-string banjo',
    blurb: 'Five steel strings on a drumhead, with picking hands: hold a chord and it rolls Scruggs-style, frails clawhammer or chops backup on the band\'s beat; notes over the roll become melody.',
    accent: '#c9a227',
    traits: { arch: ['pluck', 'banjo'], voices: 5 },
    contentHash: tag,
    params: PARAMS,
    presets: PRESETS,
    async init(ctx) {
      ctx.__jjWorklets = ctx.__jjWorklets || new Set();
      if (ctx.__jjWorklets.has(PROC)) return;
      const code = DSPW + `
;(() => {
  const rngFrom = ${rngFrom.toString()};
  class P extends AudioWorkletProcessor {
    constructor() {
      super(); this.eng = new globalThis.BanjoEngine(sampleRate, { externalPot: true }); this.dead = false;
      this.eng.setParams({ quality: 'high', cpu: 'light' });
      const handle = this.eng.handle.bind(this.eng);
      this.eng.handle = (ev) => { if (ev.seed != null) this.eng.rng = rngFrom(ev.seed); handle(ev); };
      this.port.onmessage = (m) => { if (m.data === 'dispose') { this.dead = true; return; } for (const ev of m.data) this.eng.post(ev); };
    }
    process(_, outputs) {
      const o = outputs[0]; if (this.eng.clock === 0) this.eng.clock = Math.round(currentTime * sampleRate);
      this.eng.render(o[0], o[1] || o[0], o[0].length, 0, o[2] || null, o[3] || null);
      return !this.dead;
    }
  }
  registerProcessor('${PROC}', P);
})();`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      ctx.__jjWorklets.add(PROC);
    },
    create(ctx, out, init = {}, env = null) {
      const p = {}; for (const d of PARAMS) p[d.id] = init[d.id] ?? d.def;
      // room time (s) <-> audio time (s). Without MEGAjam's env, room time is audio time.
      const toCtx = (tr) => (env ? env.audioTime(tr * 1000) : tr);
      const roomNow = () => (env ? env.roomTime(ctx.currentTime) / 1000 : ctx.currentTime);

      // the engine's four outputs: dry L/R, and the two room feeds (light CPU: both into one convolver)
      const node = new AudioWorkletNode(ctx, PROC, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [4] });
      const split = ctx.createChannelSplitter(4), dry = ctx.createChannelMerger(2), wet = ctx.createGain(), level = ctx.createGain(), conv = ctx.createConvolver();
      conv.normalize = false;
      node.connect(split); split.connect(dry, 0, 0); split.connect(dry, 1, 1); split.connect(conv, 2); split.connect(conv, 3);
      conv.connect(wet); dry.connect(level); wet.connect(level); level.connect(out);
      level.gain.value = p.level; wet.gain.value = p.reverb;

      // --- the virtual clock: everything the hands do happens in room time, in order
      let vt = 0, shift = 0, order = 0, dead = false;
      const log = [];        // what the hands decided, in room time: the same list in every browser (tests read it)
      const q = [];          // {at, ord, fn}
      const push = (at, fn) => { const it = { at, ord: ++order, fn }; let i = q.length; while (i > 0 && (q[i - 1].at > at || (q[i - 1].at === at && q[i - 1].ord > it.ord))) i--; q.splice(i, 0, it); return it.ord; };
      const vSet = (fn, ms) => push(vt + Math.max(0, +ms || 0) / 1000, fn);
      const vClear = (id) => { const i = q.findIndex((x) => x.ord === id); if (i >= 0) q.splice(i, 1); };
      let rng = rngFrom(1);
      const roomBpm = () => (p.sync && env && env.bpm ? env.bpm(vt * 1000) : p.bpm);
      const run = (until) => {
        while (q.length && q[0].at <= until) {
          const it = q.shift(); vt = Math.max(vt, it.at); rng = rngFrom(seedOf(vt, 0));
          if (p.sync) hands.o.bpm = roomBpm();   // the tempo at this moment of room time: the same answer in every browser
          try { it.fn(); } catch (e) { console.warn('BanJo hands:', e); }
        }
      };
      // the engine gets everything in audio time, each event seeded from its room time
      const post = (evs) => {
        const outEvs = [];
        for (const e of evs) {
          const tr = e.t == null ? vt : e.t, seed = seedOf(tr, (e.s ?? 7) + 1);
          outEvs.push({ ...e, t: toCtx(tr) - shift, seed });
          if (e.type === 'pluck' || e.type === 'hammer' || e.type === 'pulloff' || e.type === 'glide') { log.push(`${e.type} s${e.s ?? ''} ${e.midi ?? ''} @${tr.toFixed(5)} #${seed}`); if (log.length > 600) log.splice(0, 200); }
        }
        if (outEvs.length && !dead) node.port.postMessage(outEvs);
      };
      const G = handsFactory({}, vSet, vClear);
      const hands = new G.BanjoHands({ send: post, now: () => vt, timers: { set: vSet, clear: vClear }, seed: 1 });
      hands.rng = () => rng();   // the hands' random numbers come from room time

      const tuning = () => (lib.BANJO_TUNINGS[TUNING_IDS[p.tuning]] || lib.BANJO_TUNINGS.openG).t.slice();
      const styleId = () => (p.style >= STYLE_IDS.length ? null : STYLE_IDS[p.style] || 'forward');
      const handOpts = () => {
        const sid = styleId(), kind = sid ? STYLES[sid].kind : 'free';
        return { mode: sid ? 'pattern' : 'free', style: sid || hands.o.style, picks: kind === 'claw' ? 'bare' : 'picks', bpm: roomBpm(),
          voicing: p.voicing ? 'played' : 'banjo', drone: p.drone ? 'follow' : 'open', freeStyle: p.free ? 'single' : 'melodic',
          skill: p.skill, humanize: p.humanize, licks: p.licks, strength: p.strength, tuning: tuning(), capo: p.capo, spike: p.capo };
      };
      const engineParams = () => ({ preset: PRESET_IDS[p.body] || 'bluegrass', tuning: tuning(), capo: p.capo, spike: p.capo, brightness: p.bright, quality: 'high', cpu: 'light' });
      // the pot (and then the room, which needs the pot's shape): built in the worker, then handed to the engine
      let potJob = 0, potKey = '', roomKey = '', geom = null;
      const sceneOf = () => {
        const S = lib.BanjoSpace, room = S.ROOMS[roomIds[p.room]] || S.ROOMS.living;
        const [Lx, Ly] = room.open ? [12, 8] : room.dims, mx = Math.min(1.2, Lx * 0.2), my = Math.min(1.2, Ly * 0.2);
        return { room: roomIds[p.room] || 'living', mics: S.scaledSetup(MIC_IDS[p.mic] || 'front30', 1, 'default'), hold: 'lap',
          guitar: { pos: [Math.max(mx, Math.min(Lx - mx, Lx * 0.42)), Math.max(my, Math.min(Ly - my, Ly * 0.62)), 0.95], yaw: 0 }, geom };
      };
      const rebuildRoom = async () => {
        const key = `${p.room}/${p.mic}/${p.body}`; if (key === roomKey || !geom) return; roomKey = key;
        const sc = { ...sceneOf(), maxDur: 2.5 };
        post([{ type: 'params', t: null, params: { scene: { mics: sc.mics, hold: 'lap' } } }]);
        const d = await ask({ kind: 'ir', scene: sc, sr: ctx.sampleRate });
        if (dead || key !== roomKey) return;
        const B = ctx.createBuffer(2, d.bufs[0].length, ctx.sampleRate); B.getChannelData(0).set(d.bufs[0]); B.getChannelData(1).set(d.bufs[1]);
        conv.buffer = B;
      };
      const rebuildPot = async () => {
        const params = engineParams(), key = JSON.stringify([params.preset, params.tuning, params.capo]); if (key === potKey) return; potKey = key;
        const job = ++potJob, d = await ask({ kind: 'pot', params });
        if (dead || job !== potJob) return;
        geom = d.geom; roomKey = '';
        node.port.postMessage([{ type: 'params', params, t: null }, { type: 'pot', pot: d.pot, t: null }]);
        rebuildRoom();
      };
      hands.set(handOpts()); node.port.postMessage([{ type: 'params', params: engineParams(), t: null }]); rebuildPot();

      // with the room's tempo on, a roll starts on the room's eighth-note grid at the right step of the bar
      if (env && env.beatAt) {
        const start0 = hands.start.bind(hands);
        hands.start = (t) => {
          if (!p.sync) return start0(t);
          const nb = Math.ceil(env.beatAt(t * 1000) * 2 - 1e-6) / 2;
          hands.running = true; hands.drift = 0; hands.tGrid = env.timeOf(nb) / 1000;
          hands.step = Math.round((((nb % 4) + 4) % 4) * 2) % 8;
          hands.sched();
        };
      }

      const tick = setInterval(() => run(roomNow() + LEAD + shift), 5);
      // a MEGAjam event at audio time t with room stamp at (ms). Self-monitored notes (t now, at in the future)
      // are decided at their room time like everyone else's, then played early by the difference.
      const input = (t, at, fn) => {
        const tr = at != null ? at / 1000 : t;
        const early = toCtx(tr) - t;
        shift = early > 0.004 ? early : 0;
        push(tr, fn); if (shift) run(roomNow() + LEAD + shift);
      };
      return {
        noteOn: (note, vel, t, at) => input(t, at, () => hands.noteOn(note, Math.max(0.02, Math.min(1, vel / 127)), vt)),
        noteOff: (note, t, at) => input(t, at, () => hands.noteOff(note)),
        set: (id, v, t, at) => {
          if (id === 'bend') { input(t, at, () => hands.choke(Math.max(0, v))); return; }   // pitch bend up chokes the string
          if (!(id in p)) return;
          p[id] = v;
          if (id === 'level') { level.gain.setTargetAtTime(v, t, 0.02); return; }
          if (id === 'reverb') { wet.gain.setTargetAtTime(v, t, 0.02); return; }
          input(t, at, () => {
            hands.set(handOpts());
            if (id === 'style' && hands.running && (!styleId() || hands.o.mode === 'free')) hands.stop();
            if (id === 'bright') post([{ type: 'params', t: vt, params: { brightness: v } }]);
            if (['body', 'tuning', 'capo'].includes(id)) rebuildPot();
            if (['room', 'mic'].includes(id)) rebuildRoom();
          });
        },
        allOff: (t) => input(t, null, () => hands.allOff()),
        _log: log,
        dispose: () => { dead = true; clearInterval(tick); q.length = 0; node.port.postMessage('dispose'); level.disconnect(); },
      };
    },
  };
}
