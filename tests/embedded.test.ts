import { describe, expect, it } from "vitest";
import {
  EMBEDDED_SLOT_HEADER,
  FAVICON_MAX_BYTES,
  ZOOM_STEPS,
  clampZoom,
  desktopUserAgent,
  embeddedPartition,
  embeddedSlotCount,
  embeddedSlotRects,
  embeddedViewRect,
  inlineFavicon,
  neighborZoomStep,
  normalizeEmbeddedUrl,
  parkedViewBounds,
  resolveSlotTabs,
} from "@shared/embedded";

const stage = { x: 0, y: 60, width: 1000, height: 600 };

describe("embedded slot geometry", () => {
  it("splits the stage edge to edge with no gaps", () => {
    const slots = embeddedSlotRects("2x2", stage);
    expect(slots).toHaveLength(4);
    expect(slots[0]).toEqual({ x: 0, y: 60, width: 500, height: 300 });
    expect(slots[1]).toEqual({ x: 500, y: 60, width: 500, height: 300 });
    expect(slots[2]).toEqual({ x: 0, y: 360, width: 500, height: 300 });
    // Right/bottom edges land exactly on the stage edge: rounding must not leave
    // a one-pixel seam between neighbouring views.
    const last = slots[3]!;
    expect(last.x + last.width).toBe(stage.x + stage.width);
    expect(last.y + last.height).toBe(stage.y + stage.height);
  });

  it("treats free and unknown layouts as a single full slot", () => {
    expect(embeddedSlotCount("free")).toBe(1);
    expect(embeddedSlotCount("nope")).toBe(1);
    expect(embeddedSlotRects("free", stage)).toEqual([{ x: 0, y: 60, width: 1000, height: 600 }]);
  });

  it("reserves header space and never produces a negative view height", () => {
    const view = embeddedViewRect({ x: 10, y: 20, width: 300, height: 200 });
    expect(view).toEqual({
      x: 10,
      y: 20 + EMBEDDED_SLOT_HEADER,
      width: 300,
      height: 200 - EMBEDDED_SLOT_HEADER,
    });

    const tiny = embeddedViewRect({ x: 0, y: 0, width: 100, height: 4 });
    expect(tiny.height).toBeGreaterThanOrEqual(1);
    expect(tiny.y).toBeLessThanOrEqual(4);
  });

  it("keeps odd sizes from losing a pixel at the right edge", () => {
    const slots = embeddedSlotRects("3x1", { x: 0, y: 0, width: 1001, height: 400 });
    expect(slots.map((slot) => slot.width)).toEqual([334, 333, 334]);
    expect(slots[2]!.x + slots[2]!.width).toBe(1001);
  });
});

describe("slot assignment", () => {
  it("keeps explicit pins and fills the rest in tab order", () => {
    const result = resolveSlotTabs(["a", "b", "c"], ["c", null, null], 3);
    expect(result).toEqual(["c", "a", "b"]);
  });

  it("drops closed tabs and duplicate pins", () => {
    const result = resolveSlotTabs(["a", "b"], ["b", "b", "gone"], 3);
    expect(result).toEqual(["b", "a", null]);
  });

  it("always returns exactly the slot count", () => {
    expect(resolveSlotTabs([], undefined, 4)).toEqual([null, null, null, null]);
    expect(resolveSlotTabs(["a", "b", "c", "d", "e"], undefined, 2)).toEqual(["a", "b"]);
  });
});

describe("session partitioning", () => {
  it("derives a stable, safe partition per identity", () => {
    expect(embeddedPartition("abc-123")).toBe("persist:embedded-abc-123");
    // Anything that could confuse Chromium's partition syntax is folded away.
    expect(embeddedPartition("a/b:c d")).toBe("persist:embedded-a_b_c_d");
  });

  it("gives different identities different partitions", () => {
    expect(embeddedPartition("one")).not.toBe(embeddedPartition("two"));
  });
});

