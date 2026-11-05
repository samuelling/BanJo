require('../src/pot.js');
const P = globalThis.BanjoPot;
const n=8; const A=[],B=[]; for(let i=0;i<n;i++){A.push(new Float64Array(n));B.push(new Float64Array(n));}
const diag=[5,7,0,3,9,0,4,2]; for(let i=0;i<n;i++){A[i][i]=B[i][i]=diag[i];}
A[3][6]=A[6][3]=B[3][6]=B[6][3]=1;
const E=P.symEig(A,n); let err=0;
for(let k=0;k<n;k++){ for(let i=0;i<n;i++){let s=0;for(let j=0;j<n;j++) s+=B[i][j]*E.V[j][k]; err=Math.max(err,Math.abs(s-E.d[k]*E.V[i][k]));}}
console.log('residual', err, Array.from(E.d).map(x=>x.toFixed(3)));
for(let k=0;k<n;k++) console.log(Array.from({length:n},(_,i)=>E.V[i][k].toFixed(2)).join(' '));
