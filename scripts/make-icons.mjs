// Renders ROG's icon (a black core inside a thin antique-gold ring) into
// resources/icons as PNG (tray + app) and ICO (installer), using only zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const out = join(import.meta.dirname, '..', 'resources', 'icons');
mkdirSync(out, { recursive: true });

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const S = 4; // supersampling per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const dx = (x + (sx + 0.5) / S - 0.5 - c) / (size / 2);
          const dy = (y + (sy + 0.5) / S - 0.5 - c) / (size / 2);
          const d = Math.hypot(dx, dy);
          const ang = Math.atan2(dy, dx);
          // Doppler-like brightening on one side of the ring.
          const beam = 0.55 + 0.45 * Math.cos(ang + 2.4);
          const ringW = size < 40 ? 0.13 : 0.075;
          const ring = Math.max(0, 1 - Math.abs(d - 0.74) / ringW);
          const halo = Math.max(0, 1 - Math.abs(d - 0.74) / 0.28) * 0.25;
          const core = d < 0.6 ? 1 : 0;
          const ra = Math.min(1, ring * beam + halo * beam);
          // gold: #c9a24a -> champagne highlights #f1d9a0
          const gr = 184 + 48 * ring * beam, gg = 140 + 52 * ring * beam, gb = 58 + 50 * ring * beam;
          if (core) { r += 6; g += 5; b += 4; a += 1; }
          else if (ra > 0) { r += gr * ra; g += gg * ra; b += gb * ra; a += ra; }
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      const alpha = a / n;
      px[i] = alpha ? Math.min(255, r / a) : 0;
      px[i + 1] = alpha ? Math.min(255, g / a) : 0;
      px[i + 2] = alpha ? Math.min(255, b / a) : 0;
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const px = render(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8); e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...images]);
}

writeFileSync(join(out, 'tray.png'), png(16));
writeFileSync(join(out, 'tray@2x.png'), png(32));
writeFileSync(join(out, 'icon.png'), png(256));
writeFileSync(join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
console.log('icons written to', out);
