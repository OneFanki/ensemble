import { BUILTIN_LAYOUTS, FREE_LAYOUT_ID } from "./layouts";
import type { LayoutId, RoleColor, SlotRect } from "./types";

/**
 * Width of the gap between a docked DevTools panel and its page.
 *
 * The drag handle is renderer HTML, which paints below every native view, so
 * the views must physically part around this many DIP for the handle to exist.
 * Main process (layout) and renderer (handle) share the constant so the gap
 * and the handle stay the same width.
 */

/**
 * A page hosted inside the app's own browser surface.
 *
 * The embedded surface exists so AI-driven work does not open a system window per
 * account: everything happens inside one window the user can watch and take over.
 * Each tab carries its identity so the chrome can label it, but the tab itself is
 * just a page — several tabs of the same identity is a legitimate arrangement.
 */
export interface EmbeddedTab {
  id: string;
  identityId?: string;
  siteId?: string;
  label: string;
  color?: RoleColor;
  url: string;
  title: string;
  /**
   * Site icon, already inlined as a `data:` URL.
   *
   * The app renderer never loads a remote image: the main process fetches the
   * icon through the page's own session (so a logged-in site resolves it the
   * same way the page does) and hands over bytes. Absent for blank pages and
   * for sites that publish no icon.
   */
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** View this page's browser instance belongs to; absent means ungrouped. */
  viewId?: string;
  /** Where the tab came from, so closing a view can leave hand-made tabs alone. */
  origin: "view" | "manual" | "ai";
  /**
   * Browser instance (window) this page belongs to.
   *
   * A view slot holds an instance, not a page. Pages opened by a page (a
   * `target="_blank"` link, an OAuth popup) join the same instance and never
   * become extra slot candidates. The instance id is the root page's id.
   */
  instanceId: string;
  /** Page that opened this one. */
  openerId?: string;
  /**
   * True when this instance lives in the throwaway partition.
   *
   * Surfaced so the chrome can say so: being signed out is expected in a clean
   * session and surprising in the daily profile, and the partition is the one
   * thing the URL cannot tell you.
   */
  clean?: boolean;
  /**
   * Session partition this page's renderer lives in.
   *
   * Sent with the tab rather than re-derived in the renderer: the partition is
   * a storage boundary, and two places computing it is how an identity ends up
   * sharing cookies with the daily profile. The renderer only copies it onto
   * the `<webview>` node, which is a creation-time attribute.
   */
  partition: string;
  /** True for the page currently shown by its instance. */
  active: boolean;
  /** Effective zoom in percent; `100` means the page renders at its natural size. */
  zoom: number;
  /**
   * Fixed CSS viewport this page renders at, when set.
   *
   * This is the *effective* size: the page's own override when it has one,
   * otherwise the workspace default. The view shows a scaled-down preview, and
   * `bounds` holds the fitted rect it actually occupies.
   */
  viewport?: EmbeddedViewport;
  /**
   * The page's own viewport choice, when it made one.
   *
   * Absent means "inherit the workspace default", which is what lets one global
   * size apply to every page the user has not touched. `null` is an explicit
   * "adaptive, even though a default exists"; an object pins this page alone.
   * The distinction between absent and null is the point: only a page that made
   * an explicit choice may disagree with the default.
   */
  viewportOverride?: EmbeddedViewport | null;
  /**
   * Device this page is impersonating, when it is.
   *
   * A device supersedes the viewport: it carries its own size, and on top of it
   * touch, a DPR and a UA. When it is set the page lays out at the device's
   * size too, so the two never disagree about how wide the page is.
   *
   * Absent means "not emulating"; the viewport fields below still apply then.
   */
  device?: EmbeddedDevice;
  /** True while this page's DevTools are open (docked by default). */
  devtoolsOpen: boolean;
  /**
   * Which of the panel's three tabs is showing.
   *
   * The native front-end, our device picker, or our performance monitor. Only
   * one can own the panel's rectangle at a time, because the front-end is a
   * native view that paints over anything the renderer draws.
   */
  devtoolsTab?: "front-end" | "device" | "performance";
  /**
   * Fraction of the page's cell the docked panel takes, when it is docked.
   *
   * Absent while the panel is closed or detached. Published so the renderer can
   * draw the drag handle exactly where the native views part: the page and the
   * panel are laid out by main, and the handle is the only part of the split the
   * HTML owns.
   */
  devtoolsWidth?: number;
  /**
   * Where the page sits inside the stage, in stage-relative pixels.
   *
   * Computed by main from the layout, so the renderer positions the node from
   * it rather than re-deriving the cell arithmetic. Absent while the carrier is
   * still being created — that is the renderer's signal to keep the node hidden
   * instead of placing it at 0×0.
   */
  bounds?: StageRect;
}

/**
 * A view is one shared screen region.
 *
 * Tabs inside a view share the region: at most `slots` of them are on stage, the
 * rest keep running off screen. Without any view the surface behaves like a plain
 * browser with a flat tab strip.
 */
export interface EmbeddedView {
  id: string;
  name: string;
  color?: RoleColor;
  /** View definition this container was opened from, used to merge relaunches. */
  viewDefinitionId?: string;
  layoutId: LayoutId;
  /**
   * Custom slot geometry in fractions of the stage, produced by dragging a
   * divider. Absent means "use the preset's geometry"; picking a preset clears it.
   */
  slotRects?: SlotRect[];
  /** Tab id per slot; null for an empty slot. Length always equals the slot count. */
  slotTabs: (string | null)[];
  /**
   * A batch launch still filling this view's cells.
   *
   * Present only while `launchIdentityBatch` is running: `done` counts the
   * pages already pinned, `total` the ones requested. The stage draws a small
   * progress marker from it — a free layout has one cell, so "the cells light
   * up one by one" cannot show progress there, and without a marker the stage
   * sits still for the whole launch. Cleared when the batch settles.
   */
  launching?: { total: number; done: number };
  /**
   * Page each slot displays, when it differs from the instance's active page.
   *
   * A slot names an *instance*, and normally the instance has one cell and shows
   * whichever of its pages is active. Side-by-side comparison of one account
   * needs two cells of the same instance showing two different pages, and then
   * "the active page" cannot answer for both — so a slot may pin a page here.
   * `null`/absent means "follow the instance", which is the ordinary case.
   */
  slotPages?: (string | null)[];
  collapsed: boolean;
  /** Tab that owns the keyboard and receives replacements. */
  focusedTabId?: string;
}

