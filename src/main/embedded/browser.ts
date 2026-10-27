import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDomSnapshotExpression,
  buildElementPointExpression,
  buildFocusExpression,
  buildReadExpression,
  buildSelectExpression,
  buildVisibilityExpression,
  buildWaitExpression,
  type DomSnapshot,
  describeTarget,
  type TargetInput,
  type VisibilityProbe,
  type WaitCondition,
  type WaitResult,
} from "@core/cdp/inspect";
import { buildAuthCheckExpression, buildFillExpression } from "@core/cdp/login";
import { type AiPageContext, aiOriginOf } from "@shared/ai-policy";
import {
  clampZoom,
  desktopUserAgent,
  DEVTOOLS_GRIP_WIDTH,
  EMBEDDED_SLOT_HEADER,
  type EmbeddedState,
  type EmbeddedTab,
  type EmbeddedView,
  embeddedPartition,
  embeddedSlotRects,
  embeddedTabPartition,
  embeddedViewRect,
  type FrozenSlot,
  inlineFavicon,
  insetSlotRects,
  isBlankTab,
  isEmbeddedLayout,
  neighborZoomStep,
  normalizeEmbeddedUrl,
  parkedViewBounds,
  planTabClick,
  resolveSlotTabs,
  type StageRect,
  ZOOM_STEPS,
} from "@shared/embedded";
import {
  type FlowRunResult,
  type FlowStep,
  type FlowStepResult,
  interpolateStep,
} from "@shared/flows";
import type { LayoutId, RoleColor, SlotRect } from "@shared/types";
import { BrowserWindow, Menu, screen, session, shell, WebContentsView, type WebContents } from "electron";
import { EmbeddedCdp } from "./cdp";
import { LOGIN_CAPTURE_BINDING, LOGIN_CAPTURE_SCRIPT } from "./login-capture";

export interface EmbeddedLoginPayload {
  username: string;
  password: string;
  submit: boolean;
  extraFields: { label: string; value: string }[];
  /** Site origin the credentials belong to. */
  baseUrl: string;
}

interface TabRecord {
  id: string;
  identityId?: string;
  siteId?: string;
  label: string;
  color?: RoleColor;
  viewId?: string;
  origin: "view" | "manual" | "ai";
  /**
   * Zoom this page was set to by hand, in percent.
   *
   * Absent means "follow the global default", which is what lets the setting
   * apply to every page the user has not touched while leaving a deliberately
   * zoomed page alone. It is in-memory on purpose: a tab does not survive a
   * restart, and persisting per-page zoom would resurrect settings for pages
   * that no longer exist.
   */
  zoomOverride?: number;
  /**
   * The browser instance (window) this page belongs to.
   *
   * A view slot is one isolated browser instance, not one page: a page can open
   * more pages with `window.open`, and those pages belong to the same instance
   * rather than becoming new slot candidates. The root page's id doubles as the
   * instance id.
   */
  instanceId: string;
  /** Page that opened this one, for ordering and for closing the opener's group. */
  openerId?: string;
  view: WebContentsView;
  cdp: EmbeddedCdp;
  url: string;
  title: string;
  /** Inlined site icon; cleared when the page moves to another origin. */
  favicon?: string;
  loading: boolean;
  /** `Runtime.addBinding` only needs to run once per target, not per navigation. */
  captureBinding?: boolean;
  crashed: boolean;
  /**
   * DevTools hosted by this app, rather than by Electron.
   *
   * `openDevTools({ mode: "right" })` cannot dock inside a `WebContentsView` —
   * Electron opens its own window instead, which is exactly the behaviour that
   * was not wanted. `setDevToolsWebContents` lets the tools render into a view
   * we own, so they sit inside the page's cell; the same view is re-parented
   * into a small window when the user asks to detach.
   */
  devtools?: {
    view: WebContentsView;
    /** Where the tools are shown right now. */
    mode: "docked" | "window";
    /** Set while they are shown in their own window. */
    window?: BrowserWindow;
    /** Fraction of the cell the docked panel takes. */
    width: number;
  };
}

interface ViewRecord extends EmbeddedView {
  /** Tabs this container was opened from; absent for hand-made views. */
  viewDefinitionId?: string;
}

export interface EmbeddedBrowserOptions {
  /** Where screenshots are written; created on demand. */
  shotDir: string;
  /** Icon for app-owned windows (the DevTools window), so none shows Electron's. */
  appIcon?: string;
  resolveLogin?: (identityId: string) => Promise<EmbeddedLoginPayload | undefined>;
  onStateChange?: (state: EmbeddedState) => void;
  /** Asks the renderer to switch to the browser page. */
  onShowPage?: () => void;
  /**
   * Never raise the host window.
   *
   * Set by automated runs, which drive a real app on a machine somebody is
   * working on. Raising the window is a user-facing courtesy — "you asked for
   * this page, here it is" — and a test asking for a page is not a user.
   */
  headless?: boolean;
  /** Persists a runtime layout change back to the view definition. */
  onViewLayoutChange?: (viewDefinitionId: string, layoutId: LayoutId) => void;
  onFocusTab?: (tabId: string) => void;
  /**
   * A login form was submitted inside an embedded page.
   *
   * The password travels from page to main through a CDP binding, never through
   * the app's renderer; the callback is where it is turned into a vault entry.
   */
  onLoginCaptured?: (capture: {
    tabId: string;
    username: string;
    password: string;
    origin: string;
    path: string;
  }) => void;
}

/** Scheme + host of a URL, or "" for anything that does not parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * The in-app browser surface.
 *
 * Pages live in `WebContentsView`s stacked inside the main window, so a whole
 * cast of accounts fits on one screen without opening a system window each. The
 * window's own renderer draws the chrome (tab strip, per-slot header, sidebar);
 * the native views paint over the stage below it.
 *
 * Only one view is on stage at a time: a view is a shared screen region, and
 * every view keeps its own grid layout and focused slot while it is off screen.
 *
 * Session partitions are per identity and separate from the external browser's
 * profile directory on purpose — see `embeddedPartition`.
 */
export class EmbeddedBrowser {
  private host: BrowserWindow | null = null;
  private tabs: TabRecord[] = [];
  private views: ViewRecord[] = [];
  /** Active page per browser instance; the page a slot shows. */
  private instanceActive = new Map<string, string>();
  /**
   * Instances opened as a deliberate clean session.
   *
   * Kept out of `TabRecord` because it is a property of the instance (the shared
   * session), not of a page: every page this instance opens has to stay in the
   * same throwaway partition, or a popup mid-flow would silently switch to the
   * daily profile.
   */
  private cleanInstances = new Set<string>();
  private activeTabId: string | undefined;
  private activeViewId: string | undefined;
  private stage: StageRect | null = null;
  /** Last stage size, kept so off-screen pages keep a realistic viewport. */
  private lastStage: StageRect | null = null;
  /**
   * Last window content size that was actually readable.
   *
   * Parking coordinates must clear the *window* edge, never the stage edge, and
   * the window can be briefly unmeasurable (hidden to the tray). Keeping the
   * last good value is what lets `hostContentSize` honour that invariant instead
   * of falling back to a number that puts pages on top of the dock.
   */
  private lastContentSize: { width: number; height: number } | null = null;
  private pendingState = false;
  private viewSeq = 0;
  /**
   * Rebuilds in flight, one per page at most.
   *
   * The ticket lets a close cancel a rebuild that is already waiting for the
   * old front-end to die: without it, closing the panel during that wait let the
   * rebuild bring it back a moment later.
   */
  private devtoolsRebuilds = new Map<string, { cancelled: boolean }>();
  /** Default zoom for pages that have not been adjusted by hand. */
  private defaultZoom = 100;
  /**
   * Downloaded icons, keyed by source URL.
   *
   * Many pages of one site share an icon and a site re-reports it on every
   * navigation, so fetching per event would hit the network far more than
   * needed. Bounded because the entries hold base64 payloads.
   */
  private faviconCache = new Map<string, { data: string; fetched: number }>();

  constructor(private readonly options: EmbeddedBrowserOptions) {}

  /**
   * Applies the global zoom setting.
   *
   * Pages with no override follow it, so changing the setting is visible on
   * every untouched page immediately. A page the user zoomed by hand keeps its
   * factor: silently resetting it would undo exactly what the keystroke was for.
   */
  setDefaultZoom(percent: number): void {
    const next = clampZoom(percent);
    if (next === this.defaultZoom) return;
    this.defaultZoom = next;
    for (const tab of this.tabs) {
      if (tab.zoomOverride !== undefined) continue;
      this.applyZoom(tab, next);
    }
    this.emitState();
  }

  /** Binds the surface to the main window; safe to call again on recreation. */
  attach(win: BrowserWindow): void {
    if (this.host === win) return;
    this.host = win;
    this.stage = null;
    for (const tab of this.tabs) this.attachView(tab);
    // A destroyed window takes its child views with it; drop the records rather
    // than keeping handles to closed renderers.
    win.once("closed", () => {
      if (this.host !== win) return;
      this.host = null;
      this.stage = null;
      this.closeAllTabs();
      this.emitState();
    });
    // Parked pages sit just past the content edge, so shrinking the window would
    // pull them back inside and paint them over whatever page is showing. A full
    // re-layout re-parks them and then puts the page on stage back with the last
    // known stage rect; the renderer's resize observer corrects that rect a
    // moment later. Doing only the parking would leave the stage blank during
    // the drag.
    win.on("resize", () => {
      if (this.host !== win) return;
      this.applyLayout();
    });
    this.parkAll();
    this.sendState();
  }

  isOpen(): boolean {
    return Boolean(this.host && !this.host.isDestroyed());
  }

  state(): EmbeddedState {
    return {
      tabs: this.tabs.map((tab) => this.describe(tab)),
      views: this.views.map((view) => this.describeView(view)),
      ...(this.activeTabId ? { activeTabId: this.activeTabId } : {}),
      ...(this.activeViewId ? { activeViewId: this.activeViewId } : {}),
    };
  }

  private describe(tab: TabRecord): EmbeddedTab {
    const contents = tab.view.webContents;
    return {
      id: tab.id,
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      ...(tab.siteId ? { siteId: tab.siteId } : {}),
      label: tab.label,
      ...(tab.color ? { color: tab.color } : {}),
      url: tab.url,
      title: tab.title,
      ...(tab.favicon ? { favicon: tab.favicon } : {}),
      loading: tab.loading,
      canGoBack: this.safeNav(tab, "canGoBack"),
      canGoForward: this.safeNav(tab, "canGoForward"),
      ...(tab.viewId ? { viewId: tab.viewId } : {}),
      origin: tab.origin,
      instanceId: tab.instanceId,
      ...(tab.openerId ? { openerId: tab.openerId } : {}),
      ...(this.cleanInstances.has(tab.instanceId) ? { clean: true } : {}),
      active: this.instanceActive.get(tab.instanceId) === tab.id,
      zoom: tab.zoomOverride ?? this.defaultZoom,
      devtoolsOpen: this.devtoolsOpen(tab),
      ...(tab.devtools?.mode === "docked" ? { devtoolsWidth: tab.devtools.width } : {}),
      ...(contents.isDestroyed()
        ? {}
        : {
            bounds: (() => {
              const rect = tab.view.getBounds();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            })(),
          }),
    };
  }

  /**
   * Whether this page's DevTools are open.
   *
   * Our own record is authoritative: when the tools are hosted in a
   * `WebContentsView` we created, Chromium's `isDevToolsOpened()` reports false
   * even though they are live and painting. The native query is kept as a
   * fallback for the moment before our view is registered.
   */
  private devtoolsOpen(tab: TabRecord): boolean {
    if (tab.devtools) return true;
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return false;
    try {
      return contents.isDevToolsOpened();
    } catch {
      return false;
    }
  }

  private describeView(view: ViewRecord): EmbeddedView {
    return {
      id: view.id,
      name: view.name,
      ...(view.color ? { color: view.color } : {}),
      ...(view.viewDefinitionId ? { viewDefinitionId: view.viewDefinitionId } : {}),
      layoutId: view.layoutId,
      ...(view.slotRects?.length ? { slotRects: view.slotRects.map((rect) => ({ ...rect })) } : {}),
      slotTabs: [...view.slotTabs],
      collapsed: view.collapsed,
      ...(view.focusedTabId ? { focusedTabId: view.focusedTabId } : {}),
    };
  }

  private safeNav(tab: TabRecord, direction: "canGoBack" | "canGoForward"): boolean {
    try {
      const history = tab.view.webContents.navigationHistory;
      return direction === "canGoBack" ? history.canGoBack() : history.canGoForward();
    } catch {
      return false;
    }
  }

