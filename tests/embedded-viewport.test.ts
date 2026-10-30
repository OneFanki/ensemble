import {
  embeddedViewRect,
  normalizeViewportSize,
  viewportFitRect,
  VIEWPORT_MAX_HEIGHT,
  VIEWPORT_MAX_WIDTH,
  VIEWPORT_MIN,
  VIEWPORT_PRESETS,
  type StageRect,
} from "@shared/embedded";
import { describe, expect, it } from "vitest";

/**
 * The arithmetic behind fixed-viewport mode.
 *
 * The promise the mode makes — media queries and scripts see exactly the
 * requested size while the user sees a scaled preview — rests on one identity:
 * bounds `w·f × h·f` at zoom `f` lay out at `w × h`. These tests pin the
 * identity and its edge cases, because a rounding drift here would make a
 * "390px" breakpoint check lie by a pixel.
 */
describe("viewport size validation", () => {
  it("accepts whole sizes inside the range", () => {
    expect(normalizeViewportSize(390, 844)).toEqual({ width: 390, height: 844 });
    expect(normalizeViewportSize(VIEWPORT_MIN, VIEWPORT_MIN)).toEqual({
      width: VIEWPORT_MIN,
      height: VIEWPORT_MIN,
    });
    expect(normalizeViewportSize(VIEWPORT_MAX_WIDTH, VIEWPORT_MAX_HEIGHT)).toEqual({
      width: VIEWPORT_MAX_WIDTH,
      height: VIEWPORT_MAX_HEIGHT,
    });
  });

  it("rejects fractions, out-of-range values and non-numbers", () => {
    expect(normalizeViewportSize(390.5, 844)).toBeUndefined();
    expect(normalizeViewportSize(200, 844)).toBeUndefined();
    expect(normalizeViewportSize(4000, 844)).toBeUndefined();
    expect(normalizeViewportSize(390, 3000)).toBeUndefined();
    expect(normalizeViewportSize("390" as unknown, 844)).toBeUndefined();
    expect(normalizeViewportSize(Number.NaN, 844)).toBeUndefined();
  });

  it("ships presets that all pass validation", () => {
    for (const preset of VIEWPORT_PRESETS) {
      expect(normalizeViewportSize(preset.width, preset.height)).toEqual({
        width: preset.width,
        height: preset.height,
      });
    }
  });
});

describe("viewport fit rect", () => {
  const cell: StageRect = { x: 100, y: 200, width: 800, height: 500 };

  it("fills the cell exactly when the target matches it", () => {
    const { rect, scale } = viewportFitRect(cell, { width: 800, height: 500 });
    expect(scale).toBe(1);
    expect(rect).toEqual(cell);
  });

  it("scales down and centres when the target is larger", () => {
    // 1920×1080 into an 800×500 cell: width-limited, f = 800/1920 ≈ 0.4167.
    const { rect, scale } = viewportFitRect(cell, { width: 1920, height: 1080 });
    expect(scale).toBeCloseTo(800 / 1920, 10);
    expect(rect.width).toBe(800);
    // 1080 × 0.4167 = 450, centred vertically in 500.
    expect(rect.height).toBe(Math.round(1080 * scale));
    expect(rect.y).toBe(cell.y + Math.round((cell.height - rect.height) / 2));
    expect(rect.x).toBe(cell.x);
  });

  it("never scales up a smaller target — the page keeps its real size", () => {
    // 320×480 in an 800×500 cell fits as-is: the preview must be 320×480,
    // not stretched to fill.
    const { rect, scale } = viewportFitRect(cell, { width: 320, height: 480 });
    expect(scale).toBe(1);
    expect(rect.width).toBe(320);
    expect(rect.height).toBe(480);
    expect(rect.x).toBe(cell.x + Math.round((cell.width - 320) / 2));
    expect(rect.y).toBe(cell.y + Math.round((cell.height - 480) / 2));
  });

  it("keeps the CSS viewport identity: fitted bounds divided by the scale hit the target", () => {
    // The identity the whole mode rests on, checked across sizes: the page at
    // zoom f inside the fitted rect lays out at the requested w × h.
    for (const size of [
      { width: 390, height: 844 },
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
    ]) {
      const { rect, scale } = viewportFitRect(cell, size);
      const cssWidth = rect.width / scale;
      const cssHeight = rect.height / scale;
      // ±1px from integer bounds rounding; media queries care about the
      // exact breakpoint only when a query sits exactly on it, and the zoom
      // factor carries the fraction the bounds rounded away.
      expect(Math.abs(cssWidth - size.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(cssHeight - size.height)).toBeLessThanOrEqual(1);
    }
  });

  it("plays along with the header-band arithmetic", () => {
    // Layout fits the page into the cell BELOW the header band, so the two
    // helpers compose: fit(embeddedViewRect(slot)) never spills into the band.
    const slot: StageRect = { x: 0, y: 0, width: 700, height: 500 };
    const pageCell = embeddedViewRect(slot);
    const { rect } = viewportFitRect(pageCell, { width: 1920, height: 1080 });
    expect(rect.y).toBeGreaterThanOrEqual(pageCell.y);
    expect(rect.y + rect.height).toBeLessThanOrEqual(pageCell.y + pageCell.height);
  });
});
