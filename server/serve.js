// 佇か server — HTTPS 静的配信 ＋ WebSocket（protocol v0）。人格の中身は M4 で behavior.js を育てる。
// client/ を配信する：オリジン一つ・HTTPS 終端一箇所、wss も同一ホスト（README §8 / protocol §1）。依存ゼロ。
//
//   node server/serve.js          → https://<このマシン>:8443/  ＋ wss://<このマシン>:8443/ws
//   PORT=9000 node server/serve.js
//
// 証明書は mkcert 製（server/certs/、git 管理外）。再生成手順は server/README.md。

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWS } from './ws.js';
import { createSession } from './behavior.js';
import { createHub } from './hub.js';
import { createPersona } from './persona.js';
import { createLLMPersona } from './persona-llm.js';
import { createWeather } from './weather.js';
import { createActivity } from './activity.js';
import { createHomeAssistant } from '../connectors/home-assistant.js';
import { createHumidity } from '../connectors/humidity.js';
import { createCo2 } from '../connectors/co2.js';
import { createRoomTemp } from '../connectors/roomtemp.js';
import { createIlluminance } from '../connectors/illuminance.js';
import { createOpening } from '../connectors/opening.js';
import { createMotion } from '../connectors/motion.js';
import { createPower } from '../connectors/power.js';
import { createGit } from '../connectors/git.js';
import { createDisk } from '../connectors/disk.js';
import { createMemory } from '../connectors/memory.js';
import { createNet } from '../connectors/net.js';
import { createNic } from '../connectors/nic.js';
import { createBattery } from '../connectors/battery.js';
import { createThermal } from '../connectors/thermal.js';
import { createDownload } from '../connectors/download.js';
import { createTrash } from '../connectors/trash.js';
import { createResume } from '../connectors/resume.js';
import { createUptime } from '../connectors/uptime.js';
import { createReunion } from './reunion.js';

