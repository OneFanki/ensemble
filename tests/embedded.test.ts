import { describe, expect, it } from "vitest";
import {
  AI_FRAMES_VISIBLE_PX,
  EMBEDDED_DAILY_PARTITION,
  EMBEDDED_SLOT_HEADER,
  FAVICON_MAX_BYTES,
  ZOOM_STEPS,
  aiFramesRect,
  clampZoom,
  desktopUserAgent,
  embeddedCleanPartition,
  embeddedPartition,
  embeddedSlotCount,
  embeddedSlotRects,
  embeddedTabPartition,
  embeddedViewRect,
  findViewContainer,
  ghostPresentationRect,
  inlineFavicon,
  needsCompositorFrames,
  neighborZoomStep,
  normalizeEmbeddedUrl,
  guestNodeRect,
  resolveDefaultTabId,
  viewIsOnScreen,
  resolveSlotPages,
  resolveSlotTabs,
  settleSplitPages,
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

  it("keeps a repeated instance only when the caller allows it", () => {
    // One account shown in two cells is the same-instance split; the same table
    // arriving by accident (a stale pin) must still collapse to one cell.
    const split = resolveSlotTabs(["a", "b"], ["a", "a"], 2, { allowDuplicates: true });
    expect(split).toEqual(["a", "a"]);
    expect(resolveSlotTabs(["a", "b"], ["a", "a"], 2)).toEqual(["a", "b"]);
    // Unknown ids are dropped even with duplicates allowed: a closed page is not
    // a split.
    expect(resolveSlotTabs(["a"], ["gone", "gone"], 2, { allowDuplicates: true })).toEqual([
      "a",
      null,
    ]);
  });

  it("keeps a page pin only while its instance fills more than one cell", () => {
    // Pages `a` and `a2` belong to instance `a`; `b` is a second window.
    const instanceOf = (tabId: string) => tabId.charAt(0);
    const split = resolveSlotPages(["a", "a"], ["a", "a2"], instanceOf);
    expect(split).toEqual(["a", "a2"]);

    // The moment the instance holds one cell, the pin must go: otherwise the
    // cell is frozen on one page while its strip still looks like a switcher.
    const merged = resolveSlotPages(["a", null], ["a", "a2"], instanceOf);
    expect(merged).toEqual([null, null]);

    // A pin from another window is never valid, and neither is a closed page.
    expect(resolveSlotPages(["a", "a"], ["a", "b"], instanceOf)).toEqual(["a", null]);
    expect(resolveSlotPages(["a", "a"], ["a", "gone"], instanceOf)).toEqual(["a", null]);
  });
});