/**
 * `activeTabId` is the tab that owns the keyboard and is the default target for
 * AI calls. `activeViewId` is the shared region currently on screen; only one
 * view is visible at a time, but every view keeps its own grid and focus.
 */
export interface EmbeddedState {
  tabs: EmbeddedTab[];
  views: EmbeddedView[];
  activeTabId?: string;
  activeViewId?: string;
  /**
   * True while docked DevTools panels are stepped aside for a stage-covering
   * menu (see `setDevtoolsParked`). The panels are native views that no HTML
   * can stack over, so while the flag holds they are parked off-screen; the
   * per-tab `devtoolsOpen` flags keep reporting true.
   */
  devtoolsParked?: boolean;
  /**
   * What draws the pages.
   *
   * `native` is a main-process view composited above the app's HTML; `guest` is a
   * `<webview>` node inside the app's own document. The difference decides
   * whether an overlay has to freeze the stage: a native view is never behind
   * HTML no matter what its z-index says, while a guest takes part in the normal
   * stacking order.
   */
  carrier?: "native" | "guest";
}

/** Where a dragged tab is being dropped. */
export type EmbeddedDropTarget =
  | { kind: "tab"; tabId: string; edge: "before" | "after" | "middle" }
  | { kind: "view"; viewId: string }
  | { kind: "loose" };

/** Rectangle in the window's content area, CSS pixels. */
export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Height of the per-slot header the chrome draws above each embedded view.
 *
 * 32, not the 26 it started at. The header carries an account name and that
 * instance's page tabs, and at 26 both were squeezed smaller than the new-tab
 * bookmark strip then was — a row of chrome with less room than a row of links.
 * The relationship is now the other way round on purpose: 32 here against the
 * strip's 28, because the strip decorates a blank page while this band names the
 * account and holds the page tabs. It is shared by the main process and the
 * renderer, so the page inside the cell and the header above it can never
 * disagree about where the boundary is.
 */
export const EMBEDDED_SLOT_HEADER = 32;

/**
 * Width of the draggable gutter between adjacent slots.
 *
 * Native pages paint over HTML, so a divider drawn on the exact boundary would
 * be covered by the page. Every view is therefore inset by this much on an
 * internal edge, which leaves a visible, clickable seam for the divider.
 */
export const EMBEDDED_DIVIDER = 8;

/**
 * Width of the gutter between a page and its docked DevTools panel.
 *
 * Same reason as `EMBEDDED_DIVIDER`: the page and the tools are both native
 * surfaces, so the HTML handle can only be seen and grabbed in a real gap
 * between them. Both sides read this one value, which is what keeps the drawn
 * handle on top of the gap it drags.
 */
export const EMBEDDED_DEVTOOLS_GRIP = 7;

/**
 * Height of the app-owned title band above a docked DevTools panel.
 *
 * The panel is a native `WebContentsView`, so no HTML can be drawn on top of
 * it — which means the app cannot place a close button over the tools. Instead
 * the panel gives up this band at its top and the renderer draws the band: the
 * panel's name on the left, a close button on the right. Both sides read this
 * one value, so the band and the hole in the panel cannot drift apart.
 */
export const EMBEDDED_DEVTOOLS_HEAD = 26;

/**
 * How far the docked panel may go, as a fraction of the cell.
 *
 * Narrower than 20% and the panel's own columns collapse; wider than 70% and
 * the page it is inspecting is too small to see what the tools describe.
 */
export const EMBEDDED_DEVTOOLS_MIN = 0.2;
export const EMBEDDED_DEVTOOLS_MAX = 0.7;
/** The split a panel opens with. */
export const EMBEDDED_DEVTOOLS_DEFAULT = 0.42;

/** Built-in layouts the embedded surface can use, in picker order. */
export const EMBEDDED_LAYOUTS: LayoutId[] = ["free", "1x1", "2x1", "1x2", "2x2", "3x1"];

export function isEmbeddedLayout(id: LayoutId | undefined): id is LayoutId {
  return typeof id === "string" && EMBEDDED_LAYOUTS.includes(id);
}

/** Slot geometry of a view: hand-dragged fractions win over the preset. */
export function viewSlotRects(
  view: Pick<EmbeddedView, "layoutId" | "slotRects">,
  stage: StageRect,
): StageRect[] {
  return embeddedSlotRects(view.layoutId, stage, view.slotRects);
}

/**
 * Shrinks each slot by the divider gutter on its internal right/bottom edges.
 *
 * A slot at the stage edge keeps its full size so the pages still reach the
 * window border; only the seams between two slots become visible gaps.
 */
export function insetSlotRects(slots: StageRect[], stage: StageRect): StageRect[] {
  const right = stage.x + stage.width;
  const bottom = stage.y + stage.height;
  return slots.map((slot) => {
    const internalRight = slot.x + slot.width < right - 1;
    const internalBottom = slot.y + slot.height < bottom - 1;
    return {
      x: slot.x,
      y: slot.y,
      width: Math.max(1, slot.width - (internalRight ? EMBEDDED_DIVIDER : 0)),
      height: Math.max(1, slot.height - (internalBottom ? EMBEDDED_DIVIDER : 0)),
    };
  });
}

/** Same geometry in fractions of the stage, for dragging and for persistence. */
export function viewSlotFractions(view: Pick<EmbeddedView, "layoutId" | "slotRects">): SlotRect[] {
  if (view.slotRects?.length) return view.slotRects.map((rect) => ({ ...rect }));
  const preset = BUILTIN_LAYOUTS.find((item) => item.id === view.layoutId);
  if (!preset || preset.slots.length === 0) return [{ x: 0, y: 0, width: 1, height: 1 }];
  return preset.slots.map((rect) => ({ ...rect }));
}

