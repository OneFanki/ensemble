<script setup lang="ts">
import type { EmbeddedTab, EmbeddedView, FrozenSlot, StageRect } from "@shared/embedded";
import {
  DEVTOOLS_GRIP_WIDTH,
  EMBEDDED_DIVIDER,
  EMBEDDED_SLOT_HEADER,
  embeddedSlotRects,
  isBlankTab,
  tabDisplayTitle,
  VIEWPORT_MAX_HEIGHT,
  VIEWPORT_MAX_WIDTH,
  VIEWPORT_MIN,
  VIEWPORT_PRESETS,
  viewSlotFractions,
} from "@shared/embedded";
import { resolveBrowserInput } from "@shared/search";
import type {
  Bookmark,
  BookmarkDraft,
  DownloadAction,
  DownloadEntry,
  Identity,
  SlotRect,
} from "@shared/types";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Copy,
  CornerDownLeft,
  Download,
  ExternalLink,
  FolderOpen,
  KeyRound,
  LayoutGrid,
  Minus,
  Monitor,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Table2,
  Trash2,
  Users,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useStageGeometry } from "../composables/stageGeometry";
import { useEmbeddedStore } from "../stores/embedded";
import { useNavigationStore } from "../stores/navigation";
import { useWorkspaceStore } from "../stores/workspace";
import BookmarkDialog from "./BookmarkDialog.vue";
import InstanceTabStrip from "./InstanceTabStrip.vue";
import NewTabPage from "./NewTabPage.vue";
import OpenSiteButton from "./OpenSiteButton.vue";
import TabIcon from "./TabIcon.vue";

const store = useEmbeddedStore();
const workspace = useWorkspaceStore();
const navigation = useNavigationStore();
const { t } = useI18n();

const props = defineProps<{
  /** An HTML overlay (for example the site menu) covers the stage. */
  obscured?: boolean;
  /**
   * Multi-cell layout is on stage: the cell headers and the run dock are shown.
   *
   * The top tab strip is drawn either way — a browser always has one. In bench
   * mode it names the focused cell's account, because every cell of the same
   * app shows the same page titles.
   */
  bench?: boolean;
}>();

const emit = defineEmits<{
  /** Open the management console (the app's own pages). */
  openConsole: [];
  /** Single cell ↔ workbench. */
  switchMode: [mode: "browse" | "bench"];
}>();

/**
 * The stage box in CSS pixels, kept reactive.
 *
 * `slotChrome` used to read `stage.clientWidth` directly, which is not a
 * reactive source: the header bands only recomputed when the tab list changed.
 * Collapsing the dock or resizing the window then left the HTML bands at the old
 * width while the native pages had already moved to the new one, which reads as
 * a dead band beside the last cell.
 *
 * Measuring lives in `useStageGeometry`, which reports the rectangle to the main
 * process: that call is the only contract with whatever draws pages inside the
 * stage, so it stays in one place rather than being spelled out here.
 */
const geometry = useStageGeometry((rect) => store.setStage(rect));
/** Template ref: `useStageGeometry` owns the measuring, so the ref comes from it. */
const stage = geometry.stage;
const stageBox = geometry.box;
const stageOrigin = geometry.origin;
const reportStage = geometry.report;
const address = ref("");
const findText = ref("");
const findResult = ref<{ matches: number; activeMatch: number } | null>(null);
const findOpen = ref(false);
/** Frozen frames shown while the native views are parked for an overlay. */
const frozenSlots = ref<FrozenSlot[]>([]);

const platform = computed(() => workspace.snapshot?.platform ?? "win32");
/** The AI endpoint menu: state, address and the way to settings. */
const aiMenuOpen = ref(false);

function openMcpSettings(): void {
  aiMenuOpen.value = false;
  navigation.navigate("settings", "mcp");
}

/**
 * Whether the cell headers and the run dock are drawn.
 *
 * Read from the prop when the parent has an opinion, and from the layout
 * otherwise: a multi-cell layout is on stage because someone opened a workbench,
 * and a stale prop should not hide the cells of the layout it is showing.
 */
const bench = computed(() => {
  if (props.bench !== undefined) return props.bench;
  return (activeView.value ? store.slots(activeView.value) : 1) > 1;
});

/**
 * Pages the window-level tab strip lists.
 *
 * The focused cell's instance when there is a view, the active instance when the
 * stage is flat. One instance fills one cell, so "the window's tabs" always means
 * one browser's pages — which is what a tab strip means.
 */
const windowInstanceId = computed<string | null>(() => {
  const view = activeView.value;
  if (view) {
    const focused = view.focusedTabId ?? view.slotTabs.find(Boolean) ?? null;
    return slotInstanceId(focused);
  }
  return activeTab.value?.instanceId ?? null;
});

const windowPages = computed<EmbeddedTab[]>(() =>
  windowInstanceId.value ? store.instancePages(windowInstanceId.value) : [],
);

/** Which page the strip marks as current: the focused cell's own page. */
const windowActivePageId = computed<string | null>(() => {
  const view = activeView.value;
  if (!view) return activeTab.value?.id ?? null;
  const focused = view.focusedTabId ?? view.slotTabs.find(Boolean) ?? null;
  const index = focused ? view.slotTabs.indexOf(focused) : -1;
  return (index >= 0 ? slotPage(focused, index) : undefined)?.id ?? null;
});

/**
 * Clicking a window-level tab shows that page in the focused cell.
 *
 * It goes through the same path as a click inside the cell's strip, so a split
 * instance keeps pinning pages to cells instead of moving the whole window's
 * active page.
 */
function activateWindowPage(pageId: string): void {
  const view = activeView.value;
  const focused = view?.focusedTabId ?? view?.slotTabs.find(Boolean) ?? null;
  const index = view && focused ? view.slotTabs.indexOf(focused) : -1;
  if (index >= 0) selectPage(pageId, index);
  else selectPage(pageId);
}

function onWindowPageDragStart(page: EmbeddedTab, event: DragEvent): void {
  store.dragTab(page.id);
  event.dataTransfer?.setData("text/plain", page.id);
  event.dataTransfer?.setData("application/x-ensemble-page", page.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onWindowPageDragEnd(): void {
  store.dragTab(null);
}

function openWindowPageMenu(page: EmbeddedTab, event: MouseEvent): void {
  openTabMenu(page, event);
}

/** The strip's "+": another page in the same instance, asked as which account. */
function addWindowPage(): void {
  if (windowInstanceId.value) void store.openTabInInstance(windowInstanceId.value);
}

/**
 * Single cell ↔ workbench.
 *
 * The parent owns the mode: the shell decides whether the run dock is on screen,
 * and the browser only reports what was clicked. Shrinking does not close
 * anything — every page keeps running and stays reachable from the run dock.
 */
function toggleBench(): void {
  emit("switchMode", bench.value ? "browse" : "bench");
}

const activeTab = computed(() => store.activeTab);
const activeView = computed(() => store.activeView);

/**
 * Whether the active page is already a bookmark.
 *
 * Compared by URL, not by name: two bookmarks may share a title but never the
 * address they open, and this drives a toggle — a star that is filled must mean
 * "clicking it removes exactly this entry".
 */
const bookmarkedEntry = computed<Bookmark | undefined>(() => {
  const tab = activeTab.value;
  if (!tab || isBlankTab(tab)) return undefined;
  return workspace.bookmarks.find((item) => samePage(item.url, tab.url));
});

/** The bookmark dialog over the stage; `null` means closed. */
const bookmarkDialogDraft = ref<BookmarkDraft | null>(null);

/** URL equality that ignores the hash and a trailing slash on the path. */
function samePage(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    const trim = (value: string) => value.replace(/\/+$/, "");
    return (
      left.origin === right.origin &&
      trim(left.pathname) === trim(right.pathname) &&
      left.search === right.search
    );
  } catch {
    return a === b;
  }
}

/**
 * The origin of the active page, when it is one the AI gate actually covers.
 *
 * Undefined for an account page, a clean session, or a non-web page: in all
 * three cases a permission switch here would be meaningless, and showing one
 * would teach the user that the control is decorative.
 */
const aiGateOrigin = computed<string | undefined>(() => {
  const tab = activeTab.value;
  if (!tab || tab.identityId || tab.clean) return undefined;
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
});

const aiGateVisible = computed(() => Boolean(aiGateOrigin.value));
const aiOriginAuthorized = computed(() => {
  const origin = aiGateOrigin.value;
  return origin ? (workspace.mcp?.aiOrigins ?? []).includes(origin) : false;
});

/**
 * Grants or revokes AI input for the page's origin.
 *
 * Per origin rather than per tab, and reversible in one click: the user's model
 * is "this site may be operated", and a permission that takes a trip to Settings
 * to undo would stay on long after they stopped needing it.
 */
async function toggleAiOrigin(): Promise<void> {
  const origin = aiGateOrigin.value;
  if (!origin) {
    workspace.notify(t("app.aiOriginNoOrigin"), "error");
    return;
  }
  const next = !aiOriginAuthorized.value;
  const status = await workspace.updateMcp({ aiOrigin: { origin, allowed: next } });
  if (!status) return;
  workspace.notify(t(next ? "app.aiOriginGranted" : "app.aiOriginRevoked", { origin }), "success");
}

/**
 * Star in the address bar: one click removes an existing bookmark, adding opens
 * the bookmark dialog with the page prefilled.
 *
 * The name offered is the page title, which is what the user recognises; the
 * host is the fallback for a page that has not set one. Saving goes through the
 * same `saveBookmark` call the management page uses, so the URL rule is
 * enforced in one place.
 */
async function toggleBookmark(): Promise<void> {
  const tab = activeTab.value;
  if (!tab || isBlankTab(tab)) return;
  const existing = bookmarkedEntry.value;
  if (existing) {
    await workspace.deleteBookmark(existing.id);
    workspace.notify(t("app.bookmarkRemoved", { name: existing.name }), "success");
    return;
  }
  // A crash page and a scheme the surface refuses both have a URL but no
  // bookmark; the service would reject them, so say why before trying.
  let host = "";
  try {
    const parsed = new URL(tab.url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") host = parsed.host;
  } catch {
    host = "";
  }
  if (!host) return;
  const name = (tab.title || "").trim() || host;
  bookmarkDialogDraft.value = { name: name.slice(0, 120), url: tab.url };
}

async function onBookmarkDialogSave(draft: BookmarkDraft): Promise<void> {
  // run() reports the failure itself and returns undefined — without the truth
  // check the star would announce a bookmark that never landed.
  if (!(await workspace.saveBookmark(draft))) return;
  bookmarkDialogDraft.value = null;
  // The icon is already in hand here: the tab fetched it through its own
  // session, so the grid does not have to make a second request for the bytes.
  const saved = workspace.bookmarks.find((item) => samePage(item.url, draft.url));
  if (saved && activeTab.value?.favicon) {
    await workspace.setBookmarkFavicon(saved.id, activeTab.value.favicon);
  }
  workspace.notify(t("app.bookmarkAdded", { name: saved?.name ?? draft.name }), "success");
}

/**
 * Slots of the view on stage, in the same geometry the main process uses. The
 * header band of each slot is the only part of the stage HTML that stays
 * visible: the native page paints over the rest.
 */
const slotChrome = computed(() => {
  const view = activeView.value;
  const width = stageBox.value.width;
  const height = stageBox.value.height;
  if (!view || width <= 0 || height <= 0) return [];
  return embeddedSlotRects(view.layoutId, { x: 0, y: 0, width, height }, view.slotRects).map(
    (slot, index) => ({
      ...slot,
      index,
      tabId: view.slotTabs[index] ?? null,
    }),
  );
});

function tabById(id: string | null): EmbeddedTab | undefined {
  if (!id) return undefined;
  return store.tabs.find((tab) => tab.id === id);
}

/**
 * Page a slot is currently showing.
 *
 * `slotTabs` stores browser-instance ids; the instance may have several pages
 * after a `target="_blank"` link, and normally the slot shows the active one.
 * A slot that pinned a page (`slotPages`, the same-account split) shows that
 * page instead — otherwise the two cells would show the same thing.
 */
function slotPage(rootId: string | null, index?: number): EmbeddedTab | undefined {
  const root = tabById(rootId);
  if (!root) return undefined;
  const pinnedId = index === undefined ? null : (activeView.value?.slotPages?.[index] ?? null);
  const pinned = pinnedId ? tabById(pinnedId) : undefined;
  if (pinned && pinned.instanceId === root.instanceId) return pinned;
  const pages = store.instancePages(root.instanceId);
  return pages.find((page) => page.active) ?? root;
}

/**
 * Index of the slot that currently shows this page, if any.
 *
 * With a split, one instance occupies two cells showing two different pages; the
 * strip in each cell must mark *its own* page as current, so the caller passes
 * the slot index it is drawing for.
 */
function slotShowingPage(pageId: string | undefined): number | undefined {
  if (!pageId) return undefined;
  return slotChrome.value.find((slot) => slotPage(slot.tabId, slot.index)?.id === pageId)?.index;
}

/**
 * Instance id behind a slot's entry.
 *
 * `slotTabs` holds the root page's id, and closing that page re-points the slot
 * at the oldest survivor — whose `instanceId` still names the original instance.
 * Passing the slot entry straight to the strip therefore looked up pages by a
 * page id and found none, which is exactly how a cell lost its tab strip after
 * its root page was closed.
 */
function slotInstanceId(rootId: string | null): string | null {
  if (!rootId) return null;
  const root = tabById(rootId);
  return root?.instanceId ?? null;
}

/** Name of the account the slot's instance belongs to, when it has one. */
function slotAccount(rootId: string | null): string {
  const root = tabById(rootId);
  if (!root?.identityId) return "";
  return workspace.identities.find((item) => item.id === root.identityId)?.name ?? "";
}

/** How many cells of the active view hold the instance behind this slot entry. */
function viewSlotCount(rootId: string | null): number {
  const view = activeView.value;
  if (!view || !rootId) return 0;
  return view.slotTabs.filter((id) => id === rootId).length;
}

/**
 * Gives a split cell back to the instance.
 *
 * A split is two cells showing two pages of one window; "un-split" means this
 * cell stops pinning a page, so it follows the instance again. If the instance
 * still holds another cell the pins there are dropped too — otherwise "one cell
 * follows the window" would sit next to a cell that still pins a page, which is
 * the same confusion in a smaller dose.
 */
async function unsplitSlot(slotIndex: number): Promise<void> {
  const view = activeView.value;
  if (!view) return;
  await store.unsplitSlot(view.id, slotIndex);
}

/**
 * Switching pages inside a slot.
 *
 * The instance stays in the same cell — only which of its pages is on screen
 * changes — so this must not bubble up to the header's "select this slot".
 *
 * When the same instance occupies two cells (a split), the click also pins the
 * page to *this* cell. Without that, `activate` would move the instance's global
 * active page and the other cell would silently switch to the same page — the
 * two-cell comparison would collapse into two identical pictures.
 */
function selectPage(pageId: string, slotIndex?: number): void {
  const view = activeView.value;
  if (view && slotIndex !== undefined && viewSlotCount(view.slotTabs[slotIndex] ?? null) > 1) {
    void store.splitPageIntoSlot(view.id, slotIndex, pageId);
    return;
  }
  void store.activate(pageId);
}

/**
 * Right-click menu for a page tab.
 *
 * This is the one popup that cannot live in the header band, so it asks the
 * store to freeze the stage first — the native pages are parked, a snapshot
 * stands in for them, and the menu is plain HTML on top. Closes on the next
 * click anywhere.
 */
const tabMenu = ref<{ page: EmbeddedTab; x: number; y: number } | null>(null);

async function openTabMenu(page: EmbeddedTab, event: MouseEvent): Promise<void> {
  const x = Math.min(event.clientX, window.innerWidth - 208);
  const y = Math.min(event.clientY, window.innerHeight - 160);
  await store.coverStage();
  tabMenu.value = { page, x, y };
  window.addEventListener("pointerdown", onMenuPointerDown, true);
  window.addEventListener("keydown", onMenuKeydown, true);
}

function closeTabMenu(): void {
  window.removeEventListener("pointerdown", onMenuPointerDown, true);
  window.removeEventListener("keydown", onMenuKeydown, true);
  tabMenu.value = null;
  store.setStageMenu(false);
}

function onMenuPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest(".tab-menu")) return;
  closeTabMenu();
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeTabMenu();
}

