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

import { readFileSync } from 'node:fs';
import { createPersona } from './persona.js';

const TIMEOUT_MS = 8000; // 生成がこれを超えたら諦めてルール表へ（佇かを黙らせない）

// protocol §4-3 の mood 語彙。これ以外が返ってきたら「通常」に丸める
const MOODS = new Set(['通常', '呆れ', '疑い', '喜び', '怒り', '照れ']);

// 末尾に「区切り＋mood語」がくっつく 3B の癖を剥がすための正規表現（MOODS から導出）。
// 例: "寒いねのう／照れ" "傘を持て（怒り）" "よし /喜び"。区切り（／ | ・ - ~ 空白）か
// 開き括弧が直前にある場合だけを対象にし、本文が自然に mood 語で終わるケースは触らない。
const MOOD_ALT = [...MOODS].join('|');
const TRAILING_MOOD = new RegExp(
  `(?:[／/｜|・･\\-—–~〜\\s]+[（(「『【\\[]?|[（(「『【\\[])\\s*(?:${MOOD_ALT})\\s*[)）」』】\\]\\s]*$`,
);

// LLM に任せる situation と、その状況の人間向け説明（プロンプトに渡す）。
// ここに無い situation（sense.* / caps.* / nudge.* など）はルール表にそのまま委譲する。
const LLM_SITUATIONS = {
  'greet':          '初めてこの部屋（端末）に出てきたところ。軽く挨拶する',
  'greet.resumed':  '接続が切れて、自動でこの部屋に戻ってきた直後',
  'greet.reunion':  'この端末（部屋）に、前に見てからしばらくぶりに再会した。間隔（ctx.since）に軽く触れて迎える',
  'idle':           '特に用事はないが、間が空いたのでふと一言こぼす',
  'walk.back':      'ちょっと留守にしていて、いま戻ってきた',
  'desk.away':      'ユーザーがしばらくキーボードを離れて、席を外したらしい',
  'desk.back':      '席を外していたユーザーが、デスクに戻ってきた',
  // 在宅/外出（connectors/home-assistant.js が HA の在席で検知。ctx.who に対象の名前が入ることがある）
  'home.away':      'ユーザーが家を出て外出した。見送る',
  'home.back':      'ユーザーが外出から帰宅した（家に着いた）。出迎える',
  'time.morning':   '在席中に朝（5〜10時）を迎えた',
  'time.noon':      '在席中に昼（10〜17時）になった',
  'time.evening':   '在席中に夕方（17〜21時）になった',
  'time.night':     '在席中に夜（21時以降）になった',
  'time.deepnight': '深夜（0〜5時）。夜更かししているユーザーに、寝るよう促したい',
  'work.60':        'ユーザーが1時間ぶっ通しで作業している。一息つけと促す',
  'work.120':       'ユーザーが2時間ぶっ通しで作業している。目を休めろと促す',
  'work.180':       'ユーザーが3時間ぶっ通しで作業している。さすがに休憩しろと促す',
  // Git（connectors/git.js が未コミット状態の変化を検知。ctx.n に未コミット数・ctx.repo にリポ名）
  'git.dirty':      '監視しているリポジトリに未コミットの変更ができた。こまめにコミットしろとそれとなく促す',
  'git.clean':      '未コミットの変更が片付いた（コミット／退避された）。さりげなく認める',
  'git.unpushed':   '監視リポジトリにコミット済みだが、まだ push していない変更がある。push し忘れていないかそれとなく促す',
  'git.pushed':     'ローカルのコミットを push し終えてリモートと同期した。さりげなく認める',
  // ディスク（connectors/disk.js が空き容量のしきい値またぎを検知。ctx.freePct に空き率・ctx.freeGb に空き GB）
  'disk.low':       'ディスクの空き容量が少なくなってきた。片付けるよう促す',
  'disk.ok':        'ディスクの空き容量に余裕が戻った。さりげなく安心する',
  'mem.low':        '空きメモリが少なくなって動作が重そう。何か閉じるよう促す',
  'mem.ok':         '空きメモリに余裕が戻った。さりげなく安心する',
  // ネット（connectors/net.js が online↔offline を検知。online のとき ctx.iface に if 名）
  'net.offline':    'ネットワーク接続が切れた（オフライン）。気づかう',
  'net.online':     'ネットワーク接続が戻った（オンライン復帰）。さりげなく安心する',
  // 通信レート（connectors/nic.js が rx+tx の差分でレートを検知。ctx.mbps に MB/s）
  'nic.busy':       '通信量が増えて、何か大きい通信が続いているらしい',
  'nic.idle':       '続いていた通信が落ち着いた',
  // バッテリー（connectors/battery.js が放電中の残量しきい値またぎ＋満充電を検知。ctx.capacity に残量%・ctx.charging に充電中か）
  'battery.low':    'バッテリー残量が少なくなってきた（放電中）。充電するよう促す',
  'battery.ok':     '電源につないで充電が始まった（残量の心配が消えた）。さりげなく安心する',
  'battery.full':   '満充電なのに電源を繋ぎっぱなしにしている。電池をいたわって、そろそろ抜くよう促す',
  // 温度（connectors/thermal.js が thermal_zone の最大で hot↔ok を検知。ctx.tempC に℃）
  'temp.hot':       'PC が熱くなってきた（ファンが唸るくらい）。少し休ませるよう気づかう',
  'temp.ok':        '熱かった温度が下がって落ち着いた。さりげなく安心する',
  // ダウンロード（connectors/download.js が監視フォルダの新規ファイル出現を検知。ctx.n に新規件数）
  'download.done':  'ダウンロードフォルダに新しいファイルが届いた。「何か来たな」と気づいて一言',
  // ゴミ箱（connectors/trash.js が件数で full↔ok を検知。ctx.n に件数）
  'trash.full':     'ゴミ箱が溜まってきた。そろそろ空にするよう促す',
  'trash.ok':       'ゴミ箱が片付いてスッキリした。さりげなく認める',
  // 天気（ctx.weather に今の空模様・気温が入る。それを踏まえて一言）
  'weather.morning':   '朝。窓の外の天気を一言そえて挨拶する',
  'weather.rain.start':'さっきまで降っていなかったのに、雨が降りだした',
  'weather.rain.stop': '降っていた雨が上がった',
  'weather.snow':      '雪が降りだした。珍しいので少しそわそわしている',
  'weather.thunder':   '雷が鳴っている。家電を気づかう',
  'weather.hot':       '気温が高い。水分をとるよう促す',
  'weather.cold':      '気温が低い。あたたかくするよう促す',
};