export function embeddedSlotCount(layoutId: LayoutId, custom?: SlotRect[]): number {
  if (custom?.length) return custom.length;
  const preset = BUILTIN_LAYOUTS.find((item) => item.id === layoutId);
  // "free" shows one tab at a time; anything unknown falls back to a single slot
  // rather than throwing inside a resize path.
  if (!preset || preset.slots.length === 0) return 1;
  return preset.slots.length;
}

/**
 * Where a page node sits, given the stage and whether the page is on it.
 *
 * Pure, and shared with the renderer's pool, because both sides have to agree
 * on one thing: a page that is not on stage still needs a real box *and* must
 * not be anywhere the user can see or click it.
 *
 * Measured on Electron 45, all three of these are load-bearing:
 *
 * - **Keep the size.** A guest with no box reports a 0×0 viewport, and every
 *   visibility check inside it then answers false — reads turn into "element not
 *   found" for a page that is perfectly alive.
 * - **Hide by moving, not by `display`.** `display: none` collapses the viewport
 *   to 0×0 for the same reason; `visibility: hidden` keeps the size but refuses
 *   screenshots. `opacity: 0` does neither.
 * - **Park to the left of the window, not far away.** A node pushed well outside
 *   the window is culled from the compositor and its capture never replies, while
 *   the one-removed-left position stays cheap to bring back for a screenshot.
 */
export function guestNodeRect(input: {
  stage: StageRect | null;
  bounds: StageRect | undefined;
  onStage: boolean;
  window: { width: number; height: number };
}): StageRect {
  const { stage, bounds, onStage, window: win } = input;
  // A zero-size rect is the "carrier not laid out yet" state, not a placement:
  // using it would give the node a 0×0 box, and every visibility check inside
  // the page then answers false.
  const hasBox = Boolean(bounds && bounds.width > 0 && bounds.height > 0);
  if (hasBox && onStage && stage && stage.width > 0 && stage.height > 0 && bounds) {
    return {
      x: stage.x + bounds.x,
      y: stage.y + bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }
  /*
   * A page with a fixed viewport keeps *its own* size off stage.
   *
   * This is what makes `set_browser_viewport` mean something for a page nobody
   * is looking at. The box main computes for a parked page is the fit rect of
   * the requested viewport; before this branch existed the renderer ignored it
   * and substituted the stage's size, so the page laid out at the window's
   * width however small the requested viewport was — the tool reported success
   * and `innerWidth` never changed. Position stays off-window: size is what the
   * page reads, visibility is what the user sees.
   */
  if (hasBox && bounds) {
    const width = bounds.width;
    const height = bounds.height;
    return { x: -width, y: stage?.y ?? 0, width, height };
  }
  /*
   * A page that is on stage but has no box yet is parked, not stretched.
   *
   * It used to fall through to the window-sized fallback below, which put a
   * brand-new page at (0,0) covering the whole window — on top of whatever was
   * already there. During a view launch that is several pages arriving at once,
   * so the stage flashed full-window images over itself for a few frames.
   * Parking it keeps the node sized (the 0×0 viewport problem) without putting
   * it anywhere a user can see; its real box is one broadcast away.
   */
  const width = stage && stage.width > 0 ? stage.width : Math.max(1, Math.round(win.width));
  const height = stage && stage.height > 0 ? stage.height : Math.max(1, Math.round(win.height));
  return { x: -width, y: stage?.y ?? 0, width, height };
}

/**
 * Whether a page is painting on screen, i.e. whether the compositor has frames
 * for it.
 *
 * This decides which screenshot path to take, because the two available paths
 * have opposite blind spots (measured on Electron 44 / Chromium 152):
 *
 * | state               | Page.captureScreenshot | capturePage |
 * | ------------------- | ---------------------- | ----------- |
 * | on screen           | works, ~40ms           | works       |
 * | parked off-window   | **never returns**      | works       |
 * | window minimised    | **never returns**      | works       |
 * | window fully hidden | fails                  | fails       |
 *
 * "Never returns" is the dangerous one: it is not an error, so a caller that
 * tries the compositor first pays its full timeout every single time. A page the
 * user switched away from is parked outside the window, so this returns false
 * and the screenshot goes straight to the renderer.
 *
 * The test is a real intersection, not "is the top-left corner inside". A parked
 * node sits at `x = -width` — its left edge is *left* of the window, which the
 * corner check read as on screen because `-1320 < 1320`. That inverted answer
 * sent every screenshot of a background page down the path that never replies.
 *
 * Pure on purpose: the three inputs are all the caller needs to read, and a
 * wrong answer only costs a slower path, never a wrong pixel.
 */
export function viewIsOnScreen(
  rect: { x: number; y: number; width: number; height: number },
  content: { width: number; height: number },
  host: { visible: boolean; minimized: boolean },
): boolean {
  if (!host.visible || host.minimized) return false;
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Touching an edge is not overlapping it: a view parked flush against the
  // window has no pixel on screen, and its compositor produces nothing.
  return rect.x < content.width && rect.x + rect.width > 0 && rect.y < content.height && rect.y + rect.height > 0;
}

export function embeddedSlotRects(
  layoutId: LayoutId,
  stage: StageRect,
  custom?: SlotRect[],
): StageRect[] {
  const preset = BUILTIN_LAYOUTS.find((item) => item.id === layoutId);
  const slots: SlotRect[] = custom?.length
    ? custom
    : !preset || preset.slots.length === 0
      ? [{ x: 0, y: 0, width: 1, height: 1 }]
      : preset.slots;
  return slots.map((slot) => {
    const left = Math.round(slot.x * stage.width);
    const top = Math.round(slot.y * stage.height);
    const right = Math.round((slot.x + slot.width) * stage.width);
    const bottom = Math.round((slot.y + slot.height) * stage.height);
    return {
      x: stage.x + left,
      y: stage.y + top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  });
}

/**
 * Zoom levels a Ctrl +/- step moves through, in percent.
 *
 * Mirrors Chrome's list so two keystrokes land on the same factor a real browser
 * would pick, rather than drifting through arbitrary percentages.
 */
export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

/**
 * Index of the step next to `percent` in `direction`.
 *
 * A value between steps (for example after the default setting changed) snaps to
 * the neighbouring step instead of skipping one, so a single keystroke always
 * produces a visible change.
 */
export function neighborZoomStep(percent: number, direction: "in" | "out"): number {
  if (direction === "in") {
    const index = ZOOM_STEPS.findIndex((step) => step > percent);
    return index < 0 ? ZOOM_STEPS.length - 1 : index;
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    const step = ZOOM_STEPS[index];
    if (step !== undefined && step < percent) return index;
  }
  return 0;
}

/** Default clamp used by both the setting and the per-page override. */
export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(200, Math.max(50, Math.round(percent)));
}

/**
 * What a tab is called in the chrome.
 *
 * A browser shows the page title, not the fact that the tab was opened. The
 * fallback label ("new tab", or the identity name for a tab opened for one)
 * only applies until the page reports a title.
 */
export function tabDisplayTitle(tab: Pick<EmbeddedTab, "title" | "label" | "url">): string {
  const title = tab.title.trim();
  if (!title || title.toLowerCase() === "about:blank") return tab.label;
  return title;
}

/** A tab that has not navigated anywhere yet; its address field starts empty. */
export function isBlankTab(tab: Pick<EmbeddedTab, "url">): boolean {
  return !tab.url || tab.url === "about:blank";
}

/** Largest site icon worth inlining; anything bigger is a misconfigured page. */
export const FAVICON_MAX_BYTES = 512 * 1024;

/**
 * Turns a downloaded icon into a `data:` URL the app renderer may draw.
 *
 * The renderer's CSP only allows `data:` images, so this conversion is the whole
 * reason the main process fetches icons at all. Lives here rather than in the
 * browser manager because the rules are the security-relevant part: anything
 * that is not a plain image type is refused rather than guessed at, since an
 * icon is untrusted bytes from a remote site.
 */
export function inlineFavicon(contentType: string | null, bytes: Uint8Array): string | undefined {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!type.startsWith("image/")) return undefined;
  if (bytes.byteLength === 0 || bytes.byteLength > FAVICON_MAX_BYTES) return undefined;
  return `data:${type};base64,${toBase64(bytes)}`;
}

