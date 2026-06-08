// 佇かの振る舞い（人格の素）。トランスポート非依存：send(obj) を渡されるだけで、
// WS でも将来の何かでも同じ。protocol v0（protocol/README.md）を server 側として実装する。
//
//   const s = createSession({ send, label });
//   s.receive(msg)  ← client からの {type,data}
//   s.close()       ← 切断。タイマーを掃除する
//
// 中身は M2 の client/mock-server.js から移植。体験は変えず「本物化」しただけ。
// 茶々ロジック・イベント源（時刻/天気/PC監視）・LLM などは M4 でここを育てる。

const IDLE = [
  ['で、いつまでそれやってるんだ？', '呆れ'],
  ['…別に、暇なわけじゃないからな。', '照れ'],
  ['そこ、もうちょっと片付けたらどうだ。', '疑い'],
  ['ふぁ…。', '通常'],
  ['なあ、外は晴れてるのか。', '通常'],
];

export function createSession({ send }) {
  // タイマーは session 内で管理し、close() で必ず掃除する（接続ごとのリーク防止）
  const timers = new Set();
  let closed = false;
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); if (!closed) fn(); }, ms);
    timers.add(id);
    return id;
  };

  const say = (text, mood) => send({ type: 'say', data: mood ? { text, mood } : { text } });
  const motion = (act) => send({ type: 'motion', data: { act } });

  let helloDone = false;
  let nade = 0, poke = 0, lastShake = 0;

  // ---- 暇つぶしの茶々（「間」は server が刻む：protocol §4-1） ----
  const idle = setInterval(() => {
    if (closed || !helloDone) return;
    const r = Math.random();
    if (r < 0.15) {
      // たまにふらっと居なくなる（presence：protocol §6-1）
      send({ type: 'presence', data: { here: false } });
      later(() => {
        send({ type: 'presence', data: { here: true } });
        say('…ちょっと散歩してた。', '通常');
      }, 8000);
    } else if (r < 0.6) {
      const [text, mood] = IDLE[Math.floor(Math.random() * IDLE.length)];
      say(text, mood);
    }
  }, 25000);
  timers.add(idle); // close で clearInterval される（clearTimeout と互換 id）

  // ---- protocol §3: hello / welcome ----
  function onHello(d) {
    if (!d || d.protocol !== 0) { send({ type: 'error', data: { message: 'protocol version mismatch' } }); return; }
    helloDone = true;
    send({ type: 'welcome', data: { protocol: 0 } });
    send({ type: 'presence', data: { here: true } });

    if (d.resumed) {
      later(() => say('おい、なんかエラーで今落ちてたぞ。', '怒り'), 800); // 落ちたことは茶々に（§6-3）
    } else {
      later(() => say(`お、ここが「${d.label || '名前のない部屋'}」か。悪くないな。`, '通常'), 800);
    }

    const caps = d.caps || {};
    if (caps.orientation === 'ask') {
      later(() => say('なあ、その「傾きを許可」ってボタン、押してみろよ。', '喜び'), 7000);
    }
    if (caps.camera === 'ask') {
      later(() => say('カメラを許可したら、俺はこの箱ごと透明になれるんだがな。', '疑い'), 14000);
    }
  }

  // ---- protocol §3-3: cap の変化 ----
  function onCaps(d) {
    if (!d) return;
    if (d.orientation === 'on') {
      say('おっ、来たな。端末を傾けて、俺を覗き込んでみろ。', '喜び');
      motion('跳ねる');
    }
    if (d.camera === 'on') say('ほら、俺の言った通り、透明になっただろ。', '喜び');
    if (d.orientation === 'none' || d.camera === 'none') {
      say('…まあいい。無くても俺はここに居るからな。', '呆れ');
    }
  }

  // ---- protocol §5: sense ----
  function onSense(d) {
    if (!d) return;
    switch (d.kind) {
      case 'つつく':
        poke++;
        if (poke < 2) say('ん、なんだ？', '疑い');
        else if (poke < 4) say('いてっ。', '怒り');
        else { say('……しつこいぞ。', '怒り'); motion('首を振る'); poke = 0; }
        break;
      case 'なでる':
        nade++;
        if (nade === 1) say('…なんだよ、急に。', '照れ');
        else if (nade === 4) say('まあ……悪くない。', '照れ');
        else if (nade >= 8) { say('はいはい、分かった分かった。', '喜び'); motion('跳ねる'); nade = 0; }
        break;
      case '長押し':
        say('おい、つかむな。', '怒り');
        break;
      case '揺らす': {
        const now = Date.now();
        if (now - lastShake > 4000) { lastShake = now; say('うわっ、揺らすなって！', '怒り'); motion('首を振る'); }
        break;
      }
      default:
        break; // 未知の kind は黙って無視
    }
  }

  return {
    receive(msg) {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'hello') onHello(msg.data);
      else if (msg.type === 'caps') onCaps(msg.data);
      else if (msg.type === 'sense') onSense(msg.data);
      // 未知の型は黙って無視
    },
    close() {
      closed = true;
      for (const id of timers) clearTimeout(id); // setInterval の id も clearTimeout で消える
      clearInterval(idle);
      timers.clear();
    },
  };
}
