import type { EmbeddedState, EmbeddedTab, EmbeddedView, StageRect } from "@shared/embedded";
import { tabDisplayTitle } from "@shared/embedded";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useWorkspaceStore } from "./workspace";

/**
 * Renderer-side mirror of the embedded surface.
 *
 * The main process owns tabs and geometry; this store keeps the last broadcast
 * state so the browser page and the instance rail render from one source, and
 * wraps the IPC calls so components do not repeat error handling.
 *
 * 舞台单格化（ADR 0012）之后这里不再有多格布局的写入路径：主进程的槽位机制
 * 与视图容器保留（批量启动仍用一个 free 容器装一批账号），但 UI 侧只剩
 * 「当前上台实例 + 其余后台存活」一个模型。多格布局的 setLayout / pin /
 * split 等封装随 UI 一起撤除；主进程的对应 IPC 仍服务于 MCP 工具。
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
   * Menus can be opened from outside the stage, so this cannot be a component
   * prop: the same signal has to reach the stage from anywhere. The stage freezes
   * while it is true, otherwise the native pages paint over the menu.
   */
  const stageMenuOpen = ref(false);

  /**
   * Marks "a menu is covering the stage".
   *
   * Only the stage cover is tracked here; the docked DevTools panel steps aside
   * from `useFloatingLayer`, which every menu already goes through.
   */
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
   * A menu opened from another page has nothing to wait for: the views are
   * already parked off-stage there.
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

  let unsubscribe: (() => void) | null = null;

  async function init(): Promise<void> {
    if (unsubscribe) return;
    state.value = await window.ensemble.getEmbeddedState();
    unsubscribe = window.ensemble.onEmbeddedState((next) => {
      state.value = next;
    });
    window.ensemble.onEmbeddedZoomNotice((notice) => {
      showZoomNotice(notice);
    });
    ready.value = true;
  }

  /**
   * The transient "110%" overlay, and its lifetime.
   *
   * The toolbar used to carry this number permanently; with the stepper gone a
   * keyboard or wheel zoom would otherwise be silent, and a silent zoom reads
   * as "the gesture did nothing" — people press it repeatedly until the page is
   * unreadable. The overlay is the same idea as Chrome's: name the number, then
   * get out of the way. Replaced, not queued, on repeated presses.
   */
  const zoomNotice = ref<{ tabId: string; zoom: number } | null>(null);
  let zoomNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  function showZoomNotice(notice: { tabId: string; zoom: number }): void {
    zoomNotice.value = notice;
    if (zoomNoticeTimer) clearTimeout(zoomNoticeTimer);
    zoomNoticeTimer = setTimeout(() => {
      zoomNotice.value = null;
      zoomNoticeTimer = undefined;
    }, 1_200);
  }

  const tabs = computed<EmbeddedTab[]>(() => state.value.tabs);
  /** The container on stage, if any. A batch launch puts its members in one. */
  const views = computed<EmbeddedView[]>(() => state.value.views);
  const activeTab = computed<EmbeddedTab | undefined>(() =>
    tabs.value.find((tab) => tab.id === state.value.activeTabId),
  );
  const activeView = computed<EmbeddedView | undefined>(() =>
    views.value.find((view) => view.id === state.value.activeViewId),
  );

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

  /**
   * Whether this page is one the stage is drawing right now.
   *
   * The stage is single-cell: either the page is the selected tab of the flat
   * surface, or it is the page its container's (one) slot shows — the same rule
   * the main process uses (`pageForSlot`), so the two sides cannot disagree
   * about which node owns the pixels.
   */
  function isOnStage(tab: EmbeddedTab): boolean {
    if (!tab.viewId) return tab.id === state.value.activeTabId;
    const view = views.value.find((item) => item.id === tab.viewId);
    if (!view || view.id !== state.value.activeViewId) return false;
    const index = view.slotTabs.findIndex((id) => id === tab.instanceId || id === tab.id);
    if (index < 0) return false;
    const pinned = view.slotPages?.[index];
    if (pinned) return pinned === tab.id;
    return tab.active;
  }

  async function openTab(): Promise<void> {
    await window.ensemble.openEmbeddedTab({});
  }

  /** Opens a blank tab in the flat strip. */
  async function openLooseTab(): Promise<void> {
    await window.ensemble.openEmbeddedTab({ viewId: null });
  }

  /**
   * Opens a blank browser in a named profile.
   *
   * A profile with `ephemeral` retention gets its own in-memory session rather
   * than a shared one, which is what makes two clean browsers independent. The
   * retention is read here rather than passed in by each call site: every caller
   * would otherwise have to look up the same row and could get it wrong.
   */
  async function openProfileTab(profileId: string): Promise<void> {
    const profile = useWorkspaceStore().settings.profiles?.find((item) => item.id === profileId);
    await window.ensemble.openEmbeddedTab({
      profileId,
      ...(profile?.retention === "ephemeral" ? { ephemeral: true } : {}),
    });
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
   * Always a new page, always in the default group: the stage is left alone, and
   * the account gets its own tab.
   */
  async function openIdentity(identityId: string): Promise<void> {
    state.value = await window.ensemble.openEmbeddedIdentity(identityId);
  }

  /**
   * Batch launch: opens the selected accounts; the first takes the stage.
   *
   * One main-process call owns the whole run: pages are created concurrently in
   * one Free (single-slot) container, the first member is pinned to the stage,
   * and the rest stay alive off stage — their logins keep running and the MCP
   * tools keep driving them. Rolled back together on failure.
   */
  async function openIdentitiesInNewView(identityIds: string[]): Promise<void> {
    const workspace = useWorkspaceStore();
    const chosen = identityIds
      .map((id) => workspace.identities.find((identity) => identity.id === id))
      .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
    if (chosen.length === 0) return;
    state.value = await window.ensemble.launchEmbeddedIdentities(
      chosen.map((identity) => identity.id),
    );
  }

  async function closeTab(tabId: string): Promise<void> {
    state.value = await window.ensemble.closeEmbeddedTab(tabId);
  }

  /**
   * 把页面拆出到独立窗口；已拆出的页面收回主舞台。
   *
   * toggle 语义由主进程裁决。新状态经常规广播到达：广播里该页带 `popout: true`，
   * strip 据此换图标与文案。
   */
  async function popOutTab(tabId: string): Promise<void> {
    await window.ensemble.popOutBrowserTab(tabId);
  }

  async function activate(tabId: string): Promise<void> {
    state.value = await window.ensemble.activateEmbeddedTab(tabId);
  }

  /**
   * Pins a page to a fixed CSS viewport, or returns it to adaptive fill.
   *
   * The new state arrives on the `onEmbeddedState` push: the manager re-lays
   * the page out (fitted and centred), and the strip reads that broadcast, so
   * there is nothing to merge here.
   */
  async function setViewport(
    tabId: string,
    mode: { width: number; height: number } | "adaptive" | "inherit" | null,
  ): Promise<void> {
    await window.ensemble.setEmbeddedViewport(tabId, mode);
  }

  /**
   * Sets the per-tab sleep policy.
   *
   * Like {@link setViewport}, the result arrives as a state push: sleeping is
   * decided in the main process, and the tab strip reads `sleeping` /
   * `sleepPolicy` from that broadcast. Setting "never" wakes the page first, so
   * the broadcast that follows already carries the new state.
   */
  async function setSleepPolicy(tabId: string, policy: "auto" | "never"): Promise<void> {
    await window.ensemble.setEmbeddedSleep(tabId, policy);
  }

  /**
   * Mutes or unmutes one page's output.
   *
   * This is the user's action, so the main process records their intent and a
   * later AI operation will not silently re-mute the tab. The new state arrives
   * through the same broadcast the rest of the chrome reads.
   */
  async function setMuted(tabId: string, muted: boolean): Promise<void> {
    await window.ensemble.setEmbeddedMuted(tabId, muted);
  }

  /**
   * Sets the workspace default viewport, or clears it with `null`.
   *
   * Stored as a setting rather than broadcast state: it survives a restart, it
   * rides along with the workspace file, and pages that inherit it pick it up
   * through the main process on the next layout pass.
   *
   * `null`, not `undefined`: settings travel to the main process through
   * `JSON.stringify`, which drops keys whose value is `undefined`. Sending
   * `{ browserViewport: undefined }` arrived as `{}`, so the main process saw no
   * key at all and the change was silently discarded — picking "adaptive" after
   * a fixed size did nothing. `null` survives the round trip and is what the
   * schema accepts.
   */
  async function setDefaultViewport(size: { width: number; height: number } | null): Promise<void> {
    await useWorkspaceStore().saveSettings({ browserViewport: size });
  }

  /**
   * Reorders pages by drop target.
   *
   * The second row (the on-stage instance's page tabs) is the only drag source
   * and target left: dropping on a tab moves the page around that instance's
   * tab order. The "into a view / into the flat list" targets belonged to the
   * retired dock; the main process still accepts them for the MCP tools, but no
   * UI gesture produces them any more.
   */
  async function dropTab(tabId: string, target: { kind: "tab"; tabId: string; edge: "before" | "after" | "middle" }): Promise<void> {
    state.value = await window.ensemble.dropEmbeddedTab(tabId, target);
  }

  async function navigate(tabId: string, url: string): Promise<void> {
    await window.ensemble.navigateEmbeddedTab(tabId, url);
  }

  function setDragTab(tabId: string | null): void {
    draggingTabId.value = tabId;
  }

  /**
   * Stage rectangle in window coordinates, as last reported to main.
   *
   * Kept here because the page nodes live at the app root, not inside the
   * browser page: they have to survive the browser page unmounting (the user
   * going to a management page while an AI tool keeps using a tab). The root
   * needs the origin to place them at all.
   */
  const stageRect = ref<StageRect | null>(null);

  /**
   * True while a management page covers the browser.
   *
   * Set before the view switches, so the pages are parked in the same task that
   * renders the incoming page. Waiting for the browser page to unmount and
   * report the stage as gone is a step too late: the incoming page's first paint
   * can land while a page is still on stage, and a page paints above ordinary
   * in-flow content, so the panel and the page swap places for a frame.
   */
  const stageSuspended = ref(false);

  function suspendStage(suspended: boolean): void {
    stageSuspended.value = suspended;
  }

  function setStage(stage: StageRect | null): void {
    stageRect.value = stage;
    window.ensemble.setEmbeddedStage(stage);
  }

  /**
   * How many gestures currently need the pointer to stay in this document.
   *
   * A page is a real native surface even as a `<webview>`: once the cursor
   * crosses into a page's box, that page receives the mouse events and this
   * document gets nothing — not even the moves of a drag that started on one of
   * the app's own controls. A count rather than a flag because gestures can
   * nest, and the pages only become hit-testable again when the last one ends.
   */
  const pointerShield = ref(0);

  function holdPointer(): void {
    pointerShield.value += 1;
  }

  function releasePointer(): void {
    pointerShield.value = Math.max(0, pointerShield.value - 1);
  }

  return {
    state,
    ready,
    zoomNotice,
    showZoomNotice,
    draggingTabId,
    pointerShield,
    holdPointer,
    releasePointer,
    stageMenuOpen,
    setStageMenu,
    coverStage,
    finishCover,
    stageMounted,
    setStageMounted,
    tabs,
    views,
    activeTab,
    activeView,
    instanceRoot,
    instancePages,
    titleOf,
    isOnStage,
    init,
    openTab,
    openLooseTab,
    openProfileTab,
    openTabWith,
    openTabInInstance,
    duplicateTab,
    closeOtherTabs,
    openIdentity,
    openIdentitiesInNewView,
    closeTab,
    popOutTab,
    activate,
    setViewport,
    setSleepPolicy,
    setMuted,
    setDefaultViewport,
    dropTab,
    navigate,
    dragTab: setDragTab,
    setStage,
    stageRect,
    suspendStage,
    stageSuspended,
  };
});
