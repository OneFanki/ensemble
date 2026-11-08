<script setup lang="ts">
import type { EmbeddedTab, EmbeddedView, StageRect } from "@shared/embedded";
import type { UpdateCheckResult } from "@shared/update";
import {
  EMBEDDED_DEVTOOLS_GRIP,
  EMBEDDED_DEVTOOLS_HEAD,
  EMBEDDED_DIVIDER,
  EMBEDDED_SLOT_HEADER,
  embeddedSlotRects,
  isBlankTab,
  stageDrawsSlotHeaders,
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
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Bookmark as BookmarkIcon,
  Bug,
  Check,
  Copy,
  CornerDownLeft,
  Download,
  Eraser,
  FolderOpen,
  Info,
  KeyRound,
  LayoutGrid,
  Minus,
  Monitor,
  MoreHorizontal,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useFloatingLayer } from "../composables/floatingLayer";
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
   * The sidebar is on screen.
   *
   * The top tab strip is drawn either way — a browser always has one. With the
   * column up it also names the focused cell's account, because every cell of
   * the same app shows the same page titles.
   */
  bench?: boolean;
}>();

const emit = defineEmits<{
  /** Open a management page; `null` means "settings", the menu's default. */
  openConsole: [view?: "sites" | "bookmarks" | "settings"];
  /** Single cell ↔ workbench. */
  switchMode: [mode: "browse" | "bench"];
  /** The app menu's "open the workbench" — same action as the layout button. */
  openWorkspace: [];
  /** A manual update check from the menu found something to install. */
  updateFound: [result: UpdateCheckResult];
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
const reportStage = geometry.report;
const address = ref("");
const findText = ref("");
const findResult = ref<{ matches: number; activeMatch: number } | null>(null);
const findOpen = ref(false);

const platform = computed(() => workspace.snapshot?.platform ?? "win32");
/** The AI endpoint menu: state, address and the way to settings. */
const aiMenuOpen = ref(false);

/**
 * Closes the AI menu on a click anywhere outside it.
 *
 * It was the one popup in the toolbar that had no dismissal at all: it opened
 * from its own button and only closed by clicking that button again. Combined
 * with the header being a drag region — where clicks were swallowed before they
 * reached the page — the only reliable way out was to find the same small icon.
 */
watch(aiMenuOpen, (open) => {
  if (open) window.addEventListener("pointerdown", onAiMenuOutside, true);
  else window.removeEventListener("pointerdown", onAiMenuOutside, true);
});

function onAiMenuOutside(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest(".ai-entry")) return;
  aiMenuOpen.value = false;
}

useFloatingLayer(aiMenuOpen);

function openMcpSettings(): void {
  aiMenuOpen.value = false;
  navigation.navigate("settings", "mcp");
}

/**
 * The app menu, at the toolbar's right end.
 *
 * It replaces a bare gear. A gear says "settings" and nothing else, which left
 * every other infrequent action with no home — and, more importantly, left no
 * place to put a second door into the workbench. The workbench is the whole
 * reason this is not a plain browser, but its only entry was a grid glyph beside
 * the first tab that a newcomer has no reason to try.
 *
 * The frequent things stay outside the menu: password fill, the AI entry, zoom,
 * downloads and the bookmark star all remain visible in the toolbar. What lives
 * here is what people look for once and would otherwise hunt for — settings,
 * bookmarks, updates, quitting, and that second workbench door.
 */
const appMenuOpen = ref(false);
useFloatingLayer(appMenuOpen);

// Same dismissal the AI menu needed: the toolbar is a drag region in its empty
// parts, so without the floating-layer flag a click on that empty space never
// reaches the document at all.
watch(appMenuOpen, (open) => {
  if (open) window.addEventListener("pointerdown", onAppMenuOutside, true);
  else window.removeEventListener("pointerdown", onAppMenuOutside, true);
});

function onAppMenuOutside(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest(".app-menu-anchor")) return;
  appMenuOpen.value = false;
}

/** How the window was asked to quit; the main process owns what that means. */
const appPlatform = computed(() => workspace.snapshot?.platform ?? "win32");

function openWorkspaceFromMenu(): void {
  appMenuOpen.value = false;
  emit("openWorkspace");
}

function openPageFromMenu(view: "sites" | "bookmarks" | "settings"): void {
  appMenuOpen.value = false;
  emit("openConsole", view);
}

async function checkForUpdates(): Promise<void> {
  appMenuOpen.value = false;
  const result = await window.ensemble.checkUpdate();
  // Handed to the shell, which owns the update dialog: the menu and the settings
  // page must not each draw their own copy of it.
  if (result.status === "available") emit("updateFound", result);
}

async function quitApp(): Promise<void> {
  appMenuOpen.value = false;
  await window.ensemble.quitApp();
}

/**
 * Which surface every launch goes to.
 *
 * It lives in this menu because the switch is one decision that applies to every
 * entry — a per-page button made the same action look like several features. It
 * used to sit in the window's title bar; that row is gone, and with it the only
 * way to change the setting, which left the app permanently on whatever it was
 * last set to. The clean session below reads the same value, so the hint names
 * the surface it will actually use.
 */
const launchTarget = computed(() => workspace.settings.launchTarget ?? "embedded");