async function duplicateTab(): Promise<void> {
  const page = tabMenu.value?.page;
  closeTabMenu();
  if (page) await store.duplicateTab(page.id);
}

async function closeTab(): Promise<void> {
  const page = tabMenu.value?.page;
  closeTabMenu();
  if (page) await store.closeTab(page.id);
}

async function closeOtherTabs(): Promise<void> {
  const page = tabMenu.value?.page;
  closeTabMenu();
  if (page) await store.closeOtherTabs(page.id);
}

async function copyTabUrl(): Promise<void> {
  const page = tabMenu.value?.page;
  closeTabMenu();
  if (!page || isBlankTab(page)) return;
  await navigator.clipboard.writeText(page.url);
}

const menuPageCount = computed(() => {
  const page = tabMenu.value?.page;
  return page ? store.instancePages(page.instanceId).length : 0;
});

/**
 * The menu page's viewport, read from live state rather than the snapshot taken
 * when the menu opened: applying a preset re-lays the page out and the menu
 * should follow to mark the new active row.
 */
const menuViewport = computed(() => {
  const id = tabMenu.value?.page.id;
  return id ? store.state.tabs.find((tab) => tab.id === id)?.viewport : undefined;
});

/** What the page itself chose: absent means "inherit the workspace default". */
const menuViewportOverride = computed(() => {
  const id = tabMenu.value?.page.id;
  return id ? store.state.tabs.find((tab) => tab.id === id)?.viewportOverride : undefined;
});

const customWidth = ref("");
const customHeight = ref("");
const viewportError = ref<string | null>(null);

/**
 * Workspace-wide resolution, and the toolbar menu that sets it.
 *
 * Kept out of the tab menu on purpose: this is the answer for "how big should
 * pages be by default", which is a setting, while the tab menu answers "how big
 * should *this* page be". Putting both in the tab menu made one of them look
 * like a bug — a control that silently changed four pages at once.
 */
const globalViewport = computed(() => workspace.settings.browserViewport);
const globalViewportOpen = ref(false);

function toggleGlobalViewport(): void {
  globalViewportOpen.value = !globalViewportOpen.value;
}

// One click anywhere else closes it, like the toolbar's other dropdowns. The
// handler is capture-phase so a click on a menu row still selects before this
// runs, and pointer-down on the menu itself is exempt.
watch(globalViewportOpen, (open) => {
  if (open) window.addEventListener("pointerdown", onGlobalViewportOutside, true);
  else window.removeEventListener("pointerdown", onGlobalViewportOutside, true);
});

function onGlobalViewportOutside(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest(".global-viewport")) return;
  globalViewportOpen.value = false;
}

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onGlobalViewportOutside, true);
});

async function applyGlobalViewport(size: { width: number; height: number } | null): Promise<void> {
  globalViewportOpen.value = false;
  await store.setDefaultViewport(size);
}

/**
 * Applies a viewport choice to the menu's page, then closes the menu.
 *
 * Closing is part of the behaviour, not an afterthought. The menu floats over a
 * frozen picture of the stage, and the views are parked while it is open — so
 * the re-layout this call causes cannot be seen until the stage comes back. A
 * menu that stays open after the click therefore looks like a menu that ignored
 * it: the row highlights, the page behind does not change, and the result only
 * appears once the user dismisses it. Picking a size is "show me this page at
 * that size", so the answer has to be on screen immediately.
 */
async function applyViewport(
  size: { width: number; height: number } | "adaptive" | "inherit",
): Promise<void> {
  const page = tabMenu.value?.page;
  if (!page) return;
  viewportError.value = null;
  try {
    await store.setViewport(page.id, size);
  } catch (error) {
    // A rejected size keeps the menu open: the message belongs next to the
    // control that produced it.
    viewportError.value = (error as Error).message;
    return;
  }
  closeTabMenu();
}

async function applyCustomViewport(): Promise<void> {
  const width = Number(customWidth.value);
  const height = Number(customHeight.value);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < VIEWPORT_MIN ||
    width > VIEWPORT_MAX_WIDTH ||
    height < VIEWPORT_MIN ||
    height > VIEWPORT_MAX_HEIGHT
  ) {
    viewportError.value = t("app.viewportRangeError", {
      wMax: VIEWPORT_MAX_WIDTH,
      hMax: VIEWPORT_MAX_HEIGHT,
      min: VIEWPORT_MIN,
    });
    return;
  }
  await applyViewport({ width, height });
  // `applyViewport` already closed the menu on success; clearing the inputs is
  // only useful when the menu is still open with an error under it.
  if (!viewportError.value) {
    customWidth.value = "";
    customHeight.value = "";
  }
}

/**
 * Blank pages the stage has to draw itself.
 *
 * The main process keeps a blank page's native view parked, so the app's own
 * new-tab surface is what the user sees: search box, engine list, and a clear
 * answer for what Enter will do. This is what makes "+" land somewhere instead
 * of on an empty white rectangle.
 */
const blankSurfaces = computed(() => {
  const view = activeView.value;
  if (!view) {
    const tab = activeTab.value;
    if (!tab || tab.viewId || !isBlankTab(tab)) return [];
    // A single cell has no header band any more (the window strip owns the tabs),
    // so the blank surface fills the stage instead of starting below a band that
    // is not drawn.
    const box = stageBox.value;
    return [{ tab, slot: { x: 0, y: 0, width: box.width, height: Math.max(1, box.height) } }];
  }
  return slotChrome.value
    .map((slot, index) => ({ slot, index }))
    .flatMap(({ slot, index }) => {
      const page = slotPage(slot.tabId, index);
      if (!page || !isBlankTab(page)) return [];
      const rect = embeddedSlotRectsForSlot(index);
      return rect ? [{ tab: page, slot: rect }] : [];
    });
});

/** Slot rect with the header band removed: the surface lives below the chrome. */
function embeddedSlotRectsForSlot(index: number): StageRect | null {
  const slot = slotChrome.value.find((item) => item.index === index);
  if (!slot) return null;
  return {
    x: slot.x,
    y: slot.y + EMBEDDED_SLOT_HEADER,
    width: slot.width,
    height: Math.max(1, slot.height - EMBEDDED_SLOT_HEADER),
  };
}

/**
 * Drag handles between a docked DevTools panel and its page.
 *
 * The gap the handle lives in is real: the main process parts the two native
 * views around `DEVTOOLS_GRIP_WIDTH` precisely because renderer HTML paints
 * below them. Same arithmetic on both sides, one shared constant.
 */
const devtoolsGrips = computed(() => {
  const grips: Array<{ tabId: string; x: number; y: number; width: number; height: number }> = [];
  const push = (page: EmbeddedTab | undefined, rect: StageRect | null) => {
    if (!page?.devtoolsOpen || page.devtoolsWidth === undefined || !rect) return;
    const split = Math.round(rect.width * (1 - page.devtoolsWidth));
    grips.push({
      tabId: page.id,
      x: rect.x + split - Math.round(DEVTOOLS_GRIP_WIDTH / 2),
      y: rect.y,
      width: DEVTOOLS_GRIP_WIDTH,
      height: rect.height,
    });
  };
  for (const slot of slotChrome.value) {
    push(slotPage(slot.tabId, slot.index), embeddedSlotRectsForSlot(slot.index));
  }
  const tab = activeTab.value;
  if (!activeView.value && tab && !tab.viewId) {
    const box = stageBox.value;
    push(tab, {
      x: 0,
      y: EMBEDDED_SLOT_HEADER,
      width: box.width,
      height: Math.max(1, box.height - EMBEDDED_SLOT_HEADER),
    });
  }
  return grips;
});

