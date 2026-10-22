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
  const sidebarCollapsed = ref(
    window.localStorage.getItem("ensemble.runtimeDock.collapsed") === "1",
  );
  let unsubscribe: (() => void) | null = null;

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

  /** Opens a tab directly at `url`; the address bar's "no tab yet" path. */
  async function openTabWith(url: string): Promise<void> {
    await window.ensemble.openEmbeddedTab({ url });
  }

  /** Opens a blank tab straight into a view, so it lands on stage. */
  async function openTabInto(viewId: string): Promise<void> {
    state.value = await window.ensemble.openEmbeddedTabInView(viewId);
  }

  /** Opens a blank tab pinned to one slot of a view and focuses it. */
  async function openTabInSlot(viewId: string, slotIndex: number): Promise<void> {
    state.value = await window.ensemble.openEmbeddedTabInSlot(viewId, slotIndex);
  }

  async function openIdentity(identityId: string): Promise<void> {
    state.value = await window.ensemble.openEmbeddedIdentity(identityId);
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

  function setStage(stage: StageRect | null): void {
    window.ensemble.setEmbeddedStage(stage);
  }

  function setSidebarCollapsed(collapsed: boolean): void {
    sidebarCollapsed.value = collapsed;
    window.localStorage.setItem("ensemble.runtimeDock.collapsed", collapsed ? "1" : "0");
  }

  return {
    state,
    ready,
    tabs,
    views,
    looseTabs,
    looseInstances,
    activeTab,
    activeView,
    runningCount,
    sidebarCollapsed,
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
    openTabInto,
    openTabInSlot,
    openIdentity,
    openView,
    closeTab,
    activate,
    activateView,
    createView,
    setLayout,
    setSlotRects,
    pin,
    renameView,
    closeView,
    collapseView,
    dropTab,
    navigate,
    setStage,
    setSidebarCollapsed,
  };
});
