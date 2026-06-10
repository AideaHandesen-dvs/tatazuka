// awaypower.js の契約テスト（依存ゼロ・node:test）。fetch と時計を注入し実 HA・実時計は叩かない。
//   node --test connectors/awaypower.test.js
//
// 押さえる契約（イベント源パターン・connectors/README.md §3-1。合成型＝motion に続く二例目）：
//   - URL/トークン／在席 entity／電力 entity のどれかが欠ければ createAwayPower は null（PE：connector オフ）
//   - 留守（not_home）かつ 電力 ≥ 閾値 が dwell 続いて初めて power.forgotten（一度だけ）。ctx.watts / ctx.awayMin
//   - 帰宅 or 電力低下で解消＝再武装（次の消し忘れでまた言える）
//   - 短い外出・電力スパイクは dwell が弾く（時計が起点を捨てる）
//   - 電力が数値でない／どちらか読めない → 黙る（PE）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAwayPower } from './awaypower.js';

const ENV = {
  TZ_HASS_URL: 'http://ha.local:8123/', TZ_HASS_TOKEN: 'tok',
  TZ_HASS_PERSON: 'person.me', TZ_HASS_POWER: 'sensor.home_power',
};

// 在席と電力を別々に返す fetch（URL の entity でどちらかを判定）。各々 state の列を順に吐く。
function hassFetch(occStates, powStates) {
  let oi = 0, pi = 0;
  const fn = async (url) => {
    const isPow = url.includes('sensor.home_power');
    const arr = isPow ? powStates : occStates;
    const i = isPow ? pi++ : oi++;
    const s = arr[Math.min(i, arr.length - 1)];
    if (s === '!throw') throw new Error('down');
    if (s === '!ok') return { ok: false, async json() { return {}; } };
    return { ok: true, async json() { return { entity_id: isPow ? 'sensor.home_power' : 'person.me', state: String(s), attributes: {} }; } };
  };
  return fn;
}
// 進む時計（呼ぶたびに step 秒進む）。poll の回数で滞留時間を作る。
function clock(startS, stepS) {
  let t = startS * 1000;
  return () => { const v = t; t += stepS * 1000; return v; };
}

test('在席 entity／電力 entity／URL/トークンが欠ければ null（PE：connector オフ）', () => {
  const f = hassFetch(['not_home'], [500]);
  assert.equal(createAwayPower({ fetch: f, env: {} }), null);
  assert.equal(createAwayPower({ fetch: f, env: { ...ENV, TZ_HASS_PERSON: '' } }), null); // 在席欠け
  assert.equal(createAwayPower({ fetch: f, env: { ...ENV, TZ_HASS_POWER: '' } }), null);  // 電力欠け
  assert.equal(createAwayPower({ fetch: f, env: ENV, now: 123 }), null);                   // 時計が関数でない
  assert.ok(createAwayPower({ fetch: f, env: ENV, now: () => 0 }));
});

test('留守 × 高電力が dwell 続いたら power.forgotten（一度だけ・ctx.watts/awayMin）', async () => {
  // 5 分刻みで poll。dwell=900s(15分)。留守＆500W が続く → 15 分で確定。
  const src = createAwayPower({
    fetch: hassFetch(['not_home'], [500]), env: ENV, now: clock(0, 300), dwellS: 900, high: 300,
  });
  assert.equal(await src.poll(), null); // t=0    起点を刻む
  assert.equal(await src.poll(), null); // t=300  5分（<15）
  assert.equal(await src.poll(), null); // t=600  10分（<15）
  assert.deepEqual(await src.poll(), { situation: 'power.forgotten', ctx: { watts: 500, awayMin: 15 } }); // t=900 確定
  assert.equal(await src.poll(), null); // t=1200 既に警告済み → 黙る（鳴りっぱなしにしない）
});

test('在宅中は高電力でも黙る（留守が条件）', async () => {
  const src = createAwayPower({
    fetch: hassFetch(['home'], [900]), env: ENV, now: clock(0, 1000), dwellS: 900, high: 300,
  });
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null); // 在宅なら何分高くても消し忘れではない
});

test('留守でも電力が閾値未満なら黙る', async () => {
  const src = createAwayPower({
    fetch: hassFetch(['not_home'], [150]), env: ENV, now: clock(0, 1000), dwellS: 900, high: 300,
  });
  assert.equal(await src.poll(), null);
  assert.equal(await src.poll(), null); // 留守でも 150W（冷蔵庫待機）は警告しない
});

test('短い外出は dwell が弾く（途中で帰宅すると起点を捨てる）', async () => {
  // 留守→留守→帰宅→留守…と挟まる。帰宅でリセットされ、dwell を満たさない。
  const src = createAwayPower({
    fetch: hassFetch(['not_home', 'not_home', 'home', 'not_home', 'not_home'], [500]),
    env: ENV, now: clock(0, 300), dwellS: 900, high: 300,
  });
  assert.equal(await src.poll(), null); // t=0    起点
  assert.equal(await src.poll(), null); // t=300  5分
  assert.equal(await src.poll(), null); // t=600  帰宅 → 解消・再武装
  assert.equal(await src.poll(), null); // t=900  また留守 → 起点を打ち直し（0分扱い）
  assert.equal(await src.poll(), null); // t=1200 まだ起点から 300s（<900）→ 黙る
});

test('電力スパイク（一瞬だけ高い）は dwell が弾く', async () => {
  const src = createAwayPower({
    fetch: hassFetch(['not_home'], [500, 100, 500, 500]), env: ENV, now: clock(0, 300), dwellS: 900, high: 300,
  });
  assert.equal(await src.poll(), null); // t=0    高い → 起点
  assert.equal(await src.poll(), null); // t=300  100W に落ちた → 解消・再武装
  assert.equal(await src.poll(), null); // t=600  また高い → 起点打ち直し
  assert.equal(await src.poll(), null); // t=900  起点から 300s（<900）→ 黙る
});

test('解消後にまた留守×高電力が続けば再び鳴る（再武装）', async () => {
  // dwell=600s・5分刻み。t=0 起点 → t=600 で一発目。帰宅で解消 → 再び留守で起点打ち直し → 二発目。
  const src = createAwayPower({
    fetch: hassFetch(['not_home', 'not_home', 'not_home', 'home', 'not_home', 'not_home', 'not_home'], [500]),
    env: ENV, now: clock(0, 300), dwellS: 600, high: 300,
  });
  assert.equal(await src.poll(), null); // t=0    起点
  assert.equal(await src.poll(), null); // t=300  5分（<10）
  assert.deepEqual(await src.poll(), { situation: 'power.forgotten', ctx: { watts: 500, awayMin: 10 } }); // t=600 一発目
  assert.equal(await src.poll(), null); // t=900  帰宅 → 解消・再武装
  assert.equal(await src.poll(), null); // t=1200 また留守 → 起点打ち直し
  assert.equal(await src.poll(), null); // t=1500 起点から 300s（<600）
  assert.deepEqual(await src.poll(), { situation: 'power.forgotten', ctx: { watts: 500, awayMin: 10 } }); // t=1800 二発目
});

test('電力が数値でない／読めなければ黙る（PE）', async () => {
  const src = createAwayPower({
    fetch: hassFetch(['not_home'], ['unavailable', '!ok', '!throw']), env: ENV, now: clock(0, 1000), dwellS: 0, high: 300,
  });
  assert.equal(await src.poll(), null); // "unavailable" → NaN → 黙る
  assert.equal(await src.poll(), null); // 電力 !ok → read null → 黙る
  assert.equal(await src.poll(), null); // 電力 !throw → read null → 黙る
});
