// 使い捨ての CA 配信サーバー。表示端末に mkcert の root CA を信頼させる初回作業用。
// 公開してよい rootCA だけを、iOS / Android が「証明書」として認識できる Content-Type で配る。
//
//   node server/serve-ca.js     → http://<このマシン>:9000/tatazuka-rootCA.crt
//
// 端末のブラウザで上記 URL を開いて CA をインストールしたら、このプロセスは止めてよい（Ctrl+C）。
//
// なぜ専用スクリプトか：`python3 -m http.server` で rootCA.pem を配ると
//   (1) Content-Type が application/octet-stream になり iOS が「原因不明のエラー」で弾く
//   (2) CAROOT ごと配ってしまい秘密鍵 rootCA-key.pem まで晒す
// の二重に良くない。ここでは公開鍵だけを application/x-x509-ca-cert で配る。

import http from 'node:http';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const caRoot = execSync('mkcert -CAROOT').toString().trim();
const body = fs.readFileSync(caRoot + '/rootCA.pem'); // 公開鍵のみ。秘密鍵は読まない・配らない
const PORT = Number(process.env.PORT ?? 9000);

http
  .createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert', // ← これが無いと iOS は証明書として扱えない
      'content-disposition': 'attachment; filename="tatazuka-rootCA.crt"',
    });
    res.end(body);
  })
  .listen(PORT, () => {
    console.log(`root CA → http://localhost:${PORT}/tatazuka-rootCA.crt  （端末で開いてインストール、済んだら Ctrl+C）`);
  });
