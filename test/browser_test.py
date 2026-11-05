"""Load the built page in headless Chromium, start audio, play a pad and some keys, record a WAV, screenshot.
usage: python3 test/browser_test.py [url] [shot.png] [take.wav]"""
import sys, json, base64
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8765/index.html'
shot = sys.argv[2] if len(sys.argv) > 2 else '/tmp/banjo-page.png'
wav = sys.argv[3] if len(sys.argv) > 3 else None
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1100, 'height': 1500})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto(url); pg.wait_for_timeout(800)
    pg.click('#startBtn'); pg.wait_for_timeout(1500)
    info = pg.evaluate("""async () => {
      const B = window.__banjo; const out = {};
      out.state = B.ctx && B.ctx.state; out.worklet = !!B.node;
      document.getElementById('recBtn').click();
      document.querySelectorAll('.chord')[0].dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
      await new Promise(r => setTimeout(r, 1800));
      out.metersRoll = B.meters.map(m => +m.e.toFixed(4));
      document.querySelectorAll('.chord')[1].dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
      await new Promise(r => setTimeout(r, 1800));
      out.shape = document.getElementById('shapeText').textContent;
      document.querySelectorAll('.chord')[1].dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
      await new Promise(r => setTimeout(r, 1200));
      document.getElementById('recBtn').click();
      await new Promise(r => setTimeout(r, 300));
      const a = document.querySelector('#recOut audio'); out.rec = !!a;
      if (a) { const buf = await (await fetch(a.src)).arrayBuffer(); let s=''; const u=new Uint8Array(buf); for (let i=0;i<u.length;i+=32768) s+=String.fromCharCode.apply(null,u.subarray(i,i+32768)); out.wav = btoa(s); }
      return out; }""")
    if wav and info.get('wav'):
        open(wav, 'wb').write(base64.b64decode(info['wav']))
    info.pop('wav', None)
    pg.wait_for_timeout(200)
    pg.screenshot(path=shot, full_page=True)
    m = b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    m.goto(url); m.wait_for_timeout(700)
    sw = m.evaluate("document.documentElement.scrollWidth")
    m.screenshot(path=shot.replace('.png', '-mobile.png'), full_page=False)
    print(json.dumps(info), 'mobile scrollWidth', sw)
    print('\n'.join(logs[:30]))
    b.close()
