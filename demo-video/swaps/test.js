// Dry run of the swaps director: screenshots every N seconds + director logs.
const { chromium } = require('playwright'); const path = require('path');
(async () => {
  const srv = await require('../serve')(4115, __dirname);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  p.on('console', (m) => { if (m.text().startsWith('[director]')) console.log(m.text()); });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto('http://localhost:4115/'); await p.waitForFunction(() => window.__ready); await p.evaluate(() => document.fonts.ready);
  p.evaluate(() => window.__start()).catch(() => {});
  const every = Number(process.argv[2] || 4000); let k = 0; const t0 = Date.now();
  while (!(await p.evaluate(() => window.__done))) { await p.waitForTimeout(every); await p.screenshot({ path: path.join(__dirname, `t_${String(k++).padStart(2, '0')}.png`) }); }
  console.log('total', (Date.now() - t0) / 1000, 's', 'shots', k);
  await b.close(); srv.close();
})();
