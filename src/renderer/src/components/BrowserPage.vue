<script setup lang="ts">
import type { EmbeddedTab, FrozenSlot } from "@shared/embedded";
import {
  EMBEDDED_DIVIDER,
  EMBEDDED_SLOT_HEADER,
  embeddedSlotRects,
  tabDisplayTitle,
  viewSlotFractions,
} from "@shared/embedded";
import type { SlotRect } from "@shared/types";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  CornerDownLeft,
  Plus,
  RotateCw,
  Search,
  SquarePlus,
  X,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";

const store = useEmbeddedStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const props = defineProps<{
  /** An HTML overlay (for example the site menu) covers the stage. */
  obscured?: boolean;
}>();

const stage = ref<HTMLElement | null>(null);
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
 * Slots of the view on stage, in the same geometry the main process uses. The
 * header band of each slot is the only part of the stage HTML that stays
 * visible: the native page paints over the rest.
 */
const slotChrome = computed(() => {
  const element = stage.value;
  const view = activeView.value;
  if (!element || !view) return [];
  const width = element.clientWidth;
  const height = element.clientHeight;
  if (width <= 0 || height <= 0) return [];
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

function slotLabel(rootId: string | null): string {
  const page = slotPage(rootId);
  if (!page) return t("app.browserEmptySlot");
  return tabDisplayTitle(page);
}

function activateSlot(rootId: string | null): void {
  const page = slotPage(rootId);
  if (page) void store.activate(page.id);
}

/** Room for the empty-slot button: the header band alone is too short. */
const slotBody = computed(() =>
  slotChrome.value.map((slot) => ({
    ...slot,
    top: slot.y + EMBEDDED_SLOT_HEADER,
    height: Math.max(0, slot.height - EMBEDDED_SLOT_HEADER),
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
  store.setStage({
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.floor(box.width),
    height: Math.floor(box.height),
  });
}

let resizeObserver: ResizeObserver | null = null;

onMounted(async () => {
  await store.init();
  if (stage.value) {
    resizeObserver = new ResizeObserver(() => reportStage());
    resizeObserver.observe(stage.value);
  }
  reportStage();
  window.addEventListener("resize", reportStage);
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
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
 * Overlays float above the stage by freezing it.
 *
 * `WebContentsView` paints above all HTML regardless of z-index, so an app menu
 * that reaches into the stage would be covered by the page. Capturing the stage
 * first and parking the views keeps the menu readable and the page running.
 */
watch(
  () => props.obscured,
  async (obscured, wasObscured) => {
    if (obscured) {
      frozenSlots.value = await window.ensemble.freezeEmbedded();
      store.setStage(null);
      return;
    }
    if (!wasObscured) return;
    frozenSlots.value = [];
    reportStage();
  },
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
 */
async function navigate(): Promise<void> {
  const target = address.value.trim();
  if (!target) return;
  const tab = activeTab.value;
  if (!tab) {
    await store.openTabWith(target);
    return;
  }
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
  void window.ensemble.openEmbeddedDevTools(tabId);
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
        <ArrowLeft :size="14" />
      </button>
      <button
        type="button"
        class="icon"
        :disabled="!activeTab?.canGoForward"
        :title="t('app.browserForward')"
        @click="goForward"
      >
        <ArrowRight :size="14" />
      </button>
      <button
        type="button"
        class="icon"
        :title="t('app.browserReload')"
        @click="reload"
      >
        <RotateCw :size="14" :class="{ spin: activeTab?.loading }" />
      </button>

      <form class="address" @submit.prevent="navigate">
        <input
          v-model="address"
          type="text"
          spellcheck="false"
          :placeholder="t('app.browserAddress')"
          data-tour="browser-address"
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
      </form>

      <span v-if="activeTab" class="page-title" :title="activeTab.url">
        {{ tabDisplayTitle(activeTab) }}
      </span>

      <button
        v-if="activeTab?.identityId"
        type="button"
        class="text-btn"
        :title="t('app.browserFillHint')"
        @click="fillLogin(activeTab.id)"
      >
        {{ t("app.browserFill") }}
      </button>
      <button
        type="button"
        class="icon"
        :title="t('app.browserFind')"
        @click="findOpen = !findOpen"
      >
        <Search :size="14" />
      </button>
      <button
        type="button"
        class="icon"
        :title="t('app.browserDevTools')"
        @click="activeTab && openDevTools(activeTab.id)"
      >
        <Bug :size="14" />
      </button>
      <button
        type="button"
        class="icon"
        :title="t('app.browserNewTab')"
        @click="store.openTab()"
      >
        <SquarePlus :size="14" />
      </button>
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
      <!-- Native views paint over this area; only the slot headers stay visible. -->
      <div
        v-for="slot in slotChrome"
        :key="slot.index"
        class="slot-header"
        :class="{
          empty: !slot.tabId,
          focused: slot.tabId && slot.tabId === activeView?.focusedTabId,
        }"
        :style="{
          left: `${slot.x}px`,
          top: `${slot.y}px`,
          width: `${slot.width}px`,
          height: `${EMBEDDED_SLOT_HEADER}px`,
        }"
        @click="activateSlot(slot.tabId)"
      >
        <span class="slot-index mono">{{ slot.index + 1 }}</span>
        <span
          v-if="slotPage(slot.tabId)?.color"
          class="dot"
          :style="{ background: `var(--role-${slotPage(slot.tabId)?.color})` }"
        ></span>
        <span class="slot-title">
          {{ slotLabel(slot.tabId) }}
        </span>
        <span v-if="slotPage(slot.tabId)?.loading" class="spinner"></span>
        <span
          v-if="slot.tabId && slot.tabId === activeView?.focusedTabId"
          class="slot-focus mono"
          :title="t('app.browserFocusHint')"
        >
          {{ t("app.browserFocus") }}
        </span>
      </div>

      <!--
        An empty slot has to invite the next action, so the dashed frame fills
        the whole cell and carries an "add a page" button: the new tab lands in
        this slot and takes focus, which leaves the address bar ready to type.
      -->
      <div
        v-for="slot in slotBody"
        v-show="!slot.tabId"
        :key="`body-${slot.index}`"
        class="slot-empty"
        :style="{
          left: `${slot.x}px`,
          top: `${slot.top}px`,
          width: `${slot.width}px`,
          height: `${slot.height}px`,
        }"
      >
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
        <button type="button" class="empty-action" @click="store.openTab()">
          {{ t("app.browserNewTab") }}
        </button>
      </div>
    </div>
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

.icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
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

.address {
  position: relative;
  flex: 1;
  min-width: 0;
}

.address input,
.findbar input {
  width: 100%;
  padding: 5px 9px;
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

.page-title {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--faint);
}

.text-btn {
  padding: 4px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
}

.text-btn:hover {
  background: var(--surface-2);
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
  background: var(--bg);
}

.frozen {
  position: absolute;
  object-fit: fill;
  pointer-events: none;
}

.slot-header {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  background: var(--surface);
  border-bottom: 1px solid var(--line-soft);
  box-sizing: border-box;
  cursor: pointer;
  z-index: 1;
}

.slot-header:hover {
  background: var(--surface-2);
}

.slot-header.focused {
  border-left: 2px solid var(--accent);
  padding-left: 6px;
  background: var(--surface-2);
}

.slot-header.empty {
  cursor: default;
  border: 1px dashed var(--line);
  border-bottom: none;
  border-radius: 4px 4px 0 0;
  background: transparent;
  color: var(--faint);
}

/* Whole-cell dashed frame with a centred action; the header band alone is too
   small to look like a place a page can be added. */
.slot-empty {
  position: absolute;
  display: grid;
  place-items: center;
  border: 1px dashed var(--line);
  border-top: none;
  border-radius: 0 0 4px 4px;
  background: var(--bg);
  z-index: 0;
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

.slot-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-secondary);
}

.slot-focus {
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--accent);
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
</style>
