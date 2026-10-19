import { describe, expect, it } from "vitest";
import { computeSlots, fullWorkArea, singleWindowRect } from "@core/layout/grid";
import { BUILTIN_LAYOUTS, FREE_LAYOUT_ID, clampSlot, findLayout } from "@shared/layouts";

const area = { x: 100, y: 50, width: 1400, height: 900 };

describe("computeSlots", () => {
  it("covers the whole work area with no outer padding", () => {
    const preset = findLayout("2x2");
    const slots = computeSlots(preset, area);
    expect(slots).toHaveLength(4);
    expect(slots[0]).toEqual({ x: 100, y: 50, width: 700, height: 450 });
    const last = slots[3]!;
    expect(last.x + last.width).toBe(area.x + area.width);
    expect(last.y + last.height).toBe(area.y + area.height);
  });

  it("splits 2x2 into four non-overlapping slots", () => {
    const slots = computeSlots(findLayout("2x2"), area);
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

  it("absorbs rounding remainder so the right and bottom edges are exact", () => {
    const odd = { x: 0, y: 0, width: 1001, height: 701 };
    const slots = computeSlots(findLayout("3x1"), odd);
    expect(slots).toHaveLength(3);
    expect(slots[0]!.x).toBe(0);
    const last = slots[2]!;
    expect(last.x + last.width).toBe(1001);
    expect(last.y + last.height).toBe(701);
  });

  it("maps custom fractional slots onto the work area", () => {
    const slots = computeSlots(
      {
        id: "custom",
        name: "wide-left",
        builtin: false,
        slots: [
          { x: 0, y: 0, width: 0.6, height: 1 },
          { x: 0.6, y: 0, width: 0.4, height: 0.5 },
          { x: 0.6, y: 0.5, width: 0.4, height: 0.5 },
        ],
      },
      area,
    );
    expect(slots[0]).toEqual({ x: 100, y: 50, width: 840, height: 900 });
    expect(slots[1]!.x).toBe(940);
    expect(slots[2]!.y).toBe(500);
  });

  it("falls back to a usable preset when the id is unknown", () => {
    expect(findLayout("does-not-exist").id).toBe("2x2");
  });

  it("keeps every built-in preset inside the unit square", () => {
    for (const preset of BUILTIN_LAYOUTS) {
      for (const slot of preset.slots) {
        expect(slot.x).toBeGreaterThanOrEqual(0);
        expect(slot.y).toBeGreaterThanOrEqual(0);
        expect(slot.x + slot.width).toBeLessThanOrEqual(1.0001);
        expect(slot.y + slot.height).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it("treats the free preset as no layout and gives windows the full area", () => {
    const free = findLayout(FREE_LAYOUT_ID);
    expect(free.slots).toHaveLength(0);
    expect(computeSlots(free, area)).toEqual([]);
    expect(fullWorkArea(area)).toEqual(area);
  });
});

describe("clampSlot", () => {
  it("keeps a slot inside the screen", () => {
    const slot = clampSlot({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 });
    expect(slot.x).toBeCloseTo(0.5);
    expect(slot.y).toBeCloseTo(0.5);
    expect(slot.x + slot.width).toBeLessThanOrEqual(1);
  });

  it("enforces a usable minimum size", () => {
    const slot = clampSlot({ x: 0, y: 0, width: 0.01, height: 0.01 });
    expect(slot.width).toBeGreaterThanOrEqual(0.08);
    expect(slot.height).toBeGreaterThanOrEqual(0.08);
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
