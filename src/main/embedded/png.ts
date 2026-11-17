import { inflateSync, deflateSync } from "node:zlib";

/**
 * Flattens a PNG onto an opaque white background, in place of an image library.
 *
 * A page that paints no root background composites over nothing, so the frame
 * a screenshot reads — compositor or renderer, they carry the same one — keeps
 * alpha 0 in every region nothing drew into. A real browser never shows that:
 * the widget under the page lays white under the canvas, which is what a
 * person looking at the same page sees. This puts that base into the picture.
 *
 * The work is bounded and surgical: pages whose PNG has no alpha channel (the
 * overwhelming majority — Electron writes RGB once the frame is opaque) are
 * returned untouched, and anything that fails to parse is returned as-is so a
 * post-processing bug can never destroy a capture that succeeded.
 */

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0;
    const index = (crc ^ byte) & 0xff;
    crc = (CRC_TABLE[index] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

interface DecodedPng {
  width: number;
  height: number;
  /** Bytes per pixel in the source: 1 gray, 2 gray+a, 3 RGB, 4 RGBA. */
  channels: number;
  rgba: Uint8Array;
}

function decode(buf: Buffer): DecodedPng | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      const bitDepth = buf[pos + 16] ?? 0;
      const colorType = buf[pos + 17] ?? 0;
      const interlace = buf[pos + 20] ?? 0;
      if (bitDepth !== 8 || interlace !== 0) return null;
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType] ?? 0;
      if (channels === 0) return null;
    } else if (type === "IDAT") {
      idat.push(buf.subarray(pos + 8, pos + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (width <= 0 || height <= 0 || channels === 0 || idat.length === 0) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] ?? 0;
    for (let i = 0; i < stride; i++) {
      const x = raw[p++] ?? 0;
      const a = i >= channels ? (cur[i - channels] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= channels ? (prev[i - channels] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        default: v = x + paeth(a, b, c); break;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (channels === 4) {
        rgba[o] = cur[x * 4] ?? 0;
        rgba[o + 1] = cur[x * 4 + 1] ?? 0;
        rgba[o + 2] = cur[x * 4 + 2] ?? 0;
        rgba[o + 3] = cur[x * 4 + 3] ?? 255;
      } else if (channels === 3) {
        rgba[o] = cur[x * 3] ?? 0;
        rgba[o + 1] = cur[x * 3 + 1] ?? 0;
        rgba[o + 2] = cur[x * 3 + 2] ?? 0;
        rgba[o + 3] = 255;
      } else if (channels === 2) {
        const gray = cur[x * 2] ?? 0;
        rgba[o] = gray;
        rgba[o + 1] = gray;
        rgba[o + 2] = gray;
        rgba[o + 3] = cur[x * 2 + 1] ?? 255;
      } else {
        const gray = cur[x] ?? 0;
        rgba[o] = gray;
        rgba[o + 1] = gray;
        rgba[o + 2] = gray;
        rgba[o + 3] = 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, channels, rgba };
}

/** Serialises RGBA pixels as an 8-bit RGB PNG (filter 0 rows, zlib IDAT). */
function encodeRgb(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (stride + 1) + 1 + x * 3;
      const r = rgba[src] ?? 0;
      const g = rgba[src + 1] ?? 0;
      const b = rgba[src + 2] ?? 0;
      raw[dst] = r;
      raw[dst + 1] = g;
      raw[dst + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** True when the PNG carries an alpha channel that could be non-opaque. */
export function pngHasAlpha(buf: Buffer): boolean {
  // Signature (8) + chunk length (4) + "IHDR" (4) + width/height (8) + bit depth (1).
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) return false;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return false;
  const colorType = buf[25];
  return colorType === 4 || colorType === 6;
}

/**
 * The capture flattened onto white, or the input unchanged when flattening is
 * not needed (an RGB capture) or not possible (a PNG this cannot parse).
 */
export function flattenPngOntoWhite(buf: Buffer): Buffer {
  if (!pngHasAlpha(buf)) return buf;
  const decoded = decode(buf);
  if (!decoded) return buf;
  const { width, height, rgba } = decoded;
  let transparent = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 255) < 255) transparent += 1;
  }
  // Nothing to flatten: an all-opaque capture keeps its bytes.
  if (transparent === 0) return buf;
  const k = 255;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    const a = rgba[i + 3] ?? 255;
    if (a === 255) continue;
    const inv = k - a;
    rgba[i] = (r * a + 255 * inv) / k;
    rgba[i + 1] = (g * a + 255 * inv) / k;
    rgba[i + 2] = (b * a + 255 * inv) / k;
    rgba[i + 3] = k;
  }
  return encodeRgb(width, height, rgba);
}