function chooseLaunchTarget(target: "embedded" | "external"): void {
  appMenuOpen.value = false;
  if (target === launchTarget.value) return;
  void workspace.saveSettings({ launchTarget: target });
}

async function openCleanFromMenu(): Promise<void> {
  appMenuOpen.value = false;
  await workspace.openCleanSession();
}

/**
 * Whether the sidebar is up.
 *
 * Read from the prop when the parent has an opinion, and from the layout
 * otherwise: a multi-cell layout is on stage because someone opened the
 * workbench, and a stale prop should not hide the column beside a grid.
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
  stripDropHint.value = null;
  store.dragTab(null);
}

/**
 * Reordering inside the strip.
 *
 * The drag data is the same payload the cells read (`application/x-ensemble-page`),
 * so a drop here means "this page belongs at this spot in the instance's tab
 * order" — the same reorder the dock rows perform, arriving via the strip. Only
 * a page of the same instance qualifies: the strip lists one browser's pages, and
 * dropping a foreign page between them would splice two windows' tab lists
 * together. The edge splits at the target's midpoint — left half lands before it,
 * right half lands after.
 */
const stripDropHint = ref<{ tabId: string; edge: "before" | "after" } | null>(null);

function onStripTabDragOver(page: EmbeddedTab, event: DragEvent): void {
  const dragId = store.draggingTabId;
  const dragPage = dragId ? store.tabs.find((tab) => tab.id === dragId) : undefined;
  if (!dragPage || dragPage.instanceId !== page.instanceId || dragId === page.id) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const edge: "before" | "after" = event.clientX - rect.left < rect.width / 2 ? "before" : "after";
  stripDropHint.value = { tabId: page.id, edge };
}

function onStripTabDragLeave(page: EmbeddedTab): void {
  if (stripDropHint.value?.tabId === page.id) stripDropHint.value = null;
}

/** Insertion marker on the edge the drop would land on; only while a drag is live. */
function stripDropClass(page: EmbeddedTab): Record<string, boolean> {
  const hint = stripDropHint.value;
  if (!store.draggingTabId || !hint || hint.tabId !== page.id) return {};
  return { [`drop-${hint.edge}`]: true };
}

async function onStripTabDrop(page: EmbeddedTab, event: DragEvent): Promise<void> {
  event.preventDefault();
  const dragId = store.draggingTabId;
  const hint = stripDropHint.value;
  stripDropHint.value = null;
  store.dragTab(null);
  if (!dragId || dragId === page.id || !hint || hint.tabId !== page.id) return;
  // Copied into a fresh literal like the dock's drop does: the IPC argument must
  // be plain data whatever the ref was holding.
  await store.dropTab(dragId, { kind: "tab", tabId: page.id, edge: hint.edge });
}

/**
 * Middle-click closes, the way every browser does it.
 *
 * Chromium starts an autoscroll on a middle press, so the mousedown is answered
 * here with `preventDefault`; the close itself happens on `auxclick`, which a
 * middle release fires and a plain left click does not.
 */
function onWindowPageMouseDown(event: MouseEvent): void {
  if (event.button === 1) event.preventDefault();
}

function onWindowPageAuxClick(page: EmbeddedTab, event: MouseEvent): void {
  if (event.button !== 1) return;
  event.preventDefault();
  store.closeTab(page.id);
}

function openWindowPageMenu(page: EmbeddedTab, event: MouseEvent): void {
  openTabMenu(page, event);
}

/**
 * The strip's "+": another page in the same instance, asked as which account.
 *
 * With no page open there is no instance to grow, which made this a button that
 * did nothing at the exact moment it was the only page control on screen. It
 * falls back to a fresh loose tab — the same thing the toolbar's "+" does.
 */
function addWindowPage(): void {
  if (windowInstanceId.value) void store.openTabInInstance(windowInstanceId.value);
  else void store.openLooseTab();
}

/**
 * Show ↔ hide the sidebar.
 *
 * The parent owns the mode: the shell decides whether the column is on screen,
 * and the browser only reports what was clicked. Hiding does not close anything —
 * every page keeps running and is still reachable when the column comes back.
 */
function toggleBench(): void {
  emit("switchMode", bench.value ? "browse" : "bench");
}

const activeTab = computed(() => store.activeTab);
const activeView = computed(() => store.activeView);

/**
 * The strip swaps its pages as a set when the selection moves to another
 * window: every key changes at once, so the enter/leave pair reads as "a new
 * tab appeared and the old one was closed". Same title, same slot — there is
 * nothing to animate, and the switch below turns the transition off for that
 * one frame. New tabs inside one window and reordering keep theirs.
 *
 * Declared after `activeView` on purpose: `windowInstanceId` reads it, and a
 * watch established while it is still in its temporal dead zone would throw
 * during setup and take the whole page down with it.
 */
const stripAnimated = ref(true);

watch(windowInstanceId, () => {
  stripAnimated.value = false;
  requestAnimationFrame(() => {
    stripAnimated.value = true;
  });
});

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

/**
 * Cells that draw their own header band.
 *
 * Empty for a one-cell stage: with a single cell the band repeats the window's
 * tab strip one row lower and says nothing the strip does not. The same rule
 * decides the page's geometry in the main process (`stageDrawsSlotHeaders`), so
 * the two cannot disagree about whether that 26px belongs to the chrome or to
 * the page.
 */
