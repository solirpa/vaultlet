// Generate simple placeholder PNG icons (blue rounded square with a white key dot)
// without any image library: raw RGBA → zlib → PNG.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function icon(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // corner radius
  const cx = size / 2;
  const cy = size / 2;
  const keyR = size * 0.2; // key head radius
  const stemW = size * 0.11;
  const inside = (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (cx - r), 0);
    const dy = Math.max(Math.abs(y - cy) - (cy - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  const inKey = (x, y) => {
    const hx = cx - size * 0.12;
    const hy = cy - size * 0.1;
    const d = Math.hypot(x - hx, y - hy);
    if (d <= keyR && d >= keyR * 0.45) return true; // ring
    // stem going down-right
    const sx = x - hx;
    const sy = y - hy;
    const t = (sx + sy) / Math.SQRT2; // along diagonal
    const n = Math.abs(sx - sy) / Math.SQRT2; // distance from diagonal
    if (t > keyR * 0.9 && t < size * 0.42 && n < stemW / 2) return true;
    if (t > size * 0.3 && t < size * 0.36 && n < stemW * 1.3 && sx - sy > 0) return true; // tooth
    return false;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 4x supersampling for soft edges
      let cover = 0;
      let key = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const fx = x + (sx + 0.5) / 2;
          const fy = y + (sy + 0.5) / 2;
          if (inside(fx, fy)) {
            cover++;
            if (inKey(fx, fy)) key++;
          }
        }
      const a = (cover / 4) * 255;
      const k = cover ? key / cover : 0;
      px[i] = Math.round(0x25 * (1 - k) + 255 * k);
      px[i + 1] = Math.round(0x63 * (1 - k) + 255 * k);
      px[i + 2] = Math.round(0xeb * (1 - k) + 255 * k);
      px[i + 3] = Math.round(a);
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [16, 32, 48, 128]) {
  writeFileSync(resolve(outDir, `icon${s}.png`), icon(s));
}
console.log('icons written to', outDir);
