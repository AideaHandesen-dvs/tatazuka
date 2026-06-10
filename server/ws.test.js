// ws.js（自前 RFC 6455）の契約テスト（依存ゼロ・node:test）。socket は本物を使わず、
// EventEmitter のフェイク（server＝upgrade を出す／socket＝書込を配列に貯める）を attachWS に
// 食わせて、公開面のまま「ワイヤの解釈/組立て」を固定する。リポの「IO 注入してテスト」流儀。
//   node --test server/ws.test.js
//
// 押さえる契約：
//   - ハンドシェイク：Sec-WebSocket-Accept が RFC 6455 の base64(sha1(key+GUID))（既知ベクタで裏取り）
//   - path 不一致／key 欠落 → 101 を返さず socket.destroy()
//   - 受信：クライアント→サーバは必ずマスク。テキスト(0x1)を unmask→JSON.parse して message に渡す
//   - 継続フレーム（fin=0 → 0x0 fin=1）を連結。非 JSON テキストは黙殺（message を呼ばない）
//   - 分割到着（ヘッダと payload が別チャンク）でも null 待ちで取りこぼさない
//   - 126 拡張長（payload ≥126）の解析
//   - 制御：ping(0x9)→pong(0xA) を返す／close(0x8)→close フレーム＋end
//   - 送信：session.send は unmasked テキストフレーム(0x1)＝クライアントが復号できる形
//   - onClose は socket 'close' で呼ばれる

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { attachWS } from './ws.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---- フェイク socket：書込を貯め、destroy/end/writable を記録。EventEmitter なので on('data') が効く ----
function fakeSocket() {
  const s = new EventEmitter();
  s.writable = true;
  s.writes = [];               // 生の write 引数（string=ハンドシェイク / Buffer=フレーム）
  s.destroyed = false;
  s.ended = false;
  s.write = (d) => { s.writes.push(d); return true; };
  s.destroy = () => { s.destroyed = true; s.writable = false; };
  s.end = () => { s.ended = true; s.writable = false; };
  s.handshake = () => s.writes.find((w) => typeof w === 'string') || '';
  s.frames = () => s.writes.filter(Buffer.isBuffer).map(decodeServerFrame); // server→client は unmask
  return s;
}

// ---- フェイク server：attachWS が server.on('upgrade', cb) するので、emit で 1 接続を起こす ----
function connect({ path = '/ws', key = 'dGhlIHNhbXBsZSBub25jZQ==', reqPath } = {}) {
  const server = new EventEmitter();
  let session = null;
  attachWS(server, path, (s) => { session = s; });
  const socket = fakeSocket();
  const headers = {};
  if (key !== null) headers['sec-websocket-key'] = key;
  server.emit('upgrade', { url: reqPath ?? path, headers }, socket);
  return { socket, session };
}

// ---- クライアント→サーバのフレームを組む（必ずマスク・RFC 6455 §5.3） ----
function clientFrame(opcode, payload, { fin = true, mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]) } = {}) {
  payload = Buffer.from(payload);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode; header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2); header.writeUInt32BE(len >>> 0, 6);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}
const textFrame = (str, opts) => clientFrame(0x1, Buffer.from(str, 'utf8'), opts);

// ---- サーバ→クライアントのフレームを復号（unmasked 前提・アサート用） ----
function decodeServerFrame(buf) {
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
  let len = b1 & 0x7f, off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { len = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6); off = 10; }
  assert.equal(b1 & 0x80, 0, 'server→client はマスクしない（RFC 6455 §5.1）');
  return { fin, opcode, payload: buf.slice(off, off + len) };
}

