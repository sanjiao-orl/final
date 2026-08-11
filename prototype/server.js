// 壳重设计原型 · 零依赖静态服务器
// 支持 --port / -p / --port=xxxx 与 --host 参数转发
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function argValue(names, fallback) {
  for (let i = 0; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n && argv[i + 1]) return argv[i + 1];
      if (argv[i].startsWith(n + '=')) return argv[i].slice(n.length + 1);
    }
  }
  return fallback;
}
const port = Number(argValue(['--port', '-p'], process.env.PORT || 7100));
const host = argValue(['--host', '-H'], '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(__dirname, path.normalize(urlPath));
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, host, () => {
  console.log(`prototype dev server: http://${host}:${port}/`);
});
