<script setup lang="ts">
import type { EmbeddedDropTarget, EmbeddedTab, EmbeddedView } from "@shared/embedded";
import { EMBEDDED_LAYOUTS } from "@shared/embedded";
import type { LayoutId, RoleColor } from "@shared/types";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Layers,
  PanelRightClose,
  Plus,
  Power,
  X,
} from "lucide-vue-next";
import { computed, nextTick, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import OpenSiteButton from "./OpenSiteButton.vue";
import SelectField from "./SelectField.vue";
import TabIcon from "./TabIcon.vue";

const workspace = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const { t } = useI18n();

/**
 * A dock row is a browser instance, not a page.
 *
 * One view slot holds one instance; pages a page opens (`target="_blank"`,
 * OAuth popups) stay inside that instance and are listed under its row. That is
 * why every row here speaks in instance ids even though the manager still models
 * pages individually.
 */
type DropHint =
  | { kind: "tab"; tabId: string; edge: "before" | "after" | "middle" }
  | { kind: "view"; viewId: string }
  | { kind: "loose" };

const draggedTabId = ref<string | null>(null);
/**
 * `shallowRef` on purpose: this object crosses `contextBridge` as an IPC
 * argument, and a deep ref would hand over a reactive Proxy, which the
 * structured clone step rejects ("an object could not be cloned"). The whole
 * object is replaced on every drag event, so shallow reactivity is enough.
 */
const dropHint = shallowRef<DropHint | null>(null);
const renamingViewId = ref<string | null>(null);
const renameText = ref("");
const renameInput = ref<HTMLInputElement | null>(null);
/** True while the left edge is being dragged, so the width transition stays off. */
const resizing = ref(false);

const collapsed = computed(() => embedded.sidebarCollapsed);

/**
 * Layout choices for a view.
 *
 * "1 × 1" is what "no layout" looks like once a preset exists, so offering both
 * would be two names for the same screen. Custom presets are also omitted: the
 * embedded surface only knows the built-in grids, and offering an option that
 * silently does nothing is worse than not offering it.
 */
const layoutOptions = computed(() =>
  workspace.viewLayoutPresets
    .filter((preset) => EMBEDDED_LAYOUTS.includes(preset.id))
    .map((preset) => ({ value: preset.id, label: workspace.presetName(preset) })),
);

const totalRunning = computed(() => embedded.runningCount + workspace.instances.length);

function toggleCollapsed(): void {
  embedded.setSidebarCollapsed(!collapsed.value);
}

/**
 * Drags the left edge to resize the dock.
 *
 * Width is written to the store on every move so the stage re-lays out live,
 * but persistence waits for pointerup: writing localStorage 60 times a second
 * during a drag is what makes sidebars feel sticky.
 *
 * The pointer is captured for the duration. Without it the drag stops the
 * moment the cursor crosses out of the dock: the pages are `<webview>` nodes
 * occupying the stage, and a guest is its own native surface, so it takes the
 * pointer and the embedder never sees the move. Every subsequent position was
 * lost and the dock stayed at its starting width.
 */
function startResize(event: PointerEvent): void {
  if (collapsed.value) return;
  event.preventDefault();
  const handle = event.currentTarget as Element | null;
  try {
    handle?.setPointerCapture(event.pointerId);
  } catch {
    // A capture that cannot be taken still leaves the window listeners working
    // for the part of the drag that stays inside the dock.
  }
  const startX = event.clientX;
  const startWidth = embedded.dockWidth;
  resizing.value = true;
  embedded.holdPointer();
  const move = (next: PointerEvent) => {
    embedded.setDockWidth(startWidth - (next.clientX - startX), false);
  };
  const up = () => {
    resizing.value = false;
    embedded.setDockWidth(embedded.dockWidth);
    embedded.releasePointer();
    try {
      handle?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released by the browser.
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** Pages of an instance; more than one means it behaves like a tabbed window. */
function pagesOf(root: EmbeddedTab): EmbeddedTab[] {
  return embedded.instancePages(root.instanceId);
}

function activePageOf(root: EmbeddedTab): EmbeddedTab {
  return pagesOf(root).find((page) => page.active) ?? root;
}

/**
 * One row of the dock's view block.
 *
 * The dock used to draw exactly one row per instance, with its pages nested
 * underneath. A split breaks that: one instance now occupies two cells showing
 * two different pages, so "one row per instance" had to either repeat the page
 * list twice or list an instance that visibly holds two cells as a single row —
 * the header then said 1/2 while both cells were full, and the nesting repeated
 * the same page under itself.
 *
 * So a row is now a *cell* when the instance is split, and an *instance* when it
 * is not. `nested` carries the pages to indent under the row and is empty for a
 * split row: there is nothing below a cell that shows exactly one page.
 */
interface DockRow {
  root: EmbeddedTab;
  /** Page this row stands for: the pinned page in a split, else the active one. */
  page: EmbeddedTab;
  /** Zero-based slot this row occupies; absent when the instance is off stage. */
  slot?: number;
  /** Pages to list under the row; empty for a split row. */
  nested: EmbeddedTab[];
}

/**
 * Rows for one view block, in slot order then off-stage order.
 *
 * Off-stage instances still deserve a row — they are running, and that is how the
 * user finds and drags them back. They are never split (a split needs two cells),
 * so they keep the nested-pages shape.
 */
function dockRows(view: EmbeddedView): DockRow[] {
  const rows: DockRow[] = [];
  const slotCounts = new Map<string, number>();
  for (const rootId of view.slotTabs) {
    const root = rootId ? embedded.state.tabs.find((tab) => tab.id === rootId) : undefined;
    if (!root) continue;
    slotCounts.set(root.instanceId, (slotCounts.get(root.instanceId) ?? 0) + 1);
  }

  const placed = new Set<string>();
  view.slotTabs.forEach((rootId, index) => {
    const root = rootId ? embedded.state.tabs.find((tab) => tab.id === rootId) : undefined;
    if (!root) return;
    placed.add(root.instanceId);
    const pages = pagesOf(root);
    if ((slotCounts.get(root.instanceId) ?? 1) > 1) {
      const pinnedId = view.slotPages?.[index] ?? null;
      const pinned = pinnedId ? pages.find((page) => page.id === pinnedId) : undefined;
      rows.push({
        root,
        page: pinned ?? activePageOf(root),
        slot: index,
        nested: [],
      });
      return;
    }
    // One cell: a single row for the instance, in slot order.
    if (rows.some((row) => row.root.id === root.id)) return;
    rows.push({
      root,
      page: activePageOf(root),
      slot: index,
      nested: pages.length > 1 ? pages : [],
    });
  });

  for (const root of embedded.viewInstances(view.id)) {
    if (placed.has(root.instanceId)) continue;
    const pages = pagesOf(root);
    rows.push({ root, page: activePageOf(root), nested: pages.length > 1 ? pages : [] });
  }
  return rows;
}

function titleOf(root: EmbeddedTab): string {
  return embedded.titleOf(activePageOf(root));
}

/**
 * Which world a row belongs to, shown next to the page title.
 *
 * Without it every row of the same app reads "数据集管理 · 数据集管理" and the
 * dock cannot answer the one question it exists for: which account is this?
 *
 * "No identity" is not the same as "clean" any more: an identity-less page lands
 * in the daily profile by default, and only an explicit clean open is a
 * throwaway. Saying "clean" for every daily bookmark would be actively wrong.
 */
function accountOf(root: EmbeddedTab): string {
  const identity = workspace.identities.find((item) => item.id === root.identityId);
  if (identity) return identity.name;
  return root.clean ? t("app.cleanSession") : t("app.dailyProfile");
}

/**
 * AI operations on the page this row is showing, or 0.
 *
 * Keyed by tab, not by origin. The badge sits on a row and a row is one page, so
 * the number has to answer "how much did the AI do here" — keying it by origin
 * made two rows of the same site show the same number, which reads as if the AI
 * had worked on both. A row that switched pages shows the new page's count, which
 * is what a user watching that row would expect.
 */
function aiCountOf(root: EmbeddedTab): number {
  return workspace.aiActions[activePageOf(root).id] ?? 0;
}

/**
 * The explanation for the AI-count badge, drawn on hover.
 *
 * A native `title` cannot be styled, waits a second before opening, and renders
 * as browser chrome on top of the app. Drawing it needs care in one place: the
 * panel clips its own overflow and each view block clips too, while the pages on
 * the stage are native views that always paint over app HTML — so the hint has
 * to stay inside the dock, and it opens leftwards for that reason.
 *
 * One line, no wrapping: a wrapped hint is taller than the row it belongs to and
 * gets cut off vertically by the view block instead. That makes the width budget
 * real — it must fit in the space between the badge and the dock's inner edge,
 * in both languages — and `e2e-ai-policy` measures exactly that.
 *
 * Held in state rather than driven by `:hover` so a test can open it with a
 * synthetic mouse event.
 */
const aiTip = ref<string | null>(null);

function showAiTip(root: EmbeddedTab): void {
  // Keyed by row, not by count: two rows of the same site share a number, and
  // matching on it would open the hint on both of them at once.
  aiTip.value = root.id;
}

function hideAiTip(): void {
  aiTip.value = null;
}

function onDragStart(root: EmbeddedTab, event: DragEvent): void {
  draggedTabId.value = root.id;
  // Tells the browser page a drag is in flight, so it can park its native pages
  // and let the whole stage accept a drop.
  embedded.dragTab(root.id);
  event.dataTransfer?.setData("text/plain", root.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd(): void {
  draggedTabId.value = null;
  dropHint.value = null;
  embedded.dragTab(null);
}

function edgeOf(event: DragEvent, element: HTMLElement): "before" | "after" | "middle" {
  const rect = element.getBoundingClientRect();
  const offset = (event.clientY - rect.top) / Math.max(1, rect.height);
  if (offset < 0.28) return "before";
  if (offset > 0.72) return "after";
  return "middle";
}

function onRowDragOver(root: EmbeddedTab, event: DragEvent): void {
  if (!draggedTabId.value || draggedTabId.value === root.id) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropHint.value = {
    kind: "tab",
    tabId: root.id,
    edge: edgeOf(event, event.currentTarget as HTMLElement),
  };
}

function onViewDragOver(viewId: string, event: DragEvent): void {
  if (!draggedTabId.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropHint.value = { kind: "view", viewId };
}

function onLooseDragOver(event: DragEvent): void {
  if (!draggedTabId.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropHint.value = { kind: "loose" };
}

async function onDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  const tabId = draggedTabId.value;
  const hint = dropHint.value;
  draggedTabId.value = null;
  dropHint.value = null;
  embedded.dragTab(null);
  if (!tabId || !hint) return;
  // Copied into a fresh literal for the same reason `dropHint` is shallow: keep
  // the IPC argument a plain object whatever the ref ends up holding.
  const target: EmbeddedDropTarget =
    hint.kind === "tab"
      ? { kind: "tab", tabId: hint.tabId, edge: hint.edge }
      : hint.kind === "view"
        ? { kind: "view", viewId: hint.viewId }
        : { kind: "loose" };
  await embedded.dropTab(tabId, target);
}

function rowDropClass(root: EmbeddedTab): Record<string, boolean> {
  const hint = dropHint.value;
  if (!hint || hint.kind !== "tab" || hint.tabId !== root.id) return {};
  // A loose row has no view to join, so its middle band reorders instead.
  const edge = hint.edge === "middle" && !root.viewId ? "after" : hint.edge;
  return { [`drop-${edge}`]: true };
}

function viewDropClass(viewId: string): Record<string, boolean> {
  const hint = dropHint.value;
  return hint?.kind === "view" && hint.viewId === viewId ? { "drop-into": true } : {};
}

function isOnStage(root: EmbeddedTab): boolean {
  return embedded.isOnStage(activePageOf(root));
}

function isFocused(root: EmbeddedTab): boolean {
  const page = activePageOf(root);
  return page.id === embedded.state.activeTabId;
}

/**
 * Running instances grouped the way the expanded dock groups them.
 *
 * The collapsed strip is 46px wide, so a view header cannot be printed. What it
 * can do is keep the grouping visible: instances of one view stay together,
 * groups are separated by a rule tinted with the view's own colour, and loose
 * instances end the list. Without that, collapsing turns a 2×2 view and four
 * unrelated pages into the same flat column of icons.
 */
interface MiniGroup {
  key: string;
  /** View colour, so the group boundary also says which view it belongs to. */
  color?: RoleColor;
  instances: EmbeddedTab[];
}

const miniGroups = computed<MiniGroup[]>(() => {
  const groups: MiniGroup[] = embedded.views.map((view) => ({
    key: view.id,
    ...(view.color ? { color: view.color } : {}),
    instances: embedded.viewInstances(view.id),
  }));
  if (embedded.looseInstances.length) {
    groups.push({ key: "loose", instances: [...embedded.looseInstances] });
  }
  // An empty container has nothing to show, and an empty group would render a
  // rule around nothing.
  return groups.filter((group) => group.instances.length > 0);
});

/** Icon of the page the instance is showing; the root is the fallback. */
function faviconOf(root: EmbeddedTab): string | undefined {
  return activePageOf(root).favicon ?? root.favicon;
}

/** Tab icons are a pixel or two smaller than the collapsed tile's. */
const PAGE_ICON_SIZE = 11;

/** Group boundary tinted by the group it opens, so colour carries the grouping. */
function groupRuleStyle(color: RoleColor | undefined): Record<string, string> {
  if (!color) return {};
  return { background: `color-mix(in srgb, var(--role-${color}) 45%, var(--line))` };
}

/**
 * Hover label for an icon-only strip.
 *
 * This is the one place a native `title` is used on purpose: the strip is 46px
 * wide inside the dock, and any HTML flyout would extend over the stage, where
 * the native pages paint above the app's own renderer. A tooltip drawn in our
 * layer would be invisible exactly where it needs to be. The instance tab strip
 * can use its own tooltip because it sits inside the stage's HTML band.
 */
function miniLabel(root: EmbeddedTab): string {
  const pages = pagesOf(root).length;
  const suffix = pages > 1 ? ` · ${pages}` : "";
  return `${accountOf(root)} · ${titleOf(root)}${suffix}`;
}

function miniActive(root: EmbeddedTab): boolean {
  return pagesOf(root).some((page) => page.id === embedded.state.activeTabId);
}

function miniOnStage(root: EmbeddedTab): boolean {
  return isOnStage(root);
}

async function changeLayout(view: EmbeddedView, value: string | undefined): Promise<void> {
  if (!value) return;
  await embedded.setLayout(view.id, value as LayoutId);
}

/**
 * Flat list has no container of its own, so its "layout" picker means "make one
 * out of these pages".
 *
 * The placeholder value mirrors a view's: `free` is what "no layout" is called
 * once a preset exists. Choosing a grid goes through the main process, which
 * creates the container, moves every loose page into it and focuses it — the same
 * result as dragging the rows together, so there is no second layout code path.
 */
const flatLayout = computed(() => (embedded.looseInstances.length ? "free" : undefined));

async function applyFlatLayout(value: string | undefined): Promise<void> {
  if (!value || value === "free") return;
  await embedded.groupIntoLooseView(value as LayoutId);
}

/** Closes an instance and every page it opened. */
async function closeInstance(root: EmbeddedTab): Promise<void> {
  const pages = pagesOf(root);
  for (const page of pages) await embedded.closeTab(page.id);
}

function startRename(view: EmbeddedView): void {
  renamingViewId.value = view.id;
  renameText.value = view.name;
  void nextTick(() => renameInput.value?.select());
}

async function commitRename(view: EmbeddedView): Promise<void> {
  if (renamingViewId.value !== view.id) return;
  const name = renameText.value.trim();
  renamingViewId.value = null;
  if (name && name !== view.name) await embedded.renameView(view.id, name);
}

async function closeView(view: EmbeddedView): Promise<void> {
  const accepted = await confirm.ask({
    title: t("app.browserCloseView"),
    body: t("app.browserCloseViewConfirm", { name: view.name }),
    confirmLabel: t("app.browserCloseView"),
    tone: "danger",
  });
  if (!accepted) return;
  await embedded.closeView(view.id, "all");
}

/** Creates an empty view with a default name; rename it later if needed. */
async function newView(): Promise<void> {
  await embedded.createView({ layoutId: "2x1" });
}

/** Site bookmark: open its login page as a loose page, not as a view member. */
async function openSiteBookmark(siteId: string, options?: { clean?: boolean }): Promise<void> {
  const site = workspace.sites.find((item) => item.id === siteId);
  if (!site) return;
  let url: string;
  try {
    url = new URL(site.loginPath || "/", site.baseUrl).toString();
  } catch {
    workspace.notify(t("app.errSiteUrl"), "error");
    return;
  }
  workspace.markSiteUsed(site.id);
  await embedded.openLooseTabWith(url, options);
}

/** Site bookmark as one account: own profile, own login state. */
async function openIdentityBookmark(identityId: string): Promise<void> {
  await embedded.openIdentity(identityId);
}

/**
 * The view header's "+": the same chooser as everywhere else, but every answer
 * lands inside *this* view.
 *
 * The container already names the system, so the chooser is locked to that site
 * and lists its accounts. Opening these as loose pages — what the header used to
 * do — put them in the flat strip while the user was looking at a grid, and a
 * blank daily page was the only thing the button could produce on its own.
 */
async function openSiteInView(
  view: EmbeddedView,
  siteId: string,
  options?: { clean?: boolean },
): Promise<void> {
  const site = workspace.sites.find((item) => item.id === siteId);
  if (!site) return;
  let url: string;
  try {
    url = new URL(site.loginPath || "/", site.baseUrl).toString();
  } catch {
    workspace.notify(t("app.errSiteUrl"), "error");
    return;
  }
  workspace.markSiteUsed(site.id);
  await embedded.openTabInto(view.id, { url, ...(options?.clean ? { clean: true } : {}) });
}

async function openIdentityInView(view: EmbeddedView, identityId: string): Promise<void> {
  await embedded.openTabInto(view.id, { identityId });
}

async function openBlankInView(view: EmbeddedView): Promise<void> {
  await embedded.openTabInto(view.id);
}
</script>

<template>
  <!--
    Collapsed, the dock keeps a column of site icons — one per running instance,
    the way a vertical tab strip does. Collapsing should reclaim width, not hide
    the fact that several pages are running: clicking an icon switches to that
    instance, and the last button reopens the panel.
  -->
  <aside
    class="dock"
    :class="{ collapsed, resizing }"
    :style="{ '--dock-width': `${embedded.dockWidth}px` }"
    data-tour="run-dock"
  >
    <!-- Sits on the border so the pointer turns into a resize cursor before the
         dock itself is reached; a 1px target would be unusable. -->
    <span
      v-if="!collapsed"
      class="dock-resize"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('app.browserResizeDock')"
      :title="t('app.browserResizeDock')"
      @pointerdown="startResize"
    ></span>

    <!--
      The expand control sits where the collapse control sits in the expanded
      panel — top right. A control that jumps from the bottom of the strip to the
      top of the panel makes the same action feel like two different actions.
    -->
    <div v-show="collapsed" class="mini">
      <button
        type="button"
        class="expand"
        :title="t('app.browserExpandDock')"
        :aria-label="t('app.browserExpandDock')"
        :aria-expanded="false"
        @click="toggleCollapsed"
      >
        <Layers :size="14" />
        <span class="badge mono">{{ totalRunning }}</span>
      </button>
      <div class="mini-list">
        <template v-for="(group, index) in miniGroups" :key="group.key">
          <!-- Group boundary: structural, so it has no radius and no fill of its
               own beyond the rule. Tinted by the view it opens. -->
          <span
            v-if="index > 0"
            class="mini-rule"
            :style="groupRuleStyle(group.color)"
            aria-hidden="true"
          ></span>
          <button
            v-for="root in group.instances"
            :key="root.instanceId"
            type="button"
            class="mini-tab"
            :class="{ current: miniActive(root), offstage: !miniOnStage(root) }"
            :title="miniLabel(root)"
            :aria-label="miniLabel(root)"
            :aria-current="miniActive(root) ? 'true' : undefined"
            @click="embedded.activate(activePageOf(root).id)"
          >
            <TabIcon :src="faviconOf(root)" :size="16" />
            <span
              v-if="root.color"
              class="mini-role"
              :style="{ background: `var(--role-${root.color})` }"
            ></span>
          </button>
        </template>
      </div>
    </div>

    <div class="dock-main" :class="{ hidden: collapsed }">
      <header class="dock-head">
        <span class="dock-title">{{ t("app.browserExpandedDock") }}</span>
        <span class="count mono">{{ totalRunning }}</span>
        <button
          type="button"
          class="add-view"
          :title="t('app.browserNewView')"
          @click="newView"
        >
          <Plus :size="12" />
          <span>{{ t("app.browserNewView") }}</span>
        </button>
        <button
          type="button"
          class="icon-btn collapse-btn"
          :title="t('app.browserCollapseDock')"
          @click="toggleCollapsed"
        >
          <PanelRightClose :size="13" />
        </button>
      </header>

      <div class="scroll">
        <!--
          Views: block level, coloured, collapsible; instances are rows.
          `gridded` shows the slot-number column (only a real grid can
          cross-reference one) and deepens the page-list indent to clear it.
        -->
        <section
          v-for="view in embedded.views"
          :key="view.id"
          class="view-block"
          :class="[
            viewDropClass(view.id),
            {
              active: view.id === embedded.state.activeViewId,
              gridded: embedded.slots(view) > 1,
            },
          ]"
          @dragover="onViewDragOver(view.id, $event)"
          @drop="onDrop"
        >
          <header class="block-head" @click="embedded.activateView(view.id)">
            <button
              type="button"
              class="chevron"
              :aria-label="view.collapsed ? t('app.collapse') : t('app.expand')"
              :title="view.collapsed ? t('app.expand') : t('app.collapse')"
              @click.stop="embedded.collapseView(view.id, !view.collapsed)"
            >
              <ChevronRight v-if="view.collapsed" :size="11" />
              <ChevronLeft v-else :size="11" class="down" />
            </button>
            <span
              class="view-dot"
              :style="{
                background: view.color ? `var(--role-${view.color})` : 'var(--accent)',
              }"
            ></span>
            <input
              v-if="renamingViewId === view.id"
              ref="renameInput"
              v-model="renameText"
              class="rename mono"
              @click.stop
              @keydown.enter.prevent="commitRename(view)"
              @keydown.esc.prevent="renamingViewId = null"
              @blur="commitRename(view)"
            />
            <template v-else>
              <span
                class="view-name"
                :title="t('app.browserRenameHint')"
                @dblclick.stop="startRename(view)"
                @contextmenu.prevent.stop="startRename(view)"
              >
                {{ view.name }}
              </span>
              <span class="view-count mono">
                {{ dockRows(view).length }}/{{ embedded.slots(view) }}
              </span>
            </template>
            <span class="grow"></span>
            <SelectField
              class="layout-field"
              compact
              :model-value="view.layoutId === '1x1' ? 'free' : view.layoutId"
              :options="layoutOptions"
              :aria-label="t('app.browserLayout')"
              @update:model-value="changeLayout(view, $event)"
            />
            <!--
              The view's own "+". It is a chooser rather than a one-click blank
              page: the container already says which system this is, so the only
              open question is which account — and a daily-profile page in a grid
              of accounts answers a question nobody asked.
            -->
            <OpenSiteButton
              compact
              :locked-site-id="embedded.viewSiteId(view.id)"
              @open-blank="openBlankInView(view)"
              @open-daily="openSiteInView(view, $event)"
              @open-clean="openSiteInView(view, $event, { clean: true })"
              @open-identity="openIdentityInView(view, $event)"
            />
            <button
              type="button"
              class="icon-btn"
              :title="t('app.browserCloseView')"
              :aria-label="t('app.browserCloseView')"
              @click.stop="closeView(view)"
            >
              <X :size="12" />
            </button>
          </header>

          <div v-if="!view.collapsed" class="rows">
            <div
              v-for="row in dockRows(view)"
              :key="`${row.root.id}-${row.slot ?? 'off'}`"
              class="instance"
            >
              <div
                class="tab-row"
                :class="[
                  rowDropClass(row.root),
                  {
                    offstage: view.id === embedded.state.activeViewId && !isOnStage(row.root),
                    focused: row.page.id === embedded.state.activeTabId,
                    dim: view.id !== embedded.state.activeViewId,
                  },
                ]"
                draggable="true"
                role="button"
                tabindex="0"
                :data-tab-id="row.page.id"
                @dragstart="onDragStart(row.root, $event)"
                @dragend="onDragEnd"
                @dragover.stop="onRowDragOver(row.root, $event)"
                @drop.stop="onDrop"
                @click="embedded.activate(row.page.id)"
                @keydown.enter="embedded.activate(row.page.id)"
              >
                <!-- The slot number comes from the row, not from the instance:
                     two cells of one split instance both need their own number,
                     and asking the instance would answer with the first one. -->
                <span v-if="embedded.slots(view) > 1" class="slot-no mono">{{ row.slot === undefined ? "·" : row.slot + 1 }}</span>
                <!-- Identity colour rides the icon's corner (same mark as the
                     collapsed strip): a 5px free-standing dot spent 11px of
                     every row pushing the icon right, and with same-coloured
                     identities it read as pure noise between the levels. -->
                <span class="tab-icon-wrap">
                  <!-- The row's page, not the instance root: a split cell shows
                       a different page, so its icon has to say which. -->
                  <TabIcon :src="row.page.favicon ?? faviconOf(row.root)" :size="12" />
                  <span
                    class="row-role"
                    :style="{ background: `var(--role-${row.root.color ?? 'amber'})` }"
                  ></span>
                </span>
                <!-- The full URL lives on the label rather than the row: the
                     badge at the row's end answers to its own drawn hint, and a
                     native title on an ancestor would pop up over it anyway. -->
                <span class="tab-label" :title="row.page.url">{{ embedded.titleOf(row.page) }}</span>
                <span class="tab-account">{{ accountOf(row.root) }}</span>
                <!-- How many AI operations this page has seen in this session.
                     Per page, because a row is a page: keying it by site made
                     two rows of one site show the same number. -->
                <span
                  v-if="aiCountOf(row.root)"
                  class="ai-badge mono"
                  @mouseenter="showAiTip(row.root)"
                  @mouseleave="hideAiTip"
                >
                  {{ aiCountOf(row.root) }}
                  <span v-if="aiTip === row.root.id" class="ai-tip" role="tooltip">
                    {{ t("app.aiActionCount") }}
                  </span>
                </span>
                <!-- A split row stands for one page of a two-cell instance, so the
                     "this window has N pages" badge would contradict the row. -->
                <span v-if="row.nested.length > 1" class="pages-badge mono">
                  {{ row.nested.length }}
                </span>
                <span v-if="row.page.loading" class="spinner"></span>
                <button
                  type="button"
                  class="row-close"
                  :aria-label="t('app.stop')"
                  @click.stop="closeInstance(row.root)"
                >
                  <X :size="10" />
                </button>
              </div>
              <!-- Pages opened by the page itself stay inside the instance. -->
              <div v-if="row.nested.length > 1" class="pages">
                <button
                  v-for="page in row.nested"
                  :key="page.id"
                  type="button"
                  class="page-row"
                  :class="{ current: page.id === row.page.id }"
                  :data-page-id="page.id"
                  :title="page.url"
                  @click="embedded.activate(page.id)"
                >
                  <!-- Same icon as the stage's own tab strip: the dock's page
                       list is where a test run is checked, so a page must be
                       identifiable by its site even before it reports a title. -->
                  <TabIcon :src="page.favicon" :size="PAGE_ICON_SIZE" />
                  <span class="page-title">{{ embedded.titleOf(page) }}</span>
                </button>
              </div>
            </div>
            <p v-if="dockRows(view).length === 0" class="row-empty">
              {{ t("app.browserNoTabs") }}
            </p>
          </div>
        </section>

        <!-- Loose instances: same row shape, no colour and no layout. -->
        <section
          class="view-block loose"
          :class="{ 'drop-into': dropHint?.kind === 'loose' }"
          @dragover="onLooseDragOver"
          @drop="onDrop"
        >
          <header class="block-head" @click="embedded.activateView(null)">
            <span class="chevron-spacer"></span>
            <span class="view-dot hollow"></span>
            <span class="view-name">{{ t("app.browserLooseTabs") }}</span>
            <span class="view-count mono">{{ embedded.looseInstances.length }}</span>
            <span class="grow"></span>
            <!--
              A layout for the flat list. Choosing one groups the loose instances
              into a view with that layout — the same thing dragging them together
              does — which is how the default tab group stops being the one place
              with no layout. "无布局" is the current state and is not offered
              again once a grid is chosen; pick another to switch.
            -->
            <SelectField
              v-if="embedded.looseInstances.length"
              class="layout-field"
              compact
              data-flat-layout
              :model-value="flatLayout"
              :options="layoutOptions"
              :aria-label="t('app.browserLayout')"
              @update:model-value="applyFlatLayout"
            />
            <span v-else class="layout-spacer"></span>
            <OpenSiteButton
              compact
              @open-blank="embedded.openLooseTab()"
              @open-daily="openSiteBookmark($event)"
              @open-clean="openSiteBookmark($event, { clean: true })"
              @open-identity="openIdentityBookmark"
            />
          </header>
          <div v-if="embedded.looseInstances.length" class="rows">
            <div
              v-for="root in embedded.looseInstances"
              :key="root.id"
              class="instance"
            >
              <div
                class="tab-row"
                :class="[rowDropClass(root), { focused: isFocused(root) }]"
                draggable="true"
                role="button"
                tabindex="0"
                :data-tab-id="activePageOf(root).id"
                @dragstart="onDragStart(root, $event)"
                @dragend="onDragEnd"
                @dragover.stop="onRowDragOver(root, $event)"
                @drop.stop="onDrop"
                @click="embedded.activate(activePageOf(root).id)"
                @keydown.enter="embedded.activate(activePageOf(root).id)"
              >
                <!-- The focused row's accent bar already says "this is what the
                     stage shows" in flat mode; a ▣/· column spent 16px per row
                     repeating it. -->
                <span class="tab-icon-wrap">
                  <TabIcon :src="faviconOf(root)" :size="12" />
                  <span
                    class="row-role"
                    :style="{ background: `var(--role-${root.color ?? 'amber'})` }"
                  ></span>
                </span>
                <span class="tab-label" :title="activePageOf(root).url">{{ titleOf(root) }}</span>
                <span class="tab-account">{{ accountOf(root) }}</span>
                <!-- How many AI operations this page has seen in this session.
                     Per page, because a row is a page: keying it by site made
                     two rows of one site show the same number. -->
                <span
                  v-if="aiCountOf(root)"
                  class="ai-badge mono"
                  @mouseenter="showAiTip(root)"
                  @mouseleave="hideAiTip"
                >
                  {{ aiCountOf(root) }}
                  <span v-if="aiTip === root.id" class="ai-tip" role="tooltip">
                    {{ t("app.aiActionCount") }}
                  </span>
                </span>
                <span v-if="pagesOf(root).length > 1" class="pages-badge mono">
                  {{ pagesOf(root).length }}
                </span>
                <span v-if="activePageOf(root).loading" class="spinner"></span>
                <button
                  type="button"
                  class="row-close"
                  :aria-label="t('app.stop')"
                  @click.stop="closeInstance(root)"
                >
                  <X :size="10" />
                </button>
              </div>
              <div v-if="pagesOf(root).length > 1" class="pages">
                <button
                  v-for="page in pagesOf(root)"
                  :key="page.id"
                  type="button"
                  class="page-row"
                  :class="{ current: page.id === activePageOf(root).id }"
                  :data-page-id="page.id"
                  :title="page.url"
                  @click="embedded.activate(page.id)"
                >
                  <!-- Same icon as the stage's own tab strip: the dock's page
                       list is where a test run is checked, so a page must be
                       identifiable by its site even before it reports a title. -->
                  <TabIcon :src="page.favicon" :size="PAGE_ICON_SIZE" />
                  <span class="page-title">{{ embedded.titleOf(page) }}</span>
                </button>
              </div>
            </div>
          </div>
          <p v-else class="row-empty">{{ t("app.browserNoTabs") }}</p>
        </section>

        <!-- External instances share the dock: same idea, different surface. -->
        <section v-if="workspace.instances.length" class="view-block external">
          <header class="block-head static">
            <span class="chevron-spacer"></span>
            <span class="view-dot hollow"></span>
            <span class="view-name">{{ t("app.running") }}</span>
            <span class="view-count mono">{{ workspace.instances.length }}</span>
            <span class="grow"></span>
          </header>
          <div class="rows">
            <div
              v-for="instance in workspace.instances"
              :key="instance.id"
              class="tab-row ext"
              role="button"
              tabindex="0"
              :title="t('app.switchTo')"
              @click="workspace.focusInstance(instance.id)"
              @keydown.enter="workspace.focusInstance(instance.id)"
            >
              <ExternalLink :size="10" class="ext-icon" />
              <span class="tab-label">{{ instance.label }}</span>
              <span class="ext-badge mono">{{ t("app.browserExternal") }}</span>
              <button
                type="button"
                class="row-close"
                :aria-label="t('app.stop')"
                @click.stop="workspace.stopInstance(instance.id)"
              >
                <X :size="10" />
              </button>
            </div>
          </div>
        </section>

        <p v-if="!totalRunning" class="dock-empty">{{ t("app.noRunningIdentity") }}</p>
        <p class="dock-hint">{{ t("app.browserDropHint") }}</p>
      </div>

      <footer v-if="workspace.instances.length" class="dock-foot">
        <button type="button" class="stop-all" @click="workspace.stopAll()">
          <Power :size="11" />
          {{ t("app.closeAll") }}
        </button>
      </footer>
    </div>
  </aside>
</template>

<style scoped>
.dock {
  position: relative;
  border-left: 1px solid var(--line-soft);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding: 12px 10px;
  gap: 10px;
  width: var(--dock-width);
  flex: 0 0 auto;
}

/* Animating width is fine here: the dock has no native child, only text rows. */
.dock:not(.resizing) {
  transition: width 0.18s ease;
}

.dock.resizing {
  user-select: none;
  cursor: col-resize;
}

.dock-main {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  flex: 1 1 auto;
  opacity: 1;
  transition:
    opacity 0.16s ease,
    visibility 0.16s;
}

/* The contents stay mounted and fade out while the width collapses, so the
   animation reads as one motion instead of the panel emptying first. Taken out
   of flow once hidden: the icon strip needs the full height, and the panel is
   invisible anyway. */
.dock-main.hidden {
  position: absolute;
  inset: 10px 4px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

/* Straddles the border from the inside: the dock clips its own overflow, so a
   handle hanging outside the panel would never be hit. */
.dock-resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}

.dock-resize::after {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background: transparent;
  transition: background 0.15s ease;
}

.dock-resize:hover::after,
.dock.resizing .dock-resize::after {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}

/* The collapsed strip still animates, so expanding and collapsing read as one
   motion instead of the panel popping in. */
.dock.collapsed {
  width: 46px;
  padding: 10px 4px;
  align-items: center;
}

.mini {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
}

/* Scrolls on its own so the expand control stays pinned at the top while many
   instances run: the way out of the strip must never scroll off. */
.mini-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Tight inside a group; the rule below adds the breathing room between them.
     Spacing alone is a weak signal, a rule alone is easy to miss at 1px — the
     pair is what makes the grouping readable in a 46px column. */
  gap: 3px;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;
}

.mini-list::-webkit-scrollbar {
  display: none;
}

/* Group boundary. A bare rule, square by construction: it is structure, not a
   surface, so it carries no radius and no fill of its own. Spans most of the
   strip so the break reads as a break — at 22px it looked like a smudge between
   two icons rather than a boundary. Tint comes from the view it opens. */
.mini-rule {
  flex: 0 0 auto;
  width: 26px;
  height: 1px;
  margin: 8px 0 7px;
  background: var(--line);
}

.mini-tab {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: var(--radius-sm);
  /* Recessed tile, the same language the instance tab strip uses: without a
     surface the fallback letter floats in the column and the strip reads as a
     list of stray characters rather than as a column of icons.
     Tinted from the text colour rather than from a surface step: `--surface-3`
     is a visible step in light but only barely in dark, where the strip sits on
     `--bg` and the two are within a few percent. Mixing toward `--text` moves
     away from the background in both themes, which is the property that matters
     here. */
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--text) 9%, var(--bg));
  color: var(--muted);
}

