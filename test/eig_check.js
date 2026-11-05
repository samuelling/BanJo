require('../src/pot.js');
const P = globalThis.BanjoPot;
let r=12345; const rnd=()=>{r^=r<<13;r>>>=0;r^=r>>>17;r^=r<<5;r>>>=0;return r/4294967296;};
for (const n of [6, 30, 120, 300]) {
  const A=[],B=[]; for(let i=0;i<n;i++){A.push(new Float64Array(n));B.push(new Float64Array(n));}
  for(let i=0;i<n;i++){ A[i][i]=B[i][i]=Math.pow(10, 3+6*rnd()); }
  for (let q=0;q<n/3;q++){ const i=Math.floor(rnd()*n), j=Math.floor(rnd()*n); if(i===j) continue; const v=(rnd()-0.5)*1e4; A[i][j]+=v;A[j][i]+=v;B[i][j]+=v;B[j][i]+=v; }
  const E=P.symEig(A,n); let err=0, scale=0;
  for(let k=0;k<n;k++){ scale=Math.max(scale,Math.abs(E.d[k])); for(let i=0;i<n;i++){let s=0;for(let j=0;j<n;j++) s+=B[i][j]*E.V[j][k]; err=Math.max(err,Math.abs(s-E.d[k]*E.V[i][k]));}}
  // orthonormality
  let oe=0; for(let k=0;k<Math.min(n,20);k++) for(let l=0;l<Math.min(n,20);l++){ let s=0; for(let i=0;i<n;i++) s+=E.V[i][k]*E.V[i][l]; oe=Math.max(oe,Math.abs(s-(k===l?1:0))); }
  console.log(n, 'rel residual', (err/scale).toExponential(2), 'orth', oe.toExponential(2));
}