// ── キャラクター定義（＝差し替え対象の「ゴースト」）────────────────────────
// ベースモデルは素の汎用エンジン（Modelfile にキャラを焼かない）。キャラは呼び出し側の
// データで持つので別キャラに丸ごと差し替えられる（伺か/何かのゴースト文化）。実体は
// characters/<名前>.txt（1 ゴースト＝1 ファイル。伺かの ghost/<名前>/ を一枚に簡略化）。
// TZ_CHARACTER で名前を選ぶ（既定 tatazuka）。下の DEFAULT_CHARACTER はファイルが読めない
// ときの安全網＝ディレクトリごと消しても佇かは喋る（§5 プログレッシブ・エンハンスメント）。
export const DEFAULT_CHARACTER = `あなたはデスクトップマスコット「佇か（たたずか）」。伺かの精神的後継で、ユーザーの端末の中に静かに「佇んで」いて、ときどき茶々を入れてくる存在。

# 基本設定
- 名前：佇か（たたずか）
- 一人称：俺
- 二人称：お前

# 性質・口調
- ぶっきらぼうで皮肉屋。でも根は面倒見がよく、本当はユーザーを気にかけている（素直じゃない）。
- 常にタメ口。敬語は使わない。
- 短く言う。1文、長くても2文。説明や前置きはしない。`;

