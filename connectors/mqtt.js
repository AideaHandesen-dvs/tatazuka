// MQTT 3.1.1（QoS 0）の最小クライアント＋共有リーダ（connectors 共有の小部品・依存ゼロ）。
// HA を経由しない入力源の土台＝Mosquitto 等のブローカーに直結し、安物センサ（Tasmota/ESPHome/
// Zigbee2MQTT…）の値を拾う。ha.js が「HA REST の認証・URL・PE 縮退」を一点に寄せたのと同じ役割を、
// MQTT トランスポートについて担う（run.js/hysteresis.js と同列の純 IO 部品）。
//
//   const c = makeMqttClient(opts);   // ブローカー未設定なら null（PE）
//   c.subscribe('zigbee2mqtt/living'); // topic を購読（接続前でも可・CONNACK 後にまとめて送る）
//   c.read(topic) → 最新 payload 文字列 | null（未着なら null）   ← ha.js の read() と同じ顔
//   c.close();
//
// 設計の割り切り（ws.js の「テキスト専用・背圧見ない」と同じ精神）：
//   - **QoS 0 のみ**（at-most-once）。QoS 1/2・retain の厳密さ・will・topic alias は持たない（LAN・小値前提）。
//   - **push→pull 変換**：受けた PUBLISH の最新値を topic ごとに Map へ buffer し、poll で read 返す
//     ＝behavior.js の sources（poll 撃ちっぱなし）契約を一切変えずに MQTT の push を飲み込む。
//   - **read は完全一致**：購読にワイルドカード（+/#）は使えるが、buffer は実 topic で引く。連携側は具体 topic を読む。
//   - 自前ワイヤ：CONNECT/CONNACK/SUBSCRIBE/SUBACK/PUBLISH(受)/PINGREQ/PINGRESP/DISCONNECT のみ手書き。
//   - IO 注入：opts.connect（socket factory）を差し替え可能（テストで実ブローカー・実 TCP を使わない）。
//     既定は net.connect。socket は net.Socket 互換（write / 'connect'・'data'・'close'・'error' / end・destroy）。
//   - 復元力：切断で自動再接続（opts.reconnectMs）・keepalive で PINGREQ（opts.keepaliveMs）。
//
// env：TZ_MQTT_URL（例 mqtt://localhost:1883・user:pass を URL に埋めても可）。
//   ＋任意で TZ_MQTT_USER / TZ_MQTT_PASS（URL に書かない場合）。

import net from 'node:net';

const KEEPALIVE_S = 60;       // CONNECT で申告する keepalive（秒）。この間隔で PINGREQ を撃つ
const RECONNECT_MS = 3000;    // 切断後に再接続を試みるまで

// ---- ワイヤ・エンコード（QoS 0 で要るぶんだけ） ----

// Remaining Length（可変長・7bit ずつ＋継続ビット）。
function encodeLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

// UTF-8 文字列を 2 バイト長プレフィックス付きで（MQTT の文字列表現）。
function encodeStr(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([(b.length >> 8) & 0xff, b.length & 0xff]), b]);
}

function buildConnect({ clientId, username, password, keepalive }) {
  const varHeader = Buffer.concat([
    encodeStr('MQTT'),                  // protocol name
    Buffer.from([0x04]),                // protocol level（3.1.1）
    Buffer.from([0x02 | (username ? 0x80 : 0) | (password ? 0x40 : 0)]), // flags：clean session ＋任意認証
    Buffer.from([(keepalive >> 8) & 0xff, keepalive & 0xff]),
  ]);
  const parts = [encodeStr(clientId)];
  if (username) parts.push(encodeStr(username));
  if (password) parts.push(encodeStr(password));
  const body = Buffer.concat([varHeader, ...parts]);
  return Buffer.concat([Buffer.from([0x10]), encodeLen(body.length), body]); // type 1（CONNECT）
}

function buildSubscribe(packetId, topic) {
  const body = Buffer.concat([
    Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]), // packet identifier
    encodeStr(topic), Buffer.from([0x00]),                  // topic ＋ QoS 0
  ]);
  return Buffer.concat([Buffer.from([0x82]), encodeLen(body.length), body]); // type 8 ＋必須 flags 0010
}

const PINGREQ = Buffer.from([0xc0, 0x00]);
const DISCONNECT = Buffer.from([0xe0, 0x00]);

// ---- ワイヤ・デコード ----

// buf の先頭から 1 パケット切り出す。足りなければ null（断片化＝続きを待つ）。
function parsePacket(buf) {
  if (buf.length < 2) return null;
  let multiplier = 1, value = 0, i = 1, byte;
  do {
    if (i >= buf.length) return null;             // 長さがまだ全部来ていない
    byte = buf[i++];
    value += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128) return { malformed: true };
  } while ((byte & 0x80) !== 0);
  const total = i + value;
  if (buf.length < total) return null;            // 本体がまだ全部来ていない
  return { type: buf[0] >> 4, flags: buf[0] & 0x0f, body: buf.subarray(i, total), total };
}