.mini-tab:hover {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--text-secondary);
}

/* Selected instance: accent tint and accent glyph, no outline. An outline around
   a rounded tile is a raised-button cue, and the collapsed strip is a column of
   flat targets. Derived from `--accent` rather than from a gray step, because a
   gray step means "raised" in one theme and "recessed" in the other. */
.mini-tab.current {
  background: color-mix(in srgb, var(--accent) 22%, var(--bg));
  color: var(--text);
}

/* An off-stage instance still runs; the muted icon says it is not what the
   stage is showing right now. The child component's root carries this scope
   id, so the selector reaches it without `:deep`. */
.mini-tab.offstage .tab-icon {
  opacity: 0.55;
}

/* Identity colour in the corner of the tile. Drawn whether or not the page has
   a favicon: with the letter fallback gone the corner is the only thing left
   saying which account the instance belongs to. */
.mini-role {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 9%, var(--bg));
}

/* Same tile as an instance, pinned at the top of the strip: the position the
   collapse control occupies when the panel is open, so expanding and collapsing
   are one control in one place rather than two ends of the window. */
.expand {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--text) 9%, var(--bg));
  color: var(--muted);
  cursor: pointer;
}

.expand:hover {
  background: color-mix(in srgb, var(--accent) 12%, var(--bg));
  color: var(--text);
}

.badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 9px;
  display: grid;
  place-items: center;
}

.dock-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}

.dock-title {
  font-size: 12px;
  font-weight: 500;
}

.count {
  font-size: 10.5px;
  color: var(--accent-foreground);
  background: var(--accent);
  border-radius: 999px;
  min-width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  flex: none;
}

.icon-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

/* The only way to create a view, so it gets a label instead of an icon shape
   that has to be learned. Filled, not outlined: on a dock of flat rows an
   outlined button is the one box left, and the accent fill is what makes this
   read as the action rather than as a chip. */
.add-view {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 0;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10.5px;
  white-space: nowrap;
  cursor: pointer;
  flex: none;
}

.add-view:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent-strong);
}

.collapse-btn {
  flex: none;
}

.scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
}

/*
 * A view block has no box of its own.
 *
 * The dock used to draw each group as a bordered, rounded container with a
 * filled header band and a rule under every row — three nested frames inside a
 * 244px column, which is the "card inside a card" look. What identifies a group
 * is its header text and the fact that its rows sit under it; the staging
 * colour already rides the row's own left edge.
 */
.view-block {
  border: 0;
  border-radius: 0;
  overflow: visible;
  flex: none;
  /* Rows draw their own leading rule; the block only supplies the gap. */
  padding-bottom: 2px;
}

