// persona.js の LLM 版。「何を喋るか」を手書き表から“その場の生成”に格上げする層。
// persona.js と同じ顔（line(situation, ctx) → {text,mood}|null）なので behavior.js は無傷。
//
// 設計（server/README「LLM persona」参照）:
//   - 環境系の situation（idle/time.*/work.*/greet/walk.back）だけ LLM 生成。
//     反応系（sense.* ＝つつく/なでる/揺らす）は即レスが命なので生成しない＝ルール表のまま。
//   - 生成が遅い/失敗/LLM 不在/出力が壊れている → 内部のルール persona にフォールバック。
//     LLM が無くても佇かは喋る（§5 プログレッシブ・エンハンスメント）。
//   - line() は async。behavior.js の say が await する（生成は喋る瞬間に走る）。
// provider は ollama / claude を env で両対応。依存ゼロのためグローバル fetch のみ（SDK なし）。

import { createPersona } from './persona.js';

const TIMEOUT_MS = 8000; // 生成がこれを超えたら諦めてルール表へ（佇かを黙らせない）

// protocol §4-3 の mood 語彙。これ以外が返ってきたら「通常」に丸める
const MOODS = new Set(['通常', '呆れ', '疑い', '喜び', '怒り', '照れ']);

// LLM に任せる situation と、その状況の人間向け説明（プロンプトに渡す）。
// ここに無い situation（sense.* / caps.* / nudge.* など）はルール表にそのまま委譲する。
const LLM_SITUATIONS = {
  'greet':          '初めてこの部屋（端末）に出てきたところ。軽く挨拶する',
  'greet.resumed':  '接続が切れて、自動でこの部屋に戻ってきた直後',
  'idle':           '特に用事はないが、間が空いたのでふと一言こぼす',
  'walk.back':      'ちょっと留守にしていて、いま戻ってきた',
  'time.morning':   '在席中に朝（5〜10時）を迎えた',
  'time.noon':      '在席中に昼（10〜17時）になった',
  'time.evening':   '在席中に夕方（17〜21時）になった',
  'time.night':     '在席中に夜（21時以降）になった',
  'time.deepnight': '深夜（0〜5時）。夜更かししているユーザーに、寝るよう促したい',
  'work.60':        'ユーザーが1時間ぶっ通しで作業している。一息つけと促す',
  'work.120':       'ユーザーが2時間ぶっ通しで作業している。目を休めろと促す',
  'work.180':       'ユーザーが3時間ぶっ通しで作業している。さすがに休憩しろと促す',
};

const PERSONA = `あなたはデスクトップマスコット「佇か（たたずか）」。伺かの精神的後継で、ユーザーの端末の中に静かに「佇んで」いて、ときどき茶々を入れてくる存在。

性格・口調:
- ぶっきらぼうで皮肉屋。でも根は面倒見がよく、本当はユーザーを気にかけている（素直じゃない）。
- 常にタメ口。敬語は使わない。一人称は「俺」。
- 短く言う。1文、長くても2文。説明や前置きはしない。

出力:
- 与えられた「状況」に対する佇かの一言だけを作る。
- 必ず次の JSON だけを出力する。前後に説明・コードブロック・余計な文字を付けない:
  {"text": "<台詞>", "mood": "<気分>"}
- mood は次のどれか一つ: 通常 / 呆れ / 疑い / 喜び / 怒り / 照れ`;

function buildUser(desc, ctx) {
  const label = ctx && ctx.label ? ctx.label : '名無し';
  return `状況: ${desc}\n部屋（端末）の名前: ${label}\nこの状況での佇かの一言を JSON で出せ。`;
}

// LLM の生テキストから最初の {...} を取り出し、{text,mood} に検証して返す。壊れていれば null
function parseLine(raw) {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return null; }
  if (!obj || typeof obj.text !== 'string' || !obj.text.trim()) return null;
  return { text: obj.text.trim(), mood: MOODS.has(obj.mood) ? obj.mood : '通常' };
}

// ---- provider（両対応・依存ゼロ） ----

function ollamaProvider(env) {
  const host = env.OLLAMA_HOST || 'http://localhost:11434';
  const model = env.TZ_LLM_MODEL || 'llama3.2';
  return {
    async generate(system, user, signal) {
      const r = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal,
      });
      if (!r.ok) throw new Error(`ollama ${r.status}`);
      const j = await r.json();
      return (j.message && j.message.content) || '';
    },
  };
}

function claudeProvider(env) {
  const key = env.ANTHROPIC_API_KEY;
  const model = env.TZ_LLM_MODEL || 'claude-opus-4-8';
  return {
    async generate(system, user, signal) {
      if (!key) throw new Error('ANTHROPIC_API_KEY 未設定');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        // Opus 4.8 は temperature/top_p/budget_tokens を受け付けない（送ると 400）ので付けない
        body: JSON.stringify({
          model,
          max_tokens: 200,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal,
      });
      if (!r.ok) throw new Error(`claude ${r.status}`);
      const j = await r.json();
      const block = Array.isArray(j.content) && j.content.find((b) => b.type === 'text');
      return block ? block.text : '';
    },
  };
}

// env.TZ_LLM を見て provider を選ぶ。未設定なら null（＝LLM オフ）
export function createProvider(env) {
  const e = env || process.env;
  if (e.TZ_LLM === 'ollama') return ollamaProvider(e);
  if (e.TZ_LLM === 'claude') return claudeProvider(e);
  return null;
}

// persona.js と同じ顔。ただし line() は async（生成を待つ）。
// opts.provider / opts.fallback はテスト注入用。
export function createLLMPersona(opts) {
  opts = opts || {};
  const rule = opts.fallback || createPersona();      // フォールバックの“床”
  const provider = opts.provider || createProvider(); // null なら全部ルールに委譲
  return {
    async line(situation, ctx) {
      const desc = LLM_SITUATIONS[situation];
      // 反応系・LLM オフ・未知の situation はルール表へ（即返し）
      if (!provider || !desc) return rule.line(situation, ctx);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const raw = await provider.generate(PERSONA, buildUser(desc, ctx), ctrl.signal);
        const ln = parseLine(raw);
        if (ln) return ln;
      } catch (e) {
        // 遅い・失敗・中断は握りつぶしてフォールバックへ
      } finally {
        clearTimeout(timer);
      }
      return rule.line(situation, ctx);
    },
  };
}
