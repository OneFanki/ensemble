import {
  EMBEDDED_SLOT_HEADER,
  embeddedViewRect,
  stageDrawsSlotHeaders,
} from "@shared/embedded";
import { describe, expect, it } from "vitest";

/**
 * The rule that keeps two surfaces in agreement.
 *
 * A view cell and the flat stage (the default tab group) both draw a header band
 * in the renderer and hand the native page the area below it. That band is where
 * the page strip lives. When the flat branch handed the page the whole stage
 * instead, the page painted over the strip and the default tab group lost its
 * tabs entirely — so the arithmetic is worth pinning down, even though it looks
 * trivial.
 *
 * The band is conditional now, and the condition is the interesting part: a grid
 * compares cells and needs each one labelled, while a single cell is just the
 * browser and the window's own tab strip already names the page. The renderer's
 * chrome and the main process's geometry both branch on the same predicate, so
 * they cannot disagree about whose 26px it is.
 */
describe("page area inside a cell", () => {
  const stage = { x: 0, y: 0, width: 1000, height: 600 };

  it("leaves the header band to the chrome", () => {
    expect(embeddedViewRect(stage)).toEqual({
      x: 0,
      y: EMBEDDED_SLOT_HEADER,
      width: 1000,
      height: 600 - EMBEDDED_SLOT_HEADER,
    });
  });

  it("gives a single cell the whole rectangle when told there is no band", () => {
    // `0` is what the main process passes for a one-cell stage. The page then
    // starts at the stage's own origin — a leftover 26px here is the dark strip
    // that sat above every single-cell page.
    expect(embeddedViewRect(stage, 0)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
    });
  });

  it("keeps the cell's own origin, so a cell can sit anywhere on the stage", () => {
    const cell = { x: 120, y: 40, width: 400, height: 300 };
    const page = embeddedViewRect(cell);
    expect(page.x).toBe(120);
    expect(page.y).toBe(40 + EMBEDDED_SLOT_HEADER);
    expect(page.width).toBe(400);
  });

  it("never produces a negative height on a cell shorter than the band", () => {
    const squash = embeddedViewRect({ x: 0, y: 0, width: 100, height: 5 });
    expect(squash.height).toBeGreaterThanOrEqual(1);
    expect(squash.y).toBeLessThanOrEqual(5);
  });

  it("draws headers only when there is more than one cell", () => {
    // A grid compares cells; one cell is the browser. This is the predicate the
    // renderer's chrome and the main process's geometry both branch on.
    expect(stageDrawsSlotHeaders(1)).toBe(false);
    expect(stageDrawsSlotHeaders(2)).toBe(true);
    expect(stageDrawsSlotHeaders(4)).toBe(true);
  });
});
