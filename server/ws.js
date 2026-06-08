// 依存ゼロの WebSocket（RFC 6455）サーバー。https.Server の 'upgrade' に相乗りさせ、
// protocol §1（オリジン一つ・wss 同一ホスト）を満たす。小さい JSON テキストフレーム専用に割り切る。
//
//   attachWS(httpsServer, '/ws', (session) => { ... })
//   session: { send(obj), onMessage(fn), onClose(fn), close() }   ← obj は {type,data}
//
// 割り切り: テキストフレームのみ前提（binary は無視）。断片化（継続フレーム）は連結対応。
// 背圧は LAN・小メッセージ前提で見ない。

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 固定

export function attachWS(server, path, onConnection) {
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'https://_');
    if (url.pathname !== path) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const handlers = { message: () => {}, close: () => {} };
    const session = {
      send(obj) { sendText(socket, JSON.stringify(obj)); },
      onMessage(fn) { handlers.message = fn; },
      onClose(fn) { handlers.close = fn; },
      close() { sendClose(socket); socket.end(); },
    };

    let buf = Buffer.alloc(0);
    let frags = [];      // 継続フレームの payload 蓄積
    let fragOp = null;   // 最初のフレームの opcode

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let f;
      while ((f = parseFrame(buf))) {
        buf = f.rest;
        if (f.opcode === 0x8) { sendClose(socket); socket.end(); return; } // close
        if (f.opcode === 0x9) { sendPong(socket, f.payload); continue; }   // ping → pong
        if (f.opcode === 0xA) continue;                                    // pong は無視

        // データフレーム（0x1 text / 0x2 binary / 0x0 continuation）の組み立て
        if (f.opcode === 0x0) { frags.push(f.payload); }
        else { frags = [f.payload]; fragOp = f.opcode; }
        if (!f.fin) continue;

        const full = Buffer.concat(frags);
        frags = [];
        if (fragOp === 0x1) { // text のみ扱う
          let msg;
          try { msg = JSON.parse(full.toString('utf8')); } catch { msg = null; }
          if (msg) handlers.message(msg);
        }
      }
    });

    const done = () => handlers.close();
    socket.on('close', done);
    socket.on('error', () => { handlers.close(); socket.destroy(); });

    onConnection(session);
  });
}

// ---- 受信フレームの解析。1フレーム取れたら {fin,opcode,payload,rest}、無ければ null ----
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) { if (buf.length < off + 2) return null; len = buf.readUInt16BE(off); off += 2; }
  else if (len === 127) {
    if (buf.length < off + 8) return null;
    const hi = buf.readUInt32BE(off), lo = buf.readUInt32BE(off + 4);
    len = hi * 2 ** 32 + lo; off += 8; // 我々の用途では hi=0
  }

  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.slice(off, off + 4); off += 4; }
  if (buf.length < off + len) return null; // payload 未着、続きを待つ

  const payload = Buffer.from(buf.slice(off, off + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; // クライアント→サーバは必ずマスク
  return { fin, opcode, payload, rest: buf.slice(off + len) };
}

// ---- 送信。サーバ→クライアントはマスクしない（RFC 6455） ----
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  return Buffer.concat([header, payload]);
}
function sendText(socket, str) {
  if (socket.writable) socket.write(frame(0x1, Buffer.from(str, 'utf8')));
}
function sendPong(socket, payload) {
  if (socket.writable) socket.write(frame(0xA, payload));
}
function sendClose(socket) {
  if (socket.writable) socket.write(frame(0x8, Buffer.alloc(0)));
}
