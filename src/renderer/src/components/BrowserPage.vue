<script setup lang="ts">
import type { EmbeddedTab, FrozenSlot, StageRect } from "@shared/embedded";
import {
  DEVTOOLS_GRIP_WIDTH,
  EMBEDDED_DIVIDER,
  EMBEDDED_SLOT_HEADER,
  embeddedSlotRects,
  isBlankTab,
  tabDisplayTitle,
  viewSlotFractions,
} from "@shared/embedded";
import { resolveBrowserInput } from "@shared/search";
import type { Bookmark, DownloadAction, DownloadEntry, SlotRect } from "@shared/types";
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
  Minus,
  Plus,
  RotateCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import InstanceTabStrip from "./InstanceTabStrip.vue";
import NewTabPage from "./NewTabPage.vue";
import OpenSiteButton from "./OpenSiteButton.vue";

const store = useEmbeddedStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const props = defineProps<{
  /** An HTML overlay (for example the site menu) covers the stage. */
  obscured?: boolean;
}>();

const stage = ref<HTMLElement | null>(null);
/**
 * The stage box in CSS pixels, kept reactive.
 *
 * `slotChrome` used to read `stage.clientWidth` directly, which is not a
 * reactive source: the header bands only recomputed when the tab list changed.
 * Collapsing the dock or resizing the window then left the HTML bands at the old
 * width while the native pages had already moved to the new one, which reads as
 * a dead band beside the last cell.
 */
const stageBox = ref({ width: 0, height: 0 });
const address = ref("");
const findText = ref("");
const findResult = ref<{ matches: number; activeMatch: number } | null>(null);
const findOpen = ref(false);
/** Frozen frames shown while the native views are parked for an overlay. */
const frozenSlots = ref<FrozenSlot[]>([]);
/** Stage origin, so a frozen rect can be placed inside the stage. */
const stageOrigin = ref({ x: 0, y: 0 });

const activeTab = computed(() => store.activeTab);
const activeView = computed(() => store.activeView);

/**
 * The instance on the flat stage, when no view is on stage.
 *
 * Flat mode shows one instance filling the stage. It still gets a header band and
 * a page strip, exactly like a cell of a view: the difference between the two is
 * how many instances are on screen, not whether an instance has tabs. Leaving the
 * band out here is what made "a browser opened from the tab list" behave like a
 * different, lesser thing than the same browser inside a view.
 */