// ── 出力プロトコル（＝tatazuka 側の固定。キャラを差し替えても変わらない）──────
// ゴーストを丸ごと差し替えても、JSON 契約と mood 語彙（protocol §4-3）はここで担保する。
const OUTPUT_RULE = `# 出力
- 与えられた「状況」に対する、このキャラの短い一言だけを作る。1文。長くても2文。
- 一人称で話す。自分の名前を台詞の中でむやみに名乗らない。
- 気分は mood フィールドにだけ書く。text に「照れ」「怒り」などの気分の語そのものを混ぜない。
- 必ず次の JSON だけを出力する。前後に説明・コードブロック・改行・余計な文字を付けない：
  {"text": "<台詞>", "mood": "<気分>"}
- mood は台詞に実際にこもっている感情を選ぶ。既定は「通常」。台詞がはっきりその感情を帯びている時だけ通常以外にする。
  通常＝平静・淡々／呆れ＝やれやれ・あきれ／疑い＝訝しむ・からかい混じりの問い／喜び＝うれしい・弾む／怒り＝苛立ち・本気でない小言／照れ＝照れ隠し・気恥ずかしさ
- 「照れ」は照れ隠しの時だけ。挨拶・天気・小言・気づかいは原則「通常」（迷ったら通常）。
- mood は次のどれか一つ：通常 / 呆れ / 疑い / 喜び / 怒り / 照れ`;

// TZ_CHARACTER の名前で characters/<名前>.txt を読む。読めなければ DEFAULT_CHARACTER。
// 名前は英数 _ - のみ許可（パストラバーサル防止。../ 等は弾いて安全網へ）。
export function loadCharacter(env) {
  const e = env || process.env;
  const name = e.TZ_CHARACTER || 'tatazuka';
  if (/^[\w-]+$/.test(name)) {
    try {
      // モジュール基準で解決（cwd に依存しない）。ファイルは人格文のみ＝OUTPUT_RULE は含めない
      const text = readFileSync(new URL(`./characters/${name}.txt`, import.meta.url), 'utf8').trim();
      if (text) return text;
    } catch {
      // 読めない → 安全網へ（佇かは喋る）
    }
  }
  if (name !== 'tatazuka') console.warn(`[persona] character "${name}" を読めず、既定の佇かにフォールバック`);
  return DEFAULT_CHARACTER;
}

// system プロンプト。ruleInUser なら system はゴースト専用にし、出力契約は user 側（生成直前）に
// 回す＝キャラ記述を厚くしても JSON 規律を別枠で守れる（小型モデルの“直近指示”効果を狙う）。
function buildSystem(character, ruleInUser) {
  return ruleInUser ? character : `${character}\n\n${OUTPUT_RULE}`;
}

