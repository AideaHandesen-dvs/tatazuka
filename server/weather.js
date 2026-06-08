// 天気イベント源。behavior.js に「いつ喋るか」の材料として situation を渡す。
//   weather.js  … 取得（Open-Meteo・キー不要）＋変化検知。トランスポート/人格を知らない
//   behavior.js … いつ天気に触れるか（30 分間隔の poll、朝の一言）
//   persona.*   … 何を喋るか（weather.* タグ → 台詞。LLM は ctx.weather を織り込む）
//
// 設計：
//   - protocol は不変。天気は say（situation タグ）に乗るだけ＝client は触らない。
//   - PE：場所が無い／API が落ちている／都市が解決できない → 天気イベントは出ない。佇かは喋る。
//   - 依存ゼロ：グローバル fetch のみ（SDK なし）。場所は TZ_CITY を geocoding で解決、
//     TZ_LAT/TZ_LON があればそれを直接使う（geocoding を飛ばす）。
//   - Open-Meteo：キー不要・無料。現在値（気温/WMO天気コード/昼夜）だけ取る。

const HOT_C = 30;  // この気温以上で「暑い」を一度言う
const COLD_C = 4;  // この気温以下で「寒い」を一度言う

// WMO weather code → 日本語の空模様（LLM/ルール双方の ctx に入れる）
const WMO = {
  0: '快晴', 1: '晴れ', 2: '薄曇り', 3: '曇り',
  45: '霧', 48: '霧',
  51: '霧雨', 53: '霧雨', 55: '霧雨', 56: '凍える霧雨', 57: '凍える霧雨',
  61: '雨', 63: '雨', 65: '強い雨', 66: '凍雨', 67: '凍雨',
  71: '雪', 73: '雪', 75: '大雪', 77: '霧雪',
  80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨',
  85: 'にわか雪', 86: 'にわか雪',
  95: '雷雨', 96: '雷雨（雹）', 99: '雷雨（雹）',
};
const descOf = (code) => WMO[code] || '不明な空模様';

// 降水の大分類。変化検知（降り始め/上がり）はこの category の遷移で見る
function categoryOf(code) {
  if (code >= 95) return 'thunder';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  return 'dry';
}

// env を見て天気源を作る。場所が無ければ null（＝天気オフ）。fetchImpl はテスト注入用
export function createWeather(opts) {
  opts = opts || {};
  const e = opts.env || process.env;
  const fetch_ = opts.fetchImpl || globalThis.fetch;
  const hasLatLon = e.TZ_LAT && e.TZ_LON;
  const city = e.TZ_CITY;
  if (!hasLatLon && !city) return null; // 場所未設定 → 天気イベントなし（PE）

  let loc = hasLatLon ? { lat: Number(e.TZ_LAT), lon: Number(e.TZ_LON), name: city || null } : null;
  let geoFailed = false;
  let last = null; // 前回の { cat, hot, cold }（変化検知の基準）

  // TZ_CITY を一度だけ lat/lon に解決（以後キャッシュ）。失敗したら以後あきらめる
  async function resolveLoc() {
    if (loc || geoFailed) return loc;
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ja&format=json`;
      const r = await fetch_(url);
      const j = await r.json();
      const hit = j && Array.isArray(j.results) && j.results[0];
      if (hit) loc = { lat: hit.latitude, lon: hit.longitude, name: hit.name || city };
      else geoFailed = true;
    } catch {
      geoFailed = true;
    }
    if (geoFailed) console.warn(`[weather] 都市 "${city}" を解決できず、天気オフ`);
    return loc;
  }

  // 現在の天気を取る。{ tempC, code, desc, city, isDay } か、取れなければ null
  async function fetchCurrent() {
    const l = await resolveLoc();
    if (!l) return null;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lon}&current=temperature_2m,weather_code,is_day`;
      const r = await fetch_(url);
      if (!r.ok) return null;
      const j = await r.json();
      const c = j && j.current;
      if (!c || typeof c.temperature_2m !== 'number') return null;
      return { tempC: c.temperature_2m, code: c.weather_code, desc: descOf(c.weather_code), city: l.name, isDay: c.is_day === 1 };
    } catch {
      return null;
    }
  }

  const ctxOf = (cur) => ({ weather: { tempC: cur.tempC, desc: cur.desc, city: cur.city, isDay: cur.isDay } });

  return {
    // 変化を見て situation を返す（無変化・取得失敗なら null）。30 分間隔で呼ぶ想定。
    async poll() {
      const cur = await fetchCurrent();
      if (!cur) return null;
      const cat = categoryOf(cur.code);
      const hot = cur.tempC >= HOT_C;
      const cold = cur.tempC <= COLD_C;
      const prev = last;
      last = { cat, hot, cold };

      // 降水の遷移を最優先（降り始め/上がり・雪・雷）。初回(prev=null)は「始まった」と言えない
      let situation = null;
      if (prev) {
        if (cat === 'thunder' && prev.cat !== 'thunder') situation = 'weather.thunder';
        else if (cat === 'snow' && prev.cat !== 'snow') situation = 'weather.snow';
        else if (cat === 'rain' && prev.cat !== 'rain') situation = 'weather.rain.start';
        else if (cat === 'dry' && prev.cat === 'rain') situation = 'weather.rain.stop';
      }
      // 降水イベントが無いときだけ気温の極端を一度（極端帯に入った瞬間）
      if (!situation) {
        if (hot && !(prev && prev.hot)) situation = 'weather.hot';
        else if (cold && !(prev && prev.cold)) situation = 'weather.cold';
      }
      return situation ? { situation, ctx: ctxOf(cur) } : null;
    },

    // 朝の一言用スナップショット（変化に関係なく今の空模様）。取れなければ null
    async current() {
      const cur = await fetchCurrent();
      return cur ? { situation: 'weather.morning', ctx: ctxOf(cur) } : null;
    },
  };
}
