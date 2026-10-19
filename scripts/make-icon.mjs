import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// Generates the Ensemble app icon without any image dependency: a dark rounded
// square with an amber "stage" mark made of three bars plus one solid dot.
const SIZE = 256;

const palette = {
  bg: [11, 13, 16, 255],
  bgEdge: [26, 31, 38, 255],
  amber: [224, 164, 78, 255],
  amberSoft: [224, 164, 78, 150],
  transparent: [0, 0, 0, 0],
};

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

function roundedRect(canvas, x, y, w, h, radius, color) {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      const dx = Math.max(x + radius - px, px - (x + w - radius), 0);
      const dy = Math.max(y + radius - py, py - (y + h - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) {
        canvas.set(px, py, color);
      }
    }
  }
}

function circle(canvas, cx, cy, r, color) {
  for (let py = cy - r; py <= cy + r; py += 1) {
    for (let px = cx - r; px <= cx + r; px += 1) {
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= r * r) canvas.set(px, py, color);
    }
  }
}

function makeIcon() {
  const canvas = createCanvas(SIZE);
  roundedRect(canvas, 8, 8, SIZE - 16, SIZE - 16, 56, palette.bgEdge);
  roundedRect(canvas, 12, 12, SIZE - 24, SIZE - 24, 52, palette.bg);

  // Three stage bars of decreasing width: the ensemble members.
  const bars = [
    { x: 58, y: 78, w: 140, h: 22 },
    { x: 58, y: 116, w: 104, h: 22 },
    { x: 58, y: 154, w: 68, h: 22 },
  ];
  for (const bar of bars) {
    roundedRect(canvas, bar.x, bar.y, bar.w, bar.h, 11, palette.amberSoft);
  }

  // The focused identity.
  circle(canvas, 192, 165, 22, palette.amber);
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
  const raw = Buffer.alloc((canvas.size * 4 + 1) * canvas.size);
  for (let y = 0; y < canvas.size; y += 1) {
    raw[y * (canvas.size * 4 + 1)] = 0;
    canvas.pixels.copy(raw, y * (canvas.size * 4 + 1) + 1, y * canvas.size * 4, (y + 1) * canvas.size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.size, 0);
  ihdr.writeUInt32BE(canvas.size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

const canvas = makeIcon();
const png = encodePng(canvas);
mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", png);
writeFileSync("build/icon.ico", encodeIco(png));
// Linux/macOS packaging reads icon.png; Windows reads icon.ico.
console.log(`icon.png ${png.length} bytes, icon.ico ${png.length + 22} bytes`);