const flatInstance = computed(() => {
  if (activeView.value) return undefined;
  const tab = activeTab.value;
  if (!tab) return undefined;
  const pages = store.instancePages(tab.instanceId);
  return {
    instanceId: tab.instanceId,
    currentId: pages.find((page) => page.active)?.id ?? tab.id,
  };
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
 * Star in the address bar: one click adds the current page, another removes it.
 *
 * The name offered is the page title, which is what the user recognises; the
 * host is the fallback for a page that has not set one. Everything goes through
 * the same `saveBookmark` call the grid's rename uses, so the URL rule is
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
  await workspace.saveBookmark({ name: name.slice(0, 120), url: tab.url });
  // The icon is already in hand here: the tab fetched it through its own session,
  // so the grid does not have to make a second request for the same bytes.
  const saved = workspace.bookmarks.find((item) => samePage(item.url, tab.url));
  if (saved && tab.favicon) await workspace.setBookmarkFavicon(saved.id, tab.favicon);
  workspace.notify(t("app.bookmarkAdded", { name }), "success");
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
 * after a `target="_blank"` link, and the slot always shows the active one.
 */
function slotPage(rootId: string | null): EmbeddedTab | undefined {
  const root = tabById(rootId);
  if (!root) return undefined;
  const pages = store.instancePages(root.instanceId);
  return pages.find((page) => page.active) ?? root;
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

/**
 * Switching pages inside a slot.
 *
 * The instance stays in the same cell — only which of its pages is on screen
 * changes — so this must not bubble up to the header's "select this slot".
 */
function selectPage(pageId: string): void {
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
    // Flat mode reserves the same header band as a view cell, so the search
    // surface starts below it instead of underlapping the tab strip.
    const box = stageBox.value;
    return [
      {
        tab,
        slot: {
          x: 0,
          y: EMBEDDED_SLOT_HEADER,
          width: box.width,
          height: Math.max(1, box.height - EMBEDDED_SLOT_HEADER),
        },
      },
    ];
  }
  return slotChrome.value
    .map((slot, index) => ({ slot, index }))
    .flatMap(({ slot, index }) => {
      const page = slotPage(slot.tabId);
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
    push(slotPage(slot.tabId), embeddedSlotRectsForSlot(slot.index));
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

function activateSlot(rootId: string | null): void {
  const page = slotPage(rootId);
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

function onSlotDragOver(slotIndex: number, event: DragEvent): void {
  if (!event.dataTransfer?.types.includes("text/plain")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  dropSlot.value = slotIndex;
}

async function onSlotDrop(slotIndex: number, event: DragEvent): Promise<void> {
  event.preventDefault();
  const tabId = event.dataTransfer?.getData("text/plain");
  dropSlot.value = null;
  // Clearing the drag signal restores the live pages; do it before the IPC so the
  // re-layout lands on a stage that is already visible again.
  store.dragTab(null);
  const view = activeView.value;
  if (!tabId || !view) return;
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

  const vertical = new Map<number, SlotRect>();
  const horizontal = new Map<number, SlotRect>();
  for (const rect of rects) {
    const right = Math.round((rect.x + rect.width) * 1000) / 1000;
    const bottom = Math.round((rect.y + rect.height) * 1000) / 1000;
    // The right-most / bottom-most edges are the stage border, not boundaries.
    if (right > 0.001 && right < 0.999) vertical.set(right, rect);
    if (bottom > 0.001 && bottom < 0.999) horizontal.set(bottom, rect);
  }

  const handles: Divider[] = [];
  for (const [at, rect] of vertical) {
    handles.push({
      key: `v-${at}`,
      axis: "x",
      at,
      left: Math.round(at * width) - EMBEDDED_DIVIDER,
      top: 0,
      width: EMBEDDED_DIVIDER,
      height: Math.round(height),
    });
    void rect;
  }
  for (const [at, rect] of horizontal) {
    handles.push({
      key: `h-${at}-${rect.x}`,
      axis: "y",
      at,
      left: Math.round(rect.x * width),
      top: Math.round(at * height) - EMBEDDED_DIVIDER,
      width: Math.round(rect.width * width),
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

function reportStage(): void {
  const element = stage.value;
  if (!element) {
    store.setStage(null);
    return;
  }
  // Viewport coordinates are window content-area DIPs, which is exactly what
  // WebContentsView.setBounds expects; offsetTop would be relative to whichever
  // ancestor happens to be positioned.
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) {
    store.setStage(null);
    return;
  }
  stageOrigin.value = { x: Math.round(box.left), y: Math.round(box.top) };
  // Fed into `slotChrome` as well: the header bands are laid out from this box,
  // so they have to follow every resize the native pages follow.
  const width = element.clientWidth;
  const height = element.clientHeight;
  if (width !== stageBox.value.width || height !== stageBox.value.height) {
    stageBox.value = { width, height };
  }
  store.setStage({
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.floor(box.width),
    height: Math.floor(box.height),
  });
}

let resizeObserver: ResizeObserver | null = null;
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
  if (entry.state === "completed") return t("app.downloadDone", { size: formatBytes(entry.receivedBytes) });
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
  if (stage.value) {
    resizeObserver = new ResizeObserver(() => reportStage());
    resizeObserver.observe(stage.value);
  }
  reportStage();
  window.addEventListener("resize", reportStage);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  store.setStageMounted(false);
  resizeObserver?.disconnect();
  offDownloads?.();
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  window.removeEventListener("resize", reportStage);
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
 * Overlays float above the stage by freezing it.
 *
 * `WebContentsView` paints above all HTML regardless of z-index, so an app menu
 * that reaches into the stage would be covered by the page. Capturing the stage
 * first and parking the views keeps the menu readable and the page running.
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
    // pages would paint on top of them otherwise.
    (suggestionsOpen.value && siteSuggestions.value.length > 0);
  const seq = ++freezeSeq;
  if (!covered) {
    frozenSlots.value = [];
    reportStage();
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
async function addToSlot(slotIndex: number): Promise<void> {
  const view = activeView.value;
  if (!view) return;
  await store.openTabInSlot(view.id, slotIndex);
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

async function openIdentityBookmark(identityId: string): Promise<void> {
  await store.openIdentity(identityId);
}

function fillMessage(reason?: string): string {
  switch (reason) {
    case "no-identity":
      return t("app.browserFillNoIdentity");
    case "no-password":
      return t("app.browserFillNoPassword");
    case "cross-origin":
      return t("app.browserFillCrossOrigin");
    default:
      return t("app.browserFillFailed");
  }
}
</script>

<template>
  <section class="browser">
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
        <!-- An explicit go button: Enter is invisible to a mouse user, and the
             adjacent search icon is easy to mistake for "run this address". -->
        <button
          type="submit"
          class="go"
          :disabled="!address.trim()"
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
        Flat mode gets the same band a view cell has.

        Without it, an instance opened into the default tab group had no page
        strip at all: no way to reach its other pages, nowhere for the "+" to
        live, no right-click menu. The instance was not a lesser browser, only a
        browser without its controls — so the band is drawn here too, with the
        slot number and the layout picker omitted because there is exactly one
        cell and no grid to arrange.
      -->
      <div
        v-if="flatInstance"
        class="slot-header flat"
        :style="{ left: '0px', top: '0px', width: '100%', height: `${EMBEDDED_SLOT_HEADER}px` }"
      >
        <span
          v-if="activeTab?.color"
          class="dot"
          :style="{ background: `var(--role-${activeTab.color})` }"
        ></span>
        <span v-if="slotAccount(flatInstance.instanceId)" class="slot-account">
          {{ slotAccount(flatInstance.instanceId) }}
        </span>
        <span v-if="activeTab?.loading" class="spinner"></span>
        <InstanceTabStrip
          :instance-id="flatInstance.instanceId"
          :current-id="flatInstance.currentId"
          @select="selectPage"
          @menu="openTabMenu"
        />
      </div>

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
        @click="activateSlot(slot.tabId)"
        @dragover="onSlotDragOver(slot.index, $event)"
        @dragleave="dropSlot = dropSlot === slot.index ? null : dropSlot"
        @drop="onSlotDrop(slot.index, $event)"
      >
        <span class="slot-index mono">{{ slot.index + 1 }}</span>
        <span
          v-if="slotPage(slot.tabId)?.color"
          class="dot"
          :style="{ background: `var(--role-${slotPage(slot.tabId)?.color})` }"
        ></span>
        <!-- Which account this cell belongs to. Every cell of the same app shows
             the same page title, so without the account name the band cannot
             answer "who am I looking at" — which is the point of the grid. -->
        <span v-if="slotAccount(slot.tabId)" class="slot-account">{{ slotAccount(slot.tabId) }}</span>
        <span v-if="slotPage(slot.tabId)?.loading" class="spinner"></span>
        <!--
          Pages of this instance. A slot holds an instance, so a popup it opened
          has no cell of its own; without a strip here the only way to switch
          back was the dock. The strip is drawn even for a single page: it is
          what says "this cell is a browser with tabs" and the only place the
          "+" for a second page can live.
        -->
        <InstanceTabStrip
          :instance-id="slotInstanceId(slot.tabId)"
          :current-id="slotPage(slot.tabId)?.id"
          @select="selectPage"
          @menu="openTabMenu"
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
        <button
          type="button"
          class="slot-add"
          @click="addToSlot(slot.index)"
        >
          <Plus :size="13" />
          {{ t("app.browserAddTabHere") }}
        </button>
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
          role="menuitem"
          class="tab-menu-item"
          :disabled="isBlankTab(tabMenu.page)"
          @click="copyTabUrl"
        >
          <CornerDownLeft :size="12" />
          {{ t("app.browserCopyUrl") }}
        </button>
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
  </section>
</template>

<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--bg);
  flex: 0 0 auto;
}

/* Sits level with the address field, both 30px tall: a control that is shorter
   than the input beside it reads as secondary, and "+" is the primary action. */
.icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
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

.zoom-stepper {
  display: inline-flex;
  align-items: stretch;
  height: 30px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex: 0 0 auto;
}

/* Quiet at the default; the accent only appears when this page is actually
   zoomed, so the toolbar does not shout "110%" at every normal page. */
.zoom-stepper.changed {
  border-color: color-mix(in srgb, var(--line) 40%, var(--accent));
}

.zoom-stepper.changed .zoom-value {
  color: var(--accent);
}

.zoom-step {
  display: grid;
  place-items: center;
  width: 24px;
  color: var(--faint);
}

.zoom-step:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* The number is the reset: the only reason to click a zoom value is to undo it. */
.zoom-value {
  min-width: 44px;
  padding: 0 6px;
  border-right: 1px solid var(--line-soft);
  border-left: 1px solid var(--line-soft);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.zoom-value:hover {
  background: var(--surface-2);
  color: var(--text);
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
  transition: width 150ms linear;
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
  height: 30px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.address input {
  padding-right: 30px;
}

.address input:focus,
.findbar input:focus {
  border-color: color-mix(in srgb, var(--line) 50%, var(--accent));
}

/* The go affordance lives inside the field so the toolbar stays one row. */
.go {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 24px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
}

.go:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text);
}

.go:disabled {
  opacity: 0.35;
  cursor: default;
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
  background: var(--bg);
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
.slot-header.flat {
  cursor: default;
}

.slot-header.flat:hover {
  background: var(--surface);
}

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
  animation: spin 0.8s linear infinite;
}

.spin {
  animation: spin 0.9s linear infinite;
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
</style>
