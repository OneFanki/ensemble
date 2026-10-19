import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// Generates the Ensemble mark without any image dependency:
// an amber rounded square with three descending bars and one solid dot.
// The same geometry is mirrored by src/renderer/src/components/Logo.vue.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const BG_TOP = [240, 189, 111, 255];
const BG_BOTTOM = [207, 140, 51, 255];
const INK = [26, 19, 5, 255];

function blend(top, bottom, t) {
  return [
    Math.round(top[0] + (bottom[0] - top[0]) * t),
    Math.round(top[1] + (bottom[1] - top[1]) * t),
    Math.round(top[2] + (bottom[2] - top[2]) * t),
    Math.round(top[3] + (bottom[3] - top[3]) * t),
  ];
}

function createCanvas(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
    pixels[index + 3] = color[3];
  };
  return { pixels, set, size };
}

function roundedRect(canvas, x, y, w, h, radius, colorFor) {
  for (let py = Math.floor(y); py < Math.ceil(y + h); py += 1) {
    for (let px = Math.floor(x); px < Math.ceil(x + w); px += 1) {
      const dx = Math.max(x + radius - px, px - (x + w - radius), 0);
      const dy = Math.max(y + radius - py, py - (y + h - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) {
        canvas.set(px, py, colorFor(px, py));
      }
    }
  }
}

function circle(canvas, cx, cy, r, color) {
  for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py += 1) {
    for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px += 1) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) canvas.set(px, py, color);
    }
  }
}

function drawMark(size) {
  const canvas = createCanvas(size);
  const k = size / 32;

  // Amber plate with a subtle vertical gradient.
  roundedRect(
    canvas,
    0,
    0,
    size,
    size,
    8 * k,
    (_px, py) => blend(BG_TOP, BG_BOTTOM, Math.min(1, Math.max(0, py / size))),
  );

  // Three descending bars: the ensemble members.
  const bars = [
    { x: 6.5, y: 8.4, w: 19, h: 3.8 },
    { x: 6.5, y: 14.2, w: 13.5, h: 3.8 },
    { x: 6.5, y: 20, w: 8, h: 3.8 },
  ];
  for (const bar of bars) {
    roundedRect(canvas, bar.x * k, bar.y * k, bar.w * k, bar.h * k, 1.9 * k, () => INK);
  }

  // The focused identity, aligned under the second bar's right edge.
  circle(canvas, 21.6 * k, 21.9 * k, 2.9 * k, INK);
  return canvas;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePng(canvas) {
  const stride = canvas.size * 4 + 1;
  const raw = Buffer.alloc(stride * canvas.size);
  for (let y = 0; y < canvas.size; y += 1) {
    raw[y * stride] = 0;
    canvas.pixels.copy(raw, y * stride + 1, y * canvas.size * 4, (y + 1) * canvas.size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.size, 0);
  ihdr.writeUInt32BE(canvas.size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

mkdirSync("build", { recursive: true });

const pngs = SIZES.map((size) => ({ size, png: encodePng(drawMark(size)) }));
const largest = pngs[pngs.length - 1];
writeFileSync("build/icon.png", largest.png);
writeFileSync("build/icon.ico", encodeIco(pngs.filter((entry) => entry.size <= 256)));
console.log(`icon.png ${largest.png.length} bytes; icon.ico ${pngs.length} sizes`);