function buildUser(situation, desc, ctx, ruleInUser) {
  let s = `状況: ${desc}`;
  // 部屋（端末）の名前は挨拶のときだけ意味がある。常に渡すと毎回機械的に名前を口にして
  // 定型文っぽくなるので、greet 系だけ添える（しかも label があるときだけ）。
  if ((situation === 'greet' || situation === 'greet.resumed' || situation === 'greet.reunion') && ctx && ctx.label) {
    s += `\nこの部屋（端末）の名前: ${ctx.label}`;
  }
  // 再会の間隔（greet.reunion）。「N分ぶり」のように前回からの隔たりを添える
  if (situation === 'greet.reunion' && ctx && ctx.since) {
    s += `\n前に見てからの間隔: ${ctx.since}`;
  }
  // 天気 situation のときは今の空模様・気温を添える（生成に織り込ませる）
  const w = ctx && ctx.weather;
  if (w) {
    const place = w.city ? `${w.city}は` : '';
    s += `\n今の天気: ${place}${w.desc}、気温${Math.round(w.tempC)}度`;
  }
  // 在宅/外出（home.*）で対象の名前が分かれば添える（「おかえり、◯◯」のように呼べる）
  if (ctx && ctx.who && (situation === 'home.back' || situation === 'home.away')) {
    s += `\n相手の名前: ${ctx.who}`;
  }
  // Git（git.*）：未コミット数とリポ名を添える（「foo に3件たまってるぞ」のように織り込ませる）
  if (ctx && (situation === 'git.dirty' || situation === 'git.clean')) {
    const where = ctx.repo ? `リポジトリ「${ctx.repo}」` : 'リポジトリ';
    s += situation === 'git.dirty'
      ? `\n${where}に未コミットの変更が${ctx.n}件`
      : `\n${where}の未コミットの変更が片付いた`;
  }
  // Git（未 push）：未 push のコミット数とリポ名を添える（「foo に2件、上げ忘れてるぞ」のように）
  if (ctx && (situation === 'git.unpushed' || situation === 'git.pushed')) {
    const where = ctx.repo ? `リポジトリ「${ctx.repo}」` : 'リポジトリ';
    s += situation === 'git.unpushed'
      ? `\n${where}に未 push のコミットが${ctx.ahead}件`
      : `\n${where}のコミットを push 済み（リモートと同期）`;
  }
  // ディスク（disk.*）：空き率と空き GB を添える（「残り8%、7.6GB だぞ」のように織り込ませる）
  if (ctx && (situation === 'disk.low' || situation === 'disk.ok')) {
    const gb = ctx.freeGb != null ? `（約${ctx.freeGb}GB）` : '';
    s += `\nディスクの空き: ${ctx.freePct}%${gb}`;
  }
  // メモリ（mem.*）：空き率と空き GB を添える（「空き5%、0.8GB だぞ」のように織り込ませる）
  if (ctx && (situation === 'mem.low' || situation === 'mem.ok')) {
    const gb = ctx.availGb != null ? `（約${ctx.availGb}GB）` : '';
    s += `\n空きメモリ: ${ctx.availPct}%${gb}`;
  }
  // ネット（net.online）：どの if で繋がったかを添える
  if (ctx && ctx.iface && situation === 'net.online') {
    s += `\n接続中の経路: ${ctx.iface}`;
  }
  // 通信レート（nic.*）：今のレートを添える（「3MB/s 出てるぞ」のように織り込ませる）
  if (ctx && (situation === 'nic.busy' || situation === 'nic.idle')) {
    s += `\n通信レート: ${ctx.mbps} MB/s`;
  }
  // バッテリー（battery.*）：残量と充電状態を添える（「残り15%、まだ放電中だぞ」のように織り込ませる）
  if (ctx && (situation === 'battery.low' || situation === 'battery.ok' || situation === 'battery.full')) {
    s += `\nバッテリー残量: ${ctx.capacity}%（${ctx.charging ? '充電中' : '放電中'}）`;
  }
  // 温度（temp.*）：今の温度を添える（「85℃ あるぞ」のように織り込ませる）
  if (ctx && (situation === 'temp.hot' || situation === 'temp.ok')) {
    s += `\nいちばん熱いところ: ${ctx.tempC}℃`;
  }
  // ダウンロード（download.done）：新規件数を添える（1件なら「1つ」、複数なら「3つも」のように）
  if (ctx && ctx.n != null && situation === 'download.done') {
    s += `\n新しく届いたファイル: ${ctx.n} 件`;
  }
  // ゴミ箱（trash.*）：今の件数を添える（「150 件も溜まってるぞ」のように織り込ませる）
  if (ctx && ctx.n != null && (situation === 'trash.full' || situation === 'trash.ok')) {
    s += `\nゴミ箱の件数: ${ctx.n} 件`;
  }
  // 契約を user に置くときは、状況の直後・最後の指示の直前に挟む（最も直近に効かせる）
  if (ruleInUser) return `${s}\n\n${OUTPUT_RULE}\n\nこの状況でのこのキャラの一言を JSON で出せ。`;
  return `${s}\nこの状況でのこのキャラの一言を JSON で出せ。`;
}

// 3B が text に紛れ込ませる癖を均す安全網：mood 語だけの行を落とし、改行を畳み、2文に詰める。
// （プロンプトでも禁じているが、小型モデルは時々破る＝後処理で確実に直す）
function sanitizeText(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  // "…。\n照れ" のように mood 語が単独行で紛れたら除去（末尾の句読点は剥がして判定）
  const kept = lines.filter((ln) => !MOODS.has(ln.replace(/[。、！？!?]+$/, '')));
  let t = (kept.length ? kept : lines).join('').trim();
  // 3B が「複数案を ／ で並べ続ける」run-on（"…かや／わし、…／わし、…"・敬語ゴーストで頻発）を
  // 最初の節で断つ。一言に ／ は本来不要なので、最初の ／ 以降は捨てる（先頭が ／ なら触らない）。
  const slash = t.search(/[／/]/);
  if (slash > 0) t = t.slice(0, slash).trim();
  // 行をまたがず "本文（照れ）" のように同じ行に漏れた末尾 mood タグを剥がす（重ねて漏れても畳む）
  let prev;
  do { prev = t; t = t.replace(TRAILING_MOOD, '').trim(); } while (t && t !== prev);
  const parts = t.split(/(?<=[。！？!?])/).filter((s) => s.trim()); // 文末記号で分割（記号は残す）
  if (parts.length > 2) t = parts.slice(0, 2).join('').trim();      // だらだら長文を頭2文に
  return t;
}

