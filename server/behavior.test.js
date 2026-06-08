// behavior.js の非同期 say の安全性テスト（依存ゼロ・node:test）。
//   node --test server/behavior.test.js
//
// LLM persona 化で line() を async にしたときの「唯一の落とし穴」（server/README）：
//   生成（数秒）の await 中にセッションが切れることがある。await の後に closed を
//   再チェックしてから送らないと、切断後に say が飛ぶ。ここをコードで固定する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './behavior.js';
import { createReunion } from './reunion.js';

// 手で解決できる deferred な persona。line() を pending のまま握って切断を割り込ませる
function deferredPersona() {
  let resolveLine;
  const pending = new Promise((res) => { resolveLine = res; });
  return {
    persona: { line: () => pending },
    resolve: (ln) => resolveLine(ln),
  };
}

test('生成の await 中に close されたら say は送らない（切断後発話の防止）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  const { persona, resolve } = deferredPersona();
  const s = createSession({ send: (m) => sent.push(m), persona });

  s.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  // hello は welcome / presence を即送り、greet は later(800ms) で予約される
  assert.ok(sent.some((m) => m.type === 'welcome'));
  assert.ok(sent.some((m) => m.type === 'presence'));

  t.mock.timers.tick(800);   // greet の later が発火 → say('greet') が p.line を await（pending）
  s.close();                 // ★生成待ちの最中に切断
  resolve({ text: '遅れて来た挨拶', mood: '通常' }); // ここで生成が“返ってくる”
  await Promise.resolve();   // say 内の await 後の継続（closed 再チェック）を走らせる

  assert.ok(!sent.some((m) => m.type === 'say'), 'close 後に say が漏れてはいけない');
});

test('正常時：生成が close 前に返れば say は送られる', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  const { persona, resolve } = deferredPersona();
  const s = createSession({ send: (m) => sent.push(m), persona });

  s.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  t.mock.timers.tick(800);
  resolve({ text: 'よう', mood: '通常' });
  await Promise.resolve();

  const say = sent.find((m) => m.type === 'say');
  assert.ok(say, 'close していなければ say は届く');
  assert.equal(say.data.text, 'よう');
  s.close();
});

// situation と ctx を記録する persona（text に situation をそのまま載せて追える）
function recordingPersona(seen) {
  return { line: (s, ctx) => { seen.push({ s, ctx }); return { text: s, mood: '通常' }; } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const HELLO = { type: 'hello', data: { protocol: 0, label: '居間' } };

test('天気：poll が situation を返したら ctx 込みで say する', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [], seen = [];
  const weather = {
    async poll() { return { situation: 'weather.rain.start', ctx: { weather: { desc: '雨', tempC: 18 } } }; },
    async current() { return null; },
  };
  const FIXED = new Date('2026-06-09T14:00:00').getTime(); // 昼。バンド変化を起こさない固定時刻
  const s = createSession({ send: (m) => sent.push(m), persona: recordingPersona(seen), weather, now: () => FIXED, tickMs: 10, weatherMs: 1 });

  s.receive(HELLO);
  t.mock.timers.tick(10); // 最初の tick で weatherTick が poll を撃つ
  await flush();

  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'weather.rain.start'), '天気の say が飛ぶ');
  const w = seen.find((x) => x.s === 'weather.rain.start');
  assert.equal(w.ctx.weather.desc, '雨', '天気 ctx が persona に届く');
  assert.equal(w.ctx.label, '居間', '基底 ctx（label）に重ねて渡る');
  s.close();
});

test('天気：朝は weather.current で weather.morning を喋る', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [], seen = [];
  const weather = {
    async poll() { return null; },
    async current() { return { situation: 'weather.morning', ctx: { weather: { desc: '快晴', tempC: 20 } } }; },
  };
  let nowVal = new Date('2026-06-09T23:00:00').getTime(); // 接続時は夜
  const s = createSession({ send: (m) => sent.push(m), persona: recordingPersona(seen), weather, now: () => nowVal, tickMs: 10, weatherMs: 1 });

  s.receive(HELLO);
  nowVal = new Date('2026-06-09T07:00:00').getTime(); // 朝へバンドが変わる
  t.mock.timers.tick(10);
  await flush();

  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'weather.morning'), '朝は weather.morning');
  assert.ok(!sent.some((m) => m.data && m.data.text === 'time.morning'), 'time.morning には縮退しない');
  s.close();
});

test('天気：朝でも current が取れなければ time.morning に縮退', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  const weather = { async poll() { return null; }, async current() { return null; } };
  let nowVal = new Date('2026-06-09T23:00:00').getTime();
  const s = createSession({ send: (m) => sent.push(m), persona: recordingPersona([]), weather, now: () => nowVal, tickMs: 10, weatherMs: 1 });

  s.receive(HELLO);
  nowVal = new Date('2026-06-09T07:00:00').getTime();
  t.mock.timers.tick(10);
  await flush();

  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'time.morning'), '天気が取れなければ従来の朝挨拶');
  s.close();
});

