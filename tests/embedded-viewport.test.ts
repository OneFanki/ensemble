import {
  embeddedViewRect,
  normalizeViewportSize,
  pointerInsidePage,
  resizePageToPointer,
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

/**
 * Touch emulation is only allowed while the pointer is over a touch page, so
 * this test is the boundary between the page's own cursor and the rest of the
 * window's. The page rect is stage-relative while the pointer is in screen
 * space, which is one origin too many to leave untested.
 */
describe("pointer inside a page", () => {
  const stage: StageRect = { x: 100, y: 50, width: 800, height: 600 };
  const page: StageRect = { x: 200, y: 30, width: 300, height: 500 };
  const contentOrigin = { x: 10, y: 20 };
  const at = (windowX: number, windowY: number) => ({
    x: contentOrigin.x + windowX,
    y: contentOrigin.y + windowY,
  });

  it("accepts a pointer in the middle of the page", () => {
    expect(pointerInsidePage(at(450, 300), contentOrigin, stage, page)).toBe(true);
  });

  it("includes the near edges and excludes the far ones", () => {
    expect(pointerInsidePage(at(300, 80), contentOrigin, stage, page)).toBe(true);
    expect(pointerInsidePage(at(599, 579), contentOrigin, stage, page)).toBe(true);
    // Half-open on the far edges: a pointer on the boundary belongs to the
    // next surface, not to this page.
    expect(pointerInsidePage(at(600, 300), contentOrigin, stage, page)).toBe(false);
    expect(pointerInsidePage(at(400, 580), contentOrigin, stage, page)).toBe(false);
    expect(pointerInsidePage(at(299, 80), contentOrigin, stage, page)).toBe(false);
    expect(pointerInsidePage(at(300, 79), contentOrigin, stage, page)).toBe(false);
  });

  it("accounts for the window and stage origins", () => {
    // The same screen point is outside once the content area moves right.
    const pointer = at(350, 100);
    expect(pointerInsidePage(pointer, contentOrigin, stage, page)).toBe(true);
    expect(pointerInsidePage(pointer, { x: 80, y: 20 }, stage, page)).toBe(false);
  });

  it("adds the stage origin to a page rect that starts at the stage's corner", () => {
    const corner: StageRect = { x: 0, y: 0, width: 400, height: 300 };
    expect(pointerInsidePage(at(stage.x + 10, stage.y + 10), contentOrigin, stage, corner)).toBe(true);
    expect(pointerInsidePage(at(stage.x - 1, stage.y + 10), contentOrigin, stage, corner)).toBe(
      false,
    );
  });
});

/**
 * Dragging a page's edge must move that edge, not merely change a number.
 *
 * The page is centred in its cell and may be fitted down, so a naive
 * `width + delta` breaks twice: the edge moves at half the pointer's speed, and
 * once the page outgrows the cell the fit scale drops — the page shrinks while
 * the pointer keeps moving outwards, and the frame no longer sits on it.
 */
describe("page edge resize", () => {
  const cell: StageRect = { x: 0, y: 0, width: 1320, height: 784 };

  const gestureFor = (size: { width: number; height: number }) => {
    const fitted = viewportFitRect(cell, size);
    return {
      size,
      rect: fitted.rect,
      cell,
      // The handle sits in the gutter, a few pixels outside the visible edge.
      pointer: { x: fitted.rect.x + fitted.rect.width + 3, y: fitted.rect.y + fitted.rect.height / 2 },
    };
  };

  it("keeps the dragged edge under the pointer while the page still fits", () => {
    const gesture = gestureFor({ width: 900, height: 600 });
    const step = resizePageToPointer(gesture, "e", { ...gesture.pointer, x: gesture.pointer.x + 60 });

    expect(step.width).toBe(1020);
    expect(step.height).toBe(600);
    expect(step.scale).toBe(1);
    // The pointer moved 60px, so the page's right edge moved 60px with it.
    expect(step.rect.x + step.rect.width).toBe(1170);
  });

  it("caps at the cell instead of shrinking the page when the drag outgrows it", () => {
    // 1300 of 1320px: the next 20px of width would make the fit scale drop.
    const gesture = gestureFor({ width: 1300, height: 600 });
    const step = resizePageToPointer(gesture, "e", { ...gesture.pointer, x: gesture.pointer.x + 60 });

    expect(step.width).toBe(1320);
    // The height that was not dragged stays exactly where it was. Before the
    // cap it fell to ~558 because the whole page had to be fitted again.
    expect(step.height).toBe(600);
    expect(step.scale).toBe(1);
    expect(step.rect.height).toBe(600);
  });

  it("does not invent height when a tall page is dragged down", () => {
    const gesture = gestureFor({ width: 393, height: 852 });
    const step = resizePageToPointer(gesture, "s", { ...gesture.pointer, y: gesture.pointer.y + 40 });

    expect(step.height).toBe(852);
    expect(step.width).toBe(393);
    expect(step.scale).toBeCloseTo(784 / 852, 6);
    expect(step.rect.height).toBe(784);
  });

  it("reports the larger scale when shrinking lets the page fill the cell", () => {
    const gesture = gestureFor({ width: 660, height: 1000 });
    const start = viewportFitRect(cell, gesture.size);
    expect(start.scale).toBeCloseTo(0.784, 6);

    const step = resizePageToPointer(gesture, "s", { ...gesture.pointer, y: gesture.pointer.y - 100 });

    expect(step.width).toBe(660);
    expect(step.height).toBe(745);
    expect(step.scale).toBe(1);
    // The frame follows the page all the way to the cell width, rather than
    // staying at the pre-drag 517px-wide rect.
    expect(step.rect.width).toBe(660);
    expect(step.rect.height).toBe(745);
  });
});
