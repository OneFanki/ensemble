import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// Generates the Ensemble mark without any image dependency:
// an amber rounded square with three descending bars and one solid dot.
// The same geometry is mirrored by src/renderer/src/components/Logo.vue.
//
// Every size is drawn at 4x and box-filtered down. Drawing straight at 16/24/32
// produced hard, aliased edges that Windows then rescaled again — the reason the
// taskbar icon looked blurry next to sharper icons.
const SUPERSAMPLE = 4;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const PNG_SIZE = 1024;

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

  // Bars are slightly thicker than the renderer logo so they survive 16px.
  const bars = [
    { x: 6.4, y: 8.2, w: 19.2, h: 4.2 },
    { x: 6.4, y: 14.2, w: 13.8, h: 4.2 },
    { x: 6.4, y: 20.2, w: 8.2, h: 4.2 },
  ];
  for (const bar of bars) {
    roundedRect(canvas, bar.x * k, bar.y * k, bar.w * k, bar.h * k, 2.1 * k, () => INK);
  }

  // The focused identity, aligned under the second bar's right edge.
  circle(canvas, 21.6 * k, 22.3 * k, 3.05 * k, INK);
  return canvas;
}

/** Averages source pixels; colors are alpha-weighted so edges keep their hue. */
function downsample(source, size) {
  const target = createCanvas(size);
  const factor = source.size / size;
  const count = factor * factor;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < factor; sy += 1) {
        for (let sx = 0; sx < factor; sx += 1) {
          const index = ((y * factor + sy) * source.size + (x * factor + sx)) * 4;
          const alpha = source.pixels[index + 3];
          const weight = alpha / 255;
          r += source.pixels[index] * weight;
          g += source.pixels[index + 1] * weight;
          b += source.pixels[index + 2] * weight;
          a += alpha;
        }
      }
      const alpha = Math.round(a / count);
      if (alpha === 0) {
        target.set(x, y, [0, 0, 0, 0]);
        continue;
      }
      const normalizer = a / 255;
      target.set(x, y, [
        Math.round(r / normalizer),
        Math.round(g / normalizer),
        Math.round(b / normalizer),
        alpha,
      ]);
    }
  }
  return target;
}

function render(size) {
  return downsample(drawMark(size * SUPERSAMPLE), size);
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

const icoEntries = ICO_SIZES.map((size) => ({ size, png: encodePng(render(size)) }));
const large = encodePng(render(PNG_SIZE));
writeFileSync("build/icon.png", large);
writeFileSync("build/icon.ico", encodeIco(icoEntries));
// Windows trays render at 16px with 150% scaling often landing on 24px; 32 is a
// good middle ground that Electron downsamples cleanly.
const tray = encodePng(render(32));
writeFileSync("build/tray.png", tray);
console.log(
  `icon.png ${PNG_SIZE}px (${large.length} bytes); icon.ico ${ICO_SIZES.join("/")}px; tray.png 32px`,
);
