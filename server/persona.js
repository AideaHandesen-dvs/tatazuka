// 佇かの「何を喋るか」。situation タグ → { text, mood }。
// これが台詞生成のプラグイン継ぎ目：将来の LLM 版 persona は、この line() と同じ顔で
// 実装すれば behavior.js を一切触らず差し替えられる（人格層のプログレッシブ・エンハンスメント
// ＝ LLM が無くても佇かは喋る）。M4 はルールベース＝手書きテーブル。
//
// mood は protocol §4-3 の語彙（通常/呆れ/疑い/喜び/怒り/照れ）。

const TABLES = {
  'greet':            [['お、ここが「{label}」か。悪くないな。', '通常']],
  'greet.resumed':    [['おい、なんかエラーで今落ちてたぞ。', '怒り'],
                       ['…戻ってきたぞ。心配したか？', '照れ']],

  'nudge.orientation':[['なあ、その「傾きを許可」ってボタン、押してみろよ。', '喜び']],
  'nudge.camera':     [['カメラを許可したら、俺はこの箱ごと透明になれるんだがな。', '疑い']],

  'caps.orientation.on':[['おっ、来たな。端末を傾けて、俺を覗き込んでみろ。', '喜び']],
  'caps.camera.on':     [['ほら、俺の言った通り、透明になっただろ。', '喜び']],
  'caps.denied':        [['…まあいい。無くても俺はここに居るからな。', '呆れ']],

  'idle':[['で、いつまでそれやってるんだ？', '呆れ'],
          ['…別に、暇なわけじゃないからな。', '照れ'],
          ['そこ、もうちょっと片付けたらどうだ。', '疑い'],
          ['ふぁ…。', '通常'],
          ['なあ、外は晴れてるのか。', '通常']],
  'walk.back':[['…ちょっと散歩してた。', '通常']],

  // 時刻帯（在席中に日付境界をまたぐと出る／接続時の状況づけにも使う）
  'time.morning':  [['おはよう。…まあ、起きたなら働け。', '通常']],
  'time.noon':     [['昼か。飯は食ったのか？', '疑い']],
  'time.evening':  [['もう夕方だぞ。今日は何が進んだ？', '呆れ']],
  'time.night':    [['夜だな。根を詰めすぎるなよ。', '通常']],
  'time.deepnight':[['もう深夜だぞ。いい加減、寝ろ。', '怒り'],
                    ['こんな時間まで…付き合ってやってるんだからな。', '照れ']],

  // 在席・連続時間（「仕事を邪魔してくる」の素。閾値は分）
  'work.60': [['そろそろ1時間だ。一回、伸びでもしろ。', '通常']],
  'work.120':[['2時間ぶっ通しだぞ。目、休めてるか？', '疑い']],
  'work.180':[['それ3時間やってるぞ。…休憩しろって。', '呆れ']],

  // 触られたとき（protocol §5 の sense を段階で）
  'sense.poke.soft': [['ん、なんだ？', '疑い']],
  'sense.poke.mid':  [['いてっ。', '怒り']],
  'sense.poke.hard': [['……しつこいぞ。', '怒り']],
  'sense.nade.start':[['…なんだよ、急に。', '照れ']],
  'sense.nade.warm': [['まあ……悪くない。', '照れ']],
  'sense.nade.enough':[['はいはい、分かった分かった。', '喜び']],
  'sense.grab':      [['おい、つかむな。', '怒り']],
  'sense.shake':     [['うわっ、揺らすなって！', '怒り']],
};

export function createPersona() {
  const last = {}; // situation ごとに直前のインデックスを覚え、連続で同じ台詞を出さない
  return {
    // situation を知らなければ null（＝何も喋らない）。behavior 側はそれを許容する
    line(situation, ctx) {
      const table = TABLES[situation];
      if (!table) return null;
      let i = Math.floor(Math.random() * table.length);
      if (table.length > 1 && i === last[situation]) i = (i + 1) % table.length;
      last[situation] = i;
      let text = table[i][0];
      const mood = table[i][1];
      if (ctx && ctx.label) text = text.replace('{label}', ctx.label);
      return { text, mood };
    },
  };
}