/**
 * Base64 without `Buffer` or `btoa`.
 *
 * This module is bundled for the renderer as well as the main process, so it has
 * to run in both: `Buffer` does not exist in a sandboxed renderer, and `btoa`
 * would need the whole payload copied into a binary string first.
 */
function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : alphabet[c & 63];
  }
  return out;
}

/**
 * Area a WebContentsView occupies inside a slot: the chrome draws a header band
 * at the top of every slot so the identity stays visible even though a native
 * view paints over the page. A slot shorter than the header keeps a 1px view
 * rather than producing a negative height.
 *
 * `header` is a parameter because a single-cell stage has no band: with one cell
 * there is nothing to tell apart, and the window-level tab strip already answers
 * "which page is this". Passing `0` gives the page the whole rectangle.
 * Callers that lay out a real grid keep the default.
 */
export function embeddedViewRect(slot: StageRect, header = EMBEDDED_SLOT_HEADER): StageRect {
  const inset = Math.min(header, Math.max(0, slot.height - 1));
  return {
    x: slot.x,
    y: slot.y + inset,
    width: slot.width,
    height: Math.max(1, slot.height - inset),
  };
}

/**
 * Whether a stage with this many cells draws a per-cell header band.
 *
 * A layout is a comparison: several cells whose identity and pages have to stay
 * distinguishable. One cell is just the browser, and the band there duplicated
 * the window's own tab strip — a second row of the same thing, one row lower.
 * Both surfaces read this, so the rule cannot drift between the geometry the
 * main process computes and the chrome the renderer draws.
 */
export function stageDrawsSlotHeaders(slotCount: number): boolean {
  return slotCount > 1;
}

/**
 * A page rendered at a fixed CSS viewport instead of filling its cell.
 *
 * The page lays out at exactly `width × height` — `innerWidth` and every media
 * query see the target — while the view is scaled down to fit the cell, like
 * devtools responsive mode. `undefined` (no override) means adaptive: fill the
 * cell, which is the default.
 */
export interface EmbeddedViewport {
  width: number;
  height: number;
}

/** The narrowest real device width; below 320 nothing renders meaningfully. */
export const VIEWPORT_MIN = 320;
/** 4K is the widest screen worth simulating. */
export const VIEWPORT_MAX_WIDTH = 3840;
export const VIEWPORT_MAX_HEIGHT = 2160;

/**
 * Common devices and desktop sizes, ordered small → large. These are the menu's
 * one-tap answers; anything else goes through the custom input.
 *
 * These are **viewports**, not devices: they change how big the page thinks it
 * is and nothing else. The page still sees a desktop browser — no touch, desktop
 * UA, `pointer: fine`. `DEVICE_PRESETS` below is the other half.
 */
export const VIEWPORT_PRESETS: Array<EmbeddedViewport & { name: string }> = [
  { name: "320 × 640", width: 320, height: 640 },
  { name: "390 × 844", width: 390, height: 844 },
  { name: "768 × 1024", width: 768, height: 1024 },
  { name: "1024 × 768", width: 1024, height: 768 },
  { name: "1280 × 720", width: 1280, height: 720 },
  { name: "1366 × 768", width: 1366, height: 768 },
  { name: "1920 × 1080", width: 1920, height: 1080 },
];

/**
 * A simulated device: the viewport plus everything that makes a page believe it
 * is on a phone.
 *
 * Two separate things, deliberately kept apart:
 *
 * - A **viewport** is geometry. It is useful on its own (check a 768px layout
 *   without resizing the window) and leaves the page a desktop browser.
 * - A **device** is an identity. `innerWidth` alone never makes a site serve its
 *   mobile UI; it also reads `navigator.maxTouchPoints`, `matchMedia("(pointer:
 *   coarse)")`, and the UA — and redirects to `/m` or shows an "open our app"
 *   banner on the last one.
 *
 * A device therefore *contains* a viewport. The menu offers both, and switching
 * from a device back to a viewport keeps the size and drops the rest, which is
 * the direction a person actually moves while debugging.
 */
