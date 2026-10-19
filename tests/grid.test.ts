import { describe, expect, it } from "vitest";
import { computeGrid, layoutDimensions, singleWindowRect, slotCount } from "@core/layout/grid";

const area = { x: 100, y: 50, width: 1400, height: 900 };

describe("computeGrid", () => {
  it("returns one slot covering the padded area for 1x1", () => {
    const slots = computeGrid("1x1", area, 8, 8);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual({ x: 108, y: 58, width: 1384, height: 884 });
  });

  it("splits 2x2 into four non overlapping slots", () => {
    const slots = computeGrid("2x2", area, 8, 8);
    expect(slots).toHaveLength(4);
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const a = slots[i]!;
        const b = slots[j]!;
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("covers the full inner area including remainder pixels", () => {
    const odd = { x: 0, y: 0, width: 1001, height: 701 };
    const slots = computeGrid("3x1", odd, 8, 8);
    expect(slots).toHaveLength(3);
    const first = slots[0]!;
    const last = slots[2]!;
    expect(first.x).toBe(8);
    expect(last.x + last.width).toBe(993);
    expect(last.y + last.height).toBe(693);
  });

  it("reports dimensions and slot counts consistently", () => {
    for (const layout of ["1x1", "2x1", "2x2", "3x1"] as const) {
      const { columns, rows } = layoutDimensions(layout);
      expect(slotCount(layout)).toBe(columns * rows);
      expect(computeGrid(layout, area)).toHaveLength(columns * rows);
    }
  });
});

describe("singleWindowRect", () => {
  it("centers the window instead of pinning it to the first grid slot", () => {
    const rect = singleWindowRect(area);
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    expect(Math.abs(centerX - (area.x + area.width / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(centerY - (area.y + area.height / 2))).toBeLessThanOrEqual(1);
  });

  it("is much larger than a quarter of the screen", () => {
    const rect = singleWindowRect(area);
    const quarter = (area.width / 2) * (area.height / 2);
    expect(rect.width * rect.height).toBeGreaterThan(quarter * 1.5);
  });

  it("keeps a minimum size on small work areas without leaving the screen", () => {
    const small = { x: 0, y: 0, width: 800, height: 600 };
    const rect = singleWindowRect(small);
    expect(rect.width).toBeLessThanOrEqual(small.width);
    expect(rect.height).toBeLessThanOrEqual(small.height);
    expect(rect.x).toBeGreaterThanOrEqual(small.x);
    expect(rect.y).toBeGreaterThanOrEqual(small.y);
  });

  it("respects a secondary monitor offset", () => {
    const secondary = { x: 1920, y: 0, width: 1400, height: 900 };
    const rect = singleWindowRect(secondary);
    expect(rect.x).toBeGreaterThanOrEqual(1920);
    expect(rect.x + rect.width).toBeLessThanOrEqual(1920 + 1400);
  });
});
