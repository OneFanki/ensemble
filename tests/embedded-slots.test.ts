import {
  embeddedSlotCount,
  embeddedSlotRects,
  isBlankTab,
  tabDisplayTitle,
  viewSlotFractions,
} from "@shared/embedded";
import { describe, expect, it } from "vitest";

describe("slot geometry", () => {
  it("uses preset fractions when nothing was dragged", () => {
    const rects = embeddedSlotRects("2x1", { x: 0, y: 0, width: 1000, height: 600 });
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 500, height: 600 });
    expect(rects[1]?.x).toBe(500);
  });

  it("prefers hand-dragged fractions", () => {
    const custom = [
      { x: 0, y: 0, width: 0.3, height: 1 },
      { x: 0.3, y: 0, width: 0.7, height: 1 },
    ];
    const rects = embeddedSlotRects("2x1", { x: 0, y: 0, width: 1000, height: 600 }, custom);
    expect(rects[0]?.width).toBe(300);
    expect(rects[1]?.x).toBe(300);
    expect(embeddedSlotCount("2x1", custom)).toBe(2);
  });

  it("treats free as one full-stage slot", () => {
    const rects = embeddedSlotRects("free", { x: 10, y: 20, width: 800, height: 500 });
    expect(rects).toEqual([{ x: 10, y: 20, width: 800, height: 500 }]);
    expect(embeddedSlotCount("free")).toBe(1);
    expect(embeddedSlotCount("1x1")).toBe(1);
  });

  it("hands back preset fractions for a view without custom geometry", () => {
    expect(viewSlotFractions({ layoutId: "2x2" })).toEqual([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);
  });
});

describe("tab titles", () => {
  it("shows the page title once the page reports one", () => {
    expect(
      tabDisplayTitle({ label: "新标签页", title: "文档平台", url: "http://a.test/" }),
    ).toBe("文档平台");
  });

  it("falls back to the label while the page is still blank", () => {
    expect(tabDisplayTitle({ label: "账号甲", title: "", url: "about:blank" })).toBe("账号甲");
    // Chromium reports the literal URL as the title for about:blank.
    expect(tabDisplayTitle({ label: "账号甲", title: "about:blank", url: "about:blank" })).toBe(
      "账号甲",
    );
  });

  it("recognises a fresh tab", () => {
    expect(isBlankTab({ url: "about:blank" })).toBe(true);
    expect(isBlankTab({ url: "" })).toBe(true);
    expect(isBlankTab({ url: "http://a.test/" })).toBe(false);
  });
});