export interface EmbeddedDevice extends EmbeddedViewport {
  /** Device pixel ratio the page should report (`innerWidth` stays CSS px). */
  dpr: number;
  /** UA string; absent leaves the browser's own. */
  userAgent?: string;
  /** Whether to emulate touch. A tablet or phone sets this; a console does not. */
  touch: boolean;
  /** One-tap menu label; absent for anything the user typed. */
  name?: string;
}

/**
 * Devices worth one click.
 *
 * Sizes are the CSS-pixel viewports Chrome's own device list uses, so a layout
 * checked here matches what the same page shows in Chrome's responsive mode.
 * The list is short on purpose: every entry is a claim about a device somebody
 * actually opens this app to test, and a long list makes the menu unusable.
 */
export const DEVICE_PRESETS: EmbeddedDevice[] = [
  {
    name: "iPhone 15",
    width: 393,
    height: 852,
    dpr: 3,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  {
    name: "iPhone SE",
    width: 375,
    height: 667,
    dpr: 2,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  },
  {
    name: "Pixel 8",
    width: 412,
    height: 915,
    dpr: 2.625,
    touch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  },
  {
    name: "Galaxy S24",
    width: 360,
    height: 780,
    dpr: 3,
    touch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  },
  {
    name: "iPad mini",
    width: 744,
    height: 1133,
    dpr: 2,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
];

/** Device pixel ratios a browser will actually report; outside this is a typo. */
export const DEVICE_DPR_MIN = 1;
export const DEVICE_DPR_MAX = 5;

/**
 * Performance metrics the monitor shows, in display order.
 *
 * The order is Chrome's own performance monitor, and it is not arbitrary:
 * headline cost first (CPU), then what it costs in memory (heap), then the
 * page's structure (nodes, listeners, documents, frames), then churn (layouts
 * and style recalculations per second). Reading top to bottom answers "is it
 * busy", "is it growing", "is it bloated", "is it thrashing".
 *
 * In `shared/` because the panel renders them: `core/` is Electron-free but not
 * renderer-safe, and the list has to mean the same thing on both sides or the
 * table and the sampler disagree about what exists.
 */
export const PERF_METRICS = [
  "cpu",
  "heap",
  "nodes",
  "listeners",
  "documents",
  "frames",
  "layouts",
  "styleRecalcs",
] as const;

export type PerfMetric = (typeof PERF_METRICS)[number];

/**
 * One performance sample, in display units.
 *
 * Lives in `shared/` rather than beside the sampler because it crosses the IPC
 * boundary: the panel draws these directly and must not import from `core/`
 * (which is Electron-free but not renderer-safe).
 */
export interface PerfSample {
  /** Milliseconds since the page started being sampled. */
  t: number;
  /** Wall clock, so a sample can be matched against a log line. */
  at: string;
  /** CPU busy percent over the interval; the headline number. */
  cpu: number;
  nodes: number;
  listeners: number;
  documents: number;
  frames: number;
  /** JS heap in bytes. */
  heap: number;
  /** Layouts per second over the interval. */
  layouts: number;
  /** Style recalculations per second over the interval. */
  styleRecalcs: number;
}

/**
 * How often the performance panel samples.
 *
 * Edge and Chrome sample once a second, which is enough to see a trend and not
 * enough to see a stutter: a 200ms freeze lands entirely between two samples.
 * `Performance.getMetrics` is a cheap counter read, so the cost of 5 Hz is the
 * point read itself, not a tracing session.
 */
export const PERF_SAMPLE_INTERVAL_MS = 200;

/**
 * The span the chart shows, in milliseconds.
 *
 * Chosen for resolution, not for history: the docked panel is roughly 200–350px
 * wide, so a minute across it is ~4px per second and a 200ms stutter becomes
 * sub-pixel — the chart looks smooth while the page is not. Twenty seconds puts
 * ~11px between seconds, which is the range where a burst has a visible shape.
 *
 * It is a *window*, not a cap: the axis is always this wide, its right edge is
 * "now", and older samples leave at the left. Deriving the axis from whatever
 * data exists (the earlier behaviour) rescaled the whole curve on every tick,
 * which read as the chart zooming on its own.
 */
export const PERF_WINDOW_MS = 20_000;

/**
 * Samples kept, newest last.
 *
 * A window's worth at the interval above, and also the hard cap: trimming is by
 * time first (see `pushSample`), because a busy page delays the sampler and a
 * count-only cap would then keep more than a window of history.
 */
export const PERF_HISTORY_LIMIT = Math.round(PERF_WINDOW_MS / PERF_SAMPLE_INTERVAL_MS);

/**
 * Rounds a series peak up to a readable axis top.
 *
 * Two things it has to prevent: an all-zero series dividing by zero, and a
 * chart whose top edge is exactly the highest sample (a steady line then reads
 * as "pinned to the ceiling" instead of "flat"). The 10% headroom is what makes
 * a constant series visibly flat rather than visibly clipped.
 */
export function perfAxisMax(peak: number, ceiling = Number.POSITIVE_INFINITY): number {
  const value = Math.max(1, peak) * 1.1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const stepped = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].map((factor) => factor * magnitude);
  const top = stepped.find((candidate) => value <= candidate) ?? 10 * magnitude;
  return Math.min(ceiling, Math.max(1, top));
}

/**
 * The largest value a metric reached across the samples, floored at 1.
 *
 * Floored so a series of zeros has something to scale against; every caller
 * feeds the result to `perfAxisMax`, which adds the readable rounding.
 */
export function perfPeak(history: PerfSample[], metric: PerfMetric): number {
  let peak = 0;
  for (const sample of history) {
    const value = sample[metric];
    if (value > peak) peak = value;
  }
  return Math.max(1, peak);
}

/**
 * The points of one metric's line inside `width × height`.
 *
 * x is wall time, not sample index: the renderer can drop a tick (a busy page
 * delays the timer), and spacing samples evenly would silently compress the
 * gaps and misreport when a spike happened.
 *
 * The horizontal scale is **fixed at one window, ending now**, and never fitted
 * to the data. Fitting meant the axis was re-derived from "oldest sample to
 * newest" on every tick, so a freshly opened panel drew one second of data
 * across the whole chart and then squeezed it as more arrived — the curve
 * appeared to zoom out on its own, and a 200ms stutter looked like a long slow
 * wave. With a fixed scale the newest sample is always at the right edge; a
 * young series occupies only its own slice at that edge, and once a full window
 * is on screen the oldest samples fall off the left while new ones arrive on the
 * right. The window therefore slides from the first frame, not only after it
 * fills.
 *
 * `axisMax` is passed in rather than derived so every lane can share one when
 * that is the honest comparison — CPU in percent, for instance — while the
 * default per-metric scaling keeps eight series with different units readable
 * side by side.
 *
 * Returned as numbers rather than a path string because the panel draws two
 * shapes from the same points — the line and the area under it — and the area
 * has to close on the baseline at both ends.
 */
export function perfSparkPoints(
  history: PerfSample[],
  metric: PerfMetric,
  width: number,
  height: number,
  axisMax: number,
  windowMs = PERF_WINDOW_MS,
): Array<{ x: number; y: number }> {
  if (history.length < 2) return [];
  const span = Math.max(1, windowMs);
  // The right edge is "now"; the left edge is one window earlier. Not anchored
  // to the first sample: that would move the axis every tick, which is the
  // rescaling this fixed window exists to stop.
  const origin = history[history.length - 1]!.t - span;
  const top = Math.max(1, axisMax);
  return history.map((sample) => ({
    // Clamped: a sample older than the window would otherwise draw to the left
    // of the plot, into the tick gutter.
    x: Math.min(width, Math.max(0, ((sample.t - origin) / span) * width)),
    // One pixel of inset top and bottom: a sample sitting exactly at the
    // maximum would otherwise draw its stroke half outside the viewBox.
    y: height - 1 - Math.min(1, Math.max(0, sample[metric] / top)) * (height - 2),
  }));
}

/** Those points as an SVG polyline path. */
export function perfPolyline(points: Array<{ x: number; y: number }>): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");
}

