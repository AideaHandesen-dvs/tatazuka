// reunion.js の契約テスト（依存ゼロ・node:test）。
//   node --test server/reunion.test.js
//
// 押さえる契約（protocol §6-3）：
//   - 初見の label は seen=null。mark した label は最後の時刻を返す（接続をまたぐ記憶）
//   - 未命名（空 label）は覚えない
//   - humanizeGap は分→「N分」、時間→「N時間」、日→「N日」

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReunion, humanizeGap } from './reunion.js';

test('初見は null、mark した label は時刻を返す', () => {
  const r = createReunion();
  assert.equal(r.seen('居間'), null);
  r.mark('居間', 1000);
  assert.equal(r.seen('居間'), 1000);
  r.mark('居間', 5000); // 上書き（最後に見た時刻）
  assert.equal(r.seen('居間'), 5000);
  assert.equal(r.seen('寝室'), null); // 別 label は独立
});

test('未命名（空 label）は覚えない', () => {
  const r = createReunion();
  r.mark('', 1000);
  r.mark(null, 1000);
  assert.equal(r.seen(''), null);
  assert.equal(r.seen(null), null);
});

test('humanizeGap：分・時間・日の境界', () => {
  assert.equal(humanizeGap(3 * 60000), '3分');
  assert.equal(humanizeGap(59 * 60000), '59分');
  assert.equal(humanizeGap(60 * 60000), '1時間');
  assert.equal(humanizeGap(150 * 60000), '2時間');
  assert.equal(humanizeGap(24 * 60 * 60000), '1日');
  assert.equal(humanizeGap(72 * 60 * 60000), '3日');
});