/**
 * A drag is handed to the main process, which follows the cursor itself — the
 * pointer spends the drag over the native views, where HTML events never reach.
 * The renderer's mouseup is the fallback for a release over app chrome; over a
 * view, the view's own input-event reports it.
 */
function onGripDown(tabId: string, event: MouseEvent): void {
  event.preventDefault();
  void window.ensemble.beginEmbeddedDevToolsResize(tabId);
  const stop = () => {
    window.removeEventListener("mouseup", stop);
    void window.ensemble.endEmbeddedDevToolsResize();
  };
  window.addEventListener("mouseup", stop);
}

/** Arrow keys move the split in small steps, as a separator should. */
function onGripKey(tabId: string, event: KeyboardEvent): void {
  const page = tabById(tabId);
  const step = event.key === "ArrowLeft" ? -0.04 : event.key === "ArrowRight" ? 0.04 : 0;
  if (!step || !page || page.devtoolsWidth === undefined) return;
  event.preventDefault();
  void window.ensemble.setEmbeddedDevToolsWidth(tabId, page.devtoolsWidth + step);
}

function activateSlot(rootId: string | null, index?: number): void {
  const page = slotPage(rootId, index);
  if (page) void store.activate(page.id);
}

/**
 * A dock row can be dropped straight onto a slot.
 *
 * Picking a slot first and then clicking a tab is the documented path, but almost
 * nobody discovers it: dragging the page onto the cell is what people try first.
 * The header band is the only HTML above a live page, so that is the drop target.
 */
const dropSlot = ref<number | null>(null);
/** Empty cell whose account picker is open; one at a time, like a menu. */
const openSlotPicker = ref<number | null>(null);

function onSlotDragOver(slotIndex: number, event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("text/plain")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  dropSlot.value = slotIndex;
}

/**
 * Two kinds of drag land on a cell, and they mean different things.
 *
 * A dock row drags an *instance root*: "put this browser window in that cell".
 * A page tab drags one *page* (it also sets `application/x-ensemble-page`):
 * "show this page in that cell". The second is what makes one account split
 * across two cells — the instance stays the same, only the visible page differs,
 * so cookies and the login stay shared.
 */
async function onSlotDrop(slotIndex: number, event: DragEvent): Promise<void> {
  event.preventDefault();
  const pageId = event.dataTransfer?.getData("application/x-ensemble-page") ?? "";
  const tabId = event.dataTransfer?.getData("text/plain");
  dropSlot.value = null;
  // Clearing the drag signal restores the live pages; do it before the IPC so the
  // re-layout lands on a stage that is already visible again.
  store.dragTab(null);
  const view = activeView.value;
  if (!view) return;
  if (pageId) {
    await store.splitPageIntoSlot(view.id, slotIndex, pageId);
    return;
  }
  if (!tabId) return;
  // pinTab joins the view when needed and focuses the page it pinned.
  await store.pin(view.id, slotIndex, tabId);
}

/**
 * An empty slot is drawn as one dashed cell covering the whole rectangle.
 *
 * It has no header band — there is no page title to put in one, and a 26px strip
 * with only a slot number looked like a label stuck to the top edge. The number
 * moves into the cell, next to the action, so the whole area reads as "a place a
 * page belongs".
 */
const emptySlots = computed(() =>
  slotChrome.value
    .filter((slot) => !slot.tabId)
    .map((slot) => ({
      index: slot.index,
      left: slot.x,
      top: slot.y,
      width: slot.width,
      height: slot.height,
    })),
);

/**
 * Divider handles for resizing a view by hand.
 *
 * Native pages are inset by `EMBEDDED_DIVIDER` on every internal edge, which
 * leaves a real gap for the handle: a divider drawn on the exact boundary would
 * be painted over by the page itself.
 *
 * Handles are grouped by *boundary*, not by slot. In a 2×2, both bottom cells
 * end at the same y — a per-rect map keyed by that y ended up keeping only the
 * last one, so the horizontal handle covered the right half of the stage and
 * the left half was unreachable (dragging there hit the stage itself). Each
 * boundary here spans every cell that touches it.
 */
interface Divider {
  key: string;
  axis: "x" | "y";
  /** Boundary in fractions of the stage. */
  at: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rounds a fraction to the precision boundaries are compared at. */
function boundary(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const dividers = computed<Divider[]>(() => {
  const element = stage.value;
  const view = activeView.value;
  if (!element || !view) return [];
  // A single full-stage page has nothing to split.
  if (!view.slotRects && view.layoutId === "free") return [];
  const rects = viewSlotFractions(view);
  if (rects.length < 2) return [];
  const width = element.clientWidth;
  const height = element.clientHeight;
  if (width <= 0 || height <= 0) return [];

  /** One boundary per position, with the extent of every cell touching it. */
  const collect = (positions: Array<{ at: number; from: number; to: number }>) => {
    const byAt = new Map<number, { from: number; to: number }>();
    for (const edge of positions) {
      const prev = byAt.get(edge.at);
      if (!prev) {
        byAt.set(edge.at, { from: edge.from, to: edge.to });
        continue;
      }
      byAt.set(edge.at, {
        from: Math.min(prev.from, edge.from),
        to: Math.max(prev.to, edge.to),
      });
    }
    return byAt;
  };

  const verticals: Array<{ at: number; from: number; to: number }> = [];
  const horizontals: Array<{ at: number; from: number; to: number }> = [];
  for (const rect of rects) {
    const right = boundary(rect.x + rect.width);
    const bottom = boundary(rect.y + rect.height);
    const left = boundary(rect.x);
    const top = boundary(rect.y);
    // The stage border is not a boundary between cells.
    if (left > 0.001 && left < 0.999) {
      verticals.push({ at: left, from: rect.y, to: rect.y + rect.height });
    }
    if (right > 0.001 && right < 0.999) {
      verticals.push({ at: right, from: rect.y, to: rect.y + rect.height });
    }
    if (top > 0.001 && top < 0.999) {
      horizontals.push({ at: top, from: rect.x, to: rect.x + rect.width });
    }
    if (bottom > 0.001 && bottom < 0.999) {
      horizontals.push({ at: bottom, from: rect.x, to: rect.x + rect.width });
    }
  }

  const handles: Divider[] = [];
  for (const [at, span] of collect(verticals)) {
    handles.push({
      key: `v-${at}`,
      axis: "x",
      at,
      left: Math.round(at * width) - EMBEDDED_DIVIDER,
      top: Math.round(span.from * height),
      width: EMBEDDED_DIVIDER,
      height: Math.max(1, Math.round((span.to - span.from) * height)),
    });
  }
  for (const [at, span] of collect(horizontals)) {
    handles.push({
      key: `h-${at}`,
      axis: "y",
      at,
      left: Math.round(span.from * width),
      top: Math.round(at * height) - EMBEDDED_DIVIDER,
      width: Math.max(1, Math.round((span.to - span.from) * width)),
      height: EMBEDDED_DIVIDER,
    });
  }
  return handles;
});

const drag = ref<{
  axis: "x" | "y";
  at: number;
  start: number;
  rects: SlotRect[];
} | null>(null);

function startResize(divider: Divider, event: PointerEvent): void {
  const view = activeView.value;
  if (!view) return;
  event.preventDefault();
  event.stopPropagation();
  drag.value = {
    axis: divider.axis,
    at: divider.at,
    start: divider.axis === "x" ? event.clientX : event.clientY,
    rects: viewSlotFractions(view),
  };
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", endResize, { once: true });
}

/** Re-splits the slots that touch the dragged boundary; the rest stay put. */
function resizedRects(state: NonNullable<typeof drag.value>, delta: number): SlotRect[] {
  const epsilon = 0.001;
  // Keep at least 10% on both sides of the boundary, then clamp.
  let lower = 0.1;
  let upper = 0.9;
  for (const rect of state.rects) {
    const edge = state.axis === "x" ? rect.x + rect.width : rect.y + rect.height;
    const origin = state.axis === "x" ? rect.x : rect.y;
    const size = state.axis === "x" ? rect.width : rect.height;
    if (Math.abs(edge - state.at) < epsilon) lower = Math.max(lower, origin + 0.1);
    if (Math.abs(origin - state.at) < epsilon) upper = Math.min(upper, origin + size - 0.1);
  }
  const target = Math.max(lower, Math.min(upper, state.at + delta));

  return state.rects.map((rect) => {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (state.axis === "x") {
      if (Math.abs(right - state.at) < epsilon) return { ...rect, width: target - rect.x };
      if (Math.abs(rect.x - state.at) < epsilon) {
        return { ...rect, x: target, width: right - target };
      }
    } else {
      if (Math.abs(bottom - state.at) < epsilon) return { ...rect, height: target - rect.y };
      if (Math.abs(rect.y - state.at) < epsilon) {
        return { ...rect, y: target, height: bottom - target };
      }
    }
    return rect;
  });
}

let resizeFrame = 0;
let pendingRects: SlotRect[] | null = null;

function onResizeMove(event: PointerEvent): void {
  const state = drag.value;
  const element = stage.value;
  const view = activeView.value;
  if (!state || !element || !view) return;
  const size = state.axis === "x" ? element.clientWidth : element.clientHeight;
  if (size <= 0) return;
  const delta = ((state.axis === "x" ? event.clientX : event.clientY) - state.start) / size;
  const next = resizedRects(state, delta);
  pendingRects = next;
  if (resizeFrame) return;
  // Coalesce to one IPC per frame: every update re-bounds the native pages.
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0;
    if (!pendingRects) return;
    void store.setSlotRects(view.id, pendingRects);
    pendingRects = null;
  });
}

function endResize(): void {
  drag.value = null;
  window.removeEventListener("pointermove", onResizeMove);
  if (resizeFrame) {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
  }
  pendingRects = null;
}

let offDownloads: (() => void) | undefined;

/**
 * The download list lives in the main process (a download belongs to the
 * session, not the tab that started it), so this panel is a view of that list:
 * closing the page does not lose an entry, and reopening the surface shows what
 * finished while it was gone.
 */
const downloadEntries = ref<DownloadEntry[]>([]);
const downloadsOpen = ref(false);
const downloadsAnchor = ref<HTMLElement | null>(null);
const activeDownloads = computed(
  () => downloadEntries.value.filter((entry) => entry.state === "progressing").length,
);
const hasFinishedDownloads = computed(() =>
  downloadEntries.value.some((entry) => entry.state !== "progressing"),
);