/* Active is a filled header, not an outline: a 1px accent border around the
   whole group drew a box around rows that are not themselves selected. */
.view-block.active > .block-head {
  color: var(--text);
}

.view-block.active > .block-head .view-name {
  color: var(--text);
}

.view-block.active > .block-head .view-dot {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}

.view-block.drop-into {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}

/*
 * Every block header uses the same columns in the same order, so the layout
 * picker, "+" and "×" land on the same pixel in every group. Spacers keep the
 * loose block — which has no layout picker and no close button — aligned.
 *
 * A plain band, not a filled bar: the header is a label for the rows below it,
 * and filling it made each group look like a window title inside the dock.
 */
.block-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  min-width: 0;
}

.block-head.static {
  cursor: default;
}

.block-head:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}

.chevron {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: none;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  flex: none;
}

.chevron-spacer {
  width: 14px;
  flex: none;
}

.chevron .down {
  transform: rotate(-90deg);
}

.view-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
}

.view-dot.hollow {
  border: 1px solid var(--faint);
  background: transparent;
}

.view-name {
  font-size: 11.5px;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rename {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--text);
  padding: 1px 4px;
  outline: none;
}

/* Counts sit next to the name they belong to; pushing them to the right made
   a single number look centred in empty space. */
.view-count {
  font-size: 9.5px;
  color: var(--faint);
  flex: none;
}

