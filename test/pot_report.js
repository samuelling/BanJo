require('../src/pot.js');
const P = globalThis.BanjoPot, TAU = 2*Math.PI;
function report(label, spec) {
  const t0 = Date.now(); const pot = P.buildPot(spec); const dt = Date.now()-t0;
  const low = pot.f.slice(0, 8).map((f,i)=>f.toFixed(0)+'(Q'+pot.Q[i].toFixed(0)+')').join(' ');
  console.log(`${label}: ${pot.NM} membrane modes, ${pot.nDense} dense, ${pot.n} total, ${dt} ms, air ${pot.airName} ${pot.fAir.toFixed(0)} Hz, ks ${(pot.ks/1000).toFixed(1)} kN/m (head ${(pot.kHead/1000).toFixed(1)})`);
  console.log('  lowest:', low);
  return pot;
}
const bare = report('bare open-back', { back: 'open', bare: true, ring: 'none' });
// identify the (0,1)-like mode: largest volume
const pot = report('bluegrass resonator', {});
const ob = report('open back', { back: 'open', ring: 'hoop', headD: 0.305, dd: 87 });
// admittance at string 2 (3rd string) and 4 (1st)
const Y = new Float64Array(6);
function adm(pot, s){ const rows=[]; for (const f of [100,200,300,400,500,600,700,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000]) { let g=0,gy=0,n=0; for (let k=-6;k<=6;k++){ const ff=f*Math.pow(2,k/72); P.potAdmittance(pot,s,TAU*ff,Y); g+=Math.hypot(Y[4],Y[5]); gy+=Math.hypot(Y[0],Y[1]); n++; } rows.push(f+':'+(20*Math.log10(g/n)).toFixed(1)+'/'+(20*Math.log10(gy/n)).toFixed(1)); } return rows.join(' '); }
console.log('|Yzz|/|Yyy| dB re 1 m/Ns, 3rd string, bluegrass:', adm(pot, 2));
console.log('1st string:', adm(pot, 4));
console.log('open back 3rd:', adm(ob, 2));
