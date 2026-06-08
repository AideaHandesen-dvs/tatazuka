// 仲介ハブ：複数の部屋（接続）を束ね、佇かを「一度に一箇所」に居させる（protocol §6-1）。
// connectors の「出力＝表示先を差し替え可能に」の土台でもある（どの身体に居るかの選択そのもの）。
//
// 役割分担：
//   behavior.js … 一部屋ぶんの脳（喋る・動く・活性 activate/deactivate）。トランスポート非依存
//   hub.js      … どの部屋に佇かを居させるか（occupant の選択・移動・presence の出し分け）
//   serve.js    … WS 接続のたび hub.connect(send) し、受信/切断を部屋に配線する
//
// 設計：
//   - 佇かが居る部屋（occupant）だけが say/emote/motion を客に届ける。空き部屋は presence:false
//     （カメラ背景の透明な箱だけ）。これを部屋の出力に関所（gatedSend）を噛ませて実現する。
//   - welcome/error は握手なので常に通す（活性に関係なく客へ届ける）。presence は脳が present() で
//     直接出す（関所を通さない＝空き部屋にも presence:false を届けられる）。
//   - 空き部屋を つつく（sense）と、そこへ移動する（occupant を移す）。挨拶はせず sense の反応で迎える。
//   - occupant が切れたら、残った部屋のどれかへ佇かが移る（居なくなったら誰も居ない）。
//   - broadcast=true は退化形（全部屋に居る・デバッグ用。protocol §6-1 line 153 の「フラグで残す」）。
//   - protocol も client も不変：client は presence に従って描くだけ（§6-1）。server 実装の成熟。

// makeSession(opts) … opts（send/present/managed/onReady/onActive）を behavior.createSession に渡す
//   形の factory。serve.js が persona・イベント源を束ねて用意する。
// broadcast … 退化形（全部屋に居る）。
export function createHub({ makeSession, broadcast } = {}) {
  const rooms = new Set();
  let occupant = null; // 佇かが今居る部屋（broadcast 時は概念上「全部屋」なので使わない）

  function setOccupant(room, opts) {
    occupant = room;
    room.session.activate(opts); // present:true ＋（gree:false でなければ）挨拶
  }

  // 別の部屋へ佇かを移す。今居る部屋は空けて（presence:false）、移り先を活性化する。
  function moveTo(room, opts) {
    if (occupant === room) return;
    if (occupant) occupant.session.deactivate();
    setOccupant(room, opts);
  }

  function join(room) {
    rooms.add(room);
    if (broadcast) { room.session.activate(); return; } // 退化形：どの部屋にも佇かが出る
    if (!occupant) setOccupant(room);                   // 最初の部屋＝そこに居つく
    else room.session.deactivate();                     // 既に他に居る → この部屋は空き（presence:false）
  }

  function leave(room) {
    rooms.delete(room);
    if (broadcast || occupant !== room) return;
    occupant = null;
    const next = rooms.values().next().value; // 残った部屋のどれか
    if (next) setOccupant(next);              // 佇かはそちらへ移る（居なくなりはしない）
  }

  return {
    // WS 接続のたびに呼ぶ。rawSend はこの接続（部屋）へ生で送る関数。
    connect(rawSend) {
      const room = { active: false };

      // 出力の関所：welcome/error は常に通す。say/emote/motion は佇かが居る部屋だけ通す。
      const gatedSend = (obj) => {
        if (!obj || typeof obj.type !== 'string') return;
        if (obj.type === 'welcome' || obj.type === 'error') { rawSend(obj); return; }
        if (broadcast || room.active) rawSend(obj);
      };

      room.session = makeSession({
        send: gatedSend,
        present: (here) => rawSend({ type: 'presence', data: { here } }), // 空き部屋にも届く出口
        managed: true,                       // 活性は hub が握る（hello では自動活性しない）
        onReady: () => join(room),           // hello が通ったらこの部屋を迎え入れる
        onActive: (v) => { room.active = v; }, // 関所が見る活性フラグを同期
      });

      return {
        receive(msg) {
          // 空き部屋を つつかれたら、まず佇かをそこへ移してから sense を処理する（移動で迎える）。
          if (!broadcast && msg && msg.type === 'sense' && !room.active && occupant) {
            moveTo(room, { greet: false });
          }
          room.session.receive(msg);
        },
        close() {
          room.session.close();
          leave(room);
        },
      };
    },
  };
}