/**
 * The same line closed down to the baseline, for the filled area.
 *
 * A fill is what makes a low, spiky series readable: a 1px line at the bottom
 * of a 30px lane is nearly invisible, while the shaded region below it shows
 * the shape and the proportion at once. The fill is drawn with low opacity by
 * the caller, so two rows can never obscure each other.
 */
export function perfArea(points: Array<{ x: number; y: number }>, height: number): string {
  if (points.length === 0) return "";
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const baseline = height - 1;
  return `${perfPolyline(points)} L${last.x.toFixed(1)},${baseline} L${first.x.toFixed(1)},${baseline} Z`;
}

/** A metric's line as a path string; a thin wrapper over the two helpers above. */
export function perfSparkPath(
  history: PerfSample[],
  metric: PerfMetric,
  width: number,
  height: number,
  axisMax: number,
  windowMs = PERF_WINDOW_MS,
): string {
  return perfPolyline(perfSparkPoints(history, metric, width, height, axisMax, windowMs));
}

/**
 * A compact label for an axis tick.
 *
 * The gutter beside each chart is about 36px wide, so this has to say "16.9 MB"
 * in six glyphs: `17M`. Units are already in the row's name ("JS 堆大小",
 * "布局/秒"), which is the only place that can afford the words.
 *
 * Ticks are rounded *down* to a readable number rather than reporting the
 * precise cap: an axis that says `2.38M` beside a series that never exceeds
 * `1.8M` invites the reader to check the arithmetic instead of reading the
 * chart. `1.8M` and `2M` are both fine; `2.38M` is a number nobody chose.
 */
export function perfAxisLabel(metric: PerfMetric, value: number): string {
  // Zero keeps the metric's own unit: a CPU scale reading "100% / 50% / 0" has
  // one label that belongs to a different axis.
  if (!Number.isFinite(value) || value <= 0) return metric === "cpu" ? "0%" : "0";
  /** Two significant digits, which is as much as 36px can show. */
  const compact = (number: number): string => {
    if (number >= 10) return String(Math.round(number));
    if (number >= 1) return String(Math.round(number * 10) / 10);
    return String(Math.round(number * 100) / 100);
  };
  switch (metric) {
    case "cpu": {
      // Percentages are read to a tenth: the difference between 12.4% and 12%
      // is the difference between "idle" and "working a little".
      const rounded = Math.round(value * 10) / 10;
      return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
    }
    case "heap": {
      const units = ["B", "K", "M", "G"];
      const power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
      const scaled = value / 1024 ** power;
      // One decimal below 10 (1.8M), none above (17M): more digits than the
      // gutter can show, and none of them change a decision.
      const shown = scaled >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
      return `${shown}${units[power]}`;
    }
    case "layouts":
    case "styleRecalcs":
      return compact(value);
    default:
      return value >= 10_000 ? `${compact(value / 1000)}k` : String(Math.round(value));
  }
}



/**
 * Rejects a hand-typed device the same way `normalizeViewportSize` rejects a
 * size: a wrong value is reported, never silently corrected.
 *
 * The UA is capped rather than validated — there is no such thing as an invalid
 * UA string, only one too long to be worth storing, and a device with junk in
 * that field is harmless (a site simply treats it as unknown).
 */
export function normalizeDevice(input: {
  width: unknown;
  height: unknown;
  dpr: unknown;
  touch: unknown;
  userAgent?: unknown;
}): EmbeddedDevice | undefined {
  const size = normalizeViewportSize(input.width, input.height);
  if (!size) return undefined;
  const dpr = typeof input.dpr === "number" ? input.dpr : Number(input.dpr);
  if (!Number.isFinite(dpr) || dpr < DEVICE_DPR_MIN || dpr > DEVICE_DPR_MAX) return undefined;
  const userAgent =
    typeof input.userAgent === "string" && input.userAgent.trim()
      ? input.userAgent.trim().slice(0, 400)
      : undefined;
  return {
    ...size,
    dpr: Math.round(dpr * 1000) / 1000,
    touch: input.touch === true,
    ...(userAgent ? { userAgent } : {}),
  };
}

