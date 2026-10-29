// public/icons/icon.svg 와 같은 모양의 PNG 아이콘을 만든다 (외부 라이브러리 없이)
// 실행: npm run icons -w worker
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/icons/', import.meta.url));

const BG = [0x4f, 0x5b, 0xff];
const WHITE = [0xff, 0xff, 0xff];
const FOLD = [0xc7, 0xcc, 0xff];
const LINE = [0x4f, 0x5b, 0xff];

function inRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** 64x64 좌표계의 한 점 색. bg=false 면 바탕 없이 문서만 (maskable 은 바탕을 꽉 채움) */
function color(x, y, rounded) {
  // 종이: (17,12)~(47,54), 오른쪽 위 9 만큼 접힘
  const inPaper = inRoundRect(x, y, 17, 12, 30, 42, 0) && !(x > 38 && y < 21 && x - 38 > y - 12);
  if (inPaper) {
    if (x >= 38 && y <= 21 && x - 38 <= y - 12) return FOLD;
    for (const [lx, ly, lw] of [[23, 28, 18], [23, 35, 18], [23, 42, 12]]) {
      if (inRoundRect(x, y, lx, ly, lw, 3, 0)) return LINE;
    }
    return WHITE;
  }
  if (!rounded || inRoundRect(x, y, 0, 0, 64, 64, 0)) return BG;
  return null; // 투명
}

function render(size, { rounded, scale }) {
  const SS = 4; // 안티앨리어싱
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // scale < 1 이면 문서를 가운데로 줄여 maskable 안전 영역 안에 둔다
          const u = ((px + (sx + 0.5) / SS) / size) * 64;
          const v = ((py + (sy + 0.5) / SS) / size) * 64;
          const x = 32 + (u - 32) / scale;
          const y = 32 + (v - 32) / scale;
          const c = color(x, y, rounded) ?? (rounded ? null : BG);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const o = 1 + px * 4;
      row[o] = alpha ? Math.round(r / (a / 255)) : 0;
      row[o + 1] = alpha ? Math.round(g / (a / 255)) : 0;
      row[o + 2] = alpha ? Math.round(b / (a / 255)) : 0;
      row[o + 3] = Math.round(alpha);
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(OUT + 'icon-192.png', render(192, { rounded: true, scale: 1 }));
writeFileSync(OUT + 'icon-512.png', render(512, { rounded: true, scale: 1 }));
writeFileSync(OUT + 'icon-maskable-512.png', render(512, { rounded: false, scale: 0.78 }));
console.log('icons written to', OUT);
