// Real-time capture via CDP screencast -> JPEG frames with timestamps -> CFR H.264.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
(async () => {
  const out = process.argv[2] || 'take'; const dir = path.join(__dirname, `${out}_frames`);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const srv = await require('./serve')(4113);
  const b = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.goto('http://localhost:4113/'); await p.waitForFunction(() => window.__ready); await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(1500);
  const cdp = await p.context().newCDPSession(p);
  const frames = []; let n = 0;
  cdp.on('Page.screencastFrame', (f) => {
    const file = `f${String(n++).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp, wall: Date.now() });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await p.waitForTimeout(300);
  const t0 = Date.now();
  p.evaluate(() => window.__start());
  await p.waitForFunction(() => window.__done, null, { timeout: 0, polling: 500 });
  const tEnd = Date.now();
  await p.waitForTimeout(300);
  await cdp.send('Page.stopScreencast');
  await b.close(); srv.close();
  console.log('frames', frames.length, 'wall', (Date.now() - t0) / 1000);
  // concat list with per-frame durations
  let list = '';
  for (let i = 0; i < frames.length; i++) {
    // The screencast only sends frames when the page changes, so hold the last one until the director finished.
    const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : Math.max(0.1, (tEnd - frames[i].wall) / 1000);
    list += `file '${path.join(dir, frames[i].file)}'\nduration ${Math.max(0.001, d).toFixed(4)}\n`;
  }
  list += `file '${path.join(dir, frames[frames.length - 1].file)}'\n`;
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  fs.writeFileSync(path.join(dir, 'times.json'), JSON.stringify(frames.map((f) => f.t)));
})();