/**
 * Rejects anything that is not a whole number inside the supported range.
 * Silent clamping would hide a fat-fingered width, so callers get `undefined`
 * and report the usable range instead.
 */
export function normalizeViewportSize(
  width: unknown,
  height: unknown,
): EmbeddedViewport | undefined {
  const ok = (value: unknown, max: number): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= VIEWPORT_MIN && value <= max;
  if (!ok(width, VIEWPORT_MAX_WIDTH) || !ok(height, VIEWPORT_MAX_HEIGHT)) return undefined;
  return { width, height };
}

/**
 * The rect a fixed-viewport page occupies inside its cell: scaled down to fit
 * (never up), centred, plus the scale to apply as the page's zoom factor so the
 * CSS viewport stays exactly the requested size.
 *
 * With bounds `w·f × h·f` and zoom `f`, the page lays out at
 * `bounds / zoom = w × h` — the scripts and stylesheets see the real target,
 * the user sees a proportionally scaled preview of it.
 */
export function viewportFitRect(
  cell: StageRect,
  size: EmbeddedViewport,
): { rect: StageRect; scale: number } {
  const scale = Math.min(1, cell.width / size.width, cell.height / size.height);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  return {
    rect: {
      x: cell.x + Math.round((cell.width - width) / 2),
      y: cell.y + Math.round((cell.height - height) / 2),
      width,
      height,
    },
    scale,
  };
}

/**
 * Fills `slotTabs` from the tab order: explicit pins win, duplicates and unknown
 * ids are dropped, and the remaining slots take the remaining tabs in order. The
 * result always has exactly `slotCount` entries so callers can index it safely.
 *
 * `allowDuplicates` exists for one gesture: dropping two pages of the same
 * instance into two cells, which is how one account gets compared side by side.
 * The default stays strict because a slot table that silently repeats an
 * instance from a stale pin would show the same page twice with no way to tell
 * why.
 */
export function resolveSlotTabs(
  tabIds: string[],
  current: (string | null)[] | undefined,
  slotCount: number,
  options?: { allowDuplicates?: boolean },
): (string | null)[] {
  const known = new Set(tabIds);
  const taken = new Set<string>();
  const slots: (string | null)[] = [];
  for (let index = 0; index < slotCount; index += 1) {
    const pinned = current?.[index];
    const usable = Boolean(pinned) && known.has(pinned as string) && (
      options?.allowDuplicates || !taken.has(pinned as string)
    );
    if (usable) {
      slots.push(pinned as string);
      taken.add(pinned as string);
    } else {
      slots.push(null);
    }
  }
  const remaining = tabIds.filter((id) => !taken.has(id));
  for (let index = 0; index < slots.length && remaining.length > 0; index += 1) {
    if (slots[index]) continue;
    slots[index] = remaining.shift() ?? null;
  }
  return slots;
}

/**
 * Keeps only the page pins that still mean something.
 *
 * `slotPages[i]` says "this cell shows *that* page of the instance in
 * `slotTabs[i]`". Two conditions make a pin meaningless, and both have bitten:
 *
 * 1. The page is gone (closed) or belongs to a different instance.
 * 2. The instance no longer fills more than one cell. A pin left behind in a
 *    single cell freezes it: the strip lists every page, clicking one moves the
 *    window's active page, and the picture does not change.
 *
 * Pure so the rule can be tested without Electron; the caller supplies the
 * instance lookup.
 */
export function resolveSlotPages(
  slotTabs: (string | null)[],
  current: (string | null)[] | undefined,
  instanceOf: (tabId: string) => string | undefined,
): (string | null)[] {
  const pages: (string | null)[] = new Array<string | null>(slotTabs.length).fill(null);
  for (let index = 0; index < slotTabs.length; index += 1) {
    const pinnedId = current?.[index];
    const rootId = slotTabs[index];
    if (!pinnedId || !rootId) continue;
    const instance = instanceOf(pinnedId);
    if (!instance || instance !== instanceOf(rootId)) continue;
    const cells = slotTabs.filter((id) => id === rootId).length;
    if (cells < 2) continue;
    pages[index] = pinnedId;
  }
  return pages;
}

/**
 * Keeps the dropped page from claiming two cells at once.
 *
 * After a split lands, the same instance may still occupy other cells — and one
 * of them can end up showing the very page that was just dropped into the
 * target cell, either through its own pin or by following the instance's active
 * page. One page is one surface: laid out twice, the second `setBounds` simply
 * overwrites the first, so the other cell goes dark while its strip keeps
 * naming a page that is not there.
 *
 * The rule the target cell forces on its siblings:
 *
 * 1. The dropped page owns the target cell.
 * 2. Any sibling cell of the same instance that would show the dropped page is
 *    re-pinned to the instance's earliest remaining page, in creation order.
 * 3. A single-page instance cannot fill two cells: its extra cell releases the
 *    instance entirely (`released`), and the caller re-resolves the slot table
 *    so another instance, if one is waiting, can take the cell.
 *
 * Pure so the rule can be tested without Electron.
 */
export function settleSplitPages(input: {
  slotTabs: (string | null)[];
  slotPages: (string | null)[];
  slotIndex: number;
  rootId: string;
  pageId: string;
  instanceActiveId?: string;
  otherPages: string[];
}): { slotTabs: (string | null)[]; slotPages: (string | null)[]; released: number[] } {
  const slotTabs = [...input.slotTabs];
  const slotPages = [...input.slotPages];
  const released: number[] = [];
  for (let index = 0; index < slotTabs.length; index += 1) {
    if (index === input.slotIndex) continue;
    if (slotTabs[index] !== input.rootId) continue;
    const effective = slotPages[index] ?? input.instanceActiveId;
    if (effective !== input.pageId) continue;
    const fallback = input.otherPages[0];
    if (fallback) {
      slotPages[index] = fallback;
    } else {
      slotTabs[index] = null;
      slotPages[index] = null;
      released.push(index);
    }
  }
  return { slotTabs, slotPages, released };
}

