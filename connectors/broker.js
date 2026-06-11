// MQTT 3.1.1（QoS 0）の最小ブローカー（依存ゼロ・~100行）。実機スタックチャンの「身体バス」の
// 待ち合わせ場所（connectors/README §3-3）。mosquitto を立てない＝apt も新サービスも増やさないための
// 自前ワイヤで、ws.js（RFC6455）・mqtt.js（クライアント）に続く三本目の手書き。serve.js が
// TZ_MQTT_BROKER=1 で同居ホストする。標準 MQTT なので、外の mosquitto にいつでも差し替え可。
//
// 割り切り（mqtt.js と同じ精神・LAN 信頼＝protocol §6-4 の構え）：
//   - QoS 0 のみ。retain / will / QoS1↑ / 認証 / セッション復元は持たない（CONNECT は無条件で受理）。
//   - PUBLISH は「いま繋がっていて filter が合う全員」へ即配るだけ（発行者自身も購読していれば届く＝仕様どおり）。
//   - ワイルドカード（+ / #）は仕様どおり（`a/#` は `a` 自身にも一致）。
//   - 壊れたパケットは接続ごと destroy（再同期は再接続で）。
//
//   const b = createBroker({ port });  // port 0 なら空きポート（テスト用）。host 既定 0.0.0.0（LAN の身体が繋ぐ）
//   await b.ready;                     // listen 完了
//   b.port();                          // 実際のポート
//   b.close();

import net from 'node:net';
import { parsePacket, parsePublish, encodeLen, buildPublish } from './mqtt.js';

// topic filter の一致（+＝一階層任意・#＝以降全部）。`a/#` は `a` にも一致（MQTT 3.1.1 仕様）。
export function matchTopic(filter, topic) {
  const f = filter.split('/'), t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;     // 以降全部（親階層自身も含む）
    if (i >= t.length) return false;   // filter の方が深い
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

const CONNACK_OK = Buffer.from([0x20, 0x02, 0x00, 0x00]);
const PINGRESP = Buffer.from([0xd0, 0x00]);

// SUBSCRIBE 本体 → { pid, topics[] }（[pid][len+topic+qos]…）。UNSUBSCRIBE も qos が無いだけで同型。
function parseSubscribe(body, withQos) {
  const pid = (body[0] << 8) | body[1];
  const topics = [];
  let off = 2;
  while (off + 2 <= body.length) {
    const len = (body[off] << 8) | body[off + 1];
    topics.push(body.subarray(off + 2, off + 2 + len).toString('utf8'));
    off += 2 + len + (withQos ? 1 : 0); // SUBSCRIBE は topic ごとに要求 QoS 1 バイト
  }
  return { pid, topics };
}

export function createBroker(opts) {
  opts = opts || {};
  const port = opts.port ?? 1883;
  const host = opts.host || '0.0.0.0'; // LAN の身体（ESP32）が繋ぐので localhost に閉じない
  const log = opts.log || (() => {});
  const clients = new Set(); // { sock, buf, subs:Set<filter> }

  function fanout(topic, payload) {
    const pkt = buildPublish(topic, payload);
    for (const c of clients) {
      for (const f of c.subs) {
        if (matchTopic(f, topic)) {
          try { c.sock.write(pkt); } catch { /* 切断中 → close で掃除 */ }
          break; // 同一クライアントへ二重配信しない（複数 filter が合っても 1 通）
        }
      }
    }
  }

  function handle(c, pkt) {
    if (pkt.type === 1) {                 // CONNECT → 無条件で受理（LAN 信頼・認証なし）
      c.sock.write(CONNACK_OK);
    } else if (pkt.type === 8) {          // SUBSCRIBE → SUBACK（全部 QoS0 で承認）＋ filter 登録
      const { pid, topics } = parseSubscribe(pkt.body, true);
      for (const t of topics) c.subs.add(t);
      const body = Buffer.concat([Buffer.from([(pid >> 8) & 0xff, pid & 0xff]), Buffer.alloc(topics.length)]);
      c.sock.write(Buffer.concat([Buffer.from([0x90]), encodeLen(body.length), body]));
    } else if (pkt.type === 10) {         // UNSUBSCRIBE → UNSUBACK ＋ filter 解除
      const { pid, topics } = parseSubscribe(pkt.body, false);
      for (const t of topics) c.subs.delete(t);
      c.sock.write(Buffer.from([0xb0, 0x02, (pid >> 8) & 0xff, pid & 0xff]));
    } else if (pkt.type === 3) {          // PUBLISH → filter が合う全員へ即配る
      const { topic, payload } = parsePublish(pkt.body, pkt.flags);
      fanout(topic, payload);
    } else if (pkt.type === 12) {         // PINGREQ → PINGRESP
      c.sock.write(PINGRESP);
    } else if (pkt.type === 14) {         // DISCONNECT
      c.sock.end();
    }
    // それ以外（QoS1 の PUBACK 等）は来ない前提で黙って無視
  }

  const server = net.createServer((sock) => {
    const c = { sock, buf: Buffer.alloc(0), subs: new Set() };
    clients.add(c);
    sock.on('data', (chunk) => {
      c.buf = c.buf.length ? Buffer.concat([c.buf, chunk]) : chunk;
      for (;;) {
        const pkt = parsePacket(c.buf);
        if (!pkt) break;                            // 断片化＝続きを待つ
        if (pkt.malformed) { sock.destroy(); break; } // 壊れたら接続ごと捨てる
        c.buf = c.buf.subarray(pkt.total);
        handle(c, pkt);
      }
    });
    const drop = () => { clients.delete(c); };
    sock.on('close', drop);
    sock.on('error', () => sock.destroy());
  });

  const ready = new Promise((res) => server.listen(port, host, () => {
    log(`MQTT broker: ${host}:${server.address().port}（QoS0・自前）`);
    res();
  }));

  return {
    ready,
    port: () => (server.address() ? server.address().port : null),
    close() {
      for (const c of clients) { try { c.sock.destroy(); } catch { /* noop */ } }
      clients.clear();
      server.close();
    },
  };
}