// PUBLISH 本体 → {topic, payload}。QoS>0 なら topic の後に packet id が挟まる（防御的に飛ばす）。
function parsePublish(body, flags) {
  const topicLen = (body[0] << 8) | body[1];
  const topic = body.subarray(2, 2 + topicLen).toString('utf8');
  let off = 2 + topicLen;
  const qos = (flags >> 1) & 0x03;
  if (qos > 0) off += 2;                           // QoS1/2 は packet id（購読は 0 なので通常来ない）
  return { topic, payload: body.subarray(off).toString('utf8') };
}

// ---- クライアント ----

// env / opts を見てクライアントを作る。ブローカー未設定なら null（＝オフ＝PE）。
export function makeMqttClient(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const url = opts.url || e.TZ_MQTT_URL;
  if (!url) return null;                           // PE：ブローカー未設定 → MQTT オフ
  let host, port = 1883, username, password;
  try {
    const u = new URL(url);
    host = u.hostname;
    if (u.port) port = Number(u.port);
    username = u.username ? decodeURIComponent(u.username) : (opts.username || e.TZ_MQTT_USER);
    password = u.password ? decodeURIComponent(u.password) : (opts.password || e.TZ_MQTT_PASS);
  } catch { return null; }                         // URL が壊れている → オフ
  if (!host) return null;

  const connect = opts.connect || ((h, p) => net.connect({ host: h, port: p }));
  const clientId = opts.clientId || `tatazuka-${process.pid}`;
  const keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_S * 1000;
  const reconnectMs = opts.reconnectMs ?? RECONNECT_MS;

  const subs = new Set();        // 購読したい topic（再接続時にまとめて送り直す）
  const latest = new Map();      // topic → 最新 payload（push を溜める＝pull で返す）
  let sock = null, buf = Buffer.alloc(0), connected = false, closed = false;
  let pid = 0, pinger = null, retry = null;

  const send = (b) => { try { sock && sock.write(b); } catch { /* 切断中 → reconnect に任せる */ } };
  const nextPid = () => (pid = (pid % 0xffff) + 1); // 1..65535（0 は不可）

  function sendSubscribe(topic) { send(buildSubscribe(nextPid(), topic)); }

  function onData(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const pkt = parsePacket(buf);
      if (!pkt) break;                              // 続きを待つ
      if (pkt.malformed) { buf = Buffer.alloc(0); break; } // 壊れたら捨てて再同期は次接続で
      buf = buf.subarray(pkt.total);
      if (pkt.type === 2) {                         // CONNACK
        connected = pkt.body.length >= 2 && pkt.body[1] === 0; // return code 0 = accepted
        if (connected) {
          for (const t of subs) sendSubscribe(t);   // 接続できたら購読を（再）送出
          if (pinger) clearInterval(pinger);
          pinger = setInterval(() => send(PINGREQ), keepaliveMs);
          if (pinger.unref) pinger.unref();
        }
      } else if (pkt.type === 3) {                  // PUBLISH（受信）
        const { topic, payload } = parsePublish(pkt.body, pkt.flags);
        latest.set(topic, payload);
      }
      // SUBACK(9)/PINGRESP(13) は確認だけ＝何もしない（QoS0・割り切り）
    }
  }

  function open() {
    if (closed) return;
    buf = Buffer.alloc(0); connected = false;
    sock = connect(host, port);
    sock.on('connect', () => send(buildConnect({ clientId, username, password, keepalive: KEEPALIVE_S })));
    sock.on('data', onData);
    const drop = () => {                            // 切断 → 後始末して再接続を予約
      connected = false;
      if (pinger) { clearInterval(pinger); pinger = null; }
      if (closed || retry) return;
      retry = setTimeout(() => { retry = null; open(); }, reconnectMs);
      if (retry.unref) retry.unref();
    };
    sock.on('close', drop);
    sock.on('error', drop);
  }
  open();

  return {
    subscribe(topic) {
      if (subs.has(topic)) return;
      subs.add(topic);
      if (connected) sendSubscribe(topic);          // 接続済みなら即・未接続なら CONNACK 後にまとめて
    },
    read(topic) { return latest.has(topic) ? latest.get(topic) : null; },
    close() {
      closed = true;
      if (pinger) { clearInterval(pinger); pinger = null; }
      if (retry) { clearTimeout(retry); retry = null; }
      try { sock && (send(DISCONNECT), sock.end()); } catch { /* noop */ }
    },
  };
}

// payload から値を取り出す（センサごとの変動を吸収する一点）。
//   path 空      → payload そのまま（生の数値や状態文字列）
//   path "a"     → JSON.parse して a
//   path "a.b"   → ドットで潜る（Tasmota の "ENERGY.Power" 等）
// 取り出せない（JSON 壊れ・キー無し）→ null（呼び手は PE で黙る）。
export function pick(payload, path) {
  if (payload == null) return null;
  if (!path) return payload;
  try {
    let v = JSON.parse(payload);
    for (const k of path.split('.')) {
      if (v == null || typeof v !== 'object') return null;
      v = v[k];
    }
    return v == null ? null : v;
  } catch {
    return null;
  }
}
