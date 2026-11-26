const { chromium } = require('playwright');
(async () => {
  const srv = await require('./serve')(4112);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  p.on('console', (m) => console.log('console:', m.text())); p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto('http://localhost:4112/'); await p.waitForFunction(() => window.__ready);
  const shots = process.argv.slice(2);
  for (const s of shots) {
    if (s === 'intro1') { p.evaluate(() => __dbg.intro()).catch(() => {}); await p.waitForTimeout(1500); }
    else if (s === 'intro2') { await p.waitForTimeout(3300); }
    else if (s === 'outro') { p.evaluate(() => __dbg.outro()).catch(() => {}); await p.waitForTimeout(3000); }
    else { const i = +s; await p.evaluate(async (i) => { for (let k = Math.max(0, i - 3); k <= i; k++) { __dbg.push(k); __dbg.updatePanel(k); } if (__dbg.CUES[i]) __dbg.CUES[i](); }, i); await p.waitForTimeout(1300); }
    await p.screenshot({ path: `preview_${s}.png` });
  }
  await b.close(); srv.close();
})();