test('ハンドシェイク：101 と Sec-WebSocket-Accept が既知ベクタ一致', () => {
  const { socket, session } = connect({ key: 'dGhlIHNhbXBsZSBub25jZQ==' });
  assert.ok(session, 'onConnection が呼ばれセッションが渡る');
  const hs = socket.handshake();
  assert.match(hs, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(hs, /Upgrade: websocket\r\n/i);
  assert.match(hs, /Connection: Upgrade\r\n/i);
  // RFC 6455 §1.3 の既知例：key 'dGhlIHNhbXBsZSBub25jZQ==' → accept 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
  assert.match(hs, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n\r\n$/);
});

test('accept は base64(sha1(key+GUID))（任意 key でも一致）', () => {
  const key = 'x3JJHMbDL1EzLkh9GBhXDw==';
  const { socket } = connect({ key });
  const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
  assert.match(socket.handshake(), new RegExp(`Sec-WebSocket-Accept: ${expected.replace(/[+/=]/g, '\\$&')}\\r\\n`));
});

test('path 不一致 → 101 を返さず destroy', () => {
  const { socket, session } = connect({ path: '/ws', reqPath: '/nope' });
  assert.equal(session, null, 'onConnection は呼ばれない');
  assert.ok(socket.destroyed);
  assert.equal(socket.handshake(), '', '101 を書かない');
});

test('key 欠落 → destroy', () => {
  const { socket, session } = connect({ key: null });
  assert.equal(session, null);
  assert.ok(socket.destroyed);
});

test('受信：マスク付きテキストフレームを unmask→JSON.parse して message に渡す', () => {
  const { socket, session } = connect();
  const got = [];
  session.onMessage((m) => got.push(m));
  socket.emit('data', textFrame(JSON.stringify({ type: 'hello', data: { protocol: 0 } })));
  assert.deepEqual(got, [{ type: 'hello', data: { protocol: 0 } }]);
});

test('受信：継続フレーム（fin=0 の text → fin=1 の continuation）を連結', () => {
  const { socket, session } = connect();
  const got = [];
  session.onMessage((m) => got.push(m));
  const full = JSON.stringify({ type: 'sense', data: { kind: 'つつく' } });
  const mid = Math.floor(full.length / 2);
  socket.emit('data', clientFrame(0x1, Buffer.from(full.slice(0, mid), 'utf8'), { fin: false }));
  assert.deepEqual(got, [], 'fin=0 だけでは確定しない');
  socket.emit('data', clientFrame(0x0, Buffer.from(full.slice(mid), 'utf8'), { fin: true }));
  assert.deepEqual(got, [{ type: 'sense', data: { kind: 'つつく' } }]);
});

test('受信：非 JSON テキストは黙殺（message を呼ばない）', () => {
  const { socket, session } = connect();
  let calls = 0;
  session.onMessage(() => calls++);
  socket.emit('data', textFrame('これはJSONではない'));
  assert.equal(calls, 0);
});

test('受信：1チャンクに2フレーム連結でも両方取れる', () => {
  const { socket, session } = connect();
  const got = [];
  session.onMessage((m) => got.push(m));
  socket.emit('data', Buffer.concat([
    textFrame(JSON.stringify({ type: 'a' })),
    textFrame(JSON.stringify({ type: 'b' })),
  ]));
  assert.deepEqual(got.map((m) => m.type), ['a', 'b']);
});

test('受信：ヘッダと payload が別チャンクで来ても取りこぼさない（null 待ち）', () => {
  const { socket, session } = connect();
  const got = [];
  session.onMessage((m) => got.push(m));
  const frame = textFrame(JSON.stringify({ type: 'split' }));
  socket.emit('data', frame.slice(0, 3));   // 途中まで
  assert.deepEqual(got, [], 'まだ揃ってない');
  socket.emit('data', frame.slice(3));       // 残り
  assert.deepEqual(got.map((m) => m.type), ['split']);
});

test('受信：126 拡張長（payload ≥126）を解析', () => {
  const { socket, session } = connect();
  const got = [];
  session.onMessage((m) => got.push(m));
  const big = 'x'.repeat(300);
  socket.emit('data', textFrame(JSON.stringify({ type: 'big', s: big })));
  assert.equal(got.length, 1);
  assert.equal(got[0].s, big);
});

test('制御：ping(0x9) に pong(0xA) を同じ payload で返す', () => {
  const { socket } = connect();
  socket.emit('data', clientFrame(0x9, Buffer.from('pingdata')));
  const pong = socket.frames().find((f) => f.opcode === 0xA);
  assert.ok(pong, 'pong を返す');
  assert.equal(pong.payload.toString(), 'pingdata');
});

test('制御：close(0x8) で close フレームを返して end する', () => {
  const { socket, session } = connect();
  let closed = 0;
  session.onClose(() => closed++);
  socket.emit('data', clientFrame(0x8, Buffer.alloc(0)));
  assert.ok(socket.frames().some((f) => f.opcode === 0x8), 'close フレームを返す');
  assert.ok(socket.ended, 'socket.end する');
});

test('送信：session.send は unmasked テキストフレーム(0x1)＋JSON ペイロード', () => {
  const { socket, session } = connect();
  socket.writes.length = 0; // ハンドシェイク以降の送信だけ見る
  session.send({ type: 'say', data: { text: 'よう' } });
  const f = socket.frames();
  assert.equal(f.length, 1);
  assert.equal(f[0].opcode, 0x1, 'テキストフレーム');
  assert.ok(f[0].fin, 'fin=1');
  assert.deepEqual(JSON.parse(f[0].payload.toString('utf8')), { type: 'say', data: { text: 'よう' } });
});

test('送信：close() は close フレームを書いて end', () => {
  const { socket, session } = connect();
  socket.writes.length = 0;
  session.close();
  assert.ok(socket.frames().some((f) => f.opcode === 0x8));
  assert.ok(socket.ended);
});

test('onClose：socket の close イベントで呼ばれる', () => {
  const { socket, session } = connect();
  let closed = 0;
  session.onClose(() => closed++);
  socket.emit('close');
  assert.equal(closed, 1);
});

test('writable=false なら送信は書かない（背圧で socket 死亡後）', () => {
  const { socket, session } = connect();
  socket.writes.length = 0;
  socket.writable = false;
  session.send({ type: 'say', data: { text: '届かない' } });
  assert.equal(socket.frames().length, 0);
});