describe("settleSplitPages", () => {
  // Dragging page `a2` of instance `a` into cell 0. Pages `a`/`a2`/`a3` belong
  // to instance `a` in creation order.
  const drop = { slotIndex: 0, rootId: "a", pageId: "a2" };

  it("re-pins a sibling whose own pin names the dropped page", () => {
    // The user dragged a2 out of the cell that pinned it; that cell keeps
    // showing a page, just not the one that moved.
    const settled = settleSplitPages({
      ...drop,
      slotTabs: ["a", "a"],
      slotPages: ["a2", "a2"],
      instanceActiveId: "a2",
      otherPages: ["a"],
    });
    expect(settled.slotPages).toEqual(["a2", "a"]);
    expect(settled.slotTabs).toEqual(["a", "a"]);
    expect(settled.released).toEqual([]);
  });

  it("re-pins a sibling that follows the instance's active page onto it", () => {
    // No pin: the cell would follow the active page, which is the dropped one
    // right after the drop lands.
    const settled = settleSplitPages({
      ...drop,
      slotTabs: ["a", "a"],
      slotPages: ["a2", null],
      instanceActiveId: "a2",
      otherPages: ["a"],
    });
    expect(settled.slotPages).toEqual(["a2", "a"]);
    expect(settled.released).toEqual([]);
  });

  it("releases the sibling of a single-page instance instead of doubling it", () => {
    // One page cannot fill two cells; the extra cell lets go so the caller can
    // re-resolve the slot table and let another instance (or nobody) fill it.
    const settled = settleSplitPages({
      ...drop,
      slotTabs: ["a", "a"],
      slotPages: ["a2", null],
      instanceActiveId: "a2",
      otherPages: [],
    });
    expect(settled.slotTabs).toEqual(["a", null]);
    expect(settled.slotPages).toEqual(["a2", null]);
    expect(settled.released).toEqual([1]);
  });

  it("leaves a sibling alone when it already shows another page", () => {
    const settled = settleSplitPages({
      ...drop,
      slotTabs: ["a", "a"],
      slotPages: ["a2", "a"],
      instanceActiveId: "a2",
      otherPages: ["a"],
    });
    expect(settled.slotPages).toEqual(["a2", "a"]);
    expect(settled.slotTabs).toEqual(["a", "a"]);
    expect(settled.released).toEqual([]);
  });

  it("only touches cells of the dragged instance", () => {
    const settled = settleSplitPages({
      ...drop,
      slotTabs: ["a", "b"],
      slotPages: ["a2", null],
      instanceActiveId: "b1",
      otherPages: [],
    });
    expect(settled.slotTabs).toEqual(["a", "b"]);
    expect(settled.slotPages).toEqual(["a2", null]);
    expect(settled.released).toEqual([]);
  });

  it("releases every duplicated sibling, not just the first", () => {
    const settled = settleSplitPages({
      ...drop,
      slotTabs: ["a", "a", "a"],
      slotPages: ["a2", "a2", "a2"],
      instanceActiveId: "a2",
      otherPages: [],
    });
    expect(settled.slotTabs).toEqual(["a", null, null]);
    expect(settled.released).toEqual([1, 2]);
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

  /*
   * The two identity-less worlds used to be one shared, persistent partition:
   * every throwaway tab got the same cookie jar and it survived quitting. The
   * split is what makes a bookmark open signed in while "clean open" stays a
   * throwaway; if these ever collapse into one value the distinction is gone.
   */
  it("separates the daily profile from the throwaway session", () => {
    expect(embeddedTabPartition({ instanceId: "i1" })).toBe(EMBEDDED_DAILY_PARTITION);
    const clean = embeddedTabPartition({ instanceId: "i1", clean: true });
    expect(clean).toBe(embeddedCleanPartition("i1"));
    expect(clean).not.toBe(EMBEDDED_DAILY_PARTITION);
  });

  it("keeps the throwaway session in memory, not on disk", () => {
    // A `persist:` partition is written to the user's data directory and would be
    // there for the next clean open, and the next launch, which is not "clean".
    expect(embeddedCleanPartition("abc").startsWith("persist:")).toBe(false);
    expect(EMBEDDED_DAILY_PARTITION.startsWith("persist:")).toBe(true);
  });

  it("gives each clean instance its own throwaway session", () => {
    expect(embeddedCleanPartition("one")).not.toBe(embeddedCleanPartition("two"));
    // ...so a login in one clean window cannot be seen by another.
    expect(embeddedTabPartition({ instanceId: "a", clean: true })).not.toBe(
      embeddedTabPartition({ instanceId: "b", clean: true }),
    );
  });

  /*
   * The daily profile keeps the string the old shared partition used, on purpose:
   * that is where the user's existing logins live, and an upgrade must not sign
   * them out of every site they had opened before the split.
   */
  it("adopts the old shared partition as the daily profile", () => {
    expect(EMBEDDED_DAILY_PARTITION).toBe("persist:embedded-clean");
  });

  it("puts an identity's page in that identity's partition whatever clean says", () => {
    expect(embeddedTabPartition({ identityId: "id-1", instanceId: "i1" })).toBe(
      embeddedPartition("id-1"),
    );
    expect(embeddedTabPartition({ identityId: "id-1", instanceId: "i1", clean: true })).toBe(
      embeddedPartition("id-1"),
    );
  });

  it("never lets an identity land in a shared profile", () => {
    for (const identityId of ["a", "b"]) {
      const partition = embeddedTabPartition({ identityId, instanceId: "i1" });
      expect(partition).not.toBe(EMBEDDED_DAILY_PARTITION);
      expect(partition).not.toBe(embeddedCleanPartition("i1"));
    }
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

describe("where a page node sits", () => {
  // Every rule here failed at least once at runtime, and each failure looked
  // like something else — a page that read as "element not found", a screenshot
  // that hung, a page painting over the console. They are pinned together.
  const stage = { x: 52, y: 113, width: 900, height: 600 };
  const win = { width: 1280, height: 800 };
  const bounds = { x: 10, y: 26, width: 880, height: 574 };

  it("places an on-stage page at the stage origin plus its own rect", () => {
    expect(guestNodeRect({ stage, bounds, onStage: true, window: win })).toEqual({
      x: 62,
      y: 139,
      width: 880,
      height: 574,
    });
  });

  it("keeps a page's own box off stage, not the stage's", () => {
    /*
     * This used to assert the stage's size, and that is what made
     * `set_browser_viewport` a no-op for any page the user was not looking at:
     * main fitted a parked page to its requested viewport, published that rect,
     * and the renderer replaced it with the stage size. The page then laid out
     * at the window's width however small the viewport was, and the tool
     * reported success.
     *
     * The invariant that still matters is "a parked page has a real box", which
     * the next case and the never-laid-out case cover.
     */
    const parked = guestNodeRect({ stage, bounds, onStage: false, window: win });
    expect(parked.width).toBe(bounds.width);
    expect(parked.height).toBe(bounds.height);
  });

  it("parks off stage to the left of the window, out of sight and out of reach", () => {
    const parked = guestNodeRect({ stage, bounds, onStage: false, window: win });
    // Entirely left of x=0: no part of it can be seen, and no part of it can
    // take a pointer meant for the chrome.
    expect(parked.x + parked.width).toBeLessThanOrEqual(0);
  });

  it("parks a page whose bounds never arrived instead of placing it at 0×0", () => {
    const parked = guestNodeRect({ stage, bounds: undefined, onStage: true, window: win });
    expect(parked.width).toBeGreaterThan(0);
    expect(parked.x).toBeLessThan(0);
  });

  it("keeps the page's own box when no stage has been reported", () => {
    /*
     * `stage: null` means the browser page is not mounted (the console covers
     * it). The page still has to keep a real box or its visibility checks all
     * answer false, and its own fitted box is the accurate one — a page with a
     * fixed viewport must not silently become window-sized just because the
     * stage is gone.
     */
    const parked = guestNodeRect({ stage: null, bounds, onStage: true, window: win });
    expect(parked.width).toBe(bounds.width);
    expect(parked.height).toBe(bounds.height);
    expect(parked.x).toBe(-bounds.width);
  });

  it("falls back to the window size when nothing has been laid out at all", () => {
    const parked = guestNodeRect({ stage: null, bounds: undefined, onStage: true, window: win });
    expect(parked.width).toBe(win.width);
    expect(parked.height).toBe(win.height);
    expect(parked.x).toBe(-win.width);
  });
});

describe("AI 活跃页的出帧摆位", () => {
  /*
   * 缺陷背景：停放页的节点停在窗外，合成器不为窗外节点出帧，页内 rAF 被压到
   * 约 1fps；AI 命令依赖合成帧（滚轮投递、动画后读取），在命令在飞与宽限期
   * 内必须满帧。这里钉住三层契约：哪个豁免理由算「必须出帧」、出帧摆位是否
   * 真的与窗口相交、以及它不压在任何台上页上面。
   */
  const stage = { x: 52, y: 113, width: 900, height: 600 };
  const win = { width: 1280, height: 800 };
  const bounds = { x: 10, y: 26, width: 880, height: 574 };

  it("ai-active 与 loading 豁免要求持续出帧", () => {
    expect(needsCompositorFrames({ sleepExempt: "ai-active" })).toBe(true);
    /*
      加载中也算：主进程把「正在加载」排在「AI 活跃」之前作为豁免理由，登录
      监听期间的页面会在两者之间来回切换。只认 ai-active 的话，节点每次切换
      都被搬回窗外再搬回来，每搬一次都要重新解锁帧调度。
    */
    expect(needsCompositorFrames({ sleepExempt: "loading" })).toBe(true);
    // 其他豁免不改变窗外摆位：台上页本来就在窗口内，有声页与策略豁免页维持
    // 现状（省资源行为不动），无豁免与已冻结页照常停放。
    expect(needsCompositorFrames({ sleepExempt: "on-stage-visible" })).toBe(false);
    expect(needsCompositorFrames({ sleepExempt: "audible" })).toBe(false);
    expect(needsCompositorFrames({ sleepExempt: "policy" })).toBe(false);
    expect(needsCompositorFrames({})).toBe(false);
    expect(needsCompositorFrames(undefined)).toBe(false);
  });

  it("呈现页的 ghost 摆位落在舞台原点且保留自身尺寸", () => {
    const rect = ghostPresentationRect({ stage, own: bounds, window: win });
    // 左上角在舞台内：整页在窗口内，截图才有内容。
    expect(rect.x).toBeGreaterThanOrEqual(stage.x);
    expect(rect.y).toBeGreaterThanOrEqual(stage.y);
    expect(rect.x).toBeLessThan(stage.x + stage.width);
    expect(rect.y).toBeLessThan(stage.y + stage.height);
    expect(rect.width).toBe(bounds.width);
    expect(rect.height).toBe(bounds.height);
  });

  it("没有自身盒子的呈现页退到舞台尺寸，而不是 0×0", () => {
    const rect = ghostPresentationRect({ stage, own: null, window: win });
    expect(rect.x).toBe(stage.x);
    expect(rect.y).toBe(stage.y);
    expect(rect.width).toBe(stage.width);
    expect(rect.height).toBe(stage.height);
  });

  it("舞台未上报（控制台盖住浏览器）时呈现页退到窗口原点，仍在视口内", () => {
    const rect = ghostPresentationRect({ stage: null, own: bounds, window: win });
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.width).toBe(bounds.width);
    expect(rect.height).toBe(bounds.height);
    const bare = ghostPresentationRect({ stage: null, own: null, window: win });
    expect(bare.width).toBe(win.width);
    expect(bare.height).toBe(win.height);
  });

  it("出帧页贴在窗口左缘，只露出一条，不压在舞台上", () => {
    const rect = aiFramesRect({ own: bounds, window: win });
    // 与窗口相交是合成器肯出帧的前提；露出的一条不超过 e2e 探针判定
    // 「两页重叠」的 4px 门槛。
    expect(rect.x + rect.width).toBe(AI_FRAMES_VISIBLE_PX);
    expect(rect.x + rect.width).toBeLessThanOrEqual(4);
    expect(rect.y).toBe(0);
    // 尺寸不变：页内视口与 AI 的坐标不因摆位而变。
    expect(rect.width).toBe(bounds.width);
    expect(rect.height).toBe(bounds.height);
  });

  it("没有自身盒子的出帧页退到窗口尺寸，同样只露出一条", () => {
    const rect = aiFramesRect({ own: null, window: win });
    expect(rect.width).toBe(win.width);
    expect(rect.height).toBe(win.height);
    expect(rect.x + rect.width).toBe(AI_FRAMES_VISIBLE_PX);
  });

  it("按组件的取用方式组合：豁免判定决定贴边出帧还是窗外停放", () => {
    // 变异任何一环（豁免判定、贴边几何）都会让这条变红。
    const place = (tab: { sleepExempt?: string }) =>
      needsCompositorFrames(tab)
        ? aiFramesRect({ own: bounds, window: win })
        : guestNodeRect({ stage, bounds, onStage: false, window: win });
    const awake = place({ sleepExempt: "ai-active" });
    expect(awake.x + awake.width).toBeGreaterThan(0);
    expect(awake.x + awake.width).toBeLessThanOrEqual(4);
    // 反向对照：无豁免页维持窗外停放（沿用既有契约）。
    const parked = place({});
    expect(parked.x + parked.width).toBeLessThanOrEqual(0);
  });
});

describe("on-screen detection (which screenshot path can work)", () => {
  // Both screenshot paths have blind spots, and the compositor one does not
  // fail off-screen — it never returns, so guessing wrong costs a full timeout
  // on every call. These cases pin the decision itself.
  const window = { width: 1280, height: 800 };
  const onScreen = { visible: true, minimized: false };
  const onStage = { x: 52, y: 113, width: 1000, height: 600 };

  it("treats a laid-out view in a visible window as on screen", () => {
    expect(viewIsOnScreen(onStage, window, onScreen)).toBe(true);
  });

  it("treats a view parked left of the window as off screen", () => {
    // This is exactly what the page pool produces: x = -width.
    const parked = guestNodeRect({ stage: null, bounds: undefined, onStage: false, window });
    expect(parked.x).toBe(-window.width);
    expect(viewIsOnScreen(parked, window, onScreen)).toBe(false);
  });

  it("treats a minimised window as off screen even for a laid-out view", () => {
    expect(viewIsOnScreen(onStage, window, { visible: true, minimized: true })).toBe(false);
  });

  it("treats a hidden window as off screen", () => {
    expect(viewIsOnScreen(onStage, window, { visible: false, minimized: false })).toBe(false);
  });

  it("treats a zero-sized view as off screen", () => {
    expect(viewIsOnScreen({ x: 0, y: 0, width: 0, height: 0 }, window, onScreen)).toBe(false);
  });

  it("does not count touching the window edge as on screen", () => {
    // A view whose left edge sits exactly on the right edge paints nothing.
    expect(viewIsOnScreen({ x: window.width, y: 0, width: 400, height: 300 }, window, onScreen)).toBe(
      false,
    );
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

describe("the page an omitted tab id means", () => {
  const personPage = { id: "person", origin: "manual" as const };
  const viewPage = { id: "view-member", origin: "view" as const };
  const aiFirst = { id: "ai-first", origin: "ai" as const, aiOpenSeq: 1 };
  const aiSecond = { id: "ai-second", origin: "ai" as const, aiOpenSeq: 2 };

  it("is the page the AI opened most recently, never the person's active page", () => {
    // An AI-opened page does not claim the stage, so "the active page" names
    // what the person is looking at. An omitted id from a client that just
    // opened a page means that page; answering with the person's page sent
    // every id-less click, keystroke and read to a page nobody asked about.
    expect(
      resolveDefaultTabId({
        tabs: [personPage, aiFirst, aiSecond],
        activeTabId: "person",
        onStageTabId: "person",
      }),
    ).toBe("ai-second");
  });

  it("does not depend on the order of the page list", () => {
    // Moving a page reorders the list; creation order lives in the sequence.
    expect(resolveDefaultTabId({ tabs: [aiSecond, personPage, aiFirst], activeTabId: "person" })).toBe(
      "ai-second",
    );
  });

  it("falls back to the previous AI page once the latest one is closed", () => {
    expect(resolveDefaultTabId({ tabs: [personPage, aiFirst], activeTabId: "person" })).toBe("ai-first");
  });

  it("is the person's active page only while the AI has no page of its own", () => {
    // "Do this to the page I'm looking at" has to keep working: the client has
    // opened nothing, so the active page is the only page it can mean.
    expect(resolveDefaultTabId({ tabs: [personPage, viewPage], activeTabId: "view-member" })).toBe(
      "view-member",
    );
  });

  it("skips an active id that names a page already closed", () => {
    expect(resolveDefaultTabId({ tabs: [personPage], activeTabId: "gone", onStageTabId: "gone" })).toBe(
      "person",
    );
  });

  it("takes the first slot of the view on stage, then the first page in the list", () => {
    expect(resolveDefaultTabId({ tabs: [personPage, viewPage], onStageTabId: "view-member" })).toBe(
      "view-member",
    );
    expect(resolveDefaultTabId({ tabs: [viewPage, personPage] })).toBe("view-member");
  });

  it("is undefined when there is no page at all", () => {
    expect(resolveDefaultTabId({ tabs: [] })).toBeUndefined();
  });

  it("ignores an AI page that carries no sequence number", () => {
    // Only pages created since the sequence existed have one; a record without
    // it has no claim to being "the latest".
    expect(
      resolveDefaultTabId({
        tabs: [personPage, { id: "legacy", origin: "ai" }],
        activeTabId: "person",
      }),
    ).toBe("person");
  });
});

describe("which container a view id names", () => {
  const loose = { id: "container-loose", name: "临时" };
  const savedA = { id: "container-a", viewDefinitionId: "definition-a" };
  const savedB = { id: "container-b", viewDefinitionId: "definition-b" };
  const views = [loose, savedA, savedB];

  it("is the container whose own id was given", () => {
    expect(findViewContainer(views, "container-b")).toBe(savedB);
  });

  it("is the open container of a saved view when the definition id was given", () => {
    // list_views hands out definition ids, list_browser_tabs hands out
    // container ids; a client holding either one means the same view.
    expect(findViewContainer(views, "definition-a")).toBe(savedA);
  });

  it("prefers the container on stage when a definition has more than one", () => {
    const second = { id: "container-a2", viewDefinitionId: "definition-a" };
    expect(findViewContainer([...views, second], "definition-a", "container-a2")).toBe(second);
    expect(findViewContainer([...views, second], "definition-a")).toBe(savedA);
  });

  it("is undefined for an id that names neither", () => {
    expect(findViewContainer(views, "definition-missing")).toBeUndefined();
    expect(findViewContainer([], "definition-a")).toBeUndefined();
  });
});

