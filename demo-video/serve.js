const http = require('http'); const fs = require('fs'); const path = require('path');
const REPO = require('path').join(__dirname, '..'); const HERE = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
module.exports = (port) => new Promise((res) => {
  const s = http.createServer((req, r) => {
    const u = new URL(req.url, 'http://x').pathname;
    let f;
    if (u === '/' || u === '/index.html') {
      let html = fs.readFileSync(`${REPO}/public/index.html`, 'utf8');
      html = html.replace('<script src="pricing.js"></script>', '<script src="/__fake.js"></script><script src="pricing.js"></script>')
        .replace('</body>', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700;800;900&display=swap"><link rel="stylesheet" href="/__overlay.css"><script src="/__director.js"></script></body>');
      r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(html);
    }
    if (u === '/pricing.js') f = `${REPO}/src/pricing.js`;
    else if (u.startsWith('/__')) f = path.join(HERE, u.slice(3));
    else f = path.join(REPO, 'public', u);
    fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
  });
  s.listen(port, () => res(s));
});