function downloadPercent(entry: DownloadEntry): number {
  if (!entry.totalBytes) return 0;
  return Math.min(100, Math.round((entry.receivedBytes / entry.totalBytes) * 100));
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function downloadStatus(entry: DownloadEntry): string {
  if (entry.state === "progressing") {
    return entry.totalBytes
      ? `${downloadPercent(entry)}% · ${formatBytes(entry.receivedBytes)} / ${formatBytes(entry.totalBytes)}`
      : formatBytes(entry.receivedBytes);
  }
  if (entry.state === "completed")
    return t("app.downloadDone", { size: formatBytes(entry.receivedBytes) });
  return entry.state === "cancelled" ? t("app.downloadCancelled") : t("app.downloadInterrupted");
}

async function actOnDownload(action: DownloadAction, id?: string) {
  downloadEntries.value = await window.ensemble.actOnDownload(action, id);
}

/** Closes the panel on a click anywhere else, the way a menu does. */
function onDocumentPointerDown(event: PointerEvent) {
  if (!downloadsOpen.value) return;
  if (downloadsAnchor.value?.contains(event.target as Node)) return;
  downloadsOpen.value = false;
}

onMounted(async () => {
  store.setStageMounted(true);
  await store.init();
  void window.ensemble.listDownloads().then((entries) => {
    downloadEntries.value = entries;
  });
  offDownloads = window.ensemble.onDownloadsChanged((entries) => {
    const before = activeDownloads.value;
    downloadEntries.value = entries;
    // A download that just started opens the panel, the way a browser surfaces
    // one without asking; progress on an existing entry must not reopen a panel
    // the user closed.
    if (activeDownloads.value > before) downloadsOpen.value = true;
  });
  document.addEventListener("pointerdown", onDocumentPointerDown);
  // The observer lives in the geometry composable: it owns the measuring and
  // reports to the main process, so nothing here re-implements it.
  geometry.observe();
  window.addEventListener("resize", reportStage);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  store.setStageMounted(false);
  offDownloads?.();
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("pointermove", onResizeMove);
  // Park the pages: another app page is taking the window, and WebContentsViews
  // paint above HTML no matter what z-index says.
  store.setStage(null);
});

watch(
  () => activeTab.value?.url,
  (url) => {
    // A fresh tab sits on about:blank; putting that in the address field makes
    // the user delete text before typing. An empty field is the honest state.
    const next = !url || url === "about:blank" ? "" : url;
    if (next !== address.value) address.value = next;
  },
  { immediate: true },
);

watch(
  () => store.state.activeTabId,
  () => {
    findResult.value = null;
  },
);

// Slot geometry changes with the layout; tell the main process again so the
// bounds it applies match what this page drew.
watch(
  () => activeView.value?.layoutId,
  () => reportStage(),
);

/**
 * Site suggestions in the address bar.
 *
 * Typing "后台" is how people look for a system they use daily; the embedded
 * browser can reach it by address, but only this app knows which address and
 * which login path. Matching is on the name and the host, and the suggestion
 * resolves to the full login URL.
 */
const siteSuggestions = computed(() => {
  const term = address.value.trim().toLowerCase();
  if (!term || /^https?:\/\//i.test(term)) return [];
  return workspace.sites
    .map((site) => {
      const host = (() => {
        try {
          return new URL(site.baseUrl).host.toLowerCase();
        } catch {
          return "";
        }
      })();
      const nameHit = site.name.toLowerCase().includes(term);
      const hostHit = host.includes(term);
      if (!nameHit && !hostHit) return undefined;
      let url: string | undefined;
      try {
        url = new URL(site.loginPath || "/", site.baseUrl).toString();
      } catch {
        url = undefined;
      }
      return url ? { site, url, nameHit } : undefined;
    })
    .filter(
      (item): item is { site: (typeof workspace.sites)[number]; url: string; nameHit: boolean } =>
        Boolean(item),
    )
    .sort((left, right) => Number(right.nameHit) - Number(left.nameHit))
    .slice(0, 6);
});

const suggestionsOpen = ref(false);

function pickSuggestion(url: string): void {
  address.value = url;
  suggestionsOpen.value = false;
  void navigate();
}

/**
 * Overlays float above the stage by freezing it, when the carrier needs it.
 *
 * A `WebContentsView` paints above all HTML regardless of z-index, so an app
 * menu that reaches into the stage would be covered by the page. Capturing the
 * stage first and parking the views keeps the menu readable and the page running.
 *
 * A `guest` page is a node in this document instead, so it stacks like any other
 * element: the overlay's z-index is enough and nothing has to be frozen. Skipping
 * the capture also removes a real hazard — the parking step told main the stage
 * was gone, and freezing again while it had no stage returned nothing to paint,
 * which is how a second overlay ended up covering a blank rectangle.
 *
 * A drag from the running dock counts as an overlay too: while pages occupy the
 * stage, their own native views swallow every drag event, so the only way to make
 * a whole cell a drop target is to park them for the duration of the drag. The
 * frozen picture is pixel-identical to the live page, so nothing visibly changes.
 */
let freezeSeq = 0;

async function syncStageCover(): Promise<void> {
  const covered =
    props.obscured ||
    Boolean(store.draggingTabId) ||
    store.stageMenuOpen ||
    // Address-bar suggestions hang below the toolbar, over the stage; native
    // pages would paint on top of them otherwise. The workspace-resolution
    // dropdown and the downloads panel are the same shape of overlay and need
    // the same treatment: every one of them is a plain HTML box anchored to the
    // toolbar, and a native view is never behind HTML no matter what z-index it
    // is given.
    (suggestionsOpen.value && siteSuggestions.value.length > 0) ||
    globalViewportOpen.value ||
    downloadsOpen.value;
  const seq = ++freezeSeq;
  if (!covered) {
    frozenSlots.value = [];
    reportStage();
    return;
  }
  // A guest stacks inside this document, so the stage is already behind the
  // overlay and stays live. Reporting is still needed: closing an earlier
  // overlay may have left main without a stage.
  if (store.state.carrier === "guest") {
    frozenSlots.value = [];
    reportStage();
    store.finishCover();
    return;
  }
  const slots = await window.ensemble.freezeEmbedded();
  // A later call (drop, overlay closed) already restored the stage; applying this
  // stale snapshot would park the views again with nothing to put back.
  if (seq !== freezeSeq) return;
  frozenSlots.value = slots;
  store.setStage(null);
  // Only now is the stage actually free of native views, which is what a menu
  // opening over it has to wait for.
  store.finishCover();
}

watch(
  () =>
    [
      props.obscured,
      store.draggingTabId,
      store.stageMenuOpen,
      suggestionsOpen.value && siteSuggestions.value.length > 0,
      globalViewportOpen.value,
      downloadsOpen.value,
      // The stage size participates because a frozen frame is a picture placed
      // at the rect the main process reported when it captured. Collapsing the
      // run dock mid-overlay shrinks the stage by 46px; without re-capturing,
      // the picture keeps its old — wider — rect and spills past the stage edge.
      stageBox.value.width,
      stageBox.value.height,
    ] as const,
  syncStageCover,
);

watch(
  () => findOpen.value,
  (open) => {
    if (!open) return;
    findResult.value = null;
  },
);

function onKeydown(event: KeyboardEvent): void {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "f") {
    event.preventDefault();
    findOpen.value = true;
  }
  // The page handles its own Ctrl +/- through `before-input-event`; this branch
  // covers the case where focus is in the app chrome (address bar, toolbar).
  if (modifier && !event.altKey) {
    if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      void zoom("in");
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      void zoom("out");
    } else if (event.key === "0") {
      event.preventDefault();
      void zoom("reset");
    }
  }
  if (event.key === "Escape" && findOpen.value) {
    findOpen.value = false;
    closeFind();
  }
}

/**
 * Navigates the active tab, or opens one when the surface is empty.
 *
 * Typing an address with nothing open is a complete instruction: it says "show
 * me this page". Requiring a separate "+" first would just be an extra click.
 *
 * The same field also takes words: anything that is not an address goes to the
 * selected search engine. Two inputs that look identical must not disagree
 * about what Enter does, so this shares `resolveBrowserInput` with the new-tab
 * surface.
 */
async function navigate(): Promise<void> {
  const target = resolveBrowserInput(address.value, workspace.searchEngine);
  if (!target) {
    if (address.value.trim()) workspace.notify(t("app.newTabBadInput"), "error");
    return;
  }
  const tab = activeTab.value;
  if (!tab) {
    await store.openTabWith(target);
    return;
  }
  address.value = target;
  await window.ensemble.navigateEmbeddedTab(tab.id, target);
}

function goBack(): void {
  const tab = activeTab.value;
  if (tab) window.ensemble.embeddedBack(tab.id);
}

function goForward(): void {
  const tab = activeTab.value;
  if (tab) window.ensemble.embeddedForward(tab.id);
}

function reload(): void {
  const tab = activeTab.value;
  if (tab) window.ensemble.reloadEmbeddedTab(tab.id);
}

function openDevTools(tabId: string): void {
  void window.ensemble.openEmbeddedDevTools(tabId, "docked");
}

/** Opens the same tools in their own window, for a screen too small to split. */
function detachDevTools(tabId: string): void {
  void window.ensemble.openEmbeddedDevTools(tabId, "window");
}

function closeDevTools(tabId: string): void {
  void window.ensemble.closeEmbeddedDevTools(tabId);
}

/** Ctrl +/-/0 from the app chrome; the page itself handles its own keystrokes. */
async function zoom(direction: "in" | "out" | "reset"): Promise<void> {
  const tab = activeTab.value;
  if (!tab) return;
  await window.ensemble.zoomEmbeddedTab(tab.id, direction);
}

async function runFind(direction: "next" | "prev" | "reset"): Promise<void> {
  const tab = activeTab.value;
  if (!tab || !findText.value) return;
  findResult.value = await window.ensemble.findInEmbeddedTab(tab.id, findText.value, {
    forward: direction !== "prev",
    findNext: direction !== "reset",
  });
}

function closeFind(): void {
  const tab = activeTab.value;
  if (tab) void window.ensemble.stopEmbeddedFind(tab.id);
  findResult.value = null;
}

async function fillLogin(tabId: string): Promise<void> {
  const result = await window.ensemble.fillEmbeddedLogin(tabId);
  if (result.ok) return;
  workspace.notify(fillMessage(result.reason), "error");
}

/** Empty slot → new tab pinned there and focused, ready for an address. */
async function addToSlot(slotIndex: number, identityId?: string): Promise<void> {
  const view = activeView.value;
  if (!view) return;
  openSlotPicker.value = null;
  await store.openTabInSlot(view.id, slotIndex, identityId ? { identityId } : undefined);
}

/**
 * Accounts offered for an empty cell: the site's own, in stored order.
 *
 * The site comes from `store.viewSiteId`, which knows both a saved view
 * definition and a hand-assembled container. An empty container with no
 * definition offers nothing: there is nothing to infer from, and listing every
 * identity in the workspace would turn the small menu into a second identities
 * page. Dragging one account in is what establishes the site.
 */
function slotIdentities(slotIndex: number): Identity[] {
  void slotIndex;
  const view = activeView.value;
  if (!view) return [];
  const siteId = store.viewSiteId(view.id);
  if (!siteId) return [];
  return workspace.identities.filter((identity) => identity.siteId === siteId);
}

function toggleSlotPicker(slotIndex: number): void {
  openSlotPicker.value = openSlotPicker.value === slotIndex ? null : slotIndex;
}

/**
 * Site bookmarks next to the address bar.
 *
 * These are sites, not history entries: "open this system" and "open it as this
 * account" are the two things this app exists for, and both are one click away
 * from the tab bar instead of a trip to the sites page.
 *
 * The plain open lands in the daily profile, so a site the user is signed in to
 * just opens. "Clean" is the explicit exception and uses the throwaway
 * partition, which is why it is its own row in the menu rather than a modifier.
 */
function siteLoginUrl(siteId: string): string | undefined {
  const site = workspace.sites.find((item) => item.id === siteId);
  if (!site) return undefined;
  try {
    return new URL(site.loginPath || "/", site.baseUrl).toString();
  } catch {
    return undefined;
  }
}

async function openSiteBookmark(siteId: string): Promise<void> {
  const url = siteLoginUrl(siteId);
  if (!url) return;
  workspace.markSiteUsed(siteId);
  await store.openTabWith(url);
}

async function openSiteClean(siteId: string): Promise<void> {
  const url = siteLoginUrl(siteId);
  if (!url) return;
  workspace.markSiteUsed(siteId);
  await store.openTabWith(url, { clean: true });
}

