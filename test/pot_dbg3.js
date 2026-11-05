require('../src/pot.js');
const P = globalThis.BanjoPot;
const pot = P.buildPot({ back: 'open', bare: true, ring: 'none', debug: true });
const idx = pot.f.map((f,i)=>i).sort((a,b)=>pot.f[a]-pot.f[b]).slice(0,5);
const NM = pot.NM;
for (const i of idx) {
  const phi = pot.phi[i]; const e = phi.map((x,k)=>x*x*pot.Mv[k]);
  const top = Array.from(e.keys()).sort((a,b)=>e[b]-e[a]).slice(0,4);
  console.log(pot.f[i].toFixed(1), top.map(k=> k<NM ? `mem(m${pot.modes[k].m},n${pot.modes[k].n},o${pot.modes[k].o},f0=${pot.modes[k].f0.toFixed(0)}):${e[k].toFixed(3)}` : `dof${k-NM}:${e[k].toFixed(3)}`).join('  '));
}
