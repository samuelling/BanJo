// Inline src/ into a single self-contained index.html (GitHub Pages + Claude artifact).
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
const r = (f) => readFileSync(new URL('./src/' + f, import.meta.url), 'utf8');
let html = r('index.template.html');
const parts = { STYLE: r('style.css'), DSP: r('space.js') + '\n' + r('pot.js') + '\n' + r('engine.js'), HAND: r('hand.js'), APP: r('app.js') };
for (const [k, v] of Object.entries(parts)) {
  if (v.includes('</script')) throw new Error(k + ' contains </script');
  html = html.replace(`/*@@${k}@@*/`, () => v);
}
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/artifact.html', import.meta.url), html);
const page = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${html}\n</body>\n</html>\n`;
writeFileSync(new URL('./index.html', import.meta.url), page);
console.log('built', (html.length / 1024).toFixed(1) + ' KB');