/**
 * A bookmark tile on the new-tab surface.
 *
 * The tile replaces the blank page the user is looking at, which is what the
 * same click does in a browser. If the tab disappeared in the meantime (the
 * state broadcast and a close can race), a new tab is the safe fallback rather
 * than a navigation into a page that is gone.
 */
async function openBookmark(bookmark: Bookmark): Promise<void> {
  const tab = activeTab.value;
  if (!tab) {
    await store.openTabWith(bookmark.url);
    return;
  }
  await window.ensemble.navigateEmbeddedTab(tab.id, bookmark.url);
}

/**
 * The browser page's own chooser: "open this, as whom?".
 *
 * Every answer means "add the page where the user is looking". With a view on
 * stage that is one of its cells; picking an account used to open a loose page
 * in the flat strip instead, which for a grid of accounts is the one place the
 * user is not looking. Without a view the flat strip is the stage, so a loose
 * page is the same answer.
 */
async function openIdentityBookmark(identityId: string): Promise<void> {
  const view = activeView.value;
  if (view) await store.openTabInto(view.id, { identityId });
  else await store.openIdentity(identityId);
}

function fillMessage(reason?: string): string {
  switch (reason) {
    case "no-identity":
      return t("app.browserFillNoIdentity");
    case "no-password":
      // Kept for older surfaces and for a resolver that could not say more.
      return t("app.browserFillNoPassword");
    // The four specific reasons. Each names the dialog that actually fixes it:
    // "no password" alone sent users to edit the account when the site was the
    // one missing its default.
    case "identity-empty":
      return t("app.browserFillIdentityEmpty");
    case "site-empty":
      return t("app.browserFillSiteEmpty");
    case "no-site":
    case "no-site-record":
      return t("app.browserFillNoSite");
    case "reference-broken":
      return t("app.browserFillReferenceBroken");
    case "cross-origin":
      return t("app.browserFillCrossOrigin");
    default:
      return t("app.browserFillFailed");
  }
}
</script>