  /** Raises the main window and asks its renderer to show the browser page. */
  focusPage(): void {
    const host = this.host;
    // Still tell the renderer which page to show — the window just does not come
    // forward, so an automated run leaves the desktop alone.
    if (this.options.headless) {
      this.options.onShowPage?.();
      return;
    }
    if (!host || host.isDestroyed()) return;
    if (host.isMinimized()) host.restore();
    host.show();
    host.focus();
    this.options.onShowPage?.();
  }

  /** The renderer reports where the views may paint. */
  setStage(stage: StageRect | null): void {
    this.stage = stage;
    if (stage) this.lastStage = stage;
    this.applyLayout();
  }

  // ---------- views ----------

  private findView(viewId: string): ViewRecord | undefined {
    return this.views.find((view) => view.id === viewId);
  }

  private requireView(viewId: string): ViewRecord {
    const view = this.findView(viewId);
    if (!view) throw new Error(`视图不存在：${viewId}`);
    return view;
  }

  private activeView(): ViewRecord | undefined {
    return this.activeViewId ? this.findView(this.activeViewId) : undefined;
  }

  private viewTabs(viewId: string): TabRecord[] {
    return this.tabs.filter((tab) => tab.viewId === viewId);
  }

  /** Pages of one browser instance, in creation order. */
  private instanceTabs(instanceId: string): TabRecord[] {
    return this.tabs.filter((tab) => tab.instanceId === instanceId);
  }

  /** The page id that doubles as the instance id. */
  private instanceRoot(instanceId: string): TabRecord | undefined {
    return this.tabs.find((tab) => tab.id === instanceId) ?? this.instanceTabs(instanceId)[0];
  }

  /** Page the instance is currently showing; falls back to its first page. */
  private activePageOf(instanceId: string): TabRecord | undefined {
    const activeId = this.instanceActive.get(instanceId);
    return (
      (activeId ? this.tabs.find((tab) => tab.id === activeId) : undefined) ??
      this.instanceRoot(instanceId)
    );
  }

  /** One representative (the root) per instance inside a view. */
  private viewRoots(viewId: string): TabRecord[] {
    const seen = new Set<string>();
    const roots: TabRecord[] = [];
    for (const tab of this.tabs) {
      if (tab.viewId !== viewId || seen.has(tab.instanceId)) continue;
      seen.add(tab.instanceId);
      const root = this.instanceRoot(tab.instanceId);
      if (root) roots.push(root);
    }
    return roots;
  }

  /**
   * Switches which page an instance shows.
   *
   * Slot membership is by instance, so this changes pixels without touching the
   * layout: a page opened by `window.open` takes over its opener's slot.
   */
  private setActivePage(tab: TabRecord): void {
    this.instanceActive.set(tab.instanceId, tab.id);
  }

  /**
   * Marks a visible page as the selected one, without changing the layout.
   *
   * Used when the click happened inside the native page itself: the slot is
   * already correct, only the selection label and the typing target move.
   */
  private selectPage(tab: TabRecord): void {
    this.setActivePage(tab);
    this.activeTabId = tab.id;
    const root = this.instanceRoot(tab.instanceId);
    if (root?.viewId) {
      const view = this.findView(root.viewId);
      if (view) {
        view.focusedTabId = root.id;
        this.activeViewId = view.id;
      }
    }
    this.emitState();
  }

  private requireTab(tabId: string): TabRecord {
    const tab = this.findTab(tabId);
    if (!tab) throw new Error(`标签页不存在：${tabId}`);
    if (tab.view.webContents.isDestroyed()) throw new Error("页面已关闭");
    return tab;
  }

  /**
   * Opens (or reuses) the container for a saved view definition.
   *
   * Reopening merges into the existing container so logins survive; the caller
   * adds the members that are missing and then calls `activateView`.
   */
  ensureView(input: {
    viewDefinitionId: string;
    name: string;
    layoutId: LayoutId;
    color?: RoleColor;
  }): string {
    const existing = this.views.find((view) => view.viewDefinitionId === input.viewDefinitionId);
    if (existing) {
      existing.name = input.name;
      if (input.color) existing.color = input.color;
      if (isEmbeddedLayout(input.layoutId) && existing.slotTabs.length === 0) {
        existing.layoutId = input.layoutId;
      }
      return existing.id;
    }
    const view = this.addView({
      name: input.name,
      layoutId: input.layoutId,
      viewDefinitionId: input.viewDefinitionId,
      ...(input.color ? { color: input.color } : {}),
    });
    return view.id;
  }

