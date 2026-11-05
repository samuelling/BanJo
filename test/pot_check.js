require('../src/pot.js');
const P = globalThis.BanjoPot;
// Bessel checks
console.log('J0(2.404825557695773)=', P.besselJ(0, 2.404825557695773), 'J1(3.8317)=', P.besselJ(1, 3.831705970207512), 'J5(10)=', P.besselJ(5, 10), '(exp -0.2340615282)');
const z = P.besselZeros(20); console.log('zeros m0', z[0].slice(0,4).map(x=>x.toFixed(4)), 'm1', z[1].slice(0,3).map(x=>x.toFixed(4)), 'm3', z[3].slice(0,2).map(x=>x.toFixed(4)));
// eigen check
const n = 6, A = [], B = [];
for (let i=0;i<n;i++){A.push(new Float64Array(n));B.push(new Float64Array(n));}
for (let i=0;i<n;i++) for (let j=0;j<=i;j++){const v=Math.sin(i*3+j*7)+ (i===j?3:0); A[i][j]=A[j][i]=v; B[i][j]=B[j][i]=v;}
const E = P.symEig(A, n);
let err=0; for (let k=0;k<n;k++){ for (let i=0;i<n;i++){ let s=0; for(let j=0;j<n;j++) s+=B[i][j]*E.V[j][k]; err=Math.max(err,Math.abs(s-E.d[k]*E.V[i][k])); } }
console.log('eig residual', err.toExponential(2), 'vals', Array.from(E.d).map(x=>x.toFixed(3)).join(' '));