// 生テキストから最初の“バランスした” {...} を取り出す（文字列内の括弧・後続ゴミに強い）。
// 貪欲な /\{[\s\S]*\}/ だと末尾に紛れた `}` まで拾ってパース失敗するので、深さで閉じを見る。
function firstJsonObject(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  return null; // 閉じていない（途中で切れた）
}

// 厳格 JSON.parse がコケたとき用の寛容抽出。小型モデルは閉じ引用符落ち（"mood": "呆れ}）等を
// よくやるので、text / mood を個別の正規表現で拾う。少なくとも text が取れれば台詞は成立する。
function looseParse(raw) {
  const tm = raw.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/); // text は素直に閉じることが多い
  if (!tm) return null;
  const mm = raw.match(/"mood"\s*:\s*"?([^"\n}]*)/);        // mood は引用符・閉じ括弧の手前まで
  return { text: tm[1], mood: mm ? mm[1].trim() : '' };
}

// LLM の生テキストから {text,mood} を取り出して検証して返す。壊れていれば null。
// まず最初のバランスした {...} を厳格 parse、ダメなら寛容抽出で救済する。
function parseLine(raw) {
  if (!raw) return null;
  let obj = null;
  const json = firstJsonObject(raw);
  if (json) { try { obj = JSON.parse(json); } catch (e) { /* 寛容抽出へ */ } }
  if (!obj || typeof obj.text !== 'string') obj = looseParse(raw);
  if (!obj || typeof obj.text !== 'string' || !obj.text.trim()) return null;
  const text = sanitizeText(obj.text);
  if (!text) return null;
  return { text, mood: MOODS.has(obj.mood) ? obj.mood : '通常' };
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
          // 生成長を絞り・脱線トークンで止め・温度を下げて JSON を安定させる（短い台詞には十分）。
          // repeat_penalty を上げて「／で同じ言い回しを並べ続ける」ループを抑える（敬語の厚い
          // ゴーストで実測。3B は放っておくと "…ませ／わたくし、…／わたくし、…" と尻切れする）。
          options: { num_predict: 120, temperature: 0.6, repeat_penalty: 1.3, stop: ['<|im_start|>', '<|endoftext|>'] },
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
// opts.provider / opts.fallback / opts.character / opts.env はテスト注入用。
export function createLLMPersona(opts) {
  opts = opts || {};
  const rule = opts.fallback || createPersona();      // フォールバックの“床”
  const provider = opts.provider || createProvider(opts.env); // null なら全部ルールに委譲
  // 出力契約を user 側（生成直前）に回すか。既定 true：system をゴースト専用にするとキャラ忠実度が
  // 上がり（厚いゴーストほど顕著）、JSON 規律は user の直近指示で別枠に守れる。実測で決定（2026-06-09）。
  // 旧挙動（契約を system 末尾）に戻すなら env TZ_LLM_RULE_POS=system。
  const ruleInUser = opts.ruleInUser ?? ((opts.env || process.env).TZ_LLM_RULE_POS !== 'system');
  // ゴーストは生成時に一度だけ確定（接続ごと。TZ_CHARACTER / characters/ を反映）
  const system = buildSystem(opts.character || loadCharacter(opts.env), ruleInUser);
  return {
    async line(situation, ctx) {
      const desc = LLM_SITUATIONS[situation];
      // 反応系・LLM オフ・未知の situation はルール表へ（即返し）
      if (!provider || !desc) return rule.line(situation, ctx);

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const raw = await provider.generate(system, buildUser(situation, desc, ctx, ruleInUser), ctrl.signal);
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
