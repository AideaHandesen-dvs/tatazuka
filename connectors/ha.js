// Home Assistant REST の最小リーダ（connectors 共有の小部品・依存ゼロ・IO なし＝fetch を注入）。
// run.js（CLI 実行）/ hysteresis.js（判定）と同列の「複数 connector が分け合う純 IO 部品」。HA を入力に
// 使う connector が二本（home-assistant＝在席／humidity＝室内湿度）になったので、認証・URL 組み立て・
// PE 縮退という**同じ fiddly な一点**を一箇所に寄せる（trash 等で CLI を run.js に集約したのと同じ流儀）。
//
//   GET /api/states/<entity> をトークン認証（Bearer）で読み、entity の状態オブジェクト（{state, attributes,…}）
//   を返す。読めなければ null（PE：黙る）。state が文字列でなければ null。
//
// 接続先・認証・対象は env か opts で：base=TZ_HASS_URL（末尾スラッシュ正規化）／token=TZ_HASS_TOKEN（共有）／
// entity=opts.entity か e[entityEnvKey]（在席は TZ_HASS_PERSON・湿度は TZ_HASS_HUMIDITY）。fetch は opts.fetch
// で差し替え可能（テストで実 HA を叩かない）。前提が一つでも欠ければ **null を返す**＝呼び手はそれで PE 縮退する。

export function makeHassReader(opts, entityEnvKey) {
  opts = opts || {};
  const e = opts.env || process.env;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const base = (opts.url || e.TZ_HASS_URL || '').replace(/\/+$/, ''); // 末尾スラッシュを正規化
  const token = opts.token || e.TZ_HASS_TOKEN;
  const entity = opts.entity || (entityEnvKey ? e[entityEnvKey] : undefined);

  // PE：接続先・認証・対象・fetch のどれかが欠ければ「リーダ無し」＝呼び手は connector オフにする
  if (!base || !token || !entity || typeof fetchImpl !== 'function') return null;

  return async function read() {
    try {
      const r = await fetchImpl(`${base}/api/states/${encodeURIComponent(entity)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r || !r.ok) return null;
      const j = await r.json();
      return j && typeof j.state === 'string' ? j : null;
    } catch {
      return null; // HA 不達 → 黙る
    }
  };
}