/**
 * Puts a tab on stage, replacing whatever held the focused slot.
 *
 * Replacing rather than appending is what makes "click an off-stage tab" cheap to
 * undo: the tab that just left the stage is now next to it, so clicking it again
 * swaps back. Falls back to the first slot when nothing is focused.
 */
export function stageTab(
  view: Pick<EmbeddedView, "slotTabs" | "focusedTabId">,
  tabId: string,
): (string | null)[] {
  const slots = [...view.slotTabs];
  if (slots.length === 0 || slots.includes(tabId)) return slots;
  const focused = view.focusedTabId ? slots.indexOf(view.focusedTabId) : -1;
  slots[focused >= 0 ? focused : 0] = tabId;
  return slots;
}

/**
 * The five click rules of the surface, in one place.
 *
 *   click any tab -> switch to its view; if it was off stage, swap it into that
 *   view's focused slot.
 *
 * Keeping this pure means the manager and the tests exercise the same rules. The
 * caller is responsible for re-laying out when `layoutChanged` is true.
 */
export function planTabClick(
  state: Pick<EmbeddedState, "tabs" | "views" | "activeTabId" | "activeViewId">,
  tabId: string,
): Pick<EmbeddedState, "activeTabId" | "activeViewId" | "views"> & { layoutChanged: boolean } {
  const tab = state.tabs.find((item) => item.id === tabId);
  const fail = {
    ...(state.activeTabId ? { activeTabId: state.activeTabId } : {}),
    ...(state.activeViewId ? { activeViewId: state.activeViewId } : {}),
    views: state.views,
    layoutChanged: false,
  };
  if (!tab) return fail;
  if (!tab.viewId) {
    return { activeTabId: tab.id, views: state.views, layoutChanged: false };
  }
  const view = state.views.find((item) => item.id === tab.viewId);
  if (!view) return { activeTabId: tab.id, views: state.views, layoutChanged: false };
  if (view.slotTabs.includes(tab.id)) {
    return {
      activeTabId: tab.id,
      activeViewId: view.id,
      views: state.views.map((item) =>
        item.id === view.id ? { ...item, focusedTabId: tab.id } : item,
      ),
      layoutChanged: false,
    };
  }
  return {
    activeTabId: tab.id,
    activeViewId: view.id,
    views: state.views.map((item) =>
      item.id === view.id
        ? { ...item, slotTabs: stageTab(view, tab.id), focusedTabId: tab.id }
        : item,
    ),
    layoutChanged: true,
  };
}

/**
 * Session partition for an identity's embedded pages.
 *
 * Deliberately separate from the identity's on-disk browser profile: those two
 * profiles are written by different Chromium builds, and pointing Electron at a
 * profile a newer Chrome last wrote risks a downgrade migration. Separate also
 * means the embedded surface cannot corrupt a working external login.
 */
export function embeddedPartition(key: string): string {
  return `persist:embedded-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Fixed partition for the user's everyday browsing.
 *
 * Pages with no identity land here: the new-tab surface, a bookmark, a URL typed
 * into the address bar. It persists on purpose — logging in once has to keep
 * working across restarts, which is the whole point of being able to use this as
 * a normal browser and to let an assistant act on an already signed-in profile.
 *
 * The value still reads "clean" because that is the partition earlier versions
 * gave every identity-less page. Keeping the exact string adopts whatever logins
 * the user already has: an upgrade must not sign them out of everything. The
 * throwaway session below is a new name, so nothing old has to be migrated there.
 */
export const EMBEDDED_DAILY_PARTITION = "persist:embedded-clean";

/**
 * Prefix for a throwaway session, one per browser instance.
 *
 * No `persist:` prefix on purpose: Electron keeps such a session in memory only,
 * so its cookies die with the process. That is what "clean open" promises, and
 * the old shared, persistent partition could not keep it — it survived quitting
 * and was handed to the next clean tab as well.
 *
 * Keyed by instance so two clean instances never see each other's login either,
 * while the pages and popups of one instance still share it (a login flow that
 * opens a popup has to work).
 */
export const EMBEDDED_CLEAN_PREFIX = "embedded-clean-";

export function embeddedCleanPartition(instanceId: string): string {
  return `${EMBEDDED_CLEAN_PREFIX}${instanceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * Which partition a page belongs to.
 *
 * An identity gets its own partition; an everyday page shares the daily profile;
 * an explicit clean open gets a throwaway session of its own.
 */
export function embeddedTabPartition(input: {
  identityId?: string;
  clean?: boolean;
  /** Instance the page belongs to; names the throwaway session. */
  instanceId: string;
}): string {
  if (input.identityId) return embeddedPartition(input.identityId);
  return input.clean ? embeddedCleanPartition(input.instanceId) : EMBEDDED_DAILY_PARTITION;
}

/**
 * Only http(s) and about:blank are navigable inside the embedded surface.
 * Everything else is either handed to the OS (`mailto:`) or refused, so a page
 * cannot use the embedded browser as a bridge to local files.
 */
export function normalizeEmbeddedUrl(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (value === "about:blank") return value;
  const parsed = parseHttpUrl(value);
  if (parsed) return parsed;
  // A bare host such as "localhost:3000" parses as a URL whose scheme is
  // "localhost:", not as a failure — so the retry has to sit outside the parse
  // attempt rather than in a catch block.
  if (value.includes("://")) return undefined;
  return parseHttpUrl(`http://${value}`);
}

function parseHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Strips the Electron token so sites do not classify the client as unusual. */
export function desktopUserAgent(raw: string): string {
  return raw
    .replace(/\sElectron\/[\d.]+/i, "")
    .replace(/\s+Ensemble\/[\d.]+/i, "")
    .trim();
}

export { FREE_LAYOUT_ID };
