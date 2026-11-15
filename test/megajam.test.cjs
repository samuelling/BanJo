// BanJo in MEGAjam: two jammers, Sam plays the banjo from this checkout served as a library.
//   - the library loads, and Matt's browser loads it on its own when Sam picks the banjo
//   - held G chord: the hands roll, every pluck on the room's eighth-note grid (with humanizing off: Skill 1,
//     Humanize 0)
//   - Matt's banjo decides exactly the same plucks, at the same room times, with the same seeds
//   - it makes sound (both browsers), the pot and the room get built, and the arpeggiator is offered too
//   - no page errors
// Needs MEGAjam (https://github.com/samuelling/JamJam) running at localhost:8787 (node server/dev.js) and
// Playwright; this folder is served on 8793 by MEGAjam's tools/serve-library.py:
//   python3 ../JamJam/tools/serve-library.py . --port 8793 &      node test/megajam.test.cjs
const { chromium } = require('playwright');
const BASE = process.env.MEGAJAM || 'http://localhost:8787/', LIB = process.env.LIB || 'http://localhost:8793/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) failures++; };
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const errors = [];
  const mk = async (q, name) => { const c = await browser.newContext(); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(name + ': ' + e.message)); p.on('console', (m) => { if (m.type() === 'error' && /BanJo|banjo/i.test(m.text())) errors.push(name + ' console: ' + m.text()); }); await p.goto(BASE + q); await p.fill('#nameIn', name); return p; };
  try {
    const A = await mk('?lag=25', 'Sam');
    await A.click('#startBtn'); await A.waitForSelector('#studio:not(.hide)');
    const code = await A.textContent('#roomCode');
    const B = await mk(`?room=${code}&lag=25`, 'Matt');
    await B.click('#joinBtn'); await B.waitForSelector('#studio:not(.hide)');
    for (let i = 0; i < 60; i++) { const ok = await Promise.all([A, B].map((p) => p.evaluate(() => JJ.clock.locked && JJ.S.players.size === 1))); if (ok.every(Boolean)) break; await sleep(250); }
    const lib = await A.evaluate(async (u) => { const l = await JJ.engine.addLibrary(u); const d = await JJ.engine.ensureDef('banjo/banjo'); return { name: l.name, def: d.name, params: d.params.map((p) => p.id), arp: d.params.some((p) => p.id === 'arpMode'), presets: Object.keys(d.presets) }; }, LIB);
    check(lib.def === 'BanJo' && lib.presets.includes('clawhammer'), `the library loads: ${lib.def}, presets ${lib.presets.join(', ')}`);
    check(lib.arp, 'it offers the arpeggiator too');
    const r = await A.evaluate(() => JJ.addInstrument('banjo/banjo', 'scruggs')?.r);
    await A.evaluate(() => { JJ.setParam('skill', 1); JJ.setParam('humanize', 0); JJ.setParam('licks', 0); });
    const me = await A.evaluate(() => JJ.S.me), pid = `${me}:${r}`;
    let bOk = false; for (let i = 0; i < 60 && !bOk; i++) { await sleep(500); bOk = await B.evaluate((pid) => !!JJ.engine.channel(pid)?.insts?.[0]?.inst?._log, pid); }
    check(bOk, "Matt's browser loads the banjo by itself");
    await sleep(4000);   // pots and rooms built
    const t0 = await A.evaluate(() => JJ.clock.now());
    await A.evaluate(() => { JJ.input.press(55, 100, 0); JJ.input.press(59, 95, 0); JJ.input.press(62, 90, 0); });
    await sleep(3500);
    await A.evaluate(() => { JJ.input.release(55, 0); JJ.input.release(59, 0); JJ.input.release(62, 0); });
    await sleep(1500);
    const logOf = (p) => p.evaluate(([pid, t0]) => (JJ.engine.channel(pid)?.insts?.[0]?.inst?._log || []).filter((l) => l.startsWith('pluck') && +l.split('@')[1].split(' ')[0] * 1000 > t0), [pid, t0]);
    const la = await logOf(A), lb = await logOf(B);
    console.log('   ', la.slice(0, 4).join(' | '));
    check(la.length >= 10, `held G, the hands roll (${la.length} plucks in 3.5 s)`);
    const ats = la.map((l) => +l.split('@')[1].split(' ')[0] * 1000);
    const grid = await A.evaluate((ats) => ats.map((at) => { const b = JJ.tempo.beatAt(at) * 2; return Math.abs(b - Math.round(b)); }), ats);
    const offGrid = grid.filter((d) => d > 0.06).length;   // a roll pushes the beat a few ms and swings a little
    check(offGrid <= 2, `the roll sits on the room's eighth-note grid (${offGrid} of ${ats.length} off)`);
    const same = lb.length >= la.length - 1 && la.slice(0, Math.min(la.length, lb.length)).every((l, i) => l === lb[i]);
    check(same, `Matt's banjo decides the same plucks, at the same room times, with the same seeds (${lb.length} vs ${la.length})`);
    // sound: both browsers' master output moves while it rolls
    const loud = async (p) => p.evaluate(async (pid) => { const ctx = JJ.engine.ctx, an = ctx.createAnalyser(), src = JJ.engine.channel(pid).out; an.fftSize = 2048; src.connect(an); let m = 0; const d = new Float32Array(2048); for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 60)); an.getFloatTimeDomainData(d); for (const v of d) m = Math.max(m, Math.abs(v)); } src.disconnect(an); return m; }, pid);
    await A.evaluate(() => { JJ.input.press(55, 110, 0); JJ.input.press(59, 110, 0); JJ.input.press(62, 110, 0); });
    const [pa, pb] = await Promise.all([loud(A), loud(B)]);
    await A.evaluate(() => { JJ.input.release(55, 0); JJ.input.release(59, 0); JJ.input.release(62, 0); });
    check(pa > 0.01 && pb > 0.01, `it sounds in both browsers (peaks ${pa.toFixed(3)} / ${pb.toFixed(3)})`);
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { console.log('FAIL', e.message); failures++; }
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})();