<template>
  <section class="browser" :class="{ bench }">
    <!--
      The tab strip, where every browser puts it.

      1.0 drew the page list inside each cell's 26px header band, which meant a
      single-cell layout had a tab strip in an unusual place and no strip at all
      across the top — the one thing a browser is recognised by. The strip here
      belongs to the window: it shows the focused cell's pages, and in a
      multi-cell layout it also names which account that cell is, because every
      cell of the same app shows the same page titles.

      The active tab is painted in the toolbar's colour with no bottom edge, so
      strip and toolbar read as one surface. That single detail is most of the
      difference between a browser and a web app that draws tabs.
    -->
    <div class="tabstrip drag-region" :data-platform="platform">
      <button
        type="button"
        class="layout-btn no-drag"
        :class="{ 'is-bench': bench }"
        :title="bench ? t('app.layoutBackToSingle') : t('app.layoutOpenBench')"
        :aria-label="bench ? t('app.layoutBackToSingle') : t('app.layoutOpenBench')"
        @click="toggleBench"
      >
        <LayoutGrid :size="14" />
      </button>
      <div class="tabs no-drag" role="tablist" :aria-label="t('app.browserTabs')">
        <button
          v-for="page in windowPages"
          :key="page.id"
          type="button"
          role="tab"
          class="tab"
          :class="{ active: page.id === windowActivePageId }"
          :aria-selected="page.id === windowActivePageId"
          :data-tab-id="page.id"
          :title="page.url"
          draggable="true"
          @click="activateWindowPage(page.id)"
          @dragstart="onWindowPageDragStart(page, $event)"
          @dragend="onWindowPageDragEnd"
          @contextmenu.prevent.stop="openWindowPageMenu(page, $event)"
        >
          <span class="tab-fav">
            <TabIcon :src="page.favicon" :size="13" />
          </span>
          <span class="tab-label">{{ store.titleOf(page) }}</span>
          <span
            v-if="page.loading"
            class="tab-loading"
            :aria-label="t('app.browserLoading')"
          ></span>
          <span
            v-else-if="page.id === windowActivePageId"
            class="tab-close"
            role="button"
            tabindex="0"
            :aria-label="t('app.browserCloseTab')"
            :data-close-tab="page.id"
            @click.stop="store.closeTab(page.id)"
            @keydown.enter.stop="store.closeTab(page.id)"
            @keydown.space.prevent.stop="store.closeTab(page.id)"
          >
            <X :size="10" />
          </span>
        </button>
      </div>
      <button
        type="button"
        class="strip-add no-drag"
        :aria-label="t('app.browserNewTabHere')"
        :title="t('app.browserNewTabHere')"
        @click="addWindowPage"
      >
        <Plus :size="14" />
      </button>
      <div class="strip-drag drag-region"></div>
      <!--
        The console entry. `PanelLeft` drew a panel with a divider down its left
        edge — the icon for "open a side rail", which is what this console used
        to be and no longer is. A grid-of-records glyph says what the destination
        actually is: the tables behind the browser.
      -->
      <button
        type="button"
        class="console-btn no-drag"
        :aria-label="t('app.openConsole')"
        :title="t('app.openConsole')"
        @click="emit('openConsole')"
      >
        <Table2 :size="14" />
      </button>
    </div>

    <div class="toolbar">
      <button
        type="button"
        class="icon"
        :disabled="!activeTab?.canGoBack"
        :title="t('app.browserBack')"
        @click="goBack"
      >
        <ArrowLeft :size="15" />
      </button>
      <button
        type="button"
        class="icon"
        :disabled="!activeTab?.canGoForward"
        :title="t('app.browserForward')"
        @click="goForward"
      >
        <ArrowRight :size="15" />
      </button>
      <button
        type="button"
        class="icon"
        :title="t('app.browserReload')"
        @click="reload"
      >
        <RotateCw :size="15" :class="{ spin: activeTab?.loading }" />
      </button>

      <form class="address" @submit.prevent="navigate">
        <input
          v-model="address"
          type="text"
          spellcheck="false"
          :placeholder="t('app.browserAddress')"
          data-tour="browser-address"
          @focus="suggestionsOpen = true"
          @input="suggestionsOpen = true"
          @blur="suggestionsOpen = false"
          @keydown.esc="suggestionsOpen = false"
        />
        <!-- An explicit go button: Enter is invisible to a mouse user. It only
             appears once there is something to go to, so the field is quiet at
             rest instead of carrying a permanently greyed-out arrow. -->
        <button
          v-if="address.trim()"
          type="submit"
          class="go"
          :aria-label="t('app.browserGo')"
          :title="t('app.browserGo')"
        >
          <CornerDownLeft :size="13" />
        </button>

        <!-- Sites are the bookmarks: typing a name resolves to its login URL. -->
        <div v-if="suggestionsOpen && siteSuggestions.length" class="site-suggestions">
          <button
            v-for="item in siteSuggestions"
            :key="item.site.id"
            type="button"
            class="suggestion"
            @mousedown.prevent="pickSuggestion(item.url)"
          >
            <span class="sugg-name">{{ item.site.name }}</span>
            <span class="sugg-url mono">{{ item.url }}</span>
          </button>
        </div>
      </form>

      <button
        v-if="activeTab && !isBlankTab(activeTab)"
        type="button"
        class="icon star"
        :class="{ active: Boolean(bookmarkedEntry) }"
        :title="bookmarkedEntry ? t('app.bookmarkRemove') : t('app.bookmarkAddHint')"
        :aria-label="bookmarkedEntry ? t('app.bookmarkRemove') : t('app.bookmarkAdd')"
        :aria-pressed="Boolean(bookmarkedEntry)"
        @click="toggleBookmark"
      >
        <Star :size="15" :fill="bookmarkedEntry ? 'currentColor' : 'none'" />
      </button>
      <button
        v-if="activeTab?.identityId"
        type="button"
        class="icon"
        :title="t('app.browserFillHint')"
        :aria-label="t('app.browserFill')"
        @click="fillLogin(activeTab.id)"
      >
        <KeyRound :size="15" />
      </button>
      <!--
        Shown only where the answer can differ: a daily-profile page. An account
        page and a clean session are driveable already, so a control that is
        always "on" there would just add noise — and imply the switch guards
        something it does not.
      -->
      <button
        v-if="aiGateVisible"
        type="button"
        class="icon"
        data-ai-origin-switch
        :class="{ active: aiOriginAuthorized }"
        :title="aiOriginAuthorized ? t('app.aiOriginRevokeHint') : t('app.aiOriginGrantHint')"
        :aria-label="t('app.aiOriginTitle')"
        :aria-pressed="aiOriginAuthorized"
        @click="toggleAiOrigin"
      >
        <ShieldCheck :size="15" />
      </button>
      <button
        type="button"
        class="icon"
        :class="{ active: findOpen }"
        :title="t('app.browserFind')"
        @click="findOpen = !findOpen"
      >
        <Search :size="15" />
      </button>
      <!--
        Downloads: a panel rather than a page, because the useful actions are
        "open it" and "show me where it went" — both of which should not cost a
        navigation away from the page the user is working on.
      -->
      <div ref="downloadsAnchor" class="downloads-anchor">
        <button
          type="button"
          class="icon"
          :class="{ active: downloadsOpen }"
          :title="t('app.downloads')"
          :aria-label="t('app.downloads')"
          :aria-expanded="downloadsOpen"
          @click="downloadsOpen = !downloadsOpen"
        >
          <Download :size="15" />
          <span v-if="activeDownloads" class="download-badge">{{ activeDownloads }}</span>
        </button>
        <div v-if="downloadsOpen" class="downloads-panel">
          <div class="downloads-head">
            <span>{{ t("app.downloads") }}</span>
            <button
              v-if="hasFinishedDownloads"
              type="button"
              class="downloads-clear"
              @click="actOnDownload('clear')"
            >
              {{ t("app.downloadsClear") }}
            </button>
          </div>
          <div v-if="!downloadEntries.length" class="downloads-empty">
            {{ t("app.downloadsEmpty") }}
          </div>
          <div
            v-for="entry in downloadEntries"
            :key="entry.id"
            class="download-row"
            :class="entry.state"
          >
            <div class="download-main">
              <button
                type="button"
                class="download-name"
                :disabled="entry.state !== 'completed'"
                :title="entry.savePath || entry.filename"
                @click="actOnDownload('open', entry.id)"
              >
                {{ entry.filename }}
              </button>
              <span class="download-sub">{{ downloadStatus(entry) }}</span>
              <div v-if="entry.state === 'progressing'" class="download-bar">
                <span :style="{ width: `${downloadPercent(entry)}%` }" />
              </div>
            </div>
            <div class="download-actions">
              <button
                v-if="entry.state === 'progressing'"
                type="button"
                class="download-mini"
                :title="t('app.downloadCancel')"
                @click="actOnDownload('cancel', entry.id)"
              >
                <X :size="13" />
              </button>
              <template v-else>
                <button
                  type="button"
                  class="download-mini"
                  :title="t('app.downloadReveal')"
                  @click="actOnDownload('reveal', entry.id)"
                >
                  <FolderOpen :size="13" />
                </button>
                <button
                  type="button"
                  class="download-mini"
                  :title="t('app.downloadRemove')"
                  @click="actOnDownload('remove', entry.id)"
                >
                  <Trash2 :size="13" />
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
      <!--
        Workspace-wide resolution. It sits in the toolbar because it is a
        setting, not a page action: the same size applies to every page until
        one is given its own. Its menu says so in a line and points at the
        per-page path (right-click the tab), because the two controls otherwise
        look like the same feature in two places.
      -->
      <div class="global-viewport">
        <button
          type="button"
          class="icon viewport-btn"
          :class="{ changed: Boolean(globalViewport) }"
          :title="t('app.viewportDefaultHint')"
          :aria-label="t('app.viewportDefaultLabel')"
          :aria-expanded="globalViewportOpen"
          @click="toggleGlobalViewport"
        >
          <Monitor :size="15" />
          <span v-if="globalViewport" class="viewport-tag mono">
            {{ globalViewport.width }}×{{ globalViewport.height }}
          </span>
        </button>
        <div v-if="globalViewportOpen" class="global-viewport-menu" role="menu">
          <p class="global-viewport-note">{{ t("app.viewportDefaultHint") }}</p>
          <button
            type="button"
            role="menuitem"
            class="tab-menu-item"
            :class="{ checked: !globalViewport }"
            @click="applyGlobalViewport(null)"
          >
            {{ t("app.viewportGlobalOff") }}
          </button>
          <button
            v-for="preset in VIEWPORT_PRESETS"
            :key="preset.name"
            type="button"
            role="menuitem"
            class="tab-menu-item mono"
            :class="{
              checked:
                globalViewport?.width === preset.width && globalViewport?.height === preset.height,
            }"
            @click="applyGlobalViewport({ width: preset.width, height: preset.height })"
          >
            {{ preset.name }}
          </button>
        </div>
      </div>
      <!--
        Zoom lives in the toolbar so it can be found without knowing the
        shortcut. It stays visible (a hidden control is a control nobody
        discovers) but is drawn quietly at the global default and takes the
        accent colour once this page differs. The number is the reset.
      -->
      <div
        v-if="activeTab"
        class="zoom-stepper"
        :class="{ changed: activeTab.zoom !== workspace.settings.browserZoom }"
      >
        <button
          type="button"
          class="zoom-step"
          :aria-label="t('app.browserZoomOut')"
          :title="t('app.browserZoomOut')"
          @click="zoom('out')"
        >
          <Minus :size="12" />
        </button>
        <button
          type="button"
          class="zoom-value mono"
          :title="t('app.browserZoomReset')"
          @click="zoom('reset')"
        >
          {{ activeTab.zoom }}%
        </button>
        <button
          type="button"
          class="zoom-step"
          :aria-label="t('app.browserZoomIn')"
          :title="t('app.browserZoomIn')"
          @click="zoom('in')"
        >
          <Plus :size="12" />
        </button>
      </div>
      <button
        type="button"
        class="icon"
        :class="{ active: activeTab?.devtoolsOpen }"
        :title="
          activeTab?.devtoolsOpen ? t('app.browserDevToolsClose') : t('app.browserDevTools')
        "
        @click="activeTab && (activeTab.devtoolsOpen ? closeDevTools(activeTab.id) : openDevTools(activeTab.id))"
      >
        <Bug :size="15" />
      </button>
      <!-- Only relevant once the tools are docked: a small screen may want them
           in their own window instead of splitting the cell. -->
      <button
        v-if="activeTab?.devtoolsOpen"
        type="button"
        class="icon"
        :title="t('app.browserDevToolsDetach')"
        @click="activeTab && detachDevTools(activeTab.id)"
      >
        <ExternalLink :size="15" />
      </button>
      <!--
        The AI entry, and the only place the endpoint's status is reported.
        A browser has no status bar: putting "connected / port 8765" on a bar
        across the bottom of every screen was the clearest single sign that this
        was a console rather than a browser. The dot carries the state, the menu
        carries the address.
      -->
      <div class="ai-entry">
        <button
          type="button"
          class="ai-btn"
          :class="{ on: workspace.mcp?.running }"
          :aria-label="t('app.mcpAiAccess')"
          :aria-expanded="aiMenuOpen"
          :title="t('app.statusMcpHint')"
          @click="aiMenuOpen = !aiMenuOpen"
        >
          <span class="ai-mark"><Sparkles :size="14" /></span>
          <span class="ai-label">{{ t("app.aiEntryShort") }}</span>
          <span
            v-if="workspace.mcp?.running"
            class="ai-dot"
            :aria-label="t('app.statusConnected')"
          ></span>
        </button>
        <div v-if="aiMenuOpen" class="ai-menu" role="menu">
          <p class="ai-menu-head">
            <span class="ai-led" :class="{ on: workspace.mcp?.running }"></span>
            {{
              workspace.mcp?.running
                ? t("app.aiEndpointOn", { port: workspace.mcp.port })
                : t("app.aiEndpointOff")
            }}
          </p>
          <button type="button" role="menuitem" class="tab-menu-item" @click="openMcpSettings">
            <Bot :size="13" />
            {{ t("app.aiEndpointSettings") }}
          </button>
        </div>
      </div>
      <OpenSiteButton
        @open-blank="store.openTab()"
        @open-daily="openSiteBookmark"
        @open-clean="openSiteClean"
        @open-identity="openIdentityBookmark"
      />
    </div>

    <div v-if="findOpen" class="findbar">
      <input
        v-model="findText"
        type="text"
        :placeholder="t('app.browserFindPlaceholder')"
        @input="runFind('reset')"
        @keydown.enter.prevent="runFind('next')"
      />
      <span class="count">
        {{ findResult ? `${findResult.activeMatch} / ${findResult.matches}` : "—" }}
      </span>
      <button type="button" class="icon" @click="runFind('prev')">
        <ArrowLeft :size="13" />
      </button>
      <button type="button" class="icon" @click="runFind('next')">
        <ArrowRight :size="13" />
      </button>
      <button type="button" class="icon" @click="findOpen = false; closeFind()">
        <X :size="13" />
      </button>
    </div>

    <div ref="stage" class="stage">
      <img
        v-for="slot in frozenSlots"
        :key="slot.tabId"
        class="frozen"
        :src="slot.dataUrl"
        :style="{
          left: `${slot.rect.x - stageOrigin.x}px`,
          top: `${slot.rect.y - stageOrigin.y}px`,
          width: `${slot.rect.width}px`,
          height: `${slot.rect.height}px`,
        }"
        alt=""
        aria-hidden="true"
      />
      <!-- A blank page has no native view on screen; the app draws it. -->
      <div
        v-for="surface in blankSurfaces"
        :key="`blank-${surface.tab.id}`"
        class="blank-slot"
        :style="
          surface.slot
            ? {
                left: `${surface.slot.x}px`,
                top: `${surface.slot.y}px`,
                width: `${surface.slot.width}px`,
                height: `${surface.slot.height}px`,
              }
            : { inset: '0' }
        "
      >
        <NewTabPage :tab="surface.tab" @open-bookmark="openBookmark" />
      </div>

      <!--
        One handle per docked DevTools panel, standing in the gap the main
        process leaves between the page and the tools. Dragging re-splits the
        cell live; arrows nudge it from the keyboard.
      -->
      <div
        v-for="grip in devtoolsGrips"
        :key="`grip-${grip.tabId}`"
        class="devtools-grip"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('app.devtoolsGrip')"
        tabindex="0"
        :style="{
          left: `${grip.x}px`,
          top: `${grip.y}px`,
          width: `${grip.width}px`,
          height: `${grip.height}px`,
        }"
        @mousedown="onGripDown(grip.tabId, $event)"
        @keydown="onGripKey(grip.tabId, $event)"
      ></div>

      <!--
        A flat stage gets no header band, in either mode.

        It used to carry one so that an instance opened into the default tab
        group still had page tabs and a "+". The window-level strip above the
        toolbar does that now, for every mode — and in the workbench the flat
        stage drew both, two identical tab rows one under the other. The band
        remains only for real cells, where it answers something the top strip
        cannot: which account this particular cell is.
      -->

      <!-- Native views paint over this area; only the slot headers stay visible. -->
      <div
        v-for="slot in slotChrome.filter((item) => item.tabId)"
        :key="slot.index"
        class="slot-header"
        :class="{
          selected: slot.tabId === activeView?.focusedTabId,
          'drop-target': dropSlot === slot.index,
        }"
        :style="{
          left: `${slot.x}px`,
          top: `${slot.y}px`,
          width: `${slot.width}px`,
          height: `${EMBEDDED_SLOT_HEADER}px`,
        }"
        @click="activateSlot(slot.tabId, slot.index)"
        @dragover="onSlotDragOver(slot.index, $event)"
        @dragleave="dropSlot = dropSlot === slot.index ? null : dropSlot"
        @drop="onSlotDrop(slot.index, $event)"
      >
        <span class="slot-index mono">{{ slot.index + 1 }}</span>
        <span
          v-if="slotPage(slot.tabId, slot.index)?.color"
          class="dot"
          :style="{ background: `var(--role-${slotPage(slot.tabId, slot.index)?.color})` }"
        ></span>
        <!-- Which account this cell belongs to. Every cell of the same app shows
             the same page title, so without the account name the band cannot
             answer "who am I looking at" — which is the point of the grid. -->
        <span v-if="slotAccount(slot.tabId)" class="slot-account">{{ slotAccount(slot.tabId) }}</span>
        <span v-if="slotPage(slot.tabId, slot.index)?.loading" class="spinner"></span>
        <!--
          Pages of this instance. A slot holds an instance, so a popup it opened
          has no cell of its own; without a strip here the only way to switch
          back was the dock. The strip is drawn even for a single page: it is
          what says "this cell is a browser with tabs" and the only place the
          "+" for a second page can live.

          A split cell gets `split` instead: there the cell is pinned to one page
          and the strip must not offer the whole list, because the sibling cell
          would draw the same list and the two would look identical.
        -->
        <InstanceTabStrip
          :instance-id="slotInstanceId(slot.tabId)"
          :current-id="slotPage(slot.tabId, slot.index)?.id"
          :split="viewSlotCount(slot.tabId) > 1"
          @select="(pageId) => selectPage(pageId, slot.index)"
          @menu="openTabMenu"
          @merge="unsplitSlot(slot.index)"
        />
      </div>

      <!--
        An empty slot invites the next action: the dashed frame covers the whole
        cell, the slot number sits inside it, and the button drops a focused tab
        straight into this cell — so the address bar is ready to type.
      -->
      <div
        v-for="slot in emptySlots"
        :key="`empty-${slot.index}`"
        class="slot-empty"
        :class="{ 'drop-target': dropSlot === slot.index }"
        :style="{
          left: `${slot.left}px`,
          top: `${slot.top}px`,
          width: `${slot.width}px`,
          height: `${slot.height}px`,
        }"
        @dragover="onSlotDragOver(slot.index, $event)"
        @dragleave="dropSlot = dropSlot === slot.index ? null : dropSlot"
        @drop="onSlotDrop(slot.index, $event)"
      >
        <span class="slot-empty-index mono">{{ slot.index + 1 }}</span>
        <!-- Two affordances in one empty cell. The plain button is the common
             case — "put a page here, I will type an address" — and stays a
             single click. The picker beside it answers the other half of what an
             empty cell means here: "this cell is this account". Without it,
             building a grid of identities meant adding blank pages and then
             finding each account somewhere else. -->
        <div class="slot-add-row">
          <button
            type="button"
            class="slot-add"
            @click="addToSlot(slot.index)"
          >
            <Plus :size="13" />
            {{ t("app.browserAddTabHere") }}
          </button>
          <div
            v-if="slotIdentities(slot.index).length"
            class="slot-identity"
            :class="{ open: openSlotPicker === slot.index }"
          >
            <button
              type="button"
              class="slot-add slot-add-icon"
              :aria-label="t('app.browserAddIdentityHere')"
              :aria-expanded="openSlotPicker === slot.index"
              :title="t('app.browserAddIdentityHere')"
              @click="toggleSlotPicker(slot.index)"
            >
              <Users :size="13" />
            </button>
            <div v-if="openSlotPicker === slot.index" class="slot-identity-menu" role="listbox">
              <!-- Only accounts of the site this view belongs to: a grid mixes
                   accounts of one system, and listing every identity of every
                   site would turn this small menu into a second identities page. -->
              <button
                v-for="identity in slotIdentities(slot.index)"
                :key="identity.id"
                type="button"
                class="slot-identity-item"
                role="option"
                @click="addToSlot(slot.index, identity.id)"
              >
                <span
                  class="identity-dot"
                  :style="{ background: `var(--role-${identity.color ?? 'amber'})` }"
                ></span>
                <span class="identity-name">{{ identity.name }}</span>
                <span v-if="identity.role" class="identity-role">{{ identity.role }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Divider handles sit in the HTML header bands; the page body is painted
           over by the native views and would swallow a handle on the boundary. -->
      <div
        v-for="handle in dividers"
        :key="handle.key"
        class="divider"
        :class="handle.axis === 'x' ? 'vertical' : 'horizontal'"
        :style="{
          left: `${handle.left}px`,
          top: `${handle.top}px`,
          width: `${handle.width}px`,
          height: `${handle.height}px`,
        }"
        @pointerdown="startResize(handle, $event)"
      ></div>

      <div v-if="!store.tabs.length" class="empty">
        <p>{{ t("app.browserEmptyTitle") }}</p>
        <p class="sub">{{ t("app.browserEmptyHint") }}</p>
        <!-- One button, not a wall of site chips: the address bar is right above
             and the split new-tab button already lists every site as a bookmark,
             so repeating them here made the empty state look like a menu. -->
        <button type="button" class="empty-action" @click="store.openTab()">
          {{ t("app.browserNewTab") }}
        </button>
      </div>
    </div>

    <!--
      Page actions. Positioned at the click point in viewport coordinates; the
      stage was frozen before this appeared (see `openTabMenu`), so it is not
      covered by the native page under the cursor.
    -->
    <Teleport to="body">
      <div
        v-if="tabMenu"
        class="tab-menu"
        role="menu"
        :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
      >
        <button type="button" role="menuitem" class="tab-menu-item" @click="duplicateTab">
          <Copy :size="12" />
          {{ t("app.browserDuplicateTab") }}
        </button>
        <button
          type="button"
          class="tab-menu-item"
          :disabled="isBlankTab(tabMenu.page)"
          @click="copyTabUrl"
        >
          <CornerDownLeft :size="12" />
          {{ t("app.browserCopyUrl") }}
        </button>
        <div class="tab-menu-sep"></div>
        <!--
          Resolution, per page. "Follow the workspace default" comes first
          because it is the resting state: a page inherits unless the user chose
          something for it. "Adaptive" is a real choice too — it pins "fill the
          cell" against a default that says otherwise — which is why the two are
          separate rows instead of one "off" switch.
        -->
        <div class="menu-section-label">{{ t("app.viewportLabel") }}</div>
        <button
          type="button"
          role="menuitem"
          class="tab-menu-item"
          :class="{ checked: menuViewportOverride === undefined }"
          @click="applyViewport('inherit')"
        >
          {{ t("app.viewportInherit") }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="tab-menu-item"
          :class="{ checked: menuViewportOverride === null }"
          @click="applyViewport('adaptive')"
        >
          {{ t("app.viewportAdaptive") }}
        </button>
        <button
          v-for="preset in VIEWPORT_PRESETS"
          :key="preset.name"
          type="button"
          role="menuitem"
          class="tab-menu-item mono"
          :class="{
            checked:
              menuViewportOverride?.width === preset.width &&
              menuViewportOverride?.height === preset.height,
          }"
          @click="applyViewport({ width: preset.width, height: preset.height })"
        >
          {{ preset.name }}
        </button>
        <div class="viewport-custom">
          <input
            v-model="customWidth"
            class="viewport-input mono"
            type="number"
            :min="VIEWPORT_MIN"
            :max="VIEWPORT_MAX_WIDTH"
            :placeholder="$t('app.viewportWidth')"
            @keydown.enter="applyCustomViewport"
          />
          <span class="viewport-x mono">×</span>
          <input
            v-model="customHeight"
            class="viewport-input mono"
            type="number"
            :min="VIEWPORT_MIN"
            :max="VIEWPORT_MAX_HEIGHT"
            :placeholder="$t('app.viewportHeight')"
            @keydown.enter="applyCustomViewport"
          />
          <button type="button" class="viewport-apply" @click="applyCustomViewport">
            {{ t("app.viewportApply") }}
          </button>
        </div>
        <p v-if="viewportError" class="viewport-error" role="alert">{{ viewportError }}</p>
        <div class="tab-menu-sep"></div>
        <button type="button" role="menuitem" class="tab-menu-item" @click="closeTab">
          <X :size="12" />
          {{ t("app.browserCloseTab") }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="tab-menu-item"
          :disabled="menuPageCount < 2"
          @click="closeOtherTabs"
        >
          <X :size="12" />
          {{ t("app.browserCloseOtherTabs") }}
        </button>
      </div>
    </Teleport>

    <BookmarkDialog
      v-if="bookmarkDialogDraft"
      :draft="bookmarkDialogDraft"
      :folders="workspace.bookmarkFolders"
      @save="onBookmarkDialogSave"
      @close="bookmarkDialogDraft = null"
    />
  </section>
</template>

<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* The dock is a flex sibling; without this the browser refuses to shrink below
     its content's intrinsic width and the stage keeps the full window width even
     though the dock took a column. */
  min-width: 0;
  height: 100%;
  flex: 1 1 auto;
}