const slotHeaders = computed(() => {
  if (!stageDrawsSlotHeaders(slotChrome.value.length)) return [];
  return slotChrome.value.filter((item) => item.tabId);
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
// The page menu is a floating layer like the others, so the header has to be
// clickable while it is up — otherwise the one gesture everyone reaches for to
// dismiss it (click the empty part of the chrome) does nothing.
const tabMenuOpen = computed(() => tabMenu.value !== null);
useFloatingLayer(tabMenuOpen);

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
// Registered so the window's drag band stops swallowing clicks while this menu
// is up; without it, clicking the header's empty space to dismiss the menu did
// nothing at all. See `composables/floatingLayer.ts`.
useFloatingLayer(globalViewportOpen);

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
 * A blank page has no rect from main, so its node is parked and the app's own
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
  // One cell has no band (see `slotHeaders`), so the surface takes the full cell.
  const header = stageDrawsSlotHeaders(slotChrome.value.length) ? EMBEDDED_SLOT_HEADER : 0;
  return {
    x: slot.x,
    y: slot.y + header,
    width: slot.width,
    height: Math.max(1, slot.height - header),
  };
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
 * Occupied cells that need a drop cover while a drag is in flight.
 *
 * See the template comment: without it the drop is delivered to the page instead
 * of to the cell. `draggingTabId` is set by both drag sources (the dock and a
 * page tab), so this appears for either.
 */
const dragCoverSlots = computed(() =>
  store.draggingTabId ? slotChrome.value.filter((slot) => slot.tabId) : [],
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
  /*
   * The pointer has to be taken away from the pages for the whole gesture.
   *
   * A boundary runs beside two live pages, and the very first move lands over
   * one of them. A guest is a real surface: it takes the pointer and the
   * `pointermove` stream stops reaching the window, so the divider froze at its
   * starting position — the drag looked like it simply did not work. The dock's
   * resize handle has held the shield for the same reason since it was written;
   * this one was missing it.
   */
  store.holdPointer();
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
  // Balanced with `startResize`: a shield left held would leave every page
  // permanently unable to take the pointer, which reads as "the browser stopped
  // responding" rather than as a stuck resize.
  store.releasePointer();
  window.removeEventListener("pointermove", onResizeMove);
  if (resizeFrame) {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
  }
  pendingRects = null;
}

/**
 * Pages with a docked DevTools panel: the seam its handle sits in, and the band
 * across its top where the app's own close button lives.
 *
 * The panel is a native surface laid out by main, so this only draws the seam and
 * the band. The arithmetic has to match `placeDevTools` in the main process pixel
 * for pixel or the handle lands beside the gap it is supposed to fill — both
 * sides read `EMBEDDED_DEVTOOLS_GRIP` / `EMBEDDED_DEVTOOLS_HEAD` and round the
 * same way.
 */
const devtoolsPanels = computed(() => {
  const view = activeView.value;
  const cells = slotChrome.value;
  const stages: Array<{ id: string; tabId: string; rect: StageRect; width: number }> = [];
  if (view) {
    for (const cell of cells) {
      const page = slotPage(cell.tabId, cell.index);
      if (!page?.devtoolsOpen || page.devtoolsWidth === undefined) continue;
      const rect = embeddedSlotRectsForSlot(cell.index);
      if (rect) stages.push({ id: page.id, tabId: page.id, rect, width: page.devtoolsWidth });
    }
  } else {
    const page = activeTab.value;
    if (!page?.devtoolsOpen || page.devtoolsWidth === undefined) return [];
    const box = stageBox.value;
    const rect = { x: 0, y: 0, width: box.width, height: Math.max(1, box.height) };
    stages.push({ id: page.id, tabId: page.id, rect, width: page.devtoolsWidth });
  }
  return stages.map((entry) => {
    const split = Math.round(entry.rect.width * (1 - entry.width));
    const left = Math.max(1, split - Math.round(EMBEDDED_DEVTOOLS_GRIP / 2));
    const panelX = entry.rect.x + left + EMBEDDED_DEVTOOLS_GRIP;
    return {
      key: entry.id,
      tabId: entry.tabId,
      grip: {
        left: entry.rect.x + left,
        top: entry.rect.y,
        width: EMBEDDED_DEVTOOLS_GRIP,
        height: entry.rect.height,
      },
      head: {
        left: panelX,
        top: entry.rect.y,
        width: Math.max(1, entry.rect.width - left - EMBEDDED_DEVTOOLS_GRIP),
        height: EMBEDDED_DEVTOOLS_HEAD,
      },
    };
  });
});

const devtoolsGrips = computed(() =>
  devtoolsPanels.value.map((panel) => ({ key: panel.key, tabId: panel.tabId, ...panel.grip })),
);

function startDevToolsResize(tabId: string, event: PointerEvent): void {
  event.preventDefault();
  event.stopPropagation();
  // Same shield as the stage dividers: the first move lands over one of the two
  // native surfaces, which would otherwise take the pointer and freeze the grip.
  store.holdPointer();
  void window.ensemble.resizeEmbeddedDevTools(tabId);
  const stop = (): void => {
    window.removeEventListener("pointerup", stop);
    store.releasePointer();
    void window.ensemble.endEmbeddedDevToolsResize();
  };
  window.addEventListener("pointerup", stop, { once: true });
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
// Same reason as the viewport menu: the panel is a floating layer, so a click on
// the header has to reach the page to dismiss it.
useFloatingLayer(downloadsOpen);
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
// The address box is not in a drag region, but the list it opens reaches the
// top of the window on a narrow layout; registering it keeps the rule uniform.
useFloatingLayer(suggestionsOpen);

function pickSuggestion(url: string): void {
  address.value = url;
  suggestionsOpen.value = false;
  void navigate();
}

/**
 * Hands the stage to main after an overlay opens or closes.
 *
 * There is nothing to freeze any more. A page is a `<webview>` node in this
 * document, so an overlay stacks over it like any other element and the page
 * keeps running underneath. All an overlay has to do is tell main the stage is
 * still there: closing one that had parked the stage earlier must not leave the
 * pages with no rect to come back to.
 *
 * The cover handshake is still completed. Menus wait for it before opening, and
 * a menu that never hears back stays shut — an overlay that skipped the report
 * would look like a dead button rather than an unstyled one.
 */
function syncStageCover(): void {
  reportStage();
  store.finishCover();
}

// Re-report on a stage resize: the rect main holds is what every overlay and
// every page node is placed from, and collapsing the run dock changes it.
watch(() => [stageBox.value.width, stageBox.value.height] as const, syncStageCover);

// The overlay inputs still matter, but only as a signal to report.
watch(
  () =>
    [
      props.obscured,
      store.draggingTabId,
      store.stageMenuOpen,
      suggestionsOpen.value && siteSuggestions.value.length > 0,
      globalViewportOpen.value,
      downloadsOpen.value,
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

/**
 * Reload actions on the refresh button, reached by right-click.
 *
 * A plain reload is already the left click, so the menu exists for the one
 * variation a user cannot otherwise reach: dropping the HTTP cache first. It is
 * a real context menu (pointer position, Escape and outside clicks dismiss it)
 * rather than a second button, because it is a rare action and the toolbar has
 * no room for a permanent split control.
 */
const reloadMenu = ref<{ x: number; y: number } | null>(null);
const reloadMenuOpen = computed(() => reloadMenu.value !== null);
useFloatingLayer(reloadMenuOpen);

function openReloadMenu(event: MouseEvent): void {
  const width = 216;
  const height = 78;
  reloadMenu.value = {
    x: Math.min(event.clientX, window.innerWidth - width - 8),
    y: Math.min(event.clientY, window.innerHeight - height - 8),
  };
  window.addEventListener("pointerdown", onReloadMenuPointerDown, true);
  window.addEventListener("keydown", onReloadMenuKeydown, true);
}

function closeReloadMenu(): void {
  window.removeEventListener("pointerdown", onReloadMenuPointerDown, true);
  window.removeEventListener("keydown", onReloadMenuKeydown, true);
  reloadMenu.value = null;
}

function onReloadMenuPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest(".reload-menu")) return;
  closeReloadMenu();
}

function onReloadMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeReloadMenu();
}

function reloadFromMenu(): void {
  closeReloadMenu();
  reload();
}

async function clearCacheReload(): Promise<void> {
  const tab = activeTab.value;
  closeReloadMenu();
  if (!tab) return;
  await window.ensemble.clearCacheReloadEmbeddedTab(tab.id);
}

function openDevTools(tabId: string): void {
  void window.ensemble.openEmbeddedDevTools(tabId);
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
      <!--
        Shows and hides the sidebar — nothing else.

        It used to also give a one-cell view a 2×1 layout on the way in, so
        "open the workbench" silently rearranged the stage and there was no
        gesture that put it back. The column is its own answer: with it up you
        get the run dock and the navigation, and how many cells the stage is
        split into is the layout picker's business.
      -->
      <button
        type="button"
        class="layout-btn no-drag"
        :class="{ 'is-bench': bench }"
        v-tooltip="bench ? t('app.layoutHideSidebar') : t('app.layoutShowSidebar')"
        :aria-label="bench ? t('app.layoutHideSidebar') : t('app.layoutShowSidebar')"
        :aria-expanded="bench"
        @click="toggleBench"
      >
        <LayoutGrid :size="14" />
      </button>
      <div class="tabs no-drag" role="tablist" :aria-label="t('app.browserTabs')">
        <TransitionGroup :name="stripAnimated ? 'tab' : 'strip-still'">
          <button
            v-for="page in windowPages"
            :key="page.id"
            type="button"
            role="tab"
            class="tab"
            :class="{ active: page.id === windowActivePageId, ...stripDropClass(page) }"
            :aria-selected="page.id === windowActivePageId"
            :data-tab-id="page.id"
            :title="page.url"
            draggable="true"
            @click="activateWindowPage(page.id)"
            @mousedown="onWindowPageMouseDown"
            @auxclick="onWindowPageAuxClick(page, $event)"
            @dragstart="onWindowPageDragStart(page, $event)"
            @dragend="onWindowPageDragEnd"
            @dragover="onStripTabDragOver(page, $event)"
            @dragleave="onStripTabDragLeave(page)"
            @drop="onStripTabDrop(page, $event)"
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
        </TransitionGroup>
      </div>
      <button
        type="button"
        class="strip-add no-drag"
        :aria-label="t('app.browserNewTabHere')"
        v-tooltip="t('app.browserNewTabHere')"
        @click="addWindowPage"
      >
        <Plus :size="14" />
      </button>
      <div class="strip-drag drag-region"></div>
    </div>

    <div class="toolbar">
      <button
        type="button"
        class="icon"
        :disabled="!activeTab?.canGoBack"
        v-tooltip="t('app.browserBack')"
        :aria-label="t('app.browserBack')"
        @click="goBack"
      >
        <ArrowLeft :size="15" />
      </button>
      <button
        type="button"
        class="icon"
        :disabled="!activeTab?.canGoForward"
        v-tooltip="t('app.browserForward')"
        :aria-label="t('app.browserForward')"
        @click="goForward"
      >
        <ArrowRight :size="15" />
      </button>
      <button
        type="button"
        class="icon"
        v-tooltip="t('app.browserReload')"
        :aria-label="t('app.browserReload')"
        :aria-haspopup="'menu'"
        data-reload-button
        @click="reload"
        @contextmenu.prevent.stop="openReloadMenu"
      >
        <RotateCw :size="15" :class="{ spin: activeTab?.loading }" />
      </button>

      <form class="address" @submit.prevent="navigate">
        <input
          v-model="address"
          type="text"
          spellcheck="false"
          :placeholder="t('app.browserAddress')"
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
          v-tooltip="t('app.browserGo')"
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
        v-tooltip="bookmarkedEntry ? t('app.bookmarkRemove') : t('app.bookmarkAddHint')"
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
        v-tooltip="t('app.browserFillHint')"
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
        v-tooltip="aiOriginAuthorized ? t('app.aiOriginRevokeHint') : t('app.aiOriginGrantHint')"
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
        v-tooltip="t('app.browserFind')"
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
          v-tooltip="t('app.downloads')"
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
                v-tooltip="t('app.downloadCancel')"
                @click="actOnDownload('cancel', entry.id)"
              >
                <X :size="13" />
              </button>
              <template v-else>
                <button
                  type="button"
                  class="download-mini"
                  v-tooltip="t('app.downloadReveal')"
                  @click="actOnDownload('reveal', entry.id)"
                >
                  <FolderOpen :size="13" />
                </button>
                <button
                  type="button"
                  class="download-mini"
                  v-tooltip="t('app.downloadRemove')"
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
          v-tooltip="t('app.viewportDefaultHint')"
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
          v-tooltip="t('app.browserZoomOut')"
          @click="zoom('out')"
        >
          <Minus :size="12" />
        </button>
        <button
          type="button"
          class="zoom-value mono"
          v-tooltip="t('app.browserZoomReset')"
          @click="zoom('reset')"
        >
          {{ activeTab.zoom }}%
        </button>
        <button
          type="button"
          class="zoom-step"
          :aria-label="t('app.browserZoomIn')"
          v-tooltip="t('app.browserZoomIn')"
          @click="zoom('in')"
        >
          <Plus :size="12" />
        </button>
      </div>
      <button
        type="button"
        class="icon"
        :class="{ active: activeTab?.devtoolsOpen }"
        :disabled="!activeTab || isBlankTab(activeTab)"
        v-tooltip="
          activeTab?.devtoolsOpen ? t('app.browserDevToolsClose') : t('app.browserDevTools')
        "
        :aria-label="t('app.browserDevTools')"
        @click="activeTab && (activeTab.devtoolsOpen ? closeDevTools(activeTab.id) : openDevTools(activeTab.id))"
      >
        <Bug :size="15" />
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
          v-tooltip="t('app.statusMcpHint')"
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
        @open-blank-clean="store.openCleanTab()"
        @open-daily="openSiteBookmark"
        @open-clean="openSiteClean"
        @open-identity="openIdentityBookmark"
      />
      <!--
        The app menu, at the toolbar's right end where every application puts it.

        It used to be a bare gear, which said "settings" and nothing else: every
        other infrequent action had no home, and — the part that mattered — there
        was nowhere to put a second door into the sidebar. Frequent controls stay
        in the toolbar; this menu is the once-in-a-while list.
      -->
      <div class="app-menu-anchor">
        <button
          type="button"
          class="icon app-menu-btn"
          :class="{ active: appMenuOpen }"
          :aria-label="t('app.appMenu')"
          :aria-expanded="appMenuOpen"
          v-tooltip="t('app.appMenu')"
          data-app-menu
          @click="appMenuOpen = !appMenuOpen"
        >
          <MoreHorizontal :size="16" />
        </button>
        <div v-if="appMenuOpen" class="app-menu" role="menu">
          <!--
            The second door to the sidebar. The first is the grid glyph at the
            left of the tab strip — invisible as a concept to anyone who did not
            already know what this app does, which is exactly the audience the
            menu is for.
          -->
          <button
            type="button"
            role="menuitem"
            class="app-menu-item"
            data-menu-item="workspace"
            @click="openWorkspaceFromMenu"
          >
            <LayoutGrid :size="14" />
            <span>{{ t("app.layoutOpenBench") }}</span>
          </button>
          <div class="app-menu-rule" role="separator"></div>
          <!--
            Where launches go, and the throwaway session beside it: both are
            "how this browser behaves", not a page to visit.
          -->
          <p class="app-menu-title">{{ t("app.launchTargetTitle") }}</p>
          <button
            type="button"
            role="menuitemradio"
            class="app-menu-item"
            :aria-checked="launchTarget === 'embedded'"
            data-menu-item="launch-embedded"
            @click="chooseLaunchTarget('embedded')"
          >
            <Monitor :size="14" />
            <span>{{ t("app.launchTargetEmbedded") }}</span>
            <Check v-if="launchTarget === 'embedded'" :size="13" class="app-menu-check" />
          </button>
          <button
            type="button"
            role="menuitemradio"
            class="app-menu-item"
            :aria-checked="launchTarget === 'external'"
            data-menu-item="launch-external"
            @click="chooseLaunchTarget('external')"
          >
            <AppWindow :size="14" />
            <span>{{ t("app.launchTargetExternal") }}</span>
            <Check v-if="launchTarget === 'external'" :size="13" class="app-menu-check" />
          </button>
          <button
            type="button"
            role="menuitem"
            class="app-menu-item"
            data-menu-item="clean-session"
            @click="openCleanFromMenu"
          >
            <ShieldOff :size="14" />
            <span>{{ t("app.cleanSession") }}</span>
          </button>
          <div class="app-menu-rule" role="separator"></div>
          <button
            type="button"
            role="menuitem"
            class="app-menu-item"
            data-menu-item="bookmarks"
            @click="openPageFromMenu('bookmarks')"
          >
            <BookmarkIcon :size="14" />
            <span>{{ t("app.bookmarks") }}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="app-menu-item"
            data-menu-item="settings"
            @click="openPageFromMenu('settings')"
          >
            <Settings :size="14" />
            <span>{{ t("app.settings") }}</span>
          </button>
          <div class="app-menu-rule" role="separator"></div>
          <button type="button" role="menuitem" class="app-menu-item" @click="checkForUpdates">
            <RefreshCw :size="14" />
            <span>{{ t("app.checkUpdate") }}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="app-menu-item"
            @click="openPageFromMenu('settings')"
          >
            <Info :size="14" />
            <span>{{ t("app.about") }}</span>
          </button>
          <div class="app-menu-rule" role="separator"></div>
          <button type="button" role="menuitem" class="app-menu-item danger" @click="quitApp">
            <Power :size="14" />
            <span>{{ t("app.quitApp") }}</span>
          </button>
        </div>
      </div>
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
      <!-- A blank page has no node on the stage; the app draws it. -->
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
        v-for="slot in slotHeaders"
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
        Drop cover, one per occupied cell, while a drag is in flight.

        A page is a real surface: it takes the drop. `pointer-events: none`
        during a drag stops it stealing the *pointer*, but drag-and-drop is
        dispatched by hit-testing the document, and the guest still answers it —
        so a drop aimed at a cell's page area was delivered to the page itself,
        and the browser treated it as "drop a link on this page" (which is where
        the stray new tab came from). This layer covers the cell's page area for
        the duration of the drag so the drop handler here is what receives it.

        It is drawn for occupied cells only; an empty cell already owns its whole
        rectangle and listens for itself.
      -->
      <div
        v-for="slot in dragCoverSlots"
        :key="`cover-${slot.index}`"
        class="slot-drop-cover"
        :class="{ 'drop-target': dropSlot === slot.index }"
        :style="{
          left: `${slot.x}px`,
          top: `${slot.y}px`,
          width: `${slot.width}px`,
          height: `${slot.height}px`,
        }"
        @dragover="onSlotDragOver(slot.index, $event)"
        @dragleave="dropSlot = dropSlot === slot.index ? null : dropSlot"
        @drop="onSlotDrop(slot.index, $event)"
      ></div>

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
              v-tooltip="t('app.browserAddIdentityHere')"
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

      <!-- Divider handles sit in the HTML header bands: a page node is a real
           surface and would take the pointer anywhere its own box covers. -->
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

      <!-- The seam between a page and its docked DevTools panel. Same reason as
           the stage dividers: both sides are native surfaces, so only a real gap
           between them leaves anywhere for this to be seen and grabbed. -->
      <div
        v-for="grip in devtoolsGrips"
        :key="`devtools-grip-${grip.key}`"
        class="devtools-grip"
        :style="{
          left: `${grip.left}px`,
          top: `${grip.top}px`,
          width: `${grip.width}px`,
          height: `${grip.height}px`,
        }"
        @pointerdown="startDevToolsResize(grip.tabId, $event)"
      ></div>

      <!--
        The strip above a docked panel. The panel is a native surface, so the
        close button cannot be drawn on top of it — it lives here instead, in the
        26px the panel gives up at its top (see `EMBEDDED_DEVTOOLS_HEAD`).
      -->
      <div
        v-for="panel in devtoolsPanels"
        :key="`devtools-head-${panel.key}`"
        class="devtools-head"
        :style="{
          left: `${panel.head.left}px`,
          top: `${panel.head.top}px`,
          width: `${panel.head.width}px`,
          height: `${panel.head.height}px`,
        }"
      >
        <span class="devtools-head-label">
          <Bug :size="11" />
          {{ t("app.browserDevTools") }}
        </span>
        <button
          type="button"
          class="devtools-head-close"
          :aria-label="t('app.browserDevToolsClose')"
          v-tooltip="t('app.browserDevToolsClose')"
          :data-devtools-close="panel.tabId"
          @click="closeDevTools(panel.tabId)"
        >
          <X :size="12" />
        </button>
      </div>

      <!--
        Batch launch marker: while a batch is still filling this view, the stage
        itself may not move at all — a free layout has one cell and the first
        page takes seconds to land. The marker is the difference between "the
        launch is running" and "the click did nothing". It sits above the guest
        nodes, which live at z-index 1.
      -->
      <div v-if="activeView?.launching" class="batch-marker" role="status">
        <span class="batch-spinner spin" aria-hidden="true"></span>
        {{ t("app.batchStarting", { done: activeView.launching.done, total: activeView.launching.total }) }}
      </div>

      <!--
        The empty stage, and only when nothing else on it says what to do.

        A view with empty cells already draws each one as a dashed "add a tab
        here" box; the global prompt then landed between them saying the same
        thing a second time, in the middle of the grid it was standing in for.
        The prompt is for a genuinely blank stage — no pages anywhere and no
        cells to invite one.
      -->
      <div v-if="!store.tabs.length && !emptySlots.length" class="empty">
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

    <Teleport to="body">
      <div
        v-if="reloadMenu"
        class="reload-menu"
        role="menu"
        :style="{ left: `${reloadMenu.x}px`, top: `${reloadMenu.y}px` }"
      >
        <button type="button" role="menuitem" class="tab-menu-item" @click="reloadFromMenu">
          <RotateCw :size="12" />
          {{ t("app.browserReload") }}
        </button>
        <button type="button" role="menuitem" class="tab-menu-item" @click="clearCacheReload">
          <Eraser :size="12" />
          {{ t("app.browserClearCacheReload") }}
        </button>
        <p class="reload-menu-note">{{ t("app.browserClearCacheReloadHint") }}</p>
      </div>
    </Teleport>

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
  color: var(--accent-text);
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
/*
 * A tab fills the whole strip so that its top edge is the window's top edge.
 *
 * It used to be 30px inside a 34px band, bottom-aligned: the 4px of frame above
 * every tab was dead space that could not be clicked, and people who slam the
 * pointer at the top of the screen to switch tabs hit the window frame instead.
 * The maximised-window case is the one that matters — the top of the screen is
 * an infinite target, and a control that starts 4px below it throws that away.
 *
 * The radius stays: a rounded tab is what says "browser". Its corners are only
 * a few pixels, and the middle of the label — where a click lands — is inside.
 */
