import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// Generates the Ensemble mark without any image dependency: a dark plate with a
// deck of three window frames, the front one filled in amber.
//
// The plate is dark on purpose. An amber plate with a dark glyph is the visual
// language of a generic system placeholder — whatever is drawn inside reads as a
// stock icon. Inverting it (dark surface, amber marks) matches the app's own dark
// UI and gives the shape room to carry the identity.
// The same geometry is mirrored by src/renderer/src/components/Logo.vue.
//
// Every size is drawn at 4x and box-filtered down. Drawing straight at 16/24/32
// produced hard, aliased edges that Windows then rescaled again — the reason the
// taskbar icon looked blurry next to sharper icons.
const SUPERSAMPLE = 4;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const PNG_SIZE = 1024;

const PLATE = [23, 27, 34, 255];
const AMBER = [224, 164, 78, 255];
const INK = [11, 13, 16, 255];
// macOS menu bar icons are template images: only the alpha channel is used, and
// the system tints the glyph for the current menu bar appearance.
const TEMPLATE_INK = [0, 0, 0, 255];

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

  // Dark plate: see the note at the top of the file.
  roundedRect(canvas, 0, 0, size, size, 7.5 * k, () => PLATE);

  // Two frames behind, one in front — the deck of open windows. The back frames
  // are pre-mixed against the plate instead of drawn semi-transparent: the canvas
  // writes pixels rather than compositing, so an alpha stroke would punch holes.
  const recessed = blend(PLATE, AMBER, 0.42);
  const deeper = blend(PLATE, AMBER, 0.66);
  drawWindowFrame(canvas, 6.5 * k, 5.5 * k, 15 * k, 11 * k, 2.2 * k, 1.6 * k, recessed, PLATE);
  drawWindowFrame(canvas, 9.5 * k, 8.8 * k, 15 * k, 11 * k, 2.2 * k, 1.6 * k, deeper, PLATE);

  // The front card is filled, with a title bar and a dot cut out of the fill.
  roundedRect(canvas, 12.5 * k, 12.2 * k, 15 * k, 11.5 * k, 2.2 * k, () => AMBER);
  roundedRect(canvas, 15.2 * k, 15.2 * k, 6 * k, 2 * k, 1 * k, () => INK);
  circle(canvas, 23 * k, 18.6 * k, 1.5 * k, INK);
  return canvas;
}

/**
 * An outlined rounded rectangle. Drawing the ring analytically produced spikes
 * at the corners, so this fills the outer shape and then paints the inner one
 * with `inside` — the plate colour, so a frame never punches a transparent hole
 * through the icon.
 */
function drawWindowFrame(canvas, x, y, w, h, r, stroke, color, inside) {
  roundedRect(canvas, x, y, w, h, r, () => color);
  const inset = stroke;
  const ir = Math.max(r - inset, 0.1);
  for (let py = Math.floor(y + inset); py < Math.ceil(y + h - inset); py += 1) {
    for (let px = Math.floor(x + inset); px < Math.ceil(x + w - inset); px += 1) {
      const cx = Math.min(Math.max(px + 0.5, x + inset + ir), x + w - inset - ir);
      const cy = Math.min(Math.max(py + 0.5, y + inset + ir), y + h - inset - ir);
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= ir * ir) canvas.set(px, py, inside);
    }
  }
}

/**
 * The same mark without the amber plate, for the macOS menu bar. The glyph is
 * scaled up ~1.3x so it reads at 16pt next to native status items instead of
 * floating in a mostly empty square.
 */
function drawTemplateMark(size) {
  const canvas = createCanvas(size);
  const scale = (size / 32) * 1.32;
  const x = (value) => size / 2 + (value - 16) * scale;
  const y = (value) => size / 2 + (value - 17.2) * scale;
  const stroke = 1.9 * scale;

  // Same deck as the app icon, but monochrome: template images keep only alpha,
  // so the two back frames are outlines and the front card is a filled block
  // with its title bar punched out.
  frameAt(canvas, x(7.4), y(6.6), 14 * scale, 10 * scale, 2 * scale, stroke);
  frameAt(canvas, x(10.2), y(9.7), 14 * scale, 10 * scale, 2 * scale, stroke);

  roundedRect(canvas, x(13), y(13), 14 * scale, 10.6 * scale, 2 * scale, () => TEMPLATE_INK);
  roundedRect(canvas, x(15.4), y(15.6), 5.4 * scale, 1.9 * scale, 0.95 * scale, () => [
    0, 0, 0, 0,
  ]);
  circle(canvas, x(22.6), y(18.7), 1.4 * scale, [0, 0, 0, 0]);
  return canvas;
}

/** Cleared rounded rectangle: the outline used by the mono tray glyph. */
function frameAt(canvas, x, y, w, h, r, stroke) {
  roundedRect(canvas, x, y, w, h, r, () => TEMPLATE_INK);
  const ir = Math.max(r - stroke, 0.1);
  for (let py = Math.floor(y + stroke); py < Math.ceil(y + h - stroke); py += 1) {
    for (let px = Math.floor(x + stroke); px < Math.ceil(x + w - stroke); px += 1) {
      const cx = Math.min(Math.max(px + 0.5, x + stroke + ir), x + w - stroke - ir);
      const cy = Math.min(Math.max(py + 0.5, y + stroke + ir), y + h - stroke - ir);
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= ir * ir) canvas.set(px, py, [0, 0, 0, 0]);
    }
  }
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

function renderTemplate(size) {
  return downsample(drawTemplateMark(size * SUPERSAMPLE), size);
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
// macOS gets a template glyph at 16pt plus a 2x variant for Retina menu bars.
writeFileSync("build/trayTemplate.png", encodePng(renderTemplate(16)));
writeFileSync("build/trayTemplate@2x.png", encodePng(renderTemplate(32)));
console.log(
  `icon.png ${PNG_SIZE}px (${large.length} bytes); icon.ico ${ICO_SIZES.join("/")}px; ` +
    "tray.png 32px; trayTemplate.png 16px; trayTemplate@2x.png 32px",
);
