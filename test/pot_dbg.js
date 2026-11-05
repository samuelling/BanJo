require('../src/pot.js');
const P = globalThis.BanjoPot;
for (const spec of [{ back: 'open', bare: true, ring: 'none' }, {}]) {
const pot = P.buildPot(spec);
const idx = pot.f.map((f,i)=>i).sort((a,b)=>pot.f[a]-pot.f[b]);
console.log('---', JSON.stringify(spec));
for (const i of idx.slice(0, 14)) console.log(pot.f[i].toFixed(1), 'Q', pot.Q[i].toFixed(0), 'P', pot.P[i].map(x=>x.toExponential(2)).join(' '), 'R', Array.from(pot.R[i]).map(x=>x.toExponential(1)).join(' '));
}