.tab {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 100%;
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

/*
 * A new tab grows from nothing instead of appearing at full width.
 *
 * Without this the strip re-lays out in one frame: the new tab materialises
 * already at its final width and every tab to its right jumps sideways. The eye
 * reads that as a flash, not as a tab being added.
 *
 * It animates `width`, not `max-width`. `max-width` only caps a box whose width
 * comes from somewhere else, and this tab's width comes from its own content —
 * so a transition on the cap changed nothing and the strip still snapped. The
 * three width-driving properties are animated together: `width` for the box,
 * `min-width` because the resting rule floors it at 46px, and the horizontal
 * padding because a zero-width tab that still carries 10px of padding pops in at
 * the wrong size for one frame.
 */
.tab-enter-active,
.tab-leave-active {
  overflow: hidden;
  transition:
    width var(--motion-base) var(--ease-out),
    min-width var(--motion-base) var(--ease-out),
    padding var(--motion-base) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out);
}

.tab-enter-from,
.tab-leave-to {
  width: 0;
  min-width: 0;
  padding-left: 0;
  padding-right: 0;
  opacity: 0;
}

/* Leaving tabs stay in flow while they shrink, so the neighbours slide across
   as the space closes rather than snapping when the node is dropped. */
.tab-leave-active {
  position: relative;
}