.grow {
  flex: 1;
  min-width: 4px;
}

/* Layout names are short and fixed-width (2 × 2), so the trigger hugs them. */
.layout-field {
  width: auto;
  min-width: 52px;
  max-width: 76px;
  flex: none;
}

.layout-spacer {
  width: 52px;
  flex: none;
}

.rows {
  display: flex;
  flex-direction: column;
}

.instance {
  min-width: 0;
}

.tab-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px 5px 5px;
  min-width: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.tab-row:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

/* The selected row is a filled surface. Its left edge used to carry a 2px accent
   bar, which on a rounded row is a straight line running into two rounded
   corners — an ornament, not structure. The fill says the same thing, and the
   row keeps the accent through its text colour instead. */
.tab-row.focused {
  background: color-mix(in srgb, var(--accent) 11%, transparent);
}

.tab-row.focused .tab-label {
  color: var(--text);
}

.tab-row.dim {
  opacity: 0.58;
}

.tab-row.offstage {
  opacity: 0.5;
}

.tab-row.offstage .tab-label {
  font-style: italic;
}

.tab-row.drop-before::before,
.tab-row.drop-after::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: var(--accent);
  border-radius: 1px;
}

.tab-row.drop-before::before {
  top: -1px;
}

.tab-row.drop-after::after {
  bottom: -1px;
}