describe("url handling", () => {
  it("accepts http(s) and about:blank", () => {
    expect(normalizeEmbeddedUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeEmbeddedUrl("about:blank")).toBe("about:blank");
  });

  it("adds a scheme to a bare host", () => {
    expect(normalizeEmbeddedUrl("localhost:3000")).toBe("http://localhost:3000/");
  });

  it("refuses schemes that could reach the local file system", () => {
    expect(normalizeEmbeddedUrl("file:///C:/Windows/win.ini")).toBeUndefined();
    expect(normalizeEmbeddedUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeEmbeddedUrl("data:text/html,<h1>x</h1>")).toBeUndefined();
    expect(normalizeEmbeddedUrl("   ")).toBeUndefined();
  });
});

describe("zoom steps", () => {
  it("moves one step at a time and stops at both ends", () => {
    expect(ZOOM_STEPS[neighborZoomStep(100, "in")]).toBe(110);
    expect(ZOOM_STEPS[neighborZoomStep(100, "out")]).toBe(90);
    expect(ZOOM_STEPS[neighborZoomStep(200, "in")]).toBe(200);
    expect(ZOOM_STEPS[neighborZoomStep(50, "out")]).toBe(50);
  });

  it("snaps a value that is between steps to the neighbouring one", () => {
    // The default setting can be any percentage; a keystroke must still move.
    expect(ZOOM_STEPS[neighborZoomStep(103, "in")]).toBe(110);
    expect(ZOOM_STEPS[neighborZoomStep(103, "out")]).toBe(100);
  });

  it("clamps to the supported range", () => {
    expect(clampZoom(10)).toBe(50);
    expect(clampZoom(400)).toBe(200);
    expect(clampZoom(Number.NaN)).toBe(100);
    expect(clampZoom(112.6)).toBe(113);
  });
});

describe("user agent", () => {
  it("removes the Electron token so sites see a normal Chrome", () => {
    const raw =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Electron/44.9.0";
    expect(desktopUserAgent(raw)).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    );
  });

  it("leaves an already-clean UA untouched", () => {
    const clean = "Mozilla/5.0 (Macintosh) Chrome/152.0.0.0 Safari/537.36";
    expect(desktopUserAgent(clean)).toBe(clean);
  });
});

describe("parked pages", () => {
  // A page that is alive but off stage still has to lay out at full size, and
  // it must not be visible anywhere in the window. Both requirements failed in
  // ways that only showed up at runtime, so the rule is pinned here.
  const content = { width: 1280, height: 800 };

  it("keeps the page at a real size instead of collapsing the viewport", () => {
    const parked = parkedViewBounds(content);
    expect(parked.width).toBe(content.width);
    expect(parked.height).toBe(content.height);
  });

  it("sits entirely past the window's right edge", () => {
    const parked = parkedViewBounds(content);
    // The stage starts right of the navigation rail, so parking at the stage's
    // width would leave the page inside the window and paint over other pages.
    expect(parked.x).toBeGreaterThanOrEqual(content.width);
  });

  it("never uses a negative coordinate, which zeroes the layout viewport", () => {
    const parked = parkedViewBounds(content);
    expect(parked.x).toBeGreaterThanOrEqual(0);
    expect(parked.y).toBeGreaterThanOrEqual(0);
  });

  it("clamps a window that reports no size", () => {
    expect(parkedViewBounds({ width: 0, height: 0 })).toEqual({
      x: 1,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("site icons", () => {
  // 1×1 transparent PNG.
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);

  it("inlines an image as a data URL", () => {
    const data = inlineFavicon("image/png", png);
    expect(data?.startsWith("data:image/png;base64,")).toBe(true);
    expect(data).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  });

  it("keeps a charset suffix out of the type", () => {
    expect(inlineFavicon("image/x-icon; charset=binary", png)).toMatch(
      /^data:image\/x-icon;base64,/,
    );
  });

  it("refuses anything that is not an image", () => {
    // An icon is untrusted bytes from a remote site; the renderer only gets
    // `data:` URLs, so guessing at a type would widen what it can be handed.
    for (const type of [null, "", "text/html", "application/octet-stream", "image"]) {
      expect(inlineFavicon(type, png), String(type)).toBeUndefined();
    }
  });

  it("refuses an empty or oversized payload", () => {
    expect(inlineFavicon("image/png", new Uint8Array())).toBeUndefined();
    expect(inlineFavicon("image/png", new Uint8Array(FAVICON_MAX_BYTES + 1))).toBeUndefined();
    expect(inlineFavicon("image/png", new Uint8Array(FAVICON_MAX_BYTES))).toBeDefined();
  });
});