.tab-move {
  transition: transform var(--motion-base) var(--ease-out);
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

/* Where a dragged tab would land: a rule on the near edge of the tab under the
   pointer, the insertion mark every browser draws while reordering tabs. */
.tab.drop-before::after,
.tab.drop-after::after {
  content: "";
  position: absolute;
  top: 6px;
  bottom: 4px;
  width: 2px;
  border-radius: 1px;
  background: var(--accent);
}

.tab.drop-before::after {
  left: 0;
}

.tab.drop-after::after {
  right: 0;
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
  border-top-color: var(--accent-text);
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

/* The app menu entry is a full toolbar button; these rules only place it. Its
   size, hover and icon colour come from `.icon`, which is what keeps it looking
   like the controls beside it rather than like a second kind of button. */
.app-menu-anchor {
  position: relative;
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.app-menu-btn {
  margin-left: 2px;
  margin-right: 4px;
}

/*
 * Anchored above the toolbar's bottom edge, right-aligned to its button.
 *
 * Right rather than left: the menu is the last control before the window
 * controls, so a left-anchored panel would run off the window on the right.
 */
.app-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: var(--z-menu, 60);
  min-width: 208px;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  display: flex;
  flex-direction: column;
  /* Same entry as every other anchored panel: it hangs off the button, so it
     grows down and out of it rather than fading in place. */
  animation: app-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top right;
}

@keyframes app-menu-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
}

.app-menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 30px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
}

