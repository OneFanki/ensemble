import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDomSnapshotExpression,
  buildElementPointExpression,
  buildFocusExpression,
  buildVisibilityExpression,
  type DomSnapshot,
  type VisibilityProbe,
} from "@core/cdp/inspect";
import { buildFillExpression } from "@core/cdp/login";
import {
  desktopUserAgent,
  EMBEDDED_CLEAN_PARTITION,
  EMBEDDED_SLOT_HEADER,
  type EmbeddedState,
  type EmbeddedTab,
  type EmbeddedView,
  embeddedPartition,
  embeddedSlotRects,
  embeddedViewRect,
  type FrozenSlot,
  insetSlotRects,
  isEmbeddedLayout,
  normalizeEmbeddedUrl,
  planTabClick,
  resolveSlotTabs,
  type StageRect,
} from "@shared/embedded";
import type { LayoutId, RoleColor, SlotRect } from "@shared/types";
import type { BrowserWindow } from "electron";
import { Menu, session, shell, WebContentsView } from "electron";
import { EmbeddedCdp } from "./cdp";

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
  loading: boolean;
  crashed: boolean;
}

interface ViewRecord extends EmbeddedView {
  /** Tabs this container was opened from; absent for hand-made views. */
  viewDefinitionId?: string;
}

export interface EmbeddedBrowserOptions {
  /** Where screenshots are written; created on demand. */
  shotDir: string;
  resolveLogin?: (identityId: string) => Promise<EmbeddedLoginPayload | undefined>;
  onStateChange?: (state: EmbeddedState) => void;
  /** Asks the renderer to switch to the browser page. */
  onShowPage?: () => void;
  /** Persists a runtime layout change back to the view definition. */
  onViewLayoutChange?: (viewDefinitionId: string, layoutId: LayoutId) => void;
  onFocusTab?: (tabId: string) => void;
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
  private activeTabId: string | undefined;
  private activeViewId: string | undefined;
  private stage: StageRect | null = null;
  /** Last stage size, kept so off-screen pages keep a realistic viewport. */
  private lastStage: StageRect | null = null;
  private pendingState = false;
  private viewSeq = 0;

