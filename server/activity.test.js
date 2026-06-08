// activity.js の契約テスト（依存ゼロ・node:test）。コマンド実行を注入し、実プロセスは起こさない。
//   node --test server/activity.test.js
//
// 押さえる契約：
//   - 表示サーバが無い（ヘッドレス）なら createActivity は null（作業監視オフ＝PE）
//   - idle のしきい値跨ぎで desk.away / desk.back を一度ずつ
//   - X11（xprintidle）/ Wayland（gdbus Mutter）双方の出力を正しくパース
//   - 複数バックエンド候補は、最初に数値を返したものを採用
//   - どのツールも無ければ縮退（poll は null を返し続ける）

import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity } from './activity.js';

test('表示サーバ無し（DISPLAY/WAYLAND 無し）なら null（作業監視オフ＝PE）', () => {
  assert.equal(createActivity({ env: {} }), null);
  assert.equal(createActivity({ env: { XDG_SESSION_TYPE: 'tty' } }), null);
});

test('idle のしきい値跨ぎで離席→復帰を一度ずつ', async () => {
  let ms = 0;
  const a = createActivity({ backend: async () => ms, awayMs: 1000 });
  ms = 500; assert.equal(await a.poll(), null, 'しきい値未満は無言');
  ms = 1500; assert.deepEqual(await a.poll(), { situation: 'desk.away' });
  ms = 1500; assert.equal(await a.poll(), null, '離席継続は繰り返さない');
  ms = 0; assert.deepEqual(await a.poll(), { situation: 'desk.back' });
  ms = 0; assert.equal(await a.poll(), null, '在席継続は無言');
});

test('X11：xprintidle の "12345\\n" をミリ秒としてパース', async () => {
  const a = createActivity({ env: { DISPLAY: ':0' }, run: async (cmd) => (cmd === 'xprintidle' ? '400000\n' : null) });
  assert.deepEqual(await a.poll(), { situation: 'desk.away' }, '400s idle > 既定5分で離席');
});

test('Wayland：gdbus の "(uint64 400000,)" をパース', async () => {
  const a = createActivity({ env: { XDG_SESSION_TYPE: 'wayland' }, run: async (cmd) => (cmd === 'gdbus' ? '(uint64 400000,)\n' : null) });
  assert.deepEqual(await a.poll(), { situation: 'desk.away' });
});

test('複数候補は最初に数値を返したものを採用（xprintidle 不在→gdbus）', async () => {
  const a = createActivity({
    env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
    run: async (cmd) => (cmd === 'gdbus' ? '(uint64 400000,)' : null), // xprintidle は null
  });
  assert.deepEqual(await a.poll(), { situation: 'desk.away' });
});

test('どのツールも無ければ縮退（poll は null を返し続ける）', async () => {
  const a = createActivity({ env: { DISPLAY: ':0' }, run: async () => null });
  for (let i = 0; i < 8; i++) assert.equal(await a.poll(), null);
});
