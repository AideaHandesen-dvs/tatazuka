// VRM(=glb) の埋め込みテクスチャだけを ImageMagick で縮小して詰め直す。
// JSON チャンク（VRMC_vrm 等の拡張・マテリアル・ボーン）は一切いじらない＝VRM を壊さない。
// 触るのは bufferView の中身（PNG バイト列）と、ずれた byteOffset/byteLength だけ。
//   node tools/shrink-vrm-textures.mjs <in.vrm> <out.vrm> [cap=512]
// 目的: 展開後 GPU メモリ（モバイルが落ちる原因）を削る。詳細は会話ログ参照。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [inPath, outPath, capArg] = process.argv.slice(2);
const CAP = Number(capArg || 512);
if (!inPath || !outPath) { console.error('usage: <in.vrm> <out.vrm> [cap]'); process.exit(1); }

const f = readFileSync(inPath);
if (f.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
const jsonLen = f.readUInt32LE(12);
const json = JSON.parse(f.slice(20, 20 + jsonLen).toString('utf8'));
const binLen = f.readUInt32LE(20 + jsonLen);
const binStart = 20 + jsonLen + 8;
const bin = f.slice(binStart, binStart + binLen); // buffer[0] の実体

const bvs = json.bufferViews || [];
const imageOfBV = new Map(); // bufferView index -> image
for (const im of (json.images || [])) if (im.bufferView != null) imageOfBV.set(im.bufferView, im);

const align4 = (n) => (n + 3) & ~3;
const chunks = [];        // 各 bufferView の新バイト列（index 順）
const newBin = [];
let cursor = 0;
let saved = 0;

for (let i = 0; i < bvs.length; i++) {
  const bv = bvs[i];
  const start = bv.byteOffset || 0;
  let bytes = bin.slice(start, start + bv.byteLength);
  const im = imageOfBV.get(i);
  if (im) {
    // PNG を ImageMagick で「大きい時だけ」縮小（アスペクト維持）。法線/サムネ含め全部対象。
    const r = spawnSync('magick', ['png:-', '-resize', `${CAP}x${CAP}>`, 'png:-'],
      { input: bytes, maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('magick failed: ' + (r.stderr || '').toString());
    if (r.stdout && r.stdout.length && r.stdout.length < bytes.length) {
      saved += bytes.length - r.stdout.length;
      bytes = r.stdout;
    }
  }
  const off = cursor;
  newBin.push(bytes);
  cursor += bytes.length;
  const pad = align4(cursor) - cursor;
  if (pad) { newBin.push(Buffer.alloc(pad)); cursor += pad; }
  bv.byteOffset = off;
  bv.byteLength = bytes.length;
}

const newBinBuf = Buffer.concat(newBin);
json.buffers[0].byteLength = newBinBuf.length;

// 再シリアライズ
let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
let jp = align4(jsonBuf.length) - jsonBuf.length;
if (jp) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jp, 0x20)]); // JSON は空白詰め
let binBuf = newBinBuf;
let bp = align4(binBuf.length) - binBuf.length;
if (bp) binBuf = Buffer.concat([binBuf, Buffer.alloc(bp)]);          // BIN は0詰め

const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
writeFileSync(outPath, Buffer.concat([head, jh, jsonBuf, bh, binBuf]));

console.log(`cap=${CAP}  in=${(f.length/1048576).toFixed(1)}MB  out=${(total/1048576).toFixed(1)}MB  textureSaved=${(saved/1048576).toFixed(1)}MB`);
