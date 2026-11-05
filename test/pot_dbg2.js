require('../src/pot.js');
const P = globalThis.BanjoPot;
const z = P.besselZeros(40);
for (let m=0;m<z.length;m+=5) console.log('m',m, z[m].slice(0,4).map(x=>x.toFixed(3)).join(' '));
// check a few J values for large m small x
for (const [m,x] of [[30,25],[30,31],[38,39],[20,10]]) console.log('J',m,x,P.besselJ(m,x));
