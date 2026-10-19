import { describe, expect, it } from "vitest";
import { snapSlotMove, snapSlotResize } from "@shared/layouts";
import type { SlotRect } from "@shared/types";

const threshold = { x: 0.01, y: 0.01 };

function slot(x: number, y: number, width: number, height: number): SlotRect {
  return { x, y, width, height };
}

describe("snapSlotMove", () => {
  it("snaps the left edge to the stage edge", () => {
    const result = snapSlotMove(slot(0.008, 0.4, 0.3, 0.3), [], threshold);
    expect(result.rect.x).toBe(0);
    expect(result.guides.vertical).toEqual([0]);
  });

  it("snaps the right edge to the stage's right edge", () => {
    const result = snapSlotMove(slot(0.68, 0.4, 0.315, 0.3), [], threshold);
    expect(result.rect.x + result.rect.width).toBeCloseTo(1);
    expect(result.guides.vertical).toContain(1);
  });

  it("snaps to a neighbour's edge instead of the stage", () => {
    const neighbour = slot(0, 0, 0.5, 1);
    // Just short of touching the neighbour's right edge at 0.5.
    const result = snapSlotMove(slot(0.495, 0, 0.2, 0.5), [neighbour], threshold);
    expect(result.rect.x).toBeCloseTo(0.5);
    expect(result.guides.vertical).toEqual([0.5]);
  });

  it("snaps the right edge back onto a neighbour's left edge", () => {
    const neighbour = slot(0.5, 0, 0.5, 1);
    const result = snapSlotMove(slot(0.305, 0.1, 0.2, 0.4), [neighbour], threshold);
    expect(result.rect.x + result.rect.width).toBeCloseTo(0.5);
  });

  it("leaves a slot alone when nothing is within the threshold", () => {
    const neighbour = slot(0.2, 0.2, 0.2, 0.2);
    const result = snapSlotMove(slot(0.55, 0.55, 0.2, 0.2), [neighbour], threshold);
    expect(result.rect.x).toBeCloseTo(0.55);
    expect(result.guides.vertical).toEqual([]);
    expect(result.guides.horizontal).toEqual([]);
  });

  it("snaps both axes at once in a corner", () => {
    const neighbour = slot(0.5, 0.5, 0.5, 0.5);
    const result = snapSlotMove(slot(0.495, 0.494, 0.2, 0.2), [neighbour], threshold);
    expect(result.rect.x).toBeCloseTo(0.5);
    expect(result.rect.y).toBeCloseTo(0.5);
    expect(result.guides.vertical).toEqual([0.5]);
    expect(result.guides.horizontal).toEqual([0.5]);
  });

  it("keeps the slot inside the stage", () => {
    const result = snapSlotMove(slot(0.95, 0.95, 0.2, 0.2), [], threshold);
    expect(result.rect.x + result.rect.width).toBeLessThanOrEqual(1);
    expect(result.rect.y + result.rect.height).toBeLessThanOrEqual(1);
  });
});

describe("snapSlotResize", () => {
  it("snaps the bottom-right corner to a neighbour edge", () => {
    const neighbour = slot(0.5, 0, 0.5, 1);
    const result = snapSlotResize(slot(0, 0, 0.495, 0.6), [neighbour], threshold);
    expect(result.rect.width).toBeCloseTo(0.5);
    expect(result.guides.vertical).toEqual([0.5]);
  });

  it("keeps the top-left corner fixed while resizing", () => {
    const result = snapSlotResize(slot(0.2, 0.3, 0.3, 0.3), [], threshold);
    expect(result.rect.x).toBe(0.2);
    expect(result.rect.y).toBe(0.3);
  });

  it("never shrinks below the minimum size or past the stage", () => {
    const tiny = snapSlotResize(slot(0.9, 0.9, 0.2, 0.2), [], threshold);
    expect(tiny.rect.width).toBeGreaterThanOrEqual(0.08);
    expect(tiny.rect.height).toBeGreaterThanOrEqual(0.08);
    expect(tiny.rect.x + tiny.rect.width).toBeLessThanOrEqual(1.0001);
  });

  it("absorbs rounding drift so an edge lands exactly on a line", () => {
    const result = snapSlotResize(slot(0, 0, 0.6666, 1), [], threshold);
    expect(result.rect.width).toBeCloseTo(0.6666);
  });
});