.tab-row.drop-middle {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 50%, transparent);
}

.slot-no {
  width: 16px;
  flex: 0 0 16px;
  text-align: center;
  font-size: 9.5px;
  color: var(--faint);
}

/* The identity colour rides the favicon's corner — the same mark the collapsed
   strip paints on its tiles — instead of a free-standing dot that pushed every
   root row 11px deeper than its children. Drawn always: with a placeholder
   icon the corner is the only thing saying which account the row belongs to. */
.tab-icon-wrap {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
}

.row-role {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 9%, var(--bg));
}

.tab-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--text-secondary);
}

/* Second line's worth of information in one row: the page title leads, the
   account follows in a quieter tone. The page title is what changes, the
   account is what identifies the row, so the title keeps the flexible width. */
.tab-account {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--faint);
}

.pages-badge {
  flex: none;
  font-size: 8.5px;
  color: var(--faint);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 3px;
}

/* Distinct from the page count: this one is about the AI, and it is the only
   place in the dock that reports what the AI did. */
.ai-badge {
  flex: none;
  position: relative;
  font-size: 8.5px;
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--line) 55%, var(--accent));
  border-radius: 3px;
  padding: 0 3px;
  cursor: help;
}

/*
 * Tooltip for the AI action count.
 *
 * Drawn, not a native `title`: native hints cannot be styled and paint as
 * browser chrome over the app. It has to stay inside the dock — the panel clips
 * its overflow, and the pages on the stage are native views that always paint
 * over app HTML — so it opens leftwards from the badge, which is the one
 * direction with room to spare at the end of a row.
 */