.app-menu-item:hover {
  background: var(--surface-3);
  color: var(--text);
}

.app-menu-item.danger {
  color: var(--red);
}

.app-menu-item.danger:hover {
  background: color-mix(in srgb, var(--red) 12%, transparent);
}

.app-menu-rule {
  height: 1px;
  margin: 4px 6px;
  background: var(--line-soft);
}

/* A caption inside the menu, not an item: the launch options below it are one
   choice with several values, and the caption is what says so. */
.app-menu-title {
  margin: 0;
  padding: 4px 9px 2px;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.app-menu-check {
  margin-left: auto;
  color: var(--accent-text);
}

/* The native window controls are drawn over the window's top-right corner, and
   that corner now belongs to this strip in both shells — the sidebar is on the
   left, so nothing else reaches the right end. */
.tabstrip[data-platform="win32"],
.tabstrip[data-platform="linux"] {
  padding-right: calc(var(--window-controls-width, 138px) + 2px);
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

/* The AI entry is a plain toolbar button. It used to tint itself amber whenever
   the endpoint was running, which made a status light look like a primary
   action and pulled the eye to the far end of the row; the dot on the corner
   carries the state, and the glyph is just an icon. */
.ai-btn.on {
  background: transparent;
}

.ai-label {
  color: var(--text-secondary);
  letter-spacing: 0.01em;
}

.ai-btn.on .ai-label {
  color: var(--text-secondary);
}

.ai-btn:hover .ai-label {
  color: var(--text);
}

.ai-mark {
  display: grid;
  place-items: center;
  color: var(--text-secondary);
}

.ai-btn:hover .ai-mark {
  color: var(--text);
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
  animation: app-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top right;
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  animation: app-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top right;
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
  animation: app-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top center;
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
  animation: app-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top right;
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
  color: var(--accent-text);
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
  color: var(--accent-text);
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
  border-color: var(--accent-text);
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

/* A blank page's HTML surface: it fills the cell below the header band. */
.blank-slot {
  position: absolute;
  z-index: 0;
  overflow: hidden;
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
  border-color: var(--accent-text);
  box-shadow: inset 0 0 0 1px var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
}

/*
 * Drop cover over an occupied cell.
 *
 * Transparent until the pointer is over it, so the page stays readable while the
 * drag is in flight; only the cell being aimed at lights up. It exists purely to
 * receive the drop — without it the page takes it (see the template comment).
 */
.slot-drop-cover {
  position: absolute;
  z-index: 2;
  border-radius: 2px;
  transition: box-shadow var(--motion-fast) var(--ease-out);
}

.slot-drop-cover.drop-target {
  box-shadow: inset 0 0 0 2px var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
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
  animation: app-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
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

/*
 * The page ↔ DevTools seam.
 *
 * Wider hit area than it looks: the visible line is drawn by `::before` in the
 * middle of the gap, while the element itself fills the gap. A 7px target is
 * hard to hit on a fast move, and the two neighbours are native surfaces that
 * will keep the pointer if it slips off — so the element is the whole gutter and
 * the line is only what marks it.
 */
.devtools-grip {
  position: absolute;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
}

.devtools-grip::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: var(--line);
  transition: background var(--motion-fast) var(--ease-out);
}

.devtools-grip:hover::before,
.devtools-grip:active::before {
  background: var(--accent);
}

/*
 * The strip the app owns above a docked panel.
 *
 * It fills the 26px hole `placeDevTools` leaves at the panel's top, so it has to
 * be painted (not transparent) or the stage behind shows through the gap.
 */
.devtools-head {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 8px;
  box-sizing: border-box;
  background: var(--surface);
  border-bottom: 1px solid var(--line-soft);
}

.devtools-head-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--faint);
}

.devtools-head-close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 4px;
  color: var(--faint);
}

.devtools-head-close:hover {
  background: var(--surface-3);
  color: var(--text);
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
  border-top-color: var(--accent-text);
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

/*
 * Batch launch marker at the stage's foot: the one signal a free layout gets
 * while a batch is filling it, since a single cell cannot light up cell by
 * cell. A quiet capsule, not a toast — the launch is progress, not an event.
 */
.batch-marker {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 13px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--line-soft);
  box-shadow: 0 4px 14px rgb(0 0 0 / 25%);
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  pointer-events: none;
}

.batch-spinner {
  width: 11px;
  height: 11px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--line);
  border-top-color: var(--accent-text);
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

/* The reload menu is the same object; it just carries a note line, so the
   width is pinned to keep that line on two rows instead of one long one. */
.reload-menu {
  position: fixed;
  z-index: 95;
  width: 216px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-dialog);
  animation: app-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

.reload-menu-note {
  margin: 0;
  padding: 4px 8px 6px;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--faint);
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
  color: var(--accent-text);
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
  border-color: var(--accent-text);
}

.viewport-error {
  padding: 0 10px 6px;
  font-size: 10px;
  line-height: 1.35;
  color: var(--danger, #e5484d);
}
</style>
