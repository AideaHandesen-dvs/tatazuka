// 佇か server — HTTPS 静的配信 ＋ WebSocket（protocol v0）。人格の中身は M4 で behavior.js を育てる。
// client/ を配信する：オリジン一つ・HTTPS 終端一箇所、wss も同一ホスト（README §8 / protocol §1）。依存ゼロ。
//
//   node server/serve.js          → https://<このマシン>:8443/  ＋ wss://<このマシン>:8443/ws
//   PORT=9000 node server/serve.js
//
// 証明書は mkcert 製（server/certs/、git 管理外）。再生成手順は server/README.md。

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWS } from './ws.js';
import { createSession } from './behavior.js';
import { createPersona } from './persona.js';
import { createLLMPersona } from './persona-llm.js';
import { createWeather } from './weather.js';

// TZ_LLM が設定されていれば LLM persona に格上げ（無ければ従来のルールベース）。
// どちらも line() の顔が同じなので behavior.js からは区別がつかない。
const makePersona = process.env.TZ_LLM ? createLLMPersona : createPersona;
// TZ_CITY または TZ_LAT/TZ_LON があれば天気イベント源を足す（無ければ null＝天気に触れない）。
// 変化検知の状態を端末ごとに独立させたいので、接続のたびに作る（各端末が天気に反応する）。
const weatherOn = !!(process.env.TZ_CITY || (process.env.TZ_LAT && process.env.TZ_LON));

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
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
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
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';

    // HEAD（app.js の VRM 存在チェック等）：本体を読まず stat だけで応答
    if (req.method === 'HEAD') {
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': type, 'content-length': st.size });
        res.end();
      });
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    });
  },
);

// ---- WebSocket（protocol v0）。同一オリジンの /ws に張る ----
attachWS(server, '/ws', (sock) => {
  const session = createSession({ send: (obj) => sock.send(obj), persona: makePersona(), weather: createWeather() });
  sock.onMessage((msg) => session.receive(msg));
  sock.onClose(() => session.close());
});

server.listen(PORT, () => {
  console.log(`佇か → https://localhost:${PORT}/  （wss://localhost:${PORT}/ws）`);
  console.log(
    process.env.TZ_LLM
      ? `人格: LLM persona（${process.env.TZ_LLM} / ${process.env.TZ_CHARACTER || 'tatazuka'}）`
      : '人格: ルールベース',
  );
  console.log(weatherOn ? `天気: on（${process.env.TZ_CITY || `${process.env.TZ_LAT},${process.env.TZ_LON}`}）` : '天気: off');
});