test('天気オフ（weather 未注入）でも朝挨拶は出る（PE）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  let nowVal = new Date('2026-06-09T23:00:00').getTime();
  const s = createSession({ send: (m) => sent.push(m), persona: recordingPersona([]), now: () => nowVal, tickMs: 10 });

  s.receive(HELLO);
  nowVal = new Date('2026-06-09T07:00:00').getTime();
  t.mock.timers.tick(10);
  await flush();

  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'time.morning'));
  s.close();
});

test('作業監視：poll が離席を返したら say する（ナグの時計には触らない）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  const activity = { async poll() { return { situation: 'desk.away' }; } };
  const FIXED = new Date('2026-06-09T14:00:00').getTime(); // バンド変化を起こさない固定時刻
  const s = createSession({ send: (m) => sent.push(m), persona: recordingPersona([]), activity, now: () => FIXED, tickMs: 10 });

  s.receive(HELLO);
  t.mock.timers.tick(10);
  await flush();

  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'desk.away'), '離席の say が飛ぶ');
  s.close();
});

test('sources：connector の poll が situation を返したら ctx 込みで say する', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [], seen = [];
  const sources = [{ async poll() { return { situation: 'home.back', ctx: { who: 'John' } }; } }];
  const FIXED = new Date('2026-06-09T14:00:00').getTime(); // バンド変化を起こさない固定時刻
  const s = createSession({ send: (m) => sent.push(m), persona: recordingPersona(seen), sources, now: () => FIXED, tickMs: 10 });

  s.receive(HELLO);
  t.mock.timers.tick(10);
  await flush();

  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'home.back'), 'connector の say が飛ぶ');
  const h = seen.find((x) => x.s === 'home.back');
  assert.equal(h.ctx.who, 'John', 'connector の ctx（who）が persona に届く');
  assert.equal(h.ctx.label, '居間', '基底 ctx（label）に重ねて渡る');
  s.close();
});

test('sources：activity と connectors は同列に poll される（両方喋る）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sent = [];
  const activity = { async poll() { return { situation: 'desk.back' }; } };
  const sources = [{ async poll() { return { situation: 'home.back' }; } }];
  const FIXED = new Date('2026-06-09T14:00:00').getTime();
  const s = createSession({ send: (m) => sent.push(m), persona: recordingPersona([]), activity, sources, now: () => FIXED, tickMs: 10 });

  s.receive(HELLO);
  t.mock.timers.tick(10);
  await flush();

  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'desk.back'), 'activity も poll される');
  assert.ok(sent.some((m) => m.type === 'say' && m.data.text === 'home.back'), 'connector も poll される');
  s.close();
});

test('再会の記憶：間隔が空いて再接続すると greet.reunion を間隔つきで言う', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const reunion = createReunion();
  let nowVal = new Date('2026-06-09T14:00:00').getTime();
  const clock = () => nowVal;

  // 1回目：接続してすぐ切断 → reunion に「居間」を最後に見た時刻として刻む
  const s1 = createSession({ send: () => {}, persona: recordingPersona([]), now: clock, tickMs: 100000, reunion });
  s1.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  s1.close();

  // 5分後に同じ label で再接続
  nowVal = new Date('2026-06-09T14:05:00').getTime();
  const seen = [];
  const s2 = createSession({ send: () => {}, persona: recordingPersona(seen), now: clock, tickMs: 100000, reunion });
  s2.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  t.mock.timers.tick(800); await flush();

  const g = seen.find((x) => x.s === 'greet.reunion');
  assert.ok(g, 'greet.reunion が選ばれる');
  assert.equal(g.ctx.since, '5分', '間隔が ctx.since に入る');
  assert.equal(g.ctx.label, '居間', 'label も渡る');
  s2.close();
});

test('再会：間隔が短すぎる（部屋移動レベル）なら素の greet', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const reunion = createReunion();
  let nowVal = new Date('2026-06-09T14:00:00').getTime();
  const clock = () => nowVal;
  const s1 = createSession({ send: () => {}, persona: recordingPersona([]), now: clock, tickMs: 100000, reunion });
  s1.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  s1.close();

  nowVal += 30000; // 30秒後（< 1分のしきい値）
  const seen = [];
  const s2 = createSession({ send: () => {}, persona: recordingPersona(seen), now: clock, tickMs: 100000, reunion });
  s2.receive({ type: 'hello', data: { protocol: 0, label: '居間' } });
  t.mock.timers.tick(800); await flush();

  assert.ok(seen.some((x) => x.s === 'greet'), '短い間隔は素の greet');
  assert.ok(!seen.some((x) => x.s === 'greet.reunion'), 'reunion にはしない');
  s2.close();
});

test('protocol 不一致の hello は error を返し、人格は動かさない', () => {
  const sent = [];
  const s = createSession({ send: (m) => sent.push(m), persona: { line: () => ({ text: 'x', mood: '通常' }) } });
  s.receive({ type: 'hello', data: { protocol: 99 } });
  assert.deepEqual(sent, [{ type: 'error', data: { message: 'protocol version mismatch' } }]);
  s.close();
});