/* ---------------------------------------------------------------------------
 * Tab strip
 *
 * The band is the frame colour; the active tab is the toolbar colour with no
 * bottom edge. That is the whole trick, and it is what makes the strip read as
 * part of the toolbar instead of as a row of pills sitting above it.
 * ------------------------------------------------------------------------ */
.tabstrip {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: var(--titlebar-height);
  padding-left: 4px;
  background: var(--frame);
}

/* The layout switch is the only way in and out of a multi-cell view, so it sits
   at the strip's leading edge where every browser puts its tab-group controls. */
.layout-btn {
  align-self: center;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  color: var(--muted);
  flex: 0 0 26px;
  margin-right: 2px;
}

.layout-btn:hover {
  background: var(--hover, color-mix(in srgb, var(--text) 7%, transparent));
  color: var(--text);
}

.layout-btn.is-bench {
  background: var(--accent-soft);
  color: var(--accent);
}

/*
 * The tab row hugs its tabs and grows only as far as they need, so the "+"
 * sits immediately after the last tab the way every browser draws it. It was
 * `flex: 1 1 auto`, which stretched the row to the full window and left the "+"
 * floating in the middle of the strip, far from the tab it belongs to.
 * Overflowing rows still shrink: `min-width: 0` plus the tabs' own `min-width`.
 */
.tabs {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
  flex: 0 1 auto;
  height: 100%;
}

/*
 * A tab is 30px tall inside a 34px band, so it sits on the toolbar's top edge.
 * Width follows the title, capped at 184px; when the row runs out they all
 * shrink together, which is the browser behaviour. `flex-basis: auto` is what
 * makes a two-character title produce a narrow tab instead of a 184px slab.
 */
.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 6px 0 10px;
  border-radius: 7px 7px 0 0;
  min-width: 46px;
  max-width: 184px;
  flex: 0 1 auto;
  font-size: var(--fs-base);
  color: var(--text-secondary);
  white-space: nowrap;
  position: relative;
}

.tab:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}

/* Same colour as the toolbar, and deliberately no bottom border: the tab and the
   toolbar form one continuous surface. */
.tab.active {
  background: var(--chrome);
  color: var(--text);
  box-shadow: 0 -1px 0 color-mix(in srgb, var(--line) 40%, transparent);
}

/* Hairline separators between inactive neighbours, as every browser draws them. */
.tab + .tab::before {
  content: "";
  position: absolute;
  left: -1px;
  top: 9px;
  bottom: 9px;
  width: 1px;
  background: var(--line);
}

.tab:hover::before,
.tab.active::before,
.tab.active + .tab::before {
  display: none;
}

.tab-fav {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  display: grid;
  place-items: center;
  overflow: hidden;
}

.tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
}

/* The close affordance appears on the current tab and on hover: always-on
   crosses in a 30px pill eat the title. */
.tab-close {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: var(--faint);
  flex: 0 0 16px;
  opacity: 0;
}

.tab:hover .tab-close,
.tab.active .tab-close {
  opacity: 1;
}

.tab-close:hover {
  background: color-mix(in srgb, var(--red) 20%, transparent);
  color: var(--red);
}

/* A loading tab spends the close button's slot on a spinner, so the title does
   not shift when the page finishes. */
.tab-loading {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  margin-right: 2px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-top-color: var(--accent);
  animation: tabspin var(--motion-slow) linear infinite;
}

@keyframes tabspin {
  to {
    transform: rotate(360deg);
  }
}

/*
 * The strip's "add page" button.
 *
 * Not `.new-tab`: the new-tab *surface* is a child component whose root carries
 * that class, and a scoped parent rule reaches a child's root element. The two
 * were the same name, so this rule's 26×26 box sized the whole new-tab surface
 * into a thumbnail in the stage's corner.
 */
.strip-add {
  align-self: center;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  color: var(--muted);
  flex: 0 0 26px;
  margin: 0 2px;
}

.strip-add:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

/* Everything between the last tab and the window controls drags the window. */
.strip-drag {
  flex: 1 1 auto;
  min-width: 12px;
  height: 100%;
}

.console-btn {
  align-self: center;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  color: var(--muted);
  flex: 0 0 26px;
  margin-right: 4px;
}

.console-btn:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

/* The native window controls are drawn over the strip's right end; that space is
   reserved by the main process overlay, so the strip only has to keep clear. */
.tabstrip[data-platform="win32"],
.tabstrip[data-platform="linux"] {
  padding-right: 140px;
}

.tabstrip[data-platform="darwin"] {
  padding-left: 82px;
}

/* ---------------------------------------------------------------------------
 * AI entry
 *
 * An icon, not an icon-plus-label: the toolbar's right end already carries the
 * zoom stepper, downloads and two page actions, and "AI 接入" was the only
 * multi-character control on the row — it read as a menu heading among buttons,
 * and it pushed the "+" (which really is a menu) to the very edge where the two
 * looked interchangeable. The label still names the button through `aria-label`
 * and `title`; the menu names the endpoint.
 * ------------------------------------------------------------------------ */
.ai-entry {
  position: relative;
  flex: 0 0 auto;
}

.ai-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  height: var(--control-lg);
  padding: 0 9px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.ai-btn:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.ai-btn.on {
  background: var(--accent-soft);
}

.ai-label {
  color: var(--text-secondary);
  letter-spacing: 0.01em;
}

.ai-btn.on .ai-label {
  color: var(--accent);
}

.ai-btn:hover .ai-label {
  color: var(--text);
}

.ai-mark {
  display: grid;
  place-items: center;
  color: var(--accent);
}

/* The dot answers "is it listening" without a word, and it lives on the
   button's corner rather than over the glyph: on the sparkle it read as part of
   the icon, and the filled background alone says the same thing less precisely. */
.ai-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
}

.ai-menu {
  position: absolute;
  z-index: var(--z-dropdown);
  top: calc(100% + 6px);
  right: 0;
  min-width: 232px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.ai-menu-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 2px 6px 6px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--line-soft);
  font-size: var(--fs-xs);
  color: var(--muted);
}

.ai-led {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--faint);
  flex: 0 0 5px;
}

.ai-led.on {
  background: var(--green);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--toolbar-height);
  padding: 0 8px;
  background: var(--chrome);
  flex: 0 0 auto;
}

/* Sits level with the address field, both 30px tall: a control that is shorter
   than the input beside it reads as secondary, and "+" is the primary action. */
.icon {
  display: grid;
  place-items: center;
  width: var(--control-lg);
  height: var(--control-lg);
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  flex: 0 0 auto;
}

