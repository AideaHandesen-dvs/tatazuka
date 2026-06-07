// 佇か server — いまは M3 前倒しの「HTTPS 静的配信」だけ。WS と人格は M3/M4 で足す。
// client/ を配信する：オリジン一つ・HTTPS 終端一箇所（README §8）。依存ゼロ。
//
//   node server/serve.js          → https://<このマシン>:8443/
//   PORT=9000 node server/serve.js
//
// 証明書は mkcert 製（server/certs/、git 管理外）。再生成手順は server/README.md。

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../client');
const CERTS = path.join(here, 'certs');
const PORT = Number(process.env.PORT ?? 8443);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const server = https.createServer(
  {
    cert: fs.readFileSync(path.join(CERTS, 'cert.pem')),
    key: fs.readFileSync(path.join(CERTS, 'key.pem')),
  },
  (req, res) => {
    const url = new URL(req.url, 'https://_');
    let file = path.normalize(path.join(CLIENT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(CLIENT)) { res.writeHead(403).end(); return; } // パストラバーサル拒否
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    });
  },
);

server.listen(PORT, () => {
  console.log(`佇か（静的配信のみ）→ https://localhost:${PORT}/`);
});