// TZ_LLM が設定されていれば LLM persona に格上げ（無ければ従来のルールベース）。
// どちらも line() の顔が同じなので behavior.js からは区別がつかない。
const makePersona = process.env.TZ_LLM ? createLLMPersona : createPersona;
// TZ_CITY または TZ_LAT/TZ_LON があれば天気イベント源を足す（無ければ null＝天気に触れない）。
// 変化検知の状態を端末ごとに独立させたいので、接続のたびに作る（各端末が天気に反応する）。
const weatherOn = !!(process.env.TZ_CITY || (process.env.TZ_LAT && process.env.TZ_LON));
// 作業監視（離席/復帰）。表示サーバ（X11/Wayland）があれば host の idle を読む。接続ごとに作る
// （変化検知の状態を端末ごとに独立）。ヘッドレス/ツール無しなら createActivity は null（PE）。
const activityOn = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
// connectors（入力）。Home Assistant が在宅/外出を投げる。URL/トークン/対象 entity が揃えば有効。
// 接続ごとに作る（変化検知の状態を端末ごとに独立）。揃わなければ createHomeAssistant は null（PE）。
const hassOn = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_PERSON);
// Humidity（HA の室内湿度センサ＝快適帯）。HA が唯一くれる「部屋の中」。URL/トークン＋対象 sensor が揃えば有効。
// 接続ごとに作る（快適帯の状態を端末ごとに独立）。揃わなければ createHumidity は null（PE）。README §7-1。
const humidityOn = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_HUMIDITY);
// CO2（HA の室内 CO2 センサ＝こもり検知）。湿度と並ぶ HA が唯一くれる「部屋の中」の二本目。URL/トークン＋対象 sensor で有効。
// 接続ごとに作る（しきい値の状態を端末ごとに独立）。揃わなければ createCo2 は null（PE）。README §7-1。
const co2On = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_CO2);
// RoomTemp（HA の室温センサ＝快適帯）。湿度・CO2 と並ぶ「部屋の中」三本目。URL/トークン＋対象 sensor で有効。
// 接続ごとに作る（快適帯の状態を端末ごとに独立）。揃わなければ createRoomTemp は null（PE）。README §7-1。
const roomtempOn = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_TEMP);
// Illuminance（HA の照度センサ＝暗くなったら「電気つけたら」）。「部屋の中」四本目。片側 below=true。URL/トークン＋対象 sensor で有効。
const illuminanceOn = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_LUX);
// Opening（HA の binary_sensor＝ドア/窓の開閉）。二値遷移＝在席と同型。URL/トークン＋対象 entity で有効。
// いずれも接続ごとに作る（遷移/しきい値の状態を端末ごとに独立）。揃わなければ null（PE）。README §7-1。
const openingOn = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_OPENING);
// Motion（HA の人感センサ＝部屋の占有/空き）。二値＋滞留タイムアウト。URL/トークン＋対象 entity で有効。
const motionOn = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_MOTION);
// Power（HA の電力センサ＝消費電力の high↔ok）。片側 below=false。URL/トークン＋対象 sensor で有効。
const powerOn = !!(process.env.TZ_HASS_URL && process.env.TZ_HASS_TOKEN && process.env.TZ_HASS_POWER);
// Git プローブ（未コミットの clean↔dirty）。soft 委譲の第一実装の readonly プローブ（README §7-1）。
// TZ_GIT_REPO があれば有効。接続ごとに作る（変化検知の状態を端末ごとに独立）。
const gitOn = !!process.env.TZ_GIT_REPO;
// Disk プローブ（空き容量の low↔ok）。soft 委譲の readonly プローブ（しきい値型・README §7-1）。
// TZ_DISK_PATH があれば有効。接続ごとに作る（変化検知の状態を端末ごとに独立）。
const diskOn = !!process.env.TZ_DISK_PATH;
// Memory プローブ（空きメモリの low↔ok）。デバウンス付きしきい値（README §7-1）。TZ_MEM=1 で有効。
const memOn = !!process.env.TZ_MEM;
// Net（オンライン/オフライン・二値）と NIC（通信レート・レート型）。TZ_NET=1 / TZ_NIC=1 で有効。
const netOn = !!process.env.TZ_NET;
const nicOn = !!process.env.TZ_NIC;
// Battery プローブ（残量の low↔ok＋満充電ケア・ゲート付きしきい値）。ノート利用者全員に効く readonly（README §7-1）。TZ_BATTERY=1 で有効。
const batteryOn = !!process.env.TZ_BATTERY;
// Thermal プローブ（温度の hot↔ok）。机に座る人全員に効く体感（README §7-1）。TZ_TEMP=1 で有効。
const tempOn = !!process.env.TZ_TEMP;
// Download プローブ（DL 完了＝エッジ型）。「何か来たぞ」。README §7-1。TZ_DOWNLOAD=1 で有効。
const downloadOn = !!process.env.TZ_DOWNLOAD;
// Trash プローブ（ゴミ箱の full↔ok）。掃除を促す家事ナッジ。README §7-1。TZ_TRASH=1 で有効。
const trashOn = !!process.env.TZ_TRASH;
// Resume プローブ（スリープ復帰＝「おかえり」）。poll 間隔の空白で検知・時計だけ。README §7-1。TZ_RESUME=1 で有効。
const resumeOn = !!process.env.TZ_RESUME;
// Uptime プローブ（連続稼働が長い＝「そろそろ再起動したら?」）。os.uptime() で検知・全OS正規化済み。resume の双子。README §7-1。TZ_UPTIME=1 で有効。
const uptimeOn = !!process.env.TZ_UPTIME;
const makeSources = () => [
  createHomeAssistant(), createHumidity(), createCo2(), createRoomTemp(), createIlluminance(), createOpening(),
  createMotion(), createPower(),
  createGit(), createDisk(), createMemory(), createNet(), createNic(),
  createBattery(), createThermal(), createDownload(), createTrash(), createResume(), createUptime(),
].filter(Boolean); // 将来 connector が増えたらここに足す

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../client');
const CERTS = path.join(here, 'certs');
const PORT = Number(process.env.PORT ?? 8443);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

