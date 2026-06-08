// 本物の server への接続。偽 server（mock-server.js）と同じ顔をしている：
//   connect({onMessage}) → { send(msg) }
// app.js から見れば mock と区別がつかない。これが M2 で用意した継ぎ目（client/README）。
//
// 担当を一つここに閉じ込める：再接続。protocol §6-2 は「切断したら hello からやり直す」。
// app.js は hello を一度しか送らないので、最初の hello を覚えておき、再接続のたびに
// resumed:true を立てて自動で打ち直す（§6-3 の「落ちたことに言及」が実接続で効く）。
//
// iOS 12 対応：?. / ?? は使わない。WebSocket API は iOS 12 で動く。

export function connect({ onMessage }) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;

  let ws = null;
  let open = false;
  let queue = [];        // open 前に send されたメッセージ
  let hello = null;      // 最初の hello を保持（再接続で打ち直す）
  let everConnected = false;
  let backoff = 1000;

  function flush() {
    for (let i = 0; i < queue.length; i++) ws.send(JSON.stringify(queue[i]));
    queue = [];
  }

  function dial() {
    ws = new WebSocket(url);

    ws.onopen = () => {
      open = true;
      backoff = 1000;
      if (everConnected && hello) {
        // 再接続：覚えておいた hello に resumed を立てて打ち直す（§6-2/§6-3）
        const again = { type: 'hello', data: Object.assign({}, hello.data, { resumed: true }) };
        ws.send(JSON.stringify(again));
      }
      everConnected = true;
      flush();
    };

    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }
      if (msg) onMessage(msg);
    };

    ws.onclose = () => {
      open = false;
      setTimeout(dial, backoff);            // 自動再接続
      backoff = Math.min(backoff * 2, 10000); // 指数バックオフ（上限10秒）
    };

    ws.onerror = () => { try { ws.close(); } catch (e) { /* onclose に任せる */ } };
  }

  dial();

  return {
    send(msg) {
      if (msg && msg.type === 'hello' && !hello) hello = msg; // 初回 hello を記憶
      if (open) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    },
  };
}