.icon:hover {
  background: var(--surface-2);
  color: var(--text);
}

.icon:disabled {
  opacity: 0.3;
  cursor: default;
  background: transparent;
}

/* On state for a toggle (DevTools open): the control is clearly "on", not just
   hovered. */
.icon.active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}

/*
 * Zoom is the one toolbar control that is a *value*, not an action, so it needs
 * a little structure — but not a permanently filled block. At rest it is as
 * quiet as the icon buttons beside it; the fill appears on hover, and the accent
 * only when this page differs from the default.
 */
.zoom-stepper {
  display: inline-flex;
  align-items: stretch;
  height: var(--control-lg);
  border: none;
  border-radius: var(--radius);
  background: transparent;
  overflow: hidden;
  flex: 0 0 auto;
  transition: background var(--motion-base) var(--ease-out);
}

.zoom-stepper:hover {
  background: var(--field);
}

/* Quiet at the default; the accent only appears when this page is actually
   zoomed, so the toolbar does not shout "110%" at every normal page. */
.zoom-stepper.changed {
  background: var(--accent-soft);
}

.zoom-stepper.changed .zoom-value {
  color: var(--accent);
}

.zoom-step {
  display: grid;
  place-items: center;
  width: 24px;
  color: var(--text-secondary);
}

.zoom-step:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

/* The number is the reset: the only reason to click a zoom value is to undo it. */
.zoom-value {
  min-width: 44px;
  padding: 0 6px;
  font-size: var(--fs-2xs);
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.zoom-value:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

/* Workspace-wide resolution. Same shape as the zoom stepper because it is the
   same kind of control — a small value with a menu — but it reads as a setting:
   quiet until a size is actually pinned. */
.global-viewport {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}

/* An icon, plus the size only once one is set: a permanently wide "自适应"
   button in the toolbar draws more attention than the setting deserves, and the
   toolbar has to survive a 960px window. */
.viewport-btn {
  position: relative;
  gap: 5px;
  width: auto;
  padding: 0 8px;
}

.viewport-btn.changed {
  color: var(--accent);
}

.viewport-tag {
  font-size: var(--fs-2xs);
  line-height: 1;
}

.global-viewport-menu {
  position: absolute;
  z-index: 72;
  top: calc(100% + 6px);
  right: 0;
  min-width: 208px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

/* The line that separates "default for every page" from "set one page": without
   it the two menus look like the same feature with two entrances. */
.global-viewport-note {
  margin: 2px 6px 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 10px;
  line-height: 1.5;
  color: var(--faint);
}

.address {
  position: relative;
  flex: 1;
  min-width: 0;
}

/* Site suggestions hang under the field. They are plain HTML, so they paint
   above the native page only while the page is parked for an overlay. */
.site-suggestions {
  position: absolute;
  z-index: 71;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  overflow: hidden;
}

/* Downloads: the panel hangs off its toolbar button, so it stays glued to the
   control at any window width. Same surface/shadow language as the site
   suggestions above it — one popover style, not two. */
.downloads-anchor {
  position: relative;
  display: flex;
}

.downloads-anchor .icon {
  position: relative;
}

.download-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 12px;
  height: 12px;
  padding: 0 3px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 9px;
  line-height: 12px;
  text-align: center;
}

.downloads-panel {
  position: absolute;
  z-index: 71;
  top: calc(100% + 6px);
  right: 0;
  width: 320px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  overflow: hidden auto;
}

.downloads-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 11.5px;
  color: var(--muted);
}

.downloads-clear {
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
}

.downloads-empty {
  padding: 18px 10px;
  text-align: center;
  font-size: 11.5px;
  color: var(--faint);
}

.download-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line-soft);
}

.download-row:last-child {
  border-bottom: 0;
}

.download-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.download-name {
  border: 0;
  background: none;
  padding: 0;
  text-align: left;
  font-size: 11.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.download-name:disabled {
  color: var(--muted);
  cursor: default;
}

.download-row.completed .download-name:hover {
  color: var(--accent);
}

.download-sub {
  font-size: 10.5px;
  color: var(--faint);
}

.download-bar {
  height: 3px;
  margin-top: 3px;
  border-radius: 2px;
  background: var(--line-soft);
  overflow: hidden;
}

.download-bar span {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width var(--motion-base) var(--ease-out);
}

.download-actions {
  flex: 0 0 auto;
  display: flex;
  gap: 2px;
}

.download-mini {
  border: 0;
  background: none;
  padding: 3px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  cursor: pointer;
}

.download-mini:hover {
  background: var(--surface-2);
  color: var(--text);
}

.suggestion {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 9px;
  text-align: left;
  color: var(--muted);
}

.suggestion:hover,
.suggestion:focus-visible {
  background: var(--surface-2);
  color: var(--text);
}

.sugg-name {
  font-size: 11.5px;
  white-space: nowrap;
}

.sugg-url {
  margin-left: auto;
  font-size: 10px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.address input,
.findbar input {
  width: 100%;
  height: var(--control-lg);
  padding: 0 10px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  background: var(--field);
  color: var(--text);
  font-size: var(--fs-base);
  outline: none;
}

.address input {
  padding-right: 30px;
}

.address input:focus,
.findbar input:focus {
  background: var(--chrome);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* The go affordance lives inside the field so the toolbar stays one row, and
   appears only once there is something to go to: a permanently disabled arrow
   at the field's edge is a control that never does anything, and Enter already
   submits. */
.go {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.go:hover {
  background: var(--surface-3);
  color: var(--text);
}

.findbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  background: var(--bg);
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}

.findbar input {
  flex: 1;
}

.count {
  min-width: 52px;
  text-align: center;
  color: var(--faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  /*
   * Clip everything to the stage.
   *
   * The frozen snapshot that stands in for a page while a menu is open is an
   * absolutely positioned <img> sized from the rect the main process reported
   * *at capture time*. If the stage shrinks afterwards — collapsing the run dock
   * is a 46px change — that rect is wider than the stage, and because the image
   * uses `object-fit: fill` it does not just overflow: it is stretched, so the
   * spill reads as a magnified band of the page sitting over the dock. Clipping
   * here bounds every such child at once instead of trusting each one's rect.
   */
  overflow: hidden;
  /* The stage is content, not frame: a page sits on the same surface as a blank
     tab, so the area behind it must match the page rather than the chrome. */
  background: var(--content);
}

.frozen {
  position: absolute;
  object-fit: fill;
  pointer-events: none;
}

/* A blank page's HTML surface: it fills the cell below the header band. */
.blank-slot {
  position: absolute;
  z-index: 0;
  overflow: hidden;
}

/*
 * The DevTools drag handle. It stands in a real gap between the page and the
 * tools — the only place renderer HTML can exist between two native views —
 * and shows as a hairline until hovered or focused.
 */
.devtools-grip {
  position: absolute;
  cursor: col-resize;
  z-index: 1;
  outline: none;
}

.devtools-grip::before {
  content: "";
  position: absolute;
  left: 3px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line);
}

.devtools-grip:hover::before,
.devtools-grip:focus-visible::before {
  left: 2px;
  width: 3px;
  background: var(--accent);
}

.slot-header {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--line-soft);
  box-sizing: border-box;
  cursor: pointer;
  z-index: 1;
  overflow: hidden;
}

.slot-header:hover {
  background: var(--surface-2);
}

/* The flat stage has one cell and no grid, so its band is a plain strip: no
   hover tint (clicking it selects nothing), no slot number, and no layout
   picker. What it does carry is the page tabs — that was the whole point. */
/* The selected cell is the keyboard target and the one a new page replaces, so
   it is marked structurally — an accent rail plus a lifted background — instead
   of spending band width on the word "selected". Tinted with the page colour
   rather than the accent: mixing 8% amber into every selected band made it look
   like a warning state. */
.slot-header.selected {
  background: var(--surface-3);
  box-shadow:
    inset 2px 0 0 var(--accent),
    inset 0 1px 0 color-mix(in srgb, var(--accent) 32%, transparent);
}

.slot-header.drop-target {
  background: color-mix(in srgb, var(--accent) 22%, var(--surface));
  box-shadow: inset 0 0 0 1px var(--accent);
}
.slot-empty {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--line);
  border-radius: 4px;
  background: var(--bg);
  z-index: 0;
}

.slot-empty.drop-target {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
}

/* The number belongs inside the empty cell: a separate 26px header with only a
   digit in it looked like a label pressed against the top edge. */
.slot-empty-index {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--surface-3);
  color: var(--faint);
  font-size: 9.5px;
}

.slot-add {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--muted);
  font-size: 11.5px;
  padding: 6px 11px;
  cursor: pointer;
}

.slot-add:hover {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  background: var(--surface-2);
  color: var(--text);
}

.slot-add-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Square icon button beside the main one: the picker is the secondary path, so
   it must not compete with "add a page here" for attention. */
.slot-add-icon {
  padding: 6px 7px;
}

.slot-identity {
  position: relative;
}

/*
 * The picker opens downwards inside the empty cell.
 *
 * Unlike the dock's badge hint this one can afford to be a normal dropdown: the
 * cell is the app's own HTML (an empty slot has no native page over it), and the
 * stage does not scroll, so there is nothing to clip it. Capped height with its
 * own scroll for a site with many accounts.
 */
.slot-identity-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  min-width: 168px;
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.slot-identity-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}

.slot-identity-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.identity-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.identity-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Role is a hint, not a label: keep it quiet so the name stays the thing read. */
.identity-role {
  margin-left: auto;
  font-size: 10px;
  color: var(--faint);
}

.divider {
  position: absolute;
  z-index: 2;
  touch-action: none;
}

.divider.vertical {
  cursor: col-resize;
}

.divider.horizontal {
  cursor: row-resize;
}

.divider:hover {
  background: color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 2px;
}

.slot-index {
  display: grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  border-radius: 3px;
  background: var(--surface-3);
  color: var(--faint);
  font-size: 9.5px;
  padding: 0 3px;
}

/* The middle of the header band, between the slot number and the strip.
   Shrinks before the strip does, so page titles keep their room. */
.slot-account {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--text-secondary);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.spinner {
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin var(--motion-slow) linear infinite;
}

.spin {
  animation: spin var(--motion-slow) linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

.empty .sub {
  max-width: 340px;
  color: var(--faint);
  font-size: 11px;
  line-height: 1.6;
}

.empty-action {
  margin-top: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 11.5px;
  cursor: pointer;
}

.empty-action:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* Page context menu ------------------------------------------------------- */

.tab-menu {
  position: fixed;
  z-index: 95;
  min-width: 196px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-dialog);
}

.tab-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.tab-menu-item:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}

.tab-menu-item:disabled {
  opacity: 0.4;
}

.tab-menu-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--line-soft);
}

/* Resolution section of the tab menu. */
.menu-section-label {
  padding: 4px 10px 2px;
  font-size: 9.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.tab-menu-item.checked {
  color: var(--accent);
}

.viewport-custom {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px 6px;
}

.viewport-input {
  width: 52px;
  padding: 3px 5px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  font-size: 10.5px;
  color: var(--text);
  outline: 0;
  /* Hide the spinner buttons: the stepper eats half of a 52px field. */
  -moz-appearance: textfield;
  appearance: textfield;
}

.viewport-input::-webkit-outer-spin-button,
.viewport-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.viewport-x {
  color: var(--faint);
  font-size: 10px;
}

.viewport-apply {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 3px 8px;
  font-size: 10.5px;
  color: var(--text-secondary);
  cursor: pointer;
}

.viewport-apply:hover {
  color: var(--text);
  border-color: var(--accent);
}

.viewport-error {
  padding: 0 10px 6px;
  font-size: 10px;
  line-height: 1.35;
  color: var(--danger, #e5484d);
}
</style>