const server = https.createServer(
  {
    cert: fs.readFileSync(path.join(CERTS, 'cert.pem')),
    key: fs.readFileSync(path.join(CERTS, 'key.pem')),
  },
  (req, res) => {
    const url = new URL(req.url, 'https://_');
    let file = path.normalize(path.join(CLIENT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(CLIENT)) { res.writeHead(403).end(); return; } // パストラバーサル拒否
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';

    // HEAD（app.js の VRM 存在チェック等）：本体を読まず stat だけで応答
    if (req.method === 'HEAD') {
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': type, 'content-length': st.size });
        res.end();
      });
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    });
  },
);

// ---- WebSocket（protocol v0）。同一オリジンの /ws に張る ----
// 仲介ハブが複数端末（部屋）を束ね、佇かを「一度に一箇所」に居させる（protocol §6-1）。
// 接続ごとに脳（createSession）を作るが、佇かが居る部屋だけが喋る。TZ_BROADCAST=1 で全部屋に居る退化形。
const broadcast = process.env.TZ_BROADCAST === '1';
const reunion = createReunion(); // 接続をまたぐ「再会の記憶」。プロセスに一つ・全部屋で共有（§6-3）
const hub = createHub({
  broadcast,
  makeSession: (opts) => createSession({
    persona: makePersona(), weather: createWeather(), activity: createActivity(), sources: makeSources(), reunion, ...opts,
  }),
});
attachWS(server, '/ws', (sock) => {
  const room = hub.connect((obj) => sock.send(obj));
  sock.onMessage((msg) => room.receive(msg));
  sock.onClose(() => room.close());
});

server.listen(PORT, () => {
  console.log(`佇か → https://localhost:${PORT}/  （wss://localhost:${PORT}/ws）`);
  console.log(
    process.env.TZ_LLM
      ? `人格: LLM persona（${process.env.TZ_LLM} / ${process.env.TZ_CHARACTER || 'tatazuka'}）`
      : '人格: ルールベース',
  );
  console.log(weatherOn ? `天気: on（${process.env.TZ_CITY || `${process.env.TZ_LAT},${process.env.TZ_LON}`}）` : '天気: off');
  console.log(activityOn ? '作業監視: 表示サーバあり（idle ツールが入っていれば離席/復帰を拾う）' : '作業監視: off（ヘッドレス）');
  const conn = [
    hassOn && `Home Assistant（${process.env.TZ_HASS_PERSON}）`,
    humidityOn && `humidity（${process.env.TZ_HASS_HUMIDITY}）`,
    co2On && `co2（${process.env.TZ_HASS_CO2}）`,
    roomtempOn && `roomtemp（${process.env.TZ_HASS_TEMP}）`,
    illuminanceOn && `illuminance（${process.env.TZ_HASS_LUX}）`,
    openingOn && `opening（${process.env.TZ_HASS_OPENING}）`,
    motionOn && `motion（${process.env.TZ_HASS_MOTION}）`,
    powerOn && `power（${process.env.TZ_HASS_POWER}）`,
    gitOn && `git（${process.env.TZ_GIT_REPO}）`,
    diskOn && `disk（${process.env.TZ_DISK_PATH}）`,
    memOn && 'memory',
    netOn && 'net',
    nicOn && 'nic',
    batteryOn && 'battery',
    tempOn && 'thermal',
    downloadOn && 'download',
    trashOn && 'trash',
    resumeOn && 'resume',
    uptimeOn && 'uptime',
  ].filter(Boolean);
  console.log(conn.length ? `connectors: ${conn.join(' / ')}` : 'connectors: off');
  console.log(broadcast ? 'presence: broadcast（全部屋に居る・デバッグ）' : 'presence: 一度に一箇所（hub ルーティング）');
});
