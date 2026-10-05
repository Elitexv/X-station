// Tiny local web server for testing: node serve.js  →  http://localhost:8080
// (Firebase sign-in only works on http/https, not when index.html is opened directly.)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let file = decodeURIComponent(req.url.split('?')[0]);
  if (file === '/') file = '/index.html';
  const full = path.join(ROOT, path.normalize(file));
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`X-Station is already running at http://localhost:${PORT} (another window has it open). You can use that.`);
  } else {
    console.error('Could not start the server:', err.message);
  }
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`X-Station running at http://localhost:${PORT}  — keep this window open. Close it to stop.`));