.ai-tip {
  position: absolute;
  right: calc(100% + 6px);
  top: 50%;
  transform: translateY(-50%);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text-secondary);
  /* The badge is mono because it holds a number; this sentence is not, and the
     mono stack would fall back to a serif for the Chinese characters. */
  font-family: var(--font-sans);
  font-size: 11px;
  line-height: 1.35;
  white-space: nowrap;
  box-shadow: var(--shadow-menu);
  pointer-events: none;
  z-index: 60;
}

.row-close {
  width: 17px;
  height: 17px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  flex: none;
  opacity: 0;
}

.tab-row:hover .row-close {
  opacity: 1;
}

.row-close:hover {
  color: var(--red);
  background: var(--surface-3);
}

/* Pages of one instance: indented under its row, like nested browser tabs.
   The indent must clear the parent row's icon (5px padding + 12px icon + 6px
   gap = 23px; +22px more when the slot-number column is shown in a grid), or
   the levels visually invert and children read as siblings. */
.pages {
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line-soft);
  margin-left: 23px;
}

.view-block.gridded .pages {
  margin-left: 45px;
}

.page-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: var(--faint);
  font-size: 10.5px;
  text-align: left;
  cursor: pointer;
}

.page-row:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.page-row.current {
  color: var(--text-secondary);
}

.page-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-empty {
  margin: 0;
  padding: 8px 9px;
  font-size: 10.5px;
  color: var(--faint);
}

.spinner {
  width: 8px;
  height: 8px;
  border: 1.5px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex: none;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.ext-icon {
  color: var(--faint);
  flex: none;
}

.ext-badge {
  font-size: 8.5px;
  letter-spacing: 0.06em;
  color: var(--faint);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 3px;
  flex: none;
}

/* Plain text, no dashed box: nothing is missing here, the panel is simply empty
   until a page is opened. A dotted outline around a sentence is what an empty
   *table* looks like, and it made the whole dock look unfinished. */
.dock-empty {
  margin: 2px 2px;
  padding: 14px 10px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--faint);
  text-align: center;
}

.dock-hint {
  margin: 0;
  padding: 0 4px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--faint);
}

.dock-foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--line-soft);
  padding-top: 8px;
}

.stop-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--faint);
  font-size: 10.5px;
  padding: 4px 8px;
  cursor: pointer;
}

.stop-all:hover {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 45%, var(--line));
}
</style>
