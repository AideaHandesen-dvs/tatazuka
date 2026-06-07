// 偽の本体（server スタブ）。protocol v0（protocol/README.md）を厳守して喋る。
// 本物は M3 で WebSocket になるが、この継ぎ目の形は変えない：
//   connect({onMessage}) → {send(msg)}
// app.js から見れば mock も本物も同じ。差し替えはこのファイルの import 先を変えるだけ。

export function connect({ onMessage }) {
  const out = (type, data) => setTimeout(() => onMessage({ type, data }), 60); // 配線遅延ごっこ
  const say = (text, mood) => out('say', mood ? { text, mood } : { text });

  let alive = false;
  let nade = 0, poke = 0, lastShake = 0;

  // ---- 暇つぶしの茶々（「間」は server が刻む：protocol §4-1） ----
  const IDLE = [
    ['で、いつまでそれやってるんだ？', '呆れ'],
    ['…別に、暇なわけじゃないからな。', '照れ'],
    ['そこ、もうちょっと片付けたらどうだ。', '疑い'],
    ['ふぁ…。', '通常'],
    ['なあ、外は晴れてるのか。', '通常'],
  ];
  setInterval(() => {
    if (!alive) return;
    const r = Math.random();
    if (r < 0.15) {
      // たまにふらっと居なくなる（presence のデモ：protocol §6-1）
      out('presence', { here: false });
      setTimeout(() => {
        out('presence', { here: true });
        say('…ちょっと散歩してた。', '通常');
      }, 8000);
    } else if (r < 0.6) {
      const [text, mood] = IDLE[Math.floor(Math.random() * IDLE.length)];
      say(text, mood);
    }
  }, 25000);

  // ---- protocol §3: hello / welcome ----
  function onHello(d) {
    if (d.protocol !== 0) { out('error', { message: 'protocol version mismatch' }); return; }
    alive = true;
    out('welcome', { protocol: 0 });
    out('presence', { here: true });
    if (d.resumed) {
      // 落ちたことは隠さず茶々の材料に（protocol §6-3）
      setTimeout(() => say('おい、なんかエラーで今落ちてたぞ。', '怒り'), 800);
    } else {
      setTimeout(() => say(`お、ここが「${d.label || '名前のない部屋'}」か。悪くないな。`, '通常'), 800);
    }
    // ask の cap を見つけたら、佇か自身が許可をねだる（protocol §3-2）
    if (d.caps?.orientation === 'ask') {
      setTimeout(() => { if (alive) say('なあ、その「傾きを許可」ってボタン、押してみろよ。', '喜び'); }, 7000);
    }
    if (d.caps?.camera === 'ask') {
      setTimeout(() => { if (alive) say('カメラを許可したら、俺はこの箱ごと透明になれるんだがな。', '疑い'); }, 14000);
    }
  }

  // ---- protocol §3-3: cap の変化 ----
  function onCaps(d) {
    if (d.orientation === 'on') {
      say('おっ、来たな。端末を傾けて、俺を覗き込んでみろ。', '喜び');
      out('motion', { act: '跳ねる' });
    }
    if (d.camera === 'on') say('ほら、俺の言った通り、透明になっただろ。', '喜び');
    if (d.orientation === 'none' || d.camera === 'none') {
      say('…まあいい。無くても俺はここに居るからな。', '呆れ'); // 拒否されても佇かは出る
    }
  }

  // ---- protocol §5: sense ----
  function onSense(d) {
    switch (d.kind) {
      case 'つつく':
        poke++;
        if (poke < 2) say('ん、なんだ？', '疑い');
        else if (poke < 4) say('いてっ。', '怒り');
        else { say('……しつこいぞ。', '怒り'); out('motion', { act: '首を振る' }); poke = 0; }
        break;
      case 'なでる':
        nade++;
        if (nade === 1) say('…なんだよ、急に。', '照れ');
        else if (nade === 4) say('まあ……悪くない。', '照れ');
        else if (nade >= 8) { say('はいはい、分かった分かった。', '喜び'); out('motion', { act: '跳ねる' }); nade = 0; }
        break;
      case '長押し':
        say('おい、つかむな。', '怒り');
        break;
      case '揺らす': {
        const now = Date.now();
        if (now - lastShake > 4000) {
          lastShake = now;
          say('うわっ、揺らすなって！', '怒り');
          out('motion', { act: '首を振る' });
        }
        break;
      }
      default:
        break; // 解釈できない kind は黙って無視
    }
  }

  return {
    send(msg) {
      setTimeout(() => {
        if (msg.type === 'hello') onHello(msg.data);
        else if (msg.type === 'caps') onCaps(msg.data);
        else if (msg.type === 'sense') onSense(msg.data);
        // 未知の型は黙って無視
      }, 60);
    },
  };
}