  constructor(private readonly options: EmbeddedBrowserOptions) {}

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
    return {
      id: tab.id,
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      ...(tab.siteId ? { siteId: tab.siteId } : {}),
      label: tab.label,
      ...(tab.color ? { color: tab.color } : {}),
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: this.safeNav(tab, "canGoBack"),
      canGoForward: this.safeNav(tab, "canGoForward"),
      ...(tab.viewId ? { viewId: tab.viewId } : {}),
      origin: tab.origin,
      instanceId: tab.instanceId,
      ...(tab.openerId ? { openerId: tab.openerId } : {}),
      active: this.instanceActive.get(tab.instanceId) === tab.id,
    };
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
    /** Existing instance that should own this page; omitted creates a new one. */
    instanceId?: string;
    openerId?: string;
  }): Promise<EmbeddedTab> {
    const id = randomUUID();
    const parent = input.instanceId ? this.instanceRoot(input.instanceId) : undefined;
    const instanceId = parent?.id ?? id;
    // A page opened by another page shares its session: that is what makes it
    // the same browser instance rather than a second window.
    const identityId = input.identityId ?? parent?.identityId;
    const siteId = input.siteId ?? parent?.siteId;
    const partition = identityId ? embeddedPartition(identityId) : EMBEDDED_CLEAN_PARTITION;
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

  private wireTab(tab: TabRecord): void {
    const contents = tab.view.webContents;
    const update = () => {
      this.syncTab(tab);
      this.emitState();
    };

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
      tab.url = url;
      update();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      tab.url = url;
      update();
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

  private discardTab(tab: TabRecord): void {
    const index = this.tabs.indexOf(tab);
    if (index >= 0) this.tabs.splice(index, 1);
    tab.cdp.detach();
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

  private applyLayout(): void {
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    this.parkAll();
    if (!this.stage) return;

    const view = this.activeView();
    if (!view) {
      // Flat mode: one page fills the stage. No slot header exists here, so the
      // page starts at the very top — reserving a header band would leave a
      // black strip above a page that already has its title in the toolbar.
      const tab = this.activeTabId ? this.findTab(this.activeTabId) : undefined;
      const page = tab ? this.activePageOf(tab.instanceId) : undefined;
      if (page && !page.viewId && !page.view.webContents.isDestroyed()) {
        page.view.setBounds(this.stage);
      }
      return;
    }

    const slots = insetSlotRects(
      embeddedSlotRects(view.layoutId, this.stage, view.slotRects),
      this.stage,
    );
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((tab) => tab.id),
      view.slotTabs,
      slots.length,
    );
    slots.forEach((slot, index) => {
      const rootId = view.slotTabs[index];
      if (!rootId) return;
      // A slot shows one instance; which page of it is on screen is decided by
      // `instanceActive`, so popups reuse the slot instead of adding a cell.
      const page = this.activePageOf(rootId);
      if (!page || page.view.webContents.isDestroyed()) return;
      page.view.setBounds(embeddedViewRect(slot));
    });
  }

  /**
   * Moves every view off the window instead of hiding it.
   *
   * Measured on Electron 44 / Chromium 152: `setVisible(false)` still runs page
   * scripts and `capturePage`, but CDP screenshots time out; bounds outside the
   * window keep everything working. AI calls therefore behave identically no
   * matter which app page the user is looking at.
   */
  private parkAll(): void {
    const stage = this.stage ?? this.lastStage;
    const width = Math.max(1, Math.round(stage?.width ?? 1280));
    const height = Math.max(1, Math.round(stage?.height ?? 800));
    for (const tab of this.tabs) {
      if (tab.view.webContents.isDestroyed()) continue;
      tab.view.setBounds({ x: -100_000, y: -100_000, width, height });
    }
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

  async snapshotDom(tabId: string, options: { maxNodes?: number } = {}): Promise<DomSnapshot> {
    const tab = this.requireTab(tabId);
    return tab.cdp.snapshotDom(buildDomSnapshotExpression(options));
  }

  async visibility(tabId: string, selector: string): Promise<VisibilityProbe> {
    const tab = this.requireTab(tabId);
    return tab.cdp.visibility(buildVisibilityExpression(selector));
  }

  async click(tabId: string, selector: string): Promise<{ ok: true; tag?: string; text?: string }> {
    const tab = this.requireTab(tabId);
    const point = await tab.cdp.elementPoint(buildElementPointExpression(selector));
    if (!point.ok || point.x === undefined || point.y === undefined) {
      throw new Error(`无法点击 ${selector}：${point.reason ?? "unknown"}`);
    }
    await tab.cdp.clickAt(point.x, point.y);
    return {
      ok: true,
      ...(point.tag ? { tag: point.tag } : {}),
      ...(point.text ? { text: point.text } : {}),
    };
  }

  async type(
    tabId: string,
    selector: string,
    text: string,
    options: { submit?: boolean; clear?: boolean } = {},
  ): Promise<{ ok: true }> {
    const tab = this.requireTab(tabId);
    const focus = await tab.cdp.evaluate<{ ok: boolean; reason?: string }>(
      buildFocusExpression(selector),
    );
    if (!focus.ok) throw new Error(`无法输入到 ${selector}：${focus.reason ?? "unknown"}`);
    if (options.clear !== false) {
      await tab.cdp.key("a", "KeyA", 65).catch(() => {});
    }
    await tab.cdp.insertText(text);
    if (options.submit) await tab.cdp.key("Enter", "Enter", 13);
    return { ok: true };
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
    const capture = async (tab: TabRecord, rect: StageRect) => {
      if (tab.view.webContents.isDestroyed()) return;
      try {
        const png = await tab.cdp.screenshot();
        shots.push({
          tabId: tab.id,
          rect,
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
        await capture(page, embeddedViewRect(slot));
      }
      return shots;
    }

    const tab = this.activeTabId ? this.findTab(this.activeTabId) : undefined;
    const page = tab ? this.activePageOf(tab.instanceId) : undefined;
    // Flat mode paints the page at the stage origin: there is no header band.
    if (page && stage) await capture(page, stage);
    return shots;
  }

  openDevTools(tabId: string): void {
    const tab = this.requireTab(tabId);
    tab.view.webContents.openDevTools({ mode: "detach" });
  }

  /** Per-slot label height, exported so the chrome and the manager agree. */
  static readonly slotHeaderHeight = EMBEDDED_SLOT_HEADER;
}
