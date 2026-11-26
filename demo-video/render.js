// Deterministic frame-by-frame renderer: the page runs on a fake clock (timers, Date, rAF) and every CSS
// animation/transition is paused and stepped to the virtual time, so each output frame is exact. Frames are
// piped straight into ffmpeg (no disk). Usage: node render.js <dir> <out.mp4> [fps=60] [scale=2]
const { chromium } = require('playwright'); const path = require('path'); const { spawn } = require('child_process');
(async () => {
  const dir = path.resolve(process.argv[2] || __dirname); const out = path.resolve(process.argv[3] || 'out.mp4');
  const fps = Number(process.argv[4] || 60); const scale = Number(process.argv[5] || 2); const limit = Number(process.env.LIMIT || 0);
  const srv = await require('./serve')(4117, dir);
  const b = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scale });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  p.on('console', (m) => { if (m.text().startsWith('[director]')) console.log(m.text()); });
  await p.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await p.goto('http://localhost:4117/');
  for (let k = 0; k < 400 && !(await p.evaluate(() => window.__ready && document.fonts.status === 'loaded')); k++) { await p.clock.runFor(50); await new Promise((r) => setTimeout(r, 25)); }
  await p.evaluate(() => {
    // Pause every animation the moment it appears and drive it from the (fake) clock instead of the compositor.
    window.__sync = () => {
      const now = performance.now();
      for (const a of document.getAnimations()) {
        if (a.__v0 === undefined) { a.__v0 = now; a.pause(); }
        a.currentTime = now - a.__v0;
      }
    };
  });
  const cdp = await p.context().newCDPSession(p);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', 'scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-profile:v', 'high', '-level', '4.2',
    '-x264-params', 'keyint=120:min-keyint=60', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  p.evaluate(() => { window.__start(); }).catch(() => {});
  const t0 = Date.now(); let prev = 0; let done = false; let tail = 0;
  for (let n = 0; ; n++) {
    const target = Math.round(((n + 1) * 1000) / fps);
    await p.clock.runFor(target - prev); prev = target;
    await p.evaluate(() => window.__sync());
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95, captureBeyondViewport: false });
    if (!ff.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    if (n % 60 === 0) {
      done = done || (await p.evaluate(() => !!window.__done));
      process.stdout.write(`\r${(n / fps).toFixed(1)}s video · ${((Date.now() - t0) / 1000).toFixed(0)}s wall`);
    }
    if (done && ++tail > fps * 0.5) break;
    if (limit && n >= limit) break;
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  console.log(`\nwrote ${out} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await b.close(); srv.close();
})();
