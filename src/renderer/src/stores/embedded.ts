import type {
  EmbeddedDropTarget,
  EmbeddedState,
  EmbeddedTab,
  EmbeddedView,
  StageRect,
} from "@shared/embedded";
import { embeddedSlotCount, tabDisplayTitle } from "@shared/embedded";
import type { LayoutId, SlotRect } from "@shared/types";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { tr } from "../i18n";
import { useWorkspaceStore } from "./workspace";

/** Where the expanded dock starts, and how far it may be dragged either way. */
const DOCK_DEFAULT_WIDTH = 292;
const DOCK_MIN_WIDTH = 240;
const DOCK_MAX_WIDTH = 560;

/**
 * Renderer-side mirror of the embedded surface.
 *
 * The main process owns tabs and geometry; this store keeps the last broadcast
 * state so the browser page and the runtime dock render from one source, and
 * wraps the IPC calls so components do not repeat error handling.
 */
export const useEmbeddedStore = defineStore("embedded", () => {
  const state = ref<EmbeddedState>({ tabs: [], views: [] });
  const ready = ref(false);
  /**
   * Instance being dragged out of the running dock.
   *
   * The browser page watches this: while it is set the native pages are parked so
   * the whole stage becomes a drop target. Drag data itself still travels through
   * `DataTransfer`; this is only the signal that a drag is in flight.
   */
  const draggingTabId = ref<string | null>(null);
  /**
   * A popup menu over the stage is open.
   *
   * Menus can be opened from the dock, which is outside `BrowserPage`, so this
   * cannot be a component prop: the same signal has to reach the stage from
   * anywhere. The stage freezes while it is true, otherwise the native pages
   * paint over the menu.
   */
  const stageMenuOpen = ref(false);

  function setStageMenu(open: boolean): void {
    stageMenuOpen.value = open;
  }

  /** Resolves once the stage has been captured and the pages parked. */
  let coverDone: (() => void) | null = null;
  let coverTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * True while the browser page is mounted.
   *
   * Only that page can park the native views, and only its stage can be frozen.
   * A menu opened from the dock while the user is on another rail page has
   * nothing to wait for: the views are already parked off-stage there.
   */
  const stageMounted = ref(false);

  function setStageMounted(value: boolean): void {
    stageMounted.value = value;
  }

  /**
   * Hides the native pages, then reports when that is done.
   *
   * Opening a menu must wait for this. Capturing the stage takes about 100ms
   * (measured with two pages), and until it finishes the live page still paints
   * over the menu — so a menu shown immediately has its left half missing for
   * that long, which is exactly what it looks like: a panel appearing in pieces.
   */
  function coverStage(): Promise<void> {
    stageMenuOpen.value = true;
    if (!stageMounted.value || !tabs.value.length) return Promise.resolve();
    return new Promise((done) => {
      coverDone = done;
      // Last resort: if the browser page goes away mid-capture nothing would
      // report back, and the menu must still open.
      coverTimer = setTimeout(finishCover, 1500);
    });
  }

  function finishCover(): void {
    if (coverTimer !== null) {
      clearTimeout(coverTimer);
      coverTimer = null;
    }
    const done = coverDone;
    coverDone = null;
    done?.();
  }
  const sidebarCollapsed = ref(
    window.localStorage.getItem("ensemble.runtimeDock.collapsed") === "1",
  );
  /**
   * Expanded dock width in pixels.
   *
   * The dock holds page titles and view names, so its useful width depends on
   * the workspace, not on a fixed token. Dragging the left edge adjusts it and
   * the value survives restarts.
   */
  const dockWidth = ref(readDockWidth());
  let unsubscribe: (() => void) | null = null;

  function readDockWidth(): number {
    const stored = Number(window.localStorage.getItem("ensemble.runtimeDock.width"));
    if (!Number.isFinite(stored) || stored <= 0) return DOCK_DEFAULT_WIDTH;
    return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(stored)));
  }

  async function init(): Promise<void> {
    if (unsubscribe) return;
    state.value = await window.ensemble.getEmbeddedState();
    unsubscribe = window.ensemble.onEmbeddedState((next) => {
      state.value = next;
    });
    ready.value = true;
  }

  const tabs = computed<EmbeddedTab[]>(() => state.value.tabs);
  const views = computed<EmbeddedView[]>(() => state.value.views);
  const activeTab = computed<EmbeddedTab | undefined>(() =>
    tabs.value.find((tab) => tab.id === state.value.activeTabId),
  );
  const activeView = computed<EmbeddedView | undefined>(() =>
    views.value.find((view) => view.id === state.value.activeViewId),
  );
  /** Every page not in any view. */
  const looseTabs = computed(() => tabs.value.filter((tab) => !tab.viewId));

  /** Instances (browser windows) rather than pages: one row each in the dock. */
  const runningCount = computed(() => {
    const seen = new Set<string>();
    for (const tab of tabs.value) seen.add(tab.instanceId);
    return seen.size;
  });

  /** The root page of an instance; its id is the instance id. */
  function instanceRoot(tab: EmbeddedTab): EmbeddedTab | undefined {
    return tabs.value.find((item) => item.id === tab.instanceId);
  }

  /** Pages of one instance, oldest first. */
  function instancePages(instanceId: string): EmbeddedTab[] {
    return tabs.value.filter((tab) => tab.instanceId === instanceId);
  }

  function titleOf(tab: EmbeddedTab): string {
    return tabDisplayTitle(tab);
  }

  /** Slot index (1-based) of an instance inside the view on stage. */
  function slotOf(tab: EmbeddedTab): number | undefined {
    if (!tab.viewId) return undefined;
    if (tab.viewId !== state.value.activeViewId) return undefined;
    const view = views.value.find((item) => item.id === tab.viewId);
    if (!view) return undefined;
    // Slots hold instances, so a page of an instance shares its slot number.
    const index = view.slotTabs.findIndex((id) => id === tab.instanceId || id === tab.id);
    return index >= 0 ? index + 1 : undefined;
  }

  function isOnStage(tab: EmbeddedTab): boolean {
    if (!tab.viewId) {
      // In flat mode the stage shows the active page of the focused instance.
      const focused = tabs.value.find((item) => item.id === state.value.activeTabId);
      return Boolean(focused && tab.instanceId === focused.instanceId);
    }
    const view = views.value.find((item) => item.id === tab.viewId);
    return Boolean(view?.slotTabs.includes(tab.instanceId) || view?.slotTabs.includes(tab.id));
  }

  function isFocused(tab: EmbeddedTab): boolean {
    return tab.id === state.value.activeTabId;
  }

  function viewTabs(viewId: string): EmbeddedTab[] {
    return tabs.value.filter((tab) => tab.viewId === viewId);
  }

  /** Root pages of the instances in a view; one dock row each. */
  function viewInstances(viewId: string): EmbeddedTab[] {
    const seen = new Set<string>();
    const roots: EmbeddedTab[] = [];
    for (const tab of tabs.value) {
      if (tab.viewId !== viewId || seen.has(tab.instanceId)) continue;
      seen.add(tab.instanceId);
      const root = instanceRoot(tab);
      if (root) roots.push(root);
    }
    return roots;
  }

  /** Root pages of instances that belong to no view. */
  const looseInstances = computed(() => {
    const seen = new Set<string>();
    const roots: EmbeddedTab[] = [];
    for (const tab of tabs.value) {
      if (tab.viewId || seen.has(tab.instanceId)) continue;
      seen.add(tab.instanceId);
      const root = instanceRoot(tab);
      if (root) roots.push(root);
    }
    return roots;
  });

  function slots(view: EmbeddedView): number {
    return embeddedSlotCount(view.layoutId, view.slotRects);
  }

  async function openTab(): Promise<void> {
    await window.ensemble.openEmbeddedTab({});
  }

  /** Opens a blank tab in the flat strip, even when a view is on stage. */
  async function openLooseTab(): Promise<void> {
    await window.ensemble.openEmbeddedTab({ viewId: null });
  }

  /**
   * Opens a tab directly at `url`; the address bar's "no tab yet" path.
   *
   * `clean` is the explicit throwaway session. Omitting it puts the page in the
   * daily profile, which is what makes a bookmark open signed in.
   */
  async function openTabWith(url: string, options?: { clean?: boolean }): Promise<void> {
    await window.ensemble.openEmbeddedTab({
      url,
      ...(options?.clean ? { clean: true } : {}),
    });
  }

  /** Opens a site bookmark as a loose page, even when a view is on stage. */
  async function openLooseTabWith(
    url: string,
    options?: { clean?: boolean },
  ): Promise<void> {
    await window.ensemble.openEmbeddedTab({
      url,
      viewId: null,
      ...(options?.clean ? { clean: true } : {}),
    });
  }

  /** Opens a blank tab straight into a view, so it lands on stage. */
  async function openTabInto(viewId: string): Promise<void> {
    state.value = await window.ensemble.openEmbeddedTabInView(viewId);
  }

  /** Opens a blank tab pinned to one slot of a view and focuses it. */
  async function openTabInSlot(viewId: string, slotIndex: number): Promise<void> {
    state.value = await window.ensemble.openEmbeddedTabInSlot(viewId, slotIndex);
  }

  /** One more page in an existing instance; same session, same window. */
  async function openTabInInstance(instanceId: string): Promise<void> {
    state.value = await window.ensemble.openEmbeddedTabInInstance(instanceId);
  }

  async function duplicateTab(tabId: string): Promise<void> {
    state.value = await window.ensemble.duplicateEmbeddedTab(tabId);
  }

  async function closeOtherTabs(tabId: string): Promise<void> {
    state.value = await window.ensemble.closeOtherEmbeddedTabs(tabId);
  }

  /**
   * Opens an account as a new page in the flat tab strip.
   *
   * Always a new page, always in the default group: the stage (a view, if any)
   * is left alone, and the account gets its own tab where the user can then drag
   * it into a view if that is what they wanted.
   */
  async function openIdentity(identityId: string): Promise<void> {
    state.value = await window.ensemble.openEmbeddedIdentity(identityId);
  }

  /**
   * Batch launch: opens the selected accounts in one new view.
   *
   * A batch is the one case where a layout is the point, so it creates its own
   * container instead of scattering pages into the tab strip or disturbing the
   * view that happened to be on stage.
   */
  async function openIdentitiesInNewView(identityIds: string[]): Promise<void> {
    const workspace = useWorkspaceStore();
    const chosen = identityIds
      .map((id) => workspace.identities.find((identity) => identity.id === id))
      .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
    if (chosen.length === 0) return;
    // One main-process call owns the whole run now: pages are created
    // concurrently, pinned by index against the slot count read at pin time,
    // and rolled back together on failure. The old renderer loop awaited one
    // full page load per member and died on a layout change mid-run.
    state.value = await window.ensemble.launchEmbeddedIdentities(
      chosen.map((identity) => identity.id),
    );
  }

  async function openView(viewId: string): Promise<void> {
    state.value = await window.ensemble.openEmbeddedView(viewId);
  }

  async function closeTab(tabId: string): Promise<void> {
    state.value = await window.ensemble.closeEmbeddedTab(tabId);
  }

  async function activate(tabId: string): Promise<void> {
    state.value = await window.ensemble.activateEmbeddedTab(tabId);
  }

  async function activateView(viewId: string | null): Promise<void> {
    state.value = await window.ensemble.activateEmbeddedView(viewId);
  }

  async function createView(input: { name?: string; layoutId?: LayoutId } = {}): Promise<void> {
    // Named up front so the new container is identifiable in the dock; renaming
    // is a double-click away. The main process has no locale, so the label is
    // resolved here and passed down.
    const base = tr("app.browserViewDefaultName");
    const taken = new Set(views.value.map((view) => view.name));
    let name = base;
    for (let index = 2; taken.has(name); index += 1) name = `${base} ${index}`;
    state.value = await window.ensemble.createEmbeddedView({ ...input, name });
  }

  async function setLayout(viewId: string, layoutId: LayoutId): Promise<void> {
    state.value = await window.ensemble.setEmbeddedViewLayout(viewId, layoutId);
  }

  /**
   * Turns the flat list into a view with this layout.
   *
   * The dock's layout picker on the "tabs" block is the one place a layout can be
   * chosen for pages that have no container yet. The grouping itself happens in
   * the main process (`layoutTargetView`), which is also what the AI tool uses —
   * one implementation, so a manual click and a tool call cannot diverge.
   */
  async function groupIntoLooseView(layoutId: LayoutId): Promise<void> {
    const viewId = await window.ensemble.groupLooseTabs(layoutId);
    if (viewId) state.value = await window.ensemble.getEmbeddedState();
  }

  /** Applies hand-dragged slot geometry (fractions of the stage). */
  async function setSlotRects(viewId: string, rects: SlotRect[]): Promise<void> {
    state.value = await window.ensemble.setEmbeddedViewSlots(viewId, rects);
  }

  async function pin(viewId: string, slotIndex: number, tabId: string | null): Promise<void> {
    state.value = await window.ensemble.pinEmbeddedTab(viewId, slotIndex, tabId);
  }

  async function renameView(viewId: string, name: string): Promise<void> {
    state.value = await window.ensemble.renameEmbeddedView(viewId, name);
  }

  async function closeView(viewId: string, mode: "all" | "opened"): Promise<void> {
    state.value = await window.ensemble.closeEmbeddedView(viewId, mode);
  }

  async function collapseView(viewId: string, collapsed: boolean): Promise<void> {
    state.value = await window.ensemble.collapseEmbeddedView(viewId, collapsed);
  }

  async function dropTab(tabId: string, target: EmbeddedDropTarget): Promise<void> {
    state.value = await window.ensemble.dropEmbeddedTab(tabId, target);
  }

  async function navigate(tabId: string, url: string): Promise<void> {
    await window.ensemble.navigateEmbeddedTab(tabId, url);
  }

  function setDragTab(tabId: string | null): void {
    draggingTabId.value = tabId;
  }

  function setStage(stage: StageRect | null): void {
    window.ensemble.setEmbeddedStage(stage);
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    sidebarCollapsed.value = collapsed;
    window.localStorage.setItem("ensemble.runtimeDock.collapsed", collapsed ? "1" : "0");
  }

  function setDockWidth(width: number, persist = true): void {
    const next = Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width)));
    dockWidth.value = next;
    if (persist) window.localStorage.setItem("ensemble.runtimeDock.width", String(next));
  }

  return {
    state,
    ready,
    draggingTabId,
    stageMenuOpen,
    setStageMenu,
    coverStage,
    finishCover,
    stageMounted,
    setStageMounted,
    tabs,
    views,
    looseTabs,
    looseInstances,
    activeTab,
    activeView,
    runningCount,
    sidebarCollapsed,
    dockWidth,
    setDockWidth,
    init,
    slotOf,
    isOnStage,
    isFocused,
    viewTabs,
    viewInstances,
    instanceRoot,
    instancePages,
    titleOf,
    slots,
    openTab,
    openLooseTab,
    openTabWith,
    openLooseTabWith,
    openTabInto,
    openTabInSlot,
    openTabInInstance,
    duplicateTab,
    closeOtherTabs,
    openIdentity,
    openIdentitiesInNewView,
    openView,
    closeTab,
    activate,
    activateView,
    createView,
    setLayout,
    groupIntoLooseView,
    setSlotRects,
    pin,
    renameView,
    closeView,
    collapseView,
    dropTab,
    navigate,
    dragTab: setDragTab,
    setStage,
    setSidebarCollapsed,
  };
});
