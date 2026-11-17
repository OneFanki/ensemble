/**
 * Minimal PNG content checks for e2e suites, with no image dependency.
 *
 * A screenshot call can "succeed" while the picture is worthless: a pure-black
 * frame, a fully transparent one, an alpha channel that viewers fill with
 * black. Pixel size says nothing about any of that — which is exactly how a
 * suite that only asserted dimensions stayed green while every label in the
 * picture was gone. These helpers decode the PNG (zlib is built into Node) and
 * answer the question the size check cannot: is there anything actually drawn
 * here.
 *
 * Supports what Chromium emits for screenshots: 8-bit depth, grayscale / RGB /
 * gray+alpha / RGBA, non-interlaced.
 */
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decodes a PNG buffer into RGBA bytes plus its header facts. */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG 文件");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      bitDepth = buf[pos + 16];
      colorType = buf[pos + 17];
      interlace = buf[pos + 20];
    } else if (type === "IDAT") {
      idat.push(buf.subarray(pos + 8, pos + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`不支持的位深 ${bitDepth}`);
  if (interlace !== 0) throw new Error("不支持隔行 PNG");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的图像类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p++];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`坏的过滤器 ${filter}`);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 2) {
        pixels[o] = cur[x * 3];
        pixels[o + 1] = cur[x * 3 + 1];
        pixels[o + 2] = cur[x * 3 + 2];
        pixels[o + 3] = 255;
      } else if (colorType === 6) {
        pixels[o] = cur[x * 4];
        pixels[o + 1] = cur[x * 4 + 1];
        pixels[o + 2] = cur[x * 4 + 2];
        pixels[o + 3] = cur[x * 4 + 3];
      } else if (colorType === 0) {
        pixels[o] = pixels[o + 1] = pixels[o + 2] = cur[x];
        pixels[o + 3] = 255;
      } else {
        pixels[o] = pixels[o + 1] = pixels[o + 2] = cur[x * 2];
        pixels[o + 3] = cur[x * 2 + 1];
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, colorType, pixels };
}

/** Reads a PNG from disk and summarises what is actually drawn in it. */
export function analyzePngFile(path) {
  const { width, height, colorType, pixels } = decodePng(readFileSync(path));
  const n = width * height;
  let transparent = 0;
  let black = 0;
  let white = 0;
  let green = 0;
  const colors = new Set();
  let sumL = 0;
  let sumL2 = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = pixels[o];
    const g = pixels[o + 1];
    const b = pixels[o + 2];
    const a = pixels[o + 3];
    if (a === 0) transparent += 1;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sumL += l;
    sumL2 += l * l;
    if (r < 16 && g < 16 && b < 16) black += 1;
    if (r > 240 && g > 240 && b > 240) white += 1;
    if (g > 120 && r < 100 && b < 160) green += 1;
    colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }
  const meanL = sumL / n;
  const stdL = Math.sqrt(Math.max(0, sumL2 / n - meanL * meanL));
  return {
    width,
    height,
    /** 0 grayscale, 2 RGB, 4 gray+alpha, 6 RGBA. Alpha-bearing types are the ones viewers fill with black. */
    colorType,
    uniqueColors: colors.size,
    /** Fraction of pixels with alpha 0 — the region viewers fill with black or white. */
    transparentFraction: transparent / n,
    blackFraction: black / n,
    whiteFraction: white / n,
    /** Fraction of clearly green pixels — e2e pages paint their target boxes green. */
    greenFraction: green / n,
    meanLuminance: meanL,
    /** Zero for a flat frame (all black, all white); grows with anything actually drawn. */
    luminanceStd: stdL,
  };
}

/**
 * Whether the picture carries real content, with the reason when it does not.
 *
 * A frame worth having has tonal variety (text on a background, a coloured
 * block) and is not mostly alpha-0 — the failure shapes seen in the wild were
 * a solid black frame and a mostly-transparent capture that viewers render as
 * black. `minUniqueColors` is low by design: the point is to catch empty
 * frames, not to grade typography.
 */
export function contentProblem(stat, { minUniqueColors = 8, maxTransparentFraction = 0.5, minLuminanceStd = 4 } = {}) {
  if (stat.width <= 0 || stat.height <= 0) return "尺寸为空";
  if (stat.transparentFraction >= maxTransparentFraction) {
    return `透明像素占 ${(stat.transparentFraction * 100).toFixed(1)}%，超过 ${(maxTransparentFraction * 100).toFixed(0)}%`;
  }
  if (stat.luminanceStd < minLuminanceStd) {
    return `亮度标准差 ${stat.luminanceStd.toFixed(1)} 低于 ${minLuminanceStd}，画面接近纯色`;
  }
  if (stat.uniqueColors < minUniqueColors) {
    return `唯一颜色 ${stat.uniqueColors} 少于 ${minUniqueColors}，画面接近纯色`;
  }
  return null;
}