  /**
   * Creates an empty view container and puts it on stage.
   *
   * Views are only ever created explicitly: dropping tabs together reorders them
   * instead. An empty container therefore has to survive, or a newly created one
   * would vanish before the user could drag anything into it.
   */
  createView(input: { name?: string; layoutId?: LayoutId; color?: RoleColor }): EmbeddedState {
    const view = this.addView({
      name: input.name ?? "",
      layoutId: input.layoutId ?? "2x1",
      ...(input.color ? { color: input.color } : {}),
    });
    this.activeViewId = view.id;
    delete this.activeTabId;
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  private addView(input: {
    name: string;
    layoutId: LayoutId;
    color?: RoleColor;
    viewDefinitionId?: string;
  }): ViewRecord {
    const slotCount = embeddedSlotRects(input.layoutId, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).length;
    this.viewSeq += 1;
    const view: ViewRecord = {
      id: randomUUID(),
      name: input.name.trim() || `视图 ${this.viewSeq}`,
      ...(input.color ? { color: input.color } : {}),
      ...(input.viewDefinitionId ? { viewDefinitionId: input.viewDefinitionId } : {}),
      layoutId: input.layoutId,
      slotTabs: new Array<string | null>(slotCount).fill(null),
      collapsed: false,
    };
    this.views.push(view);
    return view;
  }

  /** Brings a view on stage; `null` returns to the flat loose-tab list. */
  activateView(viewId: string | null): EmbeddedState {
    if (!viewId) {
      this.activeViewId = undefined;
      const loose = this.tabs.filter((tab) => !tab.viewId);
      const remembered = loose.find((tab) => tab.id === this.activeTabId);
      this.activeTabId = (remembered ?? loose[0])?.id;
    } else {
      const view = this.requireView(viewId);
      this.activeViewId = view.id;
      // Prefer the remembered focus, then the first occupied slot, then any tab
      // the view still owns (a collapsed or emptied view keeps its members).
      const slotTab = view.slotTabs.find((id): id is string => Boolean(id));
      const root =
        (view.focusedTabId ? this.findTab(view.focusedTabId) : undefined) ||
        (slotTab ? this.findTab(slotTab) : undefined) ||
        this.viewRoots(view.id)[0];
      this.activeTabId = root ? (this.activePageOf(root.instanceId)?.id ?? root.id) : undefined;
      if (root) view.focusedTabId = root.id;
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  setViewLayout(viewId: string, layoutId: LayoutId): EmbeddedState {
    const view = this.requireView(viewId);
    // "1x1" and "free" mean the same thing here (one page fills the stage), so
    // the surface keeps only "free" as the canonical value.
    const next = layoutId === "1x1" ? "free" : layoutId;
    if (!isEmbeddedLayout(next)) return this.state();
    view.layoutId = next;
    // Picking a preset discards a hand-dragged geometry; the preset is the new
    // intent, and keeping the old fractions would make the choice look ignored.
    delete view.slotRects;
    // Normalized here as well as in `applyLayout`: this container may not be the
    // one on stage, so the generic pass would not touch it.
    this.normalizeSlots(view);
    this.applyLayout();
    if (view.viewDefinitionId) {
      this.options.onViewLayoutChange?.(view.viewDefinitionId, next);
    }
    this.emitState();
    return this.state();
  }

  /**
   * Applies slot geometry dragged by hand.
   *
   * `rects` are fractions of the stage (0–1). The container keeps them for this
   * run; the saved view definition still stores a preset, so reopening falls back
   * to the preset's even split.
   */
  setViewSlotRects(viewId: string, rects: SlotRect[]): EmbeddedState {
    const view = this.requireView(viewId);
    if (!rects.length) return this.state();
    view.slotRects = rects.map((rect) => ({
      x: Math.max(0, Math.min(1, rect.x)),
      y: Math.max(0, Math.min(1, rect.y)),
      width: Math.max(0.02, Math.min(1, rect.width)),
      height: Math.max(0.02, Math.min(1, rect.height)),
    }));
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /** Pins a tab into one slot of a view; `null` clears it. */
  pinTab(viewId: string, slotIndex: number, tabId: string | null): EmbeddedState {
    const view = this.requireView(viewId);
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    if (slotIndex < 0 || slotIndex >= slotCount) throw new Error("槽位不存在");
    const tab = tabId ? this.requireTab(tabId) : undefined;
    const root = tab ? (this.instanceRoot(tab.instanceId) ?? tab) : undefined;
    if (root && root.viewId !== view.id) {
      // Pinning is also how a loose instance joins a view.
      this.assignView(root, view.id);
    }
    const next = [...view.slotTabs];
    while (next.length < slotCount) next.push(null);
    if (root) {
      const duplicate = next.indexOf(root.id);
      if (duplicate >= 0) next[duplicate] = null;
    }
    next[slotIndex] = root ? root.id : null;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      next,
      slotCount,
    );
    if (root && view.focusedTabId !== root.id) {
      view.focusedTabId = root.id;
      this.activeTabId = tab?.id ?? root.id;
    }
    this.activeViewId = view.id;
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  renameView(viewId: string, name: string): EmbeddedState {
    const view = this.requireView(viewId);
    const next = name.trim();
    if (next) view.name = next;
    this.emitState();
    return this.state();
  }

  setViewColor(viewId: string, color: RoleColor | null): EmbeddedState {
    const view = this.requireView(viewId);
    if (color) view.color = color;
    else delete view.color;
    this.emitState();
    return this.state();
  }

  setViewCollapsed(viewId: string, collapsed: boolean): EmbeddedState {
    const view = this.requireView(viewId);
    view.collapsed = collapsed;
    this.emitState();
    return this.state();
  }

  /**
   * Points the toolbar back at the page the view already shows.
   *
   * Joining a full grid leaves the new page off stage. Letting it become the
   * active tab anyway would make the address bar describe a page nobody can see
   * while the "selected" marker stays on another cell.
   */
  keepViewSelection(viewId: string, preferredTabId?: string): EmbeddedState {
    const view = this.findView(viewId);
    if (!view) return this.state();
    const occupied = view.slotTabs.filter((id): id is string => Boolean(id));
    const selected =
      (preferredTabId && occupied.includes(preferredTabId) ? preferredTabId : undefined) ??
      occupied[0];
    const target = selected ? this.findTab(selected) : undefined;
    const page = target ? this.activePageOf(target.instanceId) : undefined;
    if (page && target) {
      this.activeTabId = page.id;
      this.setActivePage(page);
      view.focusedTabId = target.id;
    }
    this.activeViewId = view.id;
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Closes a view container. `"all"` closes every tab; `"opened"` closes only
   * tabs the view launched and leaves hand-made or AI-added tabs running.
   */
  closeView(viewId: string, mode: "all" | "opened" = "all"): EmbeddedState {
    const view = this.findView(viewId);
    if (!view) return this.state();
    const doomed = this.viewTabs(view.id).filter((tab) => mode === "all" || tab.origin === "view");
    for (const tab of doomed) this.discardTab(tab);
    for (const tab of this.viewTabs(view.id)) delete tab.viewId;
    this.views = this.views.filter((item) => item.id !== view.id);
    if (this.activeViewId === view.id) {
      this.activeViewId = undefined;
      const loose = this.tabs.filter((tab) => !tab.viewId);
      this.activeTabId = loose[0]?.id;
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Drop handling for the sidebar.
   *
   * Rows reorder the flat tab list; the middle band of a row that belongs to a
   * view joins that view. Dropping onto a view block joins it regardless of the
   * band. Nothing here creates a view: containers come from the explicit button,
   * which is the only way an empty one can survive long enough to be filled.
   */
  dropTab(
    tabId: string,
    target:
      | { kind: "tab"; tabId: string; edge: "before" | "after" | "middle" }
      | { kind: "view"; viewId: string }
      | { kind: "loose" },
  ): EmbeddedState {
    const tab = this.requireTab(tabId);
    if (target.kind === "loose") {
      this.detachFromView(tab);
      // "Loose" means "take it out of the view"; appending moves it to the end of
      // the flat strip, which is where new loose tabs live.
      const from = this.tabs.indexOf(tab);
      if (from >= 0 && from !== this.tabs.length - 1) {
        this.tabs.splice(from, 1);
        this.tabs.push(tab);
      }
      this.activeViewId = undefined;
      this.activeTabId = tab.id;
      this.applyLayout();
      this.emitState();
      return this.state();
    }
    if (target.kind === "view") {
      const view = this.requireView(target.viewId);
      this.assignView(tab, view.id);
      this.activeViewId = view.id;
      this.activeTabId = tab.id;
      view.focusedTabId = tab.id;
      this.applyLayout();
      this.emitState();
      return this.state();
    }
    const targetTab = this.requireTab(target.tabId);
    if (targetTab.id === tab.id) return this.state();
    const targetView = targetTab.viewId ? this.findView(targetTab.viewId) : undefined;
    const joining = target.edge === "middle" && targetView;
    if (joining && targetView) {
      this.assignView(tab, targetView.id);
      this.activeViewId = targetView.id;
      this.activeTabId = tab.id;
      targetView.focusedTabId = tab.id;
    } else {
      // Dropping a view member next to a loose row means leaving the view: the
      // loose strip is where it is about to appear.
      if (!targetView && tab.viewId) this.detachFromView(tab);
      // Reordering into a member row of another view means joining it there.
      if (targetView && tab.viewId !== targetView.id) this.assignView(tab, targetView.id);
      const after = target.edge === "after" || (target.edge === "middle" && !targetView);
      this.reorder(tab, targetTab, after);
      if (targetView) this.resequenceView(targetView);
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Rebuilds the slot order from the tab order.
   *
   * Called after a reorder inside a view: the sidebar order is the layout order,
   * so keeping old pins would make dragging look like it did nothing.
   */
  private resequenceView(view: ViewRecord): void {
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      undefined,
      slotCount,
    );
  }

  private reorder(tab: TabRecord, anchor: TabRecord, after = false): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0 || tab === anchor) return;
    this.tabs.splice(from, 1);
    let to = this.tabs.indexOf(anchor);
    if (to < 0) to = this.tabs.length;
    else if (after) to += 1;
    this.tabs.splice(to, 0, tab);
  }

  /** Puts a browser instance into a view, swapping it into a free or focused slot. */
  private assignView(tab: TabRecord, viewId: string): void {
    const view = this.findView(viewId);
    if (!view) return;
    const root = this.instanceRoot(tab.instanceId) ?? tab;
    if (root.viewId === view.id) return;
    if (root.viewId) this.detachFromView(root);
    for (const page of this.instanceTabs(root.instanceId)) page.viewId = view.id;
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      view.slotTabs,
      slotCount,
    );
  }

  /**
   * Removes a browser instance from its view, leaving the container in place.
   *
   * An emptied container is deliberately kept: it was created on purpose, and
   * closing it automatically would make it impossible to drag a second page in.
   */
  private detachFromView(tab: TabRecord): void {
    const root = this.instanceRoot(tab.instanceId) ?? tab;
    if (!root.viewId) return;
    const viewId = root.viewId;
    for (const page of this.instanceTabs(root.instanceId)) delete page.viewId;
    const view = this.findView(viewId);
    if (!view) return;
    view.slotTabs = view.slotTabs.map((id) => (id === root.id ? null : id));
    if (view.focusedTabId === root.id) delete view.focusedTabId;
  }

  // ---------- tabs ----------

  async createTab(input: {
    url?: string;
    identityId?: string;
    siteId?: string;
    label?: string;
    color?: RoleColor;
    viewId?: string;
    origin?: "view" | "manual" | "ai";
    /**
     * Open with no shared state at all.
     *
     * Only an explicit "clean open" sets this. A page with no identity that
     * omits it lands in the daily profile — that is what makes a bookmark and a
     * typed address reuse the login the user already has.
     */
    clean?: boolean;
    /** Existing instance that should own this page; omitted creates a new one. */
    instanceId?: string;
    openerId?: string;
  }): Promise<EmbeddedTab> {
    const id = randomUUID();
    const parent = input.instanceId ? this.instanceRoot(input.instanceId) : undefined;
    // The group key, not the parent page's id: closing the page that used to be
    // the root must not turn the surviving pages into a new instance, and a page
    // opened into that instance still has to join them.
    const instanceId = parent ? parent.instanceId : id;
    // A page opened by another page shares its session: that is what makes it
    // the same browser instance rather than a second window.
    const identityId = input.identityId ?? parent?.identityId;
    const siteId = input.siteId ?? parent?.siteId;
    // A popup inherits its opener's world, including a deliberate clean open: it
    // must not jump into the daily profile halfway through a throwaway flow.
    const clean = input.clean ?? (parent ? this.cleanInstances.has(parent.instanceId) : false);
    const partition = embeddedTabPartition({
      ...(identityId ? { identityId } : {}),
      clean,
      instanceId,
    });
    // Remembered per instance: `clean` is not part of the tab record, and the
    // next page opened by this instance has to agree with it.
    if (clean) this.cleanInstances.add(instanceId);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });
    this.configureSession(partition);
    view.setBackgroundColor("#101317");
    const tab: TabRecord = {
      id,
      ...(identityId ? { identityId } : {}),
      ...(siteId ? { siteId } : {}),
      label: input.label?.trim() || "新标签页",
      ...(input.color ? { color: input.color } : {}),
      origin: input.origin ?? parent?.origin ?? "manual",
      instanceId,
      ...(input.openerId ? { openerId: input.openerId } : {}),
      view,
      cdp: new EmbeddedCdp(view.webContents),
      url: "about:blank",
      title: "",
      loading: false,
      crashed: false,
    };
    this.tabs.push(tab);
    this.wireTab(tab);
    this.attachView(tab);
    // Lay the view out inside the window once before anything parks it. A view
    // that has never had a real rect and gets its first bounds outside the
    // window is given a 0×0 viewport and keeps it, which breaks every geometry
    // based check on that page (see `parkAll`).
    tab.view.setBounds({ x: 0, y: 0, ...this.hostContentSize() });
    // A new page starts at the global default; only a deliberate keystroke
    // creates an override, so the setting keeps applying to everything else.
    this.applyZoom(tab, parent ? (parent.zoomOverride ?? this.defaultZoom) : this.defaultZoom);
    this.activeTabId = id;
    this.setActivePage(tab);

    if (parent) {
      // A popup joins its opener's container and slot; it never becomes a new
      // slot candidate. The view on stage stays whatever it was: a page in an
      // off-stage view must not drag its view forward just by opening a popup.
      if (parent.viewId) {
        tab.viewId = parent.viewId;
        const owner = this.findView(parent.viewId);
        if (owner) owner.focusedTabId = parent.id;
      }
    } else if (input.viewId && this.findView(input.viewId)) {
      // Opening a loose tab must actually show it, even when another view was on
      // stage; opening into a view brings that view forward instead.
      this.assignView(tab, input.viewId);
      const owner = this.findView(input.viewId);
      // Select the new page only when it really landed in a cell. An off-stage
      // page that stole the marker would leave "selected" pointing at something
      // invisible, and the next swap would target slot 1 instead of the cell the
      // user is looking at.
      if (owner && owner.slotTabs.includes(tab.id)) owner.focusedTabId = tab.id;
      this.activeViewId = input.viewId;
    } else {
      delete this.activeViewId;
    }
    this.applyLayout();

    const target = normalizeEmbeddedUrl(input.url ?? "about:blank");
    if (!target) {
      this.closeTab(tab.id);
      throw new Error("只支持 http(s) 地址");
    }
    await view.webContents.loadURL(target).catch(() => {
      // A failed load still leaves a usable tab; the error page is visible.
    });
    this.syncTab(tab);
    this.applyLayout();
    this.emitState();
    return this.describe(tab);
  }

  private attachView(tab: TabRecord): void {
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    host.contentView.addChildView(tab.view);
  }

  private configureSession(partition: string): void {
    const target = session.fromPartition(partition);
    // No preload is ever registered on these partitions: they run untrusted
    // remote pages, so the only bridge is the main process.
    const userAgent = desktopUserAgent(target.getUserAgent());
    if (userAgent && !userAgent.includes("Electron/")) target.setUserAgent(userAgent);
    target.setPermissionRequestHandler((_contents, permission, callback) => {
      // Remote pages get no camera, microphone, geolocation or notifications by
      // default. Anything a test needs must be added here deliberately.
      const allowed: string[] = [];
      callback(allowed.includes(permission));
    });
    target.setPermissionCheckHandler(() => false);
  }

  /**
   * Installs the login-form listener in a freshly loaded document.
   *
   * `Runtime.addBinding` exposes one function to the page; the value it passes
   * arrives here as a `bindingCalled` event, so the password is in main-process
   * memory and never in the renderer that draws the app chrome.
   */
  private async installLoginCapture(tab: TabRecord): Promise<void> {
    if (!this.options.onLoginCaptured) return;
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    try {
      // The binding survives navigations within the same renderer; adding it
      // twice throws, so it is remembered per tab.
      if (!tab.captureBinding) {
        await tab.cdp.send("Runtime.addBinding", { name: LOGIN_CAPTURE_BINDING });
        tab.captureBinding = true;
      }
      await tab.cdp.evaluate(LOGIN_CAPTURE_SCRIPT);
    } catch {
      // A page that navigated away or a failed load has nothing to instrument.
    }
  }

  /**
   * The session a page lives in.
   *
   * Derived rather than stored: the identity and the instance already say it, and
   * a copy on the tab record would be one more thing that can disagree. The icon
   * fetch needs it because an icon request has to travel through the same session
   * the page uses (cookies, region, referrer), not the app's default session.
   */
  private partitionOf(tab: TabRecord): string {
    return embeddedTabPartition({
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      clean: this.cleanInstances.has(tab.instanceId),
      instanceId: tab.instanceId,
    });
  }

  /**
   * Downloads a site icon and inlines it.
   *
   * Electron reports icons through `page-favicon-updated`, but the renderer
   * cannot be handed a remote URL: its CSP only allows `data:` images, and a
   * remote fetch from the app renderer would leak a request the page's own
   * session already made. So the bytes are fetched with the tab's session and
   * converted here; the type and size rules live in `inlineFavicon` so they can
   * be tested without Electron.
   *
   * Failure is silent on purpose — an icon is decoration, and a site behind a
   * login can answer 403 for a request the page itself would have made.
   */
  private async loadFavicon(tab: TabRecord, url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    const hit = this.faviconCache.get(url);
    if (hit) {
      tab.favicon = hit.data;
      return;
    }
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    try {
      const response = await session.fromPartition(this.partitionOf(tab)).fetch(url);
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const data = inlineFavicon(response.headers.get("content-type"), bytes);
      if (!data) return;
      this.faviconCache.set(url, { data, fetched: Date.now() });
      if (this.faviconCache.size > 120) {
        // Cheap eviction: drop the oldest quarter instead of tracking hits.
        const oldest = [...this.faviconCache.entries()]
          .sort((a, b) => a[1].fetched - b[1].fetched)
          .slice(0, 30);
        for (const [key] of oldest) this.faviconCache.delete(key);
      }
      tab.favicon = data;
    } catch {
      // Offline, blocked, or gone: keep whatever the tab showed before.
    }
  }

  private wireTab(tab: TabRecord): void {
    const contents = tab.view.webContents;
    const update = () => {
      this.syncTab(tab);
      this.emitState();
    };

    contents.on("page-favicon-updated", (_event, urls) => {
      const first = urls[0];
      if (!first) return;
      void this.loadFavicon(tab, first).then(() => this.emitState());
    });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title;
      update();
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      update();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      this.syncTab(tab);
      update();
    });
    contents.on("did-navigate", (_event, url) => {
      // An icon belongs to an origin, not to a tab. Keeping the old one across a
      // navigation would label the new site with the previous site's mark until
      // the new icon arrives.
      if (originOf(url) !== originOf(tab.url)) delete tab.favicon;
      tab.url = url;
      update();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      tab.url = url;
      update();
    });
    // DevTools can also be closed from their own header; the toolbar's toggle
    // state has to follow that, or the button stays "on" after the panel is gone.
    contents.on("devtools-opened", update);
    contents.on("devtools-closed", update);
    /*
     * Login capture: the page hands the credentials to the main process through
     * a CDP binding, so they never enter the app's renderer. The script is
     * installed per document (a navigation replaces `window`).
     */
    contents.debugger.on("message", (_event, method, params) => {
      if (method !== "Runtime.bindingCalled") return;
      const payload = params as { name?: string; payload?: string } | undefined;
      if (payload?.name !== LOGIN_CAPTURE_BINDING || typeof payload.payload !== "string") return;
      let parsed: { username?: unknown; password?: unknown; origin?: unknown; path?: unknown };
      try {
        parsed = JSON.parse(payload.payload) as typeof parsed;
      } catch {
        return;
      }
      if (
        typeof parsed.username !== "string" ||
        typeof parsed.password !== "string" ||
        typeof parsed.origin !== "string"
      ) {
        return;
      }
      if (!parsed.username.trim() || !parsed.password) return;
      this.options.onLoginCaptured?.({
        tabId: tab.id,
        username: parsed.username.trim().slice(0, 200),
        password: parsed.password.slice(0, 500),
        origin: parsed.origin,
        path: typeof parsed.path === "string" ? parsed.path : "/",
      });
    });
    contents.on("did-finish-load", () => {
      void this.installLoginCapture(tab);
    });
    /*
     * Clicking anywhere inside a page selects that cell.
     *
     * Without this, the selection only moves when a dock row or a slot header is
     * clicked, which reads as "the highlighted cell is the last one I clicked in
     * the sidebar" instead of "the cell I am typing into". The native page owns
     * the click, so its focus event is the only signal that reaches us.
     */
    contents.on("focus", () => {
      if (this.activeTabId === tab.id) return;
      this.selectPage(tab);
    });
    contents.on("render-process-gone", () => {
      tab.crashed = true;
      update();
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted navigation caused by another navigation starting.
      if (!isMainFrame || code === -3) return;
      tab.title = `${description || "加载失败"}`;
      tab.url = url;
      update();
    });
    contents.on("context-menu", (_event, params) => {
      const menu = Menu.buildFromTemplate([
        {
          label: "后退",
          enabled: this.safeNav(tab, "canGoBack"),
          click: () => contents.navigationHistory.goBack(),
        },
        {
          label: "前进",
          enabled: this.safeNav(tab, "canGoForward"),
          click: () => contents.navigationHistory.goForward(),
        },
        { type: "separator" },
        { label: "重新加载", click: () => contents.reload() },
        {
          label: "复制链接",
          enabled: Boolean(params.linkURL),
          click: () => {
            void import("electron").then(({ clipboard }) =>
              clipboard.writeText(params.linkURL || tab.url),
            );
          },
        },
        {
          label: "在系统浏览器中打开",
          click: () => {
            const target = normalizeEmbeddedUrl(tab.url);
            if (target) void shell.openExternal(target);
          },
        },
      ]);
      menu.popup({ window: this.host ?? undefined });
    });
    contents.setWindowOpenHandler(({ url }) => {
      const target = normalizeEmbeddedUrl(url);
      if (target && /^https?:/i.test(target)) {
        // A popup belongs to the instance that opened it: same session, same
        // view slot. Treating it as a new slot would turn a login popup into an
        // extra screen region the user never asked for.
        void this.createTab({
          url: target,
          instanceId: tab.instanceId,
          openerId: tab.id,
          label: tab.label,
          ...(tab.color ? { color: tab.color } : {}),
        });
      } else if (/^https?:/i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (normalizeEmbeddedUrl(url)) return;
      event.preventDefault();
      if (/^https?:/i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
    });
    contents.on("before-input-event", (event, input) => {
      // One physical press arrives twice: `before-input-event` fires for the
      // keyDown and again for the keyUp. Shortcuts act on the way down only —
      // they are commands, not states.
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const modifier = process.platform === "darwin" ? input.meta : input.control;
      if (modifier && key === "f") {
        event.preventDefault();
        this.options.onFocusTab?.(tab.id);
      }
      if (modifier && key === "w") {
        event.preventDefault();
        this.closeTab(tab.id);
      }
      // The same toggle Chrome offers: F12, and Ctrl+Shift+I for laptops whose
      // F12 shares a row with volume. The DevTools' own webContents gets the
      // same handler below — with focus inside the panel, this one never fires.
      // Auto-repeat is ignored: holding the key would otherwise flip the panel
      // open and shut until the user lets go.
      if (!input.isAutoRepeat && (key === "f12" || (modifier && input.shift && key === "i"))) {
        event.preventDefault();
        if (this.devtoolsOpen(tab)) this.closeDevTools(tab.id);
        else this.openDevTools(tab.id, "docked");
      }
      // Zoom has to be intercepted here: a page can swallow Ctrl +/- itself
      // (code editors do), and the gesture must still work on that page.
      if (modifier && (key === "=" || key === "+")) {
        event.preventDefault();
        this.zoomBy(tab.id, "in");
      }
      if (modifier && (key === "-" || key === "_")) {
        event.preventDefault();
        this.zoomBy(tab.id, "out");
      }
      if (modifier && key === "0") {
        event.preventDefault();
        this.zoomBy(tab.id, "reset");
      }
    });
  }

  private syncTab(tab: TabRecord): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    tab.url = contents.getURL() || tab.url;
    const title = contents.getTitle();
    if (title) tab.title = title;
  }

  async navigate(tabId: string, url: string): Promise<EmbeddedTab> {
    const tab = this.requireTab(tabId);
    const target = normalizeEmbeddedUrl(url);
    if (!target) throw new Error("只支持 http(s) 地址");
    await tab.view.webContents.loadURL(target).catch(() => {
      // The error page is the feedback; the tab stays alive.
    });
    this.syncTab(tab);
    // The page is no longer blank, so it has to take over its cell: until now
    // the renderer was drawing the new-tab surface there instead.
    this.applyLayout();
    this.emitState();
    return this.describe(tab);
  }

  back(tabId: string): void {
    const tab = this.requireTab(tabId);
    if (this.safeNav(tab, "canGoBack")) tab.view.webContents.navigationHistory.goBack();
  }

  forward(tabId: string): void {
    const tab = this.requireTab(tabId);
    if (this.safeNav(tab, "canGoForward")) tab.view.webContents.navigationHistory.goForward();
  }

  reload(tabId: string): void {
    const tab = this.requireTab(tabId);
    tab.crashed = false;
    tab.view.webContents.reload();
  }

  /**
   * The click rules live in `planTabClick`; this applies the result, re-runs the
   * grid math when an instance swapped into a slot, and moves focus into the page.
   *
   * Slot membership is by instance, so a click on a secondary page only switches
   * which page that instance shows; only a click on an instance's root page can
   * pull it onto the stage.
   */
  activate(tabId: string): EmbeddedState {
    const tab = this.requireTab(tabId);
    this.setActivePage(tab);
    const root = this.instanceRoot(tab.instanceId) ?? tab;
    const plan = planTabClick(
      {
        tabs: this.tabs.map((item) => this.describe(item)),
        views: this.views.map((view) => this.describeView(view)),
        ...(this.activeTabId ? { activeTabId: this.activeTabId } : {}),
        ...(this.activeViewId ? { activeViewId: this.activeViewId } : {}),
      },
      root.id,
    );
    this.activeTabId = tab.id;
    if (plan.activeViewId) this.activeViewId = plan.activeViewId;
    else delete this.activeViewId;
    for (const next of plan.views) {
      const current = this.findView(next.id);
      if (!current) continue;
      current.slotTabs = [...next.slotTabs];
      if (next.focusedTabId) current.focusedTabId = next.focusedTabId;
      else delete current.focusedTabId;
    }
    this.applyLayout();
    this.focusActiveView();
    this.emitState();
    return this.state();
  }

  private focusActiveView(): void {
    if (!this.activeTabId) return;
    const tab = this.findTab(this.activeTabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.focus();
  }

  closeTab(tabId: string): EmbeddedState {
    const tab = this.findTab(tabId);
    if (!tab) return this.state();
    const view = tab.viewId ? this.findView(tab.viewId) : undefined;
    const instanceId = tab.instanceId;
    const wasActive = this.instanceActive.get(instanceId) === tabId;
    const siblings = this.instanceTabs(instanceId).filter((item) => item.id !== tabId);
    this.discardTab(tab);
    // The instance keeps running on its remaining pages: closing one page is not
    // closing the window. Only the last page frees the view slot.
    if (view && siblings.length === 0) {
      view.slotTabs = view.slotTabs.map((id) => (id === instanceId || id === tabId ? null : id));
      if (view.focusedTabId === instanceId || view.focusedTabId === tabId) {
        delete view.focusedTabId;
      }
      // The container stays: it may be intentionally empty, waiting for a page.
    } else if (view && siblings.length > 0) {
      /**
       * A slot names an instance by its root page's id. Closing that page left
       * the slot pointing at a tab that no longer exists, so resolving the grid
       * dropped the cell's contents — the surviving pages were still running,
       * just unreachable from the stage. The oldest survivor takes the name.
       */
      const successor = siblings[0];
      if (successor) {
        view.slotTabs = view.slotTabs.map((id) =>
          id === tabId || id === instanceId ? successor.id : id,
        );
        if (view.focusedTabId === tabId || view.focusedTabId === instanceId) {
          view.focusedTabId = successor.id;
        }
      }
    }
    const survivor = siblings[siblings.length - 1];
    if (survivor) {
      if (wasActive || !this.instanceActive.has(instanceId)) this.setActivePage(survivor);
    } else {
      this.instanceActive.delete(instanceId);
    }
    if (this.activeTabId === tabId) {
      // Stay inside the instance first, then the same view, then anywhere.
      const inView = view ? this.tabs.filter((item) => item.viewId === view.id) : [];
      this.activeTabId =
        survivor?.id ?? inView[inView.length - 1]?.id ?? this.tabs[this.tabs.length - 1]?.id;
      if (survivor && view) view.focusedTabId = this.instanceRoot(instanceId)?.id;
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Opens one more page inside an existing browser instance.
   *
   * This is the strip's "+". A new instance would be a second browser with a
   * second session, which is the opposite of what a profile with a console open
   * needs; the page has to join the same cookies, storage and window.
   */
  async openInInstance(instanceId: string): Promise<EmbeddedState> {
    const root = this.instanceRoot(instanceId);
    if (!root) throw new Error(`浏览器实例不存在：${instanceId}`);
    const tab = await this.createTab({ instanceId: root.id });
    this.activate(tab.id);
    return this.state();
  }

  /**
   * Duplicates a page in its own instance.
   *
   * Same session, same address, same cell — the copy only becomes a second page
   * in the strip, which is what "duplicate this tab" means in a browser. A blank
   * page has nothing to duplicate but the tab itself, so the copy is blank too.
   */
  async duplicateTab(tabId: string): Promise<EmbeddedState> {
    const tab = this.requireTab(tabId);
    const copy = await this.createTab({
      instanceId: tab.instanceId,
      openerId: tab.id,
      label: tab.label,
      ...(isBlankTab(tab) ? {} : { url: tab.url }),
    });
    this.activate(copy.id);
    return this.state();
  }

  /** Closes every page of an instance except the one named. */
  closeOtherTabs(tabId: string): EmbeddedState {
    const tab = this.requireTab(tabId);
    for (const sibling of this.instanceTabs(tab.instanceId)) {
      if (sibling.id !== tab.id) this.closeTab(sibling.id);
    }
    return this.state();
  }

  private discardTab(tab: TabRecord): void {
    const index = this.tabs.indexOf(tab);
    if (index >= 0) this.tabs.splice(index, 1);
    // The last page of an instance carries the instance with it; drop the
    // clean-session marker with it so the set does not grow forever.
    if (!this.tabs.some((item) => item.instanceId === tab.instanceId)) {
      this.cleanInstances.delete(tab.instanceId);
      this.instanceActive.delete(tab.instanceId);
    }
    tab.cdp.detach();
    // The DevTools view outlives the page only until here: it is hosted by the
    // same window, so a closed page must take its panel with it.
    this.dropDevTools(tab);
    try {
      this.host?.contentView.removeChildView(tab.view);
    } catch {
      // The window may already be gone.
    }
    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    } catch {
      // Closing an already-destroyed contents is a no-op.
    }
  }

  private closeAllTabs(): void {
    for (const tab of [...this.tabs]) this.discardTab(tab);
    this.tabs = [];
    this.views = [];
    this.cleanInstances.clear();
    this.activeTabId = undefined;
    this.activeViewId = undefined;
  }

  /** Closes the surface entirely; used on app shutdown. */
  dispose(): void {
    this.closeAllTabs();
    this.host = null;
    this.stage = null;
    this.lastStage = null;
  }

  /**
   * Rebuilds a view's slot table from its layout.
   *
   * The slot count follows the layout, not the stage: it is decided by the preset
   * or the hand-dragged fractions, so this must not depend on the browser page
   * being mounted.
   */
  private normalizeSlots(view: ViewRecord): void {
    const count = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((tab) => tab.id),
      view.slotTabs,
      count,
    );
    if (view.focusedTabId && !view.slotTabs.includes(view.focusedTabId)) {
      // The focused page may sit in a trimmed slot; keep the marker honest
      // instead of leaving it on a cell that no longer exists.
      const first = view.slotTabs.find((id): id is string => Boolean(id));
      if (first) view.focusedTabId = first;
      else delete view.focusedTabId;
    }
  }

  private applyLayout(): void {
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    this.parkAll();
    /**
     * Slot tables are layout *state*, not geometry, so they are normalized even
     * when no stage has been reported.
     *
     * The browser page is not always mounted: the user may be on the accounts
     * page, and an MCP call can arrive before the renderer has reported its
     * stage. Skipping this left `slotTabs` at the old length, so switching 2×2 →
     * 2×1 from `set_browser_layout` still listed four entries and a later launch
     * reused a grid the user had already changed.
     */
    const current = this.activeView();
    if (current) this.normalizeSlots(current);
    if (!this.stage) return;

    const view = this.activeView();
    if (!view) {
      // Flat mode: one page fills the stage below a header band that carries the
      // instance's page tabs. The band is the same height as a slot header, so
      // switching between a view and the flat list does not move the page.
      const tab = this.activeTabId ? this.findTab(this.activeTabId) : undefined;
      const page = tab ? this.activePageOf(tab.instanceId) : undefined;
      // A page that has not navigated anywhere stays parked so the app's own
      // new-tab surface (search box, engine picker) is what the user sees. The
      // renderer draws it in the empty stage; it is plain HTML and needs no
      // native view behind it.
      if (page && !page.viewId && !isBlankTab(page) && !page.view.webContents.isDestroyed()) {
        page.view.setBounds(embeddedViewRect(this.stage));
      }
      if (tab?.devtools?.mode === "docked") this.placeDevTools(tab);
      return;
    }

    const slots = insetSlotRects(
      embeddedSlotRects(view.layoutId, this.stage, view.slotRects),
      this.stage,
    );
    // `slotTabs` was already normalized above; the geometry is the only thing
    // left to do here.
    slots.forEach((slot, index) => {
      const rootId = view.slotTabs[index];
      if (!rootId) return;
      // A slot shows one instance; which page of it is on screen is decided by
      // `instanceActive`, so popups reuse the slot instead of adding a cell.
      const page = this.activePageOf(rootId);
      if (!page || page.view.webContents.isDestroyed()) return;
      // Same reason as the flat branch: a blank page keeps its cell for HTML.
      if (isBlankTab(page)) return;
      page.view.setBounds(embeddedViewRect(slot));
    });
    // Docked DevTools follow the cell they were opened in, so a layout change or
    // a different page on screen keeps the panel beside the right page.
    for (const tab of this.tabs) {
      if (tab.devtools?.mode === "docked") this.placeDevTools(tab);
    }
  }

  /**
   * Moves every view off the window instead of hiding it.
   *
   * Measured on Electron 44 / Chromium 152: `setVisible(false)` still runs page
   * scripts and `capturePage`, but CDP screenshots time out; bounds outside the
   * window keep everything working. AI calls therefore behave identically no
   * matter which app page the user is looking at.
   *
   * Two details decide the coordinates, both measured:
   *
   * 1. Park past the *window's* right edge, not past the stage's. The stage
   *    starts to the right of the rail, so `x = stage.width` is still inside the
   *    window — a parked page painted itself over the accounts page.
   * 2. A view that is *created* outside the window gets a 0×0 viewport for good:
   *    scripts run, but the document lays out at zero width, so "is this text
   *    visible" and every element position are wrong. `createTab` therefore
   *    gives a new view a real on-window rect before it is parked. A view that
   *    was laid out once keeps its size when moved out, so this only has to
   *    happen at creation.
   */
  private parkAll(): void {
    const content = this.hostContentSize();
    const parked = parkedViewBounds(content);
    for (const tab of this.tabs) {
      if (tab.view.webContents.isDestroyed()) continue;
      tab.view.setBounds(parked);
      // Docked DevTools are children of the same window: leaving them where they
      // were would paint a panel over whichever page is now on stage.
      if (tab.devtools?.mode === "docked" && !tab.devtools.view.webContents.isDestroyed()) {
        tab.devtools.view.setBounds(parked);
      }
    }
  }

  /**
   * Size of the window content area, which is what child view bounds use.
   *
   * The fallback must never be the stage: parking past `stage.width` puts a
   * page's left edge exactly where the dock starts, so the page paints over the
   * dock instead of off-screen. That is not theoretical — with the window hidden
   * to the tray, `getContentBounds()` is not always usable, the fallback kicked
   * in, and pages were parked at `x = stage.width` (1222 with the dock
   * collapsed). Reopening the window showed a ~98px band of the parked page
   * along the right edge, which read as page content spilling over the dock.
   * Remembering the last real window size keeps the invariant the parking
   * coordinates depend on.
   */
  private hostContentSize(): { width: number; height: number } {
    const host = this.host;
    if (host && !host.isDestroyed()) {
      const bounds = host.getContentBounds();
      if (bounds.width > 0 && bounds.height > 0) {
        this.lastContentSize = { width: bounds.width, height: bounds.height };
        return this.lastContentSize;
      }
    }
    if (this.lastContentSize) return this.lastContentSize;
    // Nothing has been measured yet (no window, no prior layout). A deliberately
    // generous default keeps a parked view off-screen even in that case.
    return { width: 1920, height: 1080 };
  }

  private emitState(): void {
    this.options.onStateChange?.(this.state());
    this.sendState();
  }

  private sendState(): void {
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    if (this.pendingState) return;
    this.pendingState = true;
    // Coalesce bursts: load events fire several times per navigation.
    setImmediate(() => {
      this.pendingState = false;
      const current = this.host;
      if (!current || current.isDestroyed()) return;
      current.webContents.send("embedded:state", this.state());
    });
  }

  findTab(tabId: string): TabRecord | undefined {
    return this.tabs.find((tab) => tab.id === tabId);
  }

  /** Tab the caller means when it omits an id: the active one, else the first. */
  defaultTabId(requested?: string): string {
    if (requested) return requested;
    if (this.activeTabId && this.findTab(this.activeTabId)) return this.activeTabId;
    const view = this.activeView();
    const onStage = view?.slotTabs.find((id): id is string => Boolean(id));
    if (onStage) return onStage;
    const first = this.tabs[0];
    if (!first) throw new Error("没有打开的标签页");
    return first.id;
  }

  /** View on stage, for AI tools that omit an explicit view id. */
  defaultViewId(): string | undefined {
    return this.activeViewId;
  }

  /**
   * View a layout tool should act on.
   *
   * Asking for a grid while every tab is loose means "put these pages on one
   * screen", so the tabs are grouped into a new view instead of failing. That is
   * the same result as dragging the tabs together by hand.
   */
  layoutTargetView(layoutId?: string): string | undefined {
    if (this.activeViewId) return this.activeViewId;
    const loose = this.tabs.filter((tab) => !tab.viewId);
    if (loose.length === 0) return undefined;
    const layout = layoutId && isEmbeddedLayout(layoutId) ? layoutId : "2x1";
    const view = this.addView({ name: "新视图", layoutId: layout });
    for (const tab of loose) this.assignView(tab, view.id);
    this.activeViewId = view.id;
    this.activeTabId = loose[0]?.id;
    this.applyLayout();
    this.emitState();
    return view.id;
  }

  /**
   * Root page of an identity inside a view, if it is already open.
   *
   * Root pages only: a popup also carries the identity, but reusing it as the
   * view member would hide which window a saved view actually opened.
   */
  findIdentityTab(viewId: string, identityId: string): EmbeddedTab | undefined {
    const tab = this.tabs.find(
      (item) =>
        item.viewId === viewId && item.identityId === identityId && item.instanceId === item.id,
    );
    return tab ? this.describe(tab) : undefined;
  }

  /** Loose root page of an identity, used to merge repeated opens. */
  findLooseIdentityTab(identityId: string): EmbeddedTab | undefined {
    const tab = this.tabs.find(
      (item) => !item.viewId && item.identityId === identityId && item.instanceId === item.id,
    );
    return tab ? this.describe(tab) : undefined;
  }

  /** The instance root page for an identity, wherever it lives. */
  findIdentityRoot(identityId: string): EmbeddedTab | undefined {
    const tab = this.tabs.find(
      (item) => item.identityId === identityId && item.instanceId === item.id,
    );
    return tab ? this.describe(tab) : undefined;
  }

  /**
   * First cell of a view that holds no instance.
   *
   * Opening an account has to distinguish "there is room, put it on stage" from
   * "the grid is full, keep it off stage". Without that split, every open either
   * replaces the selected cell or shoves the whole view aside.
   */
  firstEmptySlot(viewId: string): number | undefined {
    const view = this.findView(viewId);
    if (!view) return undefined;
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    const slots = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      view.slotTabs,
      slotCount,
    );
    const index = slots.indexOf(null);
    return index >= 0 ? index : undefined;
  }

  /**
   * Re-applies a saved `slotAssignments` map after a container was (re)opened.
   *
   * The definition stores identity ids, the container stores tab ids; the caller
   * has already translated them. Unknown slots are ignored by `resolveSlotTabs`.
   */
  applySlotAssignments(viewId: string, slots: Record<string, number>): void {
    const view = this.findView(viewId);
    if (!view) return;
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    const next: (string | null)[] = new Array<string | null>(slotCount).fill(null);
    for (const [tabId, index] of Object.entries(slots)) {
      if (index >= 0 && index < slotCount && !next[index] && this.findTab(tabId)) {
        next[index] = tabId;
      }
    }
    view.slotTabs = resolveSlotTabs(
      this.viewTabs(view.id).map((tab) => tab.id),
      next,
      slotCount,
    );
    this.applyLayout();
  }

  // ---------- AI-facing operations ----------

  /**
   * What an AI client needs to know before it may send input to a tab.
   *
   * The policy lives in `shared/ai-policy.ts`; this only reports facts about the
   * page. `clean` is read from the instance marker because an identity-less tab
   * is either daily or clean and the URL cannot tell them apart.
   */
  aiPageContext(tabId: string): AiPageContext {
    const tab = this.requireTab(tabId);
    return {
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      ...(this.cleanInstances.has(tab.instanceId) ? { clean: true } : {}),
      origin: aiOriginOf(tab.url),
    };
  }

  async snapshotDom(tabId: string, options: { maxNodes?: number } = {}): Promise<DomSnapshot> {
    const tab = this.requireTab(tabId);
    return tab.cdp.snapshotDom(buildDomSnapshotExpression(options));
  }

  async visibility(tabId: string, target: TargetInput): Promise<VisibilityProbe> {
    const tab = this.requireTab(tabId);
    return tab.cdp.visibility(buildVisibilityExpression(target));
  }

  async click(
    tabId: string,
    target: TargetInput,
  ): Promise<{ ok: true; tag?: string; text?: string; selector?: string }> {
    const tab = this.requireTab(tabId);
    const point = await tab.cdp.elementPoint(buildElementPointExpression(target));
    if (!point.ok || point.x === undefined || point.y === undefined) {
      throw new Error(`无法点击 ${describeTarget(target)}：${point.reason ?? "unknown"}`);
    }
    await tab.cdp.clickAt(point.x, point.y);
    return {
      ok: true,
      ...(point.tag ? { tag: point.tag } : {}),
      ...(point.text ? { text: point.text } : {}),
      ...(point.selector ? { selector: point.selector } : {}),
    };
  }

  async type(
    tabId: string,
    target: TargetInput,
    text: string,
    options: { submit?: boolean; clear?: boolean } = {},
  ): Promise<{ ok: true; secret?: true; selector?: string }> {
    const tab = this.requireTab(tabId);
    const focus = await tab.cdp.evaluate<{
      ok: boolean;
      reason?: string;
      inputType?: string;
      selector?: string;
    }>(buildFocusExpression(target));
    if (!focus.ok)
      throw new Error(`无法输入到 ${describeTarget(target)}：${focus.reason ?? "unknown"}`);
    if (options.clear !== false) {
      await tab.cdp.key("a", "KeyA", 65).catch(() => {});
    }
    await tab.cdp.insertText(text);
    if (options.submit) await tab.cdp.key("Enter", "Enter", 13);
    // Reported so the MCP layer can keep the value out of its audit log; a
    // password field can be a brand-new credential (creating a tenant), so it
    // cannot always go through `fill_browser_login`.
    return {
      ok: true,
      ...(focus.selector ? { selector: focus.selector } : {}),
      ...(focus.inputType === "password" ? { secret: true as const } : {}),
    };
  }

  /**
   * Waits for a page condition, polling inside the tab.
   *
   * A navigation destroys the execution context the polling loop lives in, so a
   * failure of that kind is retried with the time that is left: by then the new
   * document may already satisfy the condition. Without the retry, "click 登录,
   * then wait for the console" always reports a destroyed context instead of the
   * page it was waiting for.
   */
  async wait(
    tabId: string,
    input: {
      condition: WaitCondition;
      target?: TargetInput;
      text?: string;
      timeoutMs: number;
    },
  ): Promise<WaitResult> {
    const tab = this.requireTab(tabId);
    const started = Date.now();
    const deadline = started + input.timeoutMs;
    let last: WaitResult | undefined;
    while (Date.now() < deadline) {
      const remaining = Math.max(200, deadline - Date.now());
      const expression = buildWaitExpression({ ...input, timeoutMs: remaining });
      try {
        const result = await Promise.race([
          tab.cdp.evaluate<WaitResult>(expression, { awaitPromise: true }),
          new Promise<WaitResult>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: false,
                  waitedMs: remaining,
                  timedOut: true,
                  reason: "evaluate-timeout",
                }),
              remaining + 400,
            ),
          ),
        ]);
        if (result.ok || !result.timedOut || result.reason !== "evaluate-timeout") return result;
        last = result;
      } catch (error) {
        // Context destroyed by a navigation, or the tab went away mid-poll.
        last = {
          ok: false,
          waitedMs: Date.now() - started,
          timedOut: true,
          reason: String((error as Error)?.message ?? error).slice(0, 200),
        };
      }
    }
    return (
      last ?? {
        ok: false,
        waitedMs: Date.now() - started,
        timedOut: true,
        reason: "timeout",
      }
    );
  }

  /**
   * Fills several fields in one call.
   *
   * The point is not saving keystrokes but round trips: each field used to be
   * its own MCP request, and a slow backend meant the caller had to poll between
   * them anyway. One call also keeps the page from being left half-filled when a
   * single request times out.
   */
  async fillForm(
    tabId: string,
    fields: Array<{
      target: TargetInput;
      value: string;
      submit?: boolean;
      clear?: boolean;
    }>,
  ): Promise<{
    ok: true;
    filled: Array<{ field: string; selector?: string; secret?: true }>;
  }> {
    const tab = this.requireTab(tabId);
    const filled: Array<{ field: string; selector?: string; secret?: true }> = [];
    for (const field of fields) {
      const name = describeTarget(field.target);
      const focus = await tab.cdp.evaluate<{
        ok: boolean;
        reason?: string;
        inputType?: string;
        selector?: string;
      }>(buildFocusExpression(field.target));
      if (!focus.ok) {
        throw new Error(
          `第 ${filled.length + 1} 个字段（${name}）无法输入：${focus.reason ?? "unknown"}`,
        );
      }
      if (field.clear !== false) await tab.cdp.key("a", "KeyA", 65).catch(() => {});
      await tab.cdp.insertText(field.value);
      if (field.submit) await tab.cdp.key("Enter", "Enter", 13);
      filled.push({
        field: name,
        ...(focus.selector ? { selector: focus.selector } : {}),
        // The MCP layer masks every value whose field reported `secret`, so one
        // password in the middle of a form must not leak the rest of the call.
        ...(focus.inputType === "password" ? { secret: true as const } : {}),
      });
    }
    return { ok: true, filled };
  }

  /**
   * Runs a saved flow's steps against one tab.
   *
   * Every step goes through the same primitives the individual tools use, so a
   * flow clicks and types exactly like a person driving the app would. That is
   * the whole reason flows are step lists instead of page scripts.
   *
   * A failed step stops the run and reports where. Continuing would be worse:
   * the remaining steps assume the page reached the state this one was meant to
   * produce, and carrying on from a half-finished form creates real data on the
   * tested system. Steps marked `optional` (a wait that may time out) are the
   * one exception.
   */
  async runFlow(
    tabId: string,
    steps: FlowStep[],
    options: { baseUrl: string; vars: Record<string, string>; timeoutMs: number },
  ): Promise<FlowRunResult> {
    const tab = this.requireTab(tabId);
    const started = Date.now();
    const results: FlowStepResult[] = [];
    const vars = { ...options.vars };

    for (let index = 0; index < steps.length; index += 1) {
      if (Date.now() - started > options.timeoutMs) {
        return {
          ok: false,
          failedAt: index,
          reason: `流程超过 ${Math.round(options.timeoutMs / 1000)} 秒仍未跑完`,
          steps: results,
        };
      }
      const raw = steps[index] as FlowStep;
      const label = `第 ${index + 1} 步（${raw.action}）`;
      let step: FlowStep;
      try {
        step = interpolateStep(raw, vars);
      } catch (error) {
        return {
          ok: false,
          failedAt: index,
          reason: `${label}：${(error as Error).message}`,
          steps: results,
        };
      }

      const target = this.targetOf(step);
      try {
        let detail: string | undefined;
        switch (step.action) {
          case "navigate": {
            const url = this.resolveFlowUrl(step.url ?? "", options.baseUrl);
            await tab.view.webContents.loadURL(url).catch(() => {
              // An error page is the feedback; the navigation itself did happen.
            });
            this.syncTab(tab);
            detail = url;
            break;
          }
          case "fill": {
            const focus = await tab.cdp.evaluate<{
              ok: boolean;
              reason?: string;
              inputType?: string;
            }>(buildFocusExpression(target));
            if (!focus.ok) throw new Error(`无法输入：${focus.reason ?? "unknown"}`);
            // Some frameworks clear on focus; select-then-insert replaces the
            // old value without leaving a trailing fragment behind.
            await tab.cdp.key("a", "KeyA", 65).catch(() => {});
            await tab.cdp.insertText(step.value ?? "");
            detail = focus.inputType === "password" ? "[redacted]" : step.value;
            break;
          }
          case "click": {
            const point = await tab.cdp.elementPoint(buildElementPointExpression(target));
            if (!point.ok || point.x === undefined || point.y === undefined) {
              throw new Error(`无法点击：${point.reason ?? "unknown"}`);
            }
            await tab.cdp.clickAt(point.x, point.y);
            detail = point.text;
            break;
          }
          case "select": {
            const selected = await tab.cdp.evaluate<{
              ok: boolean;
              reason?: string;
              available?: string[];
              text?: string;
            }>(buildSelectExpression(target, step.option ?? ""));
            if (!selected.ok) {
              const hint = selected.available?.length
                ? `（可选：${selected.available.join(" / ")}）`
                : "";
              throw new Error(`无法选择「${step.option}」：${selected.reason ?? "unknown"}${hint}`);
            }
            detail = selected.text;
            break;
          }
          case "press": {
            await tab.cdp.pressNamedKey(step.key ?? "");
            detail = step.key;
            break;
          }
          case "login": {
            const filled = await this.fillLogin(tabId);
            if (!filled.ok) throw new Error(`无法填充登录：${filled.reason ?? "unknown"}`);
            detail = filled.missingFields?.length
              ? `已填入账号密码，缺少字段：${filled.missingFields.join("、")}`
              : "已填入账号密码";
            break;
          }
          case "wait": {
            const outcome = await this.wait(tabId, {
              condition: step.condition ?? "visible",
              ...(step.condition === "text" || step.condition === "url" ? {} : { target }),
              ...(step.expect ? { text: step.expect } : {}),
              timeoutMs: step.timeoutMs ?? 5000,
            });
            if (!outcome.ok && !step.optional) {
              throw new Error(`等待超时：${outcome.reason ?? "unknown"}`);
            }
            detail = outcome.ok ? `等了 ${outcome.waitedMs}ms` : "超时，按可选项继续";
            break;
          }
          case "read": {
            const read = await tab.cdp.evaluate<{
              ok: boolean;
              reason?: string;
              value?: string;
            }>(buildReadExpression(target));
            if (!read.ok) throw new Error(`无法读取：${read.reason ?? "unknown"}`);
            if (step.as) vars[step.as] = read.value ?? "";
            detail = step.as ? `${step.as} = ${read.value}` : read.value;
            break;
          }
          default:
            throw new Error(`不认识的动作 ${String(step.action)}`);
        }
        this.syncTab(tab);
        results.push({ index, action: step.action, ok: true, ...(detail ? { detail } : {}) });
      } catch (error) {
        if (step.optional) {
          results.push({
            index,
            action: step.action,
            ok: false,
            optional: true,
            detail: (error as Error).message,
          });
          continue;
        }
        return {
          ok: false,
          failedAt: index,
          reason: `${label}失败：${(error as Error).message}`,
          steps: [
            ...results,
            { index, action: step.action, ok: false, detail: (error as Error).message },
          ],
          vars,
        };
      }
    }
    this.emitState();
    return { ok: true, steps: results, vars };
  }

  /** The element target of a step, or undefined for steps that act on the page. */
  private targetOf(step: FlowStep): TargetInput {
    if (step.selector) return { selector: step.selector };
    return {
      ...(step.label ? { label: step.label } : {}),
      ...(step.text ? { text: step.text } : {}),
      ...(step.role ? { role: step.role } : {}),
      ...(step.exact ? { exact: true } : {}),
    };
  }

  /** A step's url may be absolute or a path relative to the flow's site. */
  private resolveFlowUrl(url: string, baseUrl: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      throw new Error(`无法解析地址：${url}`);
    }
  }

  async evaluate<T>(tabId: string, expression: string): Promise<T> {
    const tab = this.requireTab(tabId);
    return tab.cdp.evaluate<T>(expression, { awaitPromise: true });
  }

  async screenshot(
    tabId: string,
    options: { format?: "png" | "jpeg"; quality?: number } = {},
  ): Promise<{ path: string; bytes: number }> {
    const tab = this.requireTab(tabId);
    const buffer = await tab.cdp.screenshot(options);
    mkdirSync(this.options.shotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const extension = options.format === "jpeg" ? "jpg" : "png";
    const file = join(this.options.shotDir, `${tab.id.slice(0, 8)}-${stamp}.${extension}`);
    writeFileSync(file, buffer);
    return { path: file, bytes: buffer.length };
  }

  /**
   * Checks the tab's session against a protected path: an in-page fetch with
   * cookies, so the answer reflects this tab's own partition, not a cached
   * record. Callers use it to decide whether a launch still needs a login.
   */
  async authProbe(
    tabId: string,
    checkPath: string,
    baseUrl: string,
  ): Promise<{ ok: boolean; signedIn?: boolean; reason?: string }> {
    const tab = this.requireTab(tabId);
    let expected = "";
    try {
      expected = new URL(baseUrl).origin;
    } catch {
      return { ok: false, reason: "bad-site" };
    }
    let origin = "";
    try {
      origin = await tab.cdp.evaluate<string>("location.origin");
    } catch {
      return { ok: false, reason: "not-loaded" };
    }
    if (!origin || origin === "null") return { ok: false, reason: "not-loaded" };
    if (origin !== expected) return { ok: false, reason: "cross-origin" };
    let result: { ok?: boolean } | undefined;
    try {
      // awaitPromise is mandatory here: the expression is an async IIFE around
      // a fetch, and without it Runtime.evaluate returns the unsettled Promise,
      // which serializes to `{}` — every probe would read as signed out.
      result = await tab.cdp.evaluate<{ ok: boolean }>(buildAuthCheckExpression(checkPath), {
        awaitPromise: true,
      });
    } catch {
      return { ok: false, reason: "probe-failed" };
    }
    if (!result) return { ok: false, reason: "probe-failed" };
    return { ok: true, signedIn: result.ok === true };
  }

  /** Fills the saved credentials of the tab's identity, when it has any. */
  async fillLogin(tabId: string): Promise<{
    ok: boolean;
    reason?: string;
    submitted?: boolean;
    missingFields?: string[];
  }> {
    const tab = this.requireTab(tabId);
    if (!tab.identityId) return { ok: false, reason: "no-identity" };
    const payload = await this.options.resolveLogin?.(tab.identityId);
    if (!payload) return { ok: false, reason: "no-password" };
    const origin = await tab.cdp.evaluate<string>("location.origin");
    // A tab created with a URL is still on about:blank for a moment, where
    // `location.origin` is the string "null". That is "not there yet", not a
    // cross-origin page: reporting it as cross-origin made the fill scheduler
    // give up on its first attempt and never type anything.
    if (!origin || origin === "null") return { ok: false, reason: "password-field-not-found" };
    let expected = "";
    try {
      expected = new URL(payload.baseUrl).origin;
    } catch {
      return { ok: false, reason: "bad-site" };
    }
    if (origin !== expected) return { ok: false, reason: "cross-origin" };
    return this.runFill(tab, payload);
  }

  private async runFill(
    tab: TabRecord,
    payload: EmbeddedLoginPayload,
  ): Promise<{ ok: boolean; reason?: string; submitted?: boolean; missingFields?: string[] }> {
    const result = await tab.cdp.evaluate<{
      ok: boolean;
      reason?: string;
      submitted: boolean;
      missingExtra: string[];
    }>(
      buildFillExpression({
        username: payload.username,
        password: payload.password,
        submit: payload.submit,
        extraFields: payload.extraFields,
      }),
    );
    if (!result.ok) return { ok: false, reason: result.reason ?? "fill-failed" };
    return {
      ok: true,
      submitted: result.submitted,
      missingFields: result.missingExtra,
    };
  }

  /**
   * In-page search. Chromium does the matching; the host only draws the bar.
   *
   * `findInPage` returns a request id and the result arrives on `found-in-page`,
   * possibly in several updates while the count settles. The first non-empty
   * final update is the answer; a tab with no matches resolves with zero.
   */
  async findInTab(
    tabId: string,
    text: string,
    options: { forward?: boolean; findNext?: boolean } = {},
  ): Promise<{ matches: number; activeMatch: number }> {
    const tab = this.requireTab(tabId);
    const contents = tab.view.webContents;
    if (!text) {
      contents.stopFindInPage("clearSelection");
      return { matches: 0, activeMatch: 0 };
    }
    return new Promise((resolve) => {
      let settled = false;
      let last = { matches: 0, activeMatch: 0 };
      let quietTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (quietTimer) clearTimeout(quietTimer);
        contents.removeListener("found-in-page", listener);
        resolve(last);
      };
      // Chromium reports an initial zero-count update before the real match list,
      // and a renderer that was just restored from minimised can be throttled
      // enough that the second update lands well after the first. A zero is
      // therefore only final once the stream has been quiet for a while.
      const hardTimer = setTimeout(finish, 6_000);
      const listener = (
        _event: unknown,
        result: { finalUpdate: boolean; matches: number; activeMatchOrdinal: number },
      ) => {
        if (!result.finalUpdate) return;
        last = { matches: result.matches, activeMatch: result.activeMatchOrdinal };
        if (quietTimer) clearTimeout(quietTimer);
        if (result.matches > 0) {
          finish();
          return;
        }
        quietTimer = setTimeout(finish, 900);
      };
      contents.on("found-in-page", listener);
      // Passing `findNext: false` explicitly makes Electron 44 emit no
      // `found-in-page` at all — a fresh search has to omit the field entirely.
      // Only a genuine "next match" call carries it.
      const forward = options.forward ?? true;
      if (options.findNext) contents.findInPage(text, { findNext: true, forward });
      else if (!forward) contents.findInPage(text, { forward: false });
      else contents.findInPage(text);
    });
  }

  stopFind(tabId: string): void {
    const tab = this.requireTab(tabId);
    tab.view.webContents.stopFindInPage("clearSelection");
  }

  /**
   * Paints every page on stage into positioned images.
   *
   * Called before the views are parked for an HTML overlay. The capture goes
   * through CDP, not `capturePage`: on Electron 44 `capturePage` on a
   * WebContentsView throws `UnknownVizError`, and the overlay then covers a
   * black stage. CDP's own fallback still handles a minimised window.
   */
  async freeze(): Promise<FrozenSlot[]> {
    const stage = this.stage;
    const view = this.activeView();
    const shots: FrozenSlot[] = [];
    /**
     * Captures one page and reports the rect its pixels actually fill.
     *
     * Docked DevTools shrink the page inside the same view, so the screenshot is
     * narrower than the slot. Scaling it to the full slot would stretch the page;
     * reporting the real page box leaves the tools area unpainted instead.
     */
    const capture = async (tab: TabRecord, rect: StageRect) => {
      const contents = tab.view.webContents;
      if (contents.isDestroyed()) return;
      try {
        const png = await tab.cdp.screenshot();
        const page = await this.pageBoxDip(tab, rect);
        shots.push({
          tabId: tab.id,
          rect: page,
          dataUrl: `data:image/png;base64,${png.toString("base64")}`,
        });
      } catch {
        // A page that cannot be captured simply stays unpainted behind the overlay.
      }
    };

    if (view && stage) {
      const slots = insetSlotRects(embeddedSlotRects(view.layoutId, stage, view.slotRects), stage);
      for (let index = 0; index < slots.length; index += 1) {
        const rootId = view.slotTabs[index];
        if (!rootId) continue;
        const slot = slots[index];
        // Capture the page the slot is actually showing, which may be a popup.
        const page = this.activePageOf(rootId);
        if (!page || !slot) continue;
        // A blank page has no native pixels — the renderer draws the new-tab
        // surface in that cell. Capturing it would return an empty image and
        // paint over the search box the user is typing into.
        if (isBlankTab(page)) continue;
        await capture(page, embeddedViewRect(slot));
      }
      return shots;
    }

    const tab = this.activeTabId ? this.findTab(this.activeTabId) : undefined;
    const page = tab ? this.activePageOf(tab.instanceId) : undefined;
    // Flat mode paints the page at the stage origin: there is no header band.
    if (page && stage && !isBlankTab(page)) await capture(page, stage);
    return shots;
  }

  /**
   * Where a page's pixels land inside its slot, in window DIP.
   *
   * `window.innerWidth` is in CSS pixels, so multiplying by the zoom factor gives
   * the DIP width the page occupies. Without DevTools this equals the slot; with
   * them docked it is the shrunken page area.
   */
  private async pageBoxDip(tab: TabRecord, slot: StageRect): Promise<StageRect> {
    try {
      const size = await tab.cdp.evaluate<{ width: number; height: number }>(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      const zoom = tab.view.webContents.getZoomFactor() || 1;
      const width = Math.min(slot.width, Math.max(1, Math.round(size.width * zoom)));
      const height = Math.min(slot.height, Math.max(1, Math.round(size.height * zoom)));
      return { x: slot.x, y: slot.y, width, height };
    } catch {
      return slot;
    }
  }

  /**
   * Zooms one page, the Ctrl +/- gesture.
   *
   * The step list mirrors Chrome's: 50/67/75/80/90/100/110/125/150/175/200.
   * Snapping to it means the same two keystrokes land on the same factor as a
   * real browser, instead of drifting through arbitrary percentages.
   */
  zoomBy(tabId: string, direction: "in" | "out" | "reset"): number {
    const tab = this.requireTab(tabId);
    const current = tab.zoomOverride ?? this.defaultZoom;
    const next =
      direction === "reset"
        ? this.defaultZoom
        : clampZoom(ZOOM_STEPS[neighborZoomStep(current, direction)] ?? current);
    this.applyZoom(tab, next);
    // Reset means "back to the default", which is not an override.
    if (direction === "reset" || next === this.defaultZoom) delete tab.zoomOverride;
    else tab.zoomOverride = next;
    this.emitState();
    return next;
  }

  private applyZoom(tab: TabRecord, percent: number): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    // `setZoomFactor` is per webContents and survives navigations within the
    // page, which is what a browser tab does. It does not leak to other pages:
    // each page is its own WebContentsView.
    contents.setZoomFactor(Math.min(2, Math.max(0.5, percent / 100)));
  }

  /**
   * Opens DevTools for one page, docked inside its cell.
   *
   * Electron cannot dock DevTools into a `WebContentsView` (`mode: "right"` opens
   * a separate window), so the tools render into a view this manager owns and
   * are laid out beside the page. `mode: "window"` re-parents that same view
   * into a small window instead — one DevTools session either way, so its
   * console history survives the switch.
   */
  openDevTools(tabId: string, mode: "docked" | "window"): void {
    const tab = this.requireTab(tabId);
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    const devtools = tab.devtools ?? this.mountDevTools(tab, mode, 0.42);
    devtools.mode = mode;
    this.placeDevTools(tab);
    contents.openDevTools({ mode: "detach" });
    this.applyLayout();
    this.emitState();
  }

  /**
   * Creates the front-end view, binds it to the inspected page, and installs
   * every listener it needs.
   *
   * `openDevTools` and the reload recovery both go through here: a rebuilt
   * front-end must be indistinguishable from a first one, including the
   * keyboard handler, the language-bar dismissal, and the reload guard.
   */
  private mountDevTools(
    tab: TabRecord,
    mode: "docked" | "window",
    width: number,
  ): NonNullable<TabRecord["devtools"]> {
    // DevTools needs the devtools:// scheme and their own preload; the page's
    // identity partition would block both, so this view gets its own default
    // session and no preload of ours.
    //
    // `backgroundThrottling: false` is kept from the earlier black-panel
    // investigation. It was not the cause (see `silenceDevToolsLocaleBar`), but
    // a panel that keeps painting while the app is in the background costs one
    // idle compositor and avoids a stale first frame on re-focus.
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#101317");
    tab.view.webContents.setDevToolsWebContents(view.webContents);
    const devtools = { view, mode, width };
    tab.devtools = devtools;
    this.watchDevToolsKeys(tab);
    this.silenceDevToolsLocaleBar(tab);
    this.guardDevToolsFrontend(tab);
    return devtools;
  }

  /**
   * Keeps the panel usable across the front-end's own reloads.
   *
   * DevTools reloads itself for some settings changes — "restore defaults and
   * reload" is the one users hit. That reload used to leave every panel empty
   * for good: afterwards `InspectorFrontendHost` comes back as a stub whose
   * `sendMessageToBackend` is a no-op, so the panels keep their chrome and never
   * receive data. Measured signature — healthy:
   * `sendMessageToBackend(message) { DevToolsAPI.sendMessage...`; broken:
   * `sendMessageToBackend(r){}`. The Elements tree tells the same story: the
   * inspected page's DOM is there before the reload and gone after.
   *
   * Electron never re-binds the host for the lifetime of the inspected
   * `WebContents`, which is why closing and reopening the *same* front-end does
   * not help. Discarding the whole front-end and building a new one does: the
   * fresh document handshakes with the inspected page again. That was verified
   * from both states (healthy and already broken, 2/2 each), so this handler
   * rebuilds rather than forbidding the gesture — which is what makes the
   * settings dialog work instead of hanging on a blank panel.
   *
   * `will-navigate` is the fast path: cancelling the navigation leaves the panel
   * alive (nothing has been thrown away yet), and the rebuild applies the
   * setting the user just changed by booting a front-end that reads it. The
   * `did-finish-load` half catches reloads that never asked — anything that went
   * straight to `webContents.reload()` would otherwise land in the broken state
   * silently.
   */
  private guardDevToolsFrontend(tab: TabRecord): void {
    const contents = tab.devtools?.view.webContents;
    if (!contents) return;
    // The first load is the front-end booting; only a later one is a reload.
    let loaded = false;
    contents.on("will-navigate", (event, url) => {
      if (url !== contents.getURL()) return;
      event.preventDefault();
      void this.rebuildDevTools(tab);
    });
    contents.on("did-finish-load", () => {
      if (!loaded) {
        loaded = true;
        return;
      }
      void this.rebuildDevTools(tab);
    });
  }

  /**
   * Replaces the DevTools front-end with a freshly mounted one.
   *
   * The wait is not cosmetic: closing the view does not finish destroying its
   * renderer synchronously, and mounting a new front-end while the old one is
   * still attached leaves the new one bound to nothing (measured: empty Elements
   * tree, stub host). 350ms proved enough on this Electron; the retry covers a
   * slower machine by checking the panel instead of trusting the clock.
   */
  private async rebuildDevTools(tab: TabRecord): Promise<void> {
    const pending = tab.devtools;
    if (!pending || this.devtoolsRebuilds.has(tab.id)) return;
    const { mode, width } = pending;
    const ticket = { cancelled: false };
    this.devtoolsRebuilds.set(tab.id, ticket);
    try {
      this.discardDevTools(tab);
      await new Promise((resolve) => setTimeout(resolve, 350));
      // The user may have closed the panel during the wait; their intent wins.
      if (ticket.cancelled) return;
      const live = this.findTab(tab.id);
      if (!live || live.view.webContents.isDestroyed()) return;
      this.openDevTools(live.id, mode);
      const rebuilt = live.devtools;
      if (rebuilt) {
        rebuilt.width = width;
        this.placeDevTools(live);
        this.applyLayout();
        this.emitState();
      }
    } finally {
      this.devtoolsRebuilds.delete(tab.id);
    }
  }

  /**
   * Tears the front-end down without deciding what happens next.
   *
   * Separate from `closeDevTools` because a rebuild must not look like a user
   * closing the panel — and because a close arriving mid-rebuild has to cancel
   * it rather than race it.
   */
  private discardDevTools(tab: TabRecord): void {
    if (tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.closeDevTools();
    this.dropDevTools(tab);
    this.applyLayout();
    this.emitState();
  }

  /**
   * Keys the panel owns while focus is inside it.
   *
   * The page's handler never sees these then, and without the first half the
   * panel would be a one-way door from the keyboard.
   *
   * F5 / Ctrl+R reload the *inspected page*, which is what Chrome does with the
   * focus inside DevTools — this is the real behaviour, not a workaround. It is
   * also the safer choice: a reload of the front-end has to be rebuilt (see
   * `guardDevToolsFrontend`), and spending that on a keystroke the user meant
   * for the page would be a regression dressed up as fidelity.
   */
  private watchDevToolsKeys(tab: TabRecord): void {
    const contents = tab.devtools?.view.webContents;
    if (!contents) return;
    contents.on("before-input-event", (event, input) => {
      // Only the keyDown half of a press counts.
      //
      // This is not tidiness: the panel is opened by a keyDown handled on the
      // page, it takes focus immediately, and the *keyUp of that same press* is
      // then delivered here. Treating it as a toggle closed the panel in the
      // same instant it opened — F12 looked broken while the toolbar button,
      // which has no keystroke to finish, worked. The page-side handler never
      // shows this symptom because it calls `preventDefault()` on its keyDown,
      // which stops the matching keyUp from being reported at all.
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const modifier = process.platform === "darwin" ? input.meta : input.control;
      if (!input.isAutoRepeat && (key === "f12" || (modifier && input.shift && key === "i"))) {
        event.preventDefault();
        this.closeDevTools(tab.id);
        return;
      }
      if (key === "f5" || (modifier && key === "r")) {
        event.preventDefault();
        const page = tab.view.webContents;
        if (!page.isDestroyed()) page.reload();
      }
    });
  }

  /**
   * Dismisses the DevTools "now available in Chinese" bar without reloading.
   *
   * Two hard facts drive this, both measured on Electron 44.9 with a self-hosted
   * DevTools view:
   *
   * 1. The bar cannot be honoured. Clicking "Switch DevTools to Chinese" makes
   *    the front-end fetch its zh-CN language pack through the host's
   *    `loadNetworkResource`; that call is unimplemented for a front-end we host
   *    ourselves, the fetch fails, and the front-end falls back to en-US. The
   *    button buys a reload and delivers nothing.
   * 2. Once the front-end has loaded, its `InspectorFrontendHost` is bound to
   *    the inspected page; after a reload it comes back as a stub whose
   *    `sendMessageToBackend` does nothing, so Elements/Console/Network keep
   *    their chrome and stay empty. A rebuild recovers it (see
   *    `guardDevToolsFrontend`), but there is no reason to pay a rebuild here.
   *
   * So the bar gets its other button, "Don't show again", which dismisses the
   * block without a navigation. The cost is that the DevTools UI stays English.
   *
   * The bar shows up some time after `did-finish-load`, hence polling. It is
   * answered once per panel: the click leaves `disable-locale-info-bar` in the
   * host's preferences, so it does not come back for the rest of the run.
   */
  private silenceDevToolsLocaleBar(tab: TabRecord): void {
    const contents = tab.devtools?.view.webContents;
    if (!contents) return;
    let answered = false;
    contents.on("did-finish-load", () => {
      if (answered) return;
      answered = true;
      let attempts = 0;
      const poll = () => {
        if (contents.isDestroyed()) return;
        attempts += 1;
        // The click target is a `devtools-button` inside the front-end's shadow
        // DOM, so a document-level query never finds it. The apostrophe in the
        // label is U+2019, not ASCII.
        void contents
          .executeJavaScript(
            `(() => {
              const wanted = "Don\u2019t show again";
              const found = { el: null };
              const walk = (root) => {
                for (const el of root.querySelectorAll('*')) {
                  if (el.shadowRoot) walk(el.shadowRoot);
                  if (!found.el && /^(devtools-button|button)$/i.test(el.tagName) && (el.textContent || '').includes(wanted)) found.el = el;
                }
              };
              walk(document);
              if (found.el) { found.el.click(); return true; }
              return false;
            })()`,
            true,
          )
          .then((hit) => {
            if (hit || attempts >= 12 || contents.isDestroyed()) return;
            setTimeout(poll, 1000);
          })
          .catch(() => undefined);
      };
      setTimeout(poll, 1200);
    });
  }

  /** Moves an open panel between its cell and its own window. */
  setDevToolsMode(tabId: string, mode: "docked" | "window"): void {
    const tab = this.requireTab(tabId);
    if (!tab.devtools) {
      this.openDevTools(tabId, mode);
      return;
    }
    if (tab.devtools.mode === mode) return;
    tab.devtools.mode = mode;
    this.placeDevTools(tab);
    this.applyLayout();
    this.emitState();
  }

  /**
   * Live drag of the docked split.
   *
   * The pointer spends most of the drag over one of the two native views, so
   * the renderer cannot follow it there — HTML events stop at the view's edge.
   * Instead the main process polls the cursor and re-splits on every move, and
   * the drag ends from a mouse-up seen by either view (`input-event`) or by the
   * renderer's own mouseup when the pointer is back over app chrome.
   */
  private resizeSession?: {
    tabId: string;
    timer: NodeJS.Timeout;
    listeners: Array<{ contents: WebContents; handler: () => void }>;
  };

  beginDevToolsResize(tabId: string): void {
    const tab = this.requireTab(tabId);
    if (!tab.devtools || tab.devtools.mode !== "docked" || !this.host || this.host.isDestroyed()) {
      return;
    }
    this.endDevToolsResize();
    const rect = this.pageRect(tab);
    const host = this.host;
    if (!rect || !host || host.isDestroyed()) return;
    const move = () => {
      const live = this.findTab(tabId);
      if (!live?.devtools || live.devtools.mode !== "docked") {
        this.endDevToolsResize();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const content = host.getContentBounds();
      // Cursor and window bounds are both in screen DIP, so the difference is
      // the position inside the content area — the same space `pageRect` uses.
      const localX = cursor.x - content.x;
      const fraction = (rect.width - (localX - rect.x)) / rect.width;
      const next = Math.min(0.7, Math.max(0.2, fraction));
      if (Math.abs(next - live.devtools.width) < 0.001) return;
      live.devtools.width = next;
      this.placeDevTools(live);
    };
    const timer = setInterval(move, 16);
    const listeners: Array<{ contents: WebContents; handler: (...args: never[]) => void }> = [];
    for (const contents of [tab.view.webContents, tab.devtools.view.webContents]) {
      // Parameter types are left to be inferred from the listener signature:
      // only "did the pointer go up" matters here.
      const handler = (...args: [unknown, { type?: string }]) => {
        if (args[1]?.type === "mouseUp") this.endDevToolsResize();
      };
      contents.on("input-event", handler);
      listeners.push({ contents, handler });
    }
    this.resizeSession = { tabId, timer, listeners };
    move();
  }

  endDevToolsResize(): void {
    const session = this.resizeSession;
    if (!session) return;
    this.resizeSession = undefined;
    clearInterval(session.timer);
    for (const { contents, handler } of session.listeners) {
      if (!contents.isDestroyed()) contents.removeListener("input-event", handler);
    }
    // One state push for the whole drag: the renderer's handle jumps to where
    // the split actually landed.
    this.emitState();
  }

  /**
   * While the handle is dragged, the page and the panel must not take the
   * pointer: events have to reach the renderer's HTML handle even when the
   * pointer crosses over one of the native views.
   */
  setDevToolsWidth(tabId: string, width: number): void {
    const tab = this.requireTab(tabId);
    if (!tab.devtools || tab.devtools.mode !== "docked") return;
    const next = Math.min(0.7, Math.max(0.2, width));
    if (Math.abs(next - tab.devtools.width) < 0.001) return;
    tab.devtools.width = next;
    this.placeDevTools(tab);
    this.emitState();
  }

  closeDevTools(tabId: string): void {
    const tab = this.requireTab(tabId);
    // A rebuild that is mid-wait would otherwise reopen the panel right after
    // the user closed it.
    const inFlight = this.devtoolsRebuilds.get(tabId);
    if (inFlight) inFlight.cancelled = true;
    tab.view.webContents.closeDevTools();
    this.dropDevTools(tab);
    this.applyLayout();
    this.emitState();
  }

  /**
   * Toggles DevTools for whichever page the user is looking at.
   *
   * Called when the key never reached a page — the focus sat on the app's own
   * chrome — so "the focused page" is the one the stage is showing: the focused
   * page of the view on stage, or the active flat tab.
   */
  toggleDevToolsForFocusedPage(): void {
    const view = this.activeView();
    const tabId = view?.focusedTabId ?? this.activeTabId;
    const tab = tabId ? this.findTab(tabId) : undefined;
    if (!tab) return;
    if (this.devtoolsOpen(tab)) this.closeDevTools(tab.id);
    else this.openDevTools(tab.id, "docked");
  }

  /**
   * Releases a closed panel's resources.
   *
   * Electron does not destroy a `devToolsWebContents` when the DevTools close —
   * the caller owns it. Without an explicit close every toggle leaks a renderer,
   * so a session that opens the panel on a dozen pages ends up holding a dozen
   * idle DevTools processes
   */
  private dropDevTools(tab: TabRecord): void {
    if (!tab.devtools) return;
    const { view, window: win } = tab.devtools;
    if (win && !win.isDestroyed()) {
      win.contentView.removeChildView(view);
      win.destroy();
    }
    this.host?.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    delete tab.devtools;
  }

  /** Hosts the DevTools view in its window, or in the main window beside the page. */
  private placeDevTools(tab: TabRecord): void {
    const devtools = tab.devtools;
    if (!devtools) return;
    if (devtools.mode === "window") {
      if (!devtools.window || devtools.window.isDestroyed()) {
        const win = new BrowserWindow({
          width: 900,
          height: 620,
          title: `DevTools — ${tab.label}`,
          // A detached DevTools window is still a window on the desktop; an
          // automated run that detaches them must not paint one.
          show: !this.options.headless,
          ...(this.options.appIcon ? { icon: this.options.appIcon } : {}),
        });
        win.on("resize", () => {
          const [width, height] = win.getContentSize();
          devtools.view.setBounds({
            x: 0,
            y: 0,
            width: Math.max(1, width ?? 900),
            height: Math.max(1, height ?? 620),
          });
        });
        win.on("closed", () => {
          // Closing the window closes the tools, not just their host: leaving
          // them "open" with nowhere to draw makes the toolbar toggle lie.
          if (tab.devtools?.window === win) {
            tab.view.webContents.closeDevTools();
            this.dropDevTools(tab);
            this.applyLayout();
            this.emitState();
          }
        });
        devtools.window = win;
      }
      this.host?.contentView.removeChildView(devtools.view);
      const win = devtools.window;
      win.contentView.addChildView(devtools.view);
      const [width, height] = win.getContentSize();
      devtools.view.setBounds({
        x: 0,
        y: 0,
        width: Math.max(1, width ?? 900),
        height: Math.max(1, height ?? 620),
      });
      if (!this.options.headless) win.show();
      return;
    }

    // Docked: the page keeps the left part of its cell, the tools take the rest.
    if (devtools.window && !devtools.window.isDestroyed()) {
      devtools.window.contentView.removeChildView(devtools.view);
      devtools.window.destroy();
      delete devtools.window;
    }
    if (!this.host || this.host.isDestroyed()) return;
    this.host.contentView.addChildView(devtools.view);
    const rect = this.pageRect(tab);
    if (!rect) {
      // Off stage: keep the tools alive but out of sight, like any other page.
      const content = this.hostContentSize();
      devtools.view.setBounds({ ...parkedViewBounds(content), width: 800, height: 600 });
      return;
    }
    // The drag handle lives in the renderer's HTML, which paints *below* every
    // native view — so the two views must part around a real gap for the handle
    // to be visible and clickable at all. `DEVTOOLS_GRIP_WIDTH` matches the
    // renderer's constant; the split line runs through the gap's middle.
    const split = Math.round(rect.width * (1 - devtools.width));
    const left = Math.max(1, split - Math.round(DEVTOOLS_GRIP_WIDTH / 2));
    // The page gives up the right-hand part of its cell; the tools take it.
    // `applyLayout` resets the page to the full cell first, and this runs right
    // after it, so the two agree on the same rect.
    tab.view.setBounds({ ...rect, width: left });
    devtools.view.setBounds({
      x: rect.x + left + DEVTOOLS_GRIP_WIDTH,
      y: rect.y,
      width: Math.max(1, rect.width - left - DEVTOOLS_GRIP_WIDTH),
      height: rect.height,
    });
    // A resize after the first paint has been observed to leave the panel's
    // content area black (the chrome draws, the DOM tree does not) until
    // something forces a repaint. Ask for one explicitly; harmless otherwise.
    devtools.view.webContents.invalidate();
  }

  /** Cell a page occupies right now, in window DIP; undefined when off stage. */
  private pageRect(tab: TabRecord): StageRect | undefined {
    const stage = this.stage;
    if (!stage) return undefined;
    // A blank page draws nothing on screen — the renderer owns that cell — so
    // docked tools must not split a rectangle the page does not occupy.
    if (isBlankTab(tab)) return undefined;
    const view = this.activeView();
    if (view) {
      const slots = insetSlotRects(embeddedSlotRects(view.layoutId, stage, view.slotRects), stage);
      const index = view.slotTabs.findIndex((id) => id === tab.instanceId || id === tab.id);
      const slot = index >= 0 ? slots[index] : undefined;
      return slot ? embeddedViewRect(slot) : undefined;
    }
    const active = this.activeTabId ? this.findTab(this.activeTabId) : undefined;
    if (!active || active.instanceId !== tab.instanceId) return undefined;
    // The flat header band belongs to the renderer, like a slot header does.
    return embeddedViewRect(stage);
  }

  /** Per-slot label height, exported so the chrome and the manager agree. */
  static readonly slotHeaderHeight = EMBEDDED_SLOT_HEADER;
}
