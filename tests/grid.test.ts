import { describe, expect, it } from "vitest";
import { computeGrid, layoutDimensions, slotCount } from "@core/layout/grid";

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
