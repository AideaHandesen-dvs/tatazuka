// 会話の短期記憶（protocol §5-4 talk）。直近のやり取り（user の言葉と佇かの返事）を数往復だけ覚え、
// LLM persona が「さっきの話」を踏まえた返事をできるようにする。
//   - 佇かは一人なので、セッション（部屋）ごとではなく server プロセスに一つ持つ（serve.js が注入）。
//     部屋を移っても・WS が瞬断しても会話は続く。reunion.js と同じ注入の継ぎ目。
//   - ディスクに書かない＝再起動で消える（マスコットの記憶は儚くてよい）。protocol は不変
//     （talk の ctx に添えるだけ。§5-4「会話の記憶は server 内部実装」）。
//
// 注入の継ぎ目（behavior.js の onTalk）：
//   - 返事の前に recent() → ctx.history（persona が「ここまでのやり取り」として織り込む）
//   - 返事が実際に届いたら push(user, reply)（届かなかった往復は覚えない）

export function createTalkMemory(opts) {
  const max = (opts && opts.max) || 6; // 直近 6 往復（小型モデルのプロンプトを膨らませない）
  const turns = [];                    // { user, reply } を古い順に
  return {
    push(user, reply) {
      turns.push({ user, reply });
      if (turns.length > max) turns.shift();
    },
    recent() { return turns.slice(); }, // コピーを返す（外で壊されない）
  };
}
