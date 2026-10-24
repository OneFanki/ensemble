import { BUILTIN_LAYOUTS, FREE_LAYOUT_ID } from "./layouts";
import type { LayoutId, RoleColor, SlotRect } from "./types";

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
  /** True for the page currently shown by its instance. */
  active: boolean;
  /** Effective zoom in percent; `100` means the page renders at its natural size. */
  zoom: number;
  /** True while this page's DevTools are open (docked by default). */
  devtoolsOpen: boolean;
  /**
   * Native view geometry, in window content coordinates.
   *
   * Reported so a test can prove an off-stage page is really outside the window
   * rather than trusting the code that moved it — a parked view left inside
   * paints over whatever page is on screen, which is invisible to the renderer.
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
}

/** Where a dragged tab is being dropped. */
export type EmbeddedDropTarget =
  | { kind: "tab"; tabId: string; edge: "before" | "after" | "middle" }
  | { kind: "view"; viewId: string }
  | { kind: "loose" };

/**
 * One captured page, positioned where its native view sits.
 *
 * Native views paint above all HTML, so an app overlay that reaches into the
 * stage only stays readable if the stage is frozen into images first. Every
 * on-stage tab is captured, not just the focused one: a 2×2 view frozen into a
 * single image would leave three black cells behind the overlay.
 */
export interface FrozenSlot {
  tabId: string;
  rect: StageRect;
  dataUrl: string;
}

/** Rectangle in the window's content area, CSS pixels. */
export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Height of the per-slot header the chrome draws above each embedded view. */
export const EMBEDDED_SLOT_HEADER = 26;

/**
 * Width of the draggable gutter between adjacent slots.
 *
 * Native pages paint over HTML, so a divider drawn on the exact boundary would
 * be covered by the page. Every view is therefore inset by this much on an
 * internal edge, which leaves a visible, clickable seam for the divider.
 */
export const EMBEDDED_DIVIDER = 8;

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
 * Bounds for a page that is alive but must not be seen.
 *
 * Every number here was measured on Electron 44 / Chromium 152, because both
 * obvious choices are wrong in ways that only show up later:
 *
 * - `setVisible(false)` keeps scripts running but makes CDP screenshots time
 *   out, and the AI surface takes screenshots.
 * - A large negative coordinate (the classic `-100000` park) makes Chromium
 *   hand the renderer a 0×0 viewport: scripts run, but the document lays out at
 *   zero width, so "is this text visible" and every element position are wrong.
 *
 * So the view keeps its size and sits immediately past the window's content
 * edge. The edge is the *window's*, not the stage's: the stage starts to the
 * right of the navigation rail, so parking at the stage's width leaves the page
 * sitting inside the window, painted over whatever page is on screen.
 */
export function parkedViewBounds(content: { width: number; height: number }): StageRect {
  const width = Math.max(1, Math.round(content.width));
  const height = Math.max(1, Math.round(content.height));
  return { x: width, y: 0, width, height };
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
 */
export function embeddedViewRect(slot: StageRect): StageRect {
  const header = Math.min(EMBEDDED_SLOT_HEADER, Math.max(0, slot.height - 1));
  return {
    x: slot.x,
    y: slot.y + header,
    width: slot.width,
    height: Math.max(1, slot.height - header),
  };
}

/**
 * Fills `slotTabs` from the tab order: explicit pins win, duplicates and unknown
 * ids are dropped, and the remaining slots take the remaining tabs in order. The
 * result always has exactly `slotCount` entries so callers can index it safely.
 */
export function resolveSlotTabs(
  tabIds: string[],
  current: (string | null)[] | undefined,
  slotCount: number,
): (string | null)[] {
  const known = new Set(tabIds);
  const taken = new Set<string>();
  const slots: (string | null)[] = [];
  for (let index = 0; index < slotCount; index += 1) {
    const pinned = current?.[index];
    if (pinned && known.has(pinned) && !taken.has(pinned)) {
      slots.push(pinned);
      taken.add(pinned);
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

/** Fixed partition for throwaway sessions that belong to no identity. */
export const EMBEDDED_CLEAN_PARTITION = "persist:embedded-clean";

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
