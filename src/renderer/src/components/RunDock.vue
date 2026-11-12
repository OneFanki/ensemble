<script setup lang="ts">
import type { EmbeddedDropTarget, EmbeddedTab, EmbeddedView } from "@shared/embedded";
import { EMBEDDED_LAYOUTS } from "@shared/embedded";
import type { LayoutId, RoleColor } from "@shared/types";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Layers,
  PanelLeftClose,
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
 * Which platform the strip is drawn for.
 *
 * The caption band moved to `AppSidebar.vue` with the column — the sidebar now
 * owns the corner that touches the window controls, and this only needs the
 * platform for a couple of row rules.
 */
const platform = computed(() => workspace.snapshot?.platform ?? "win32");

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
 * A row is a *cell* when the instance is split and an *instance* when it is not.
 * Either way it stands for one browser window, never for one of its pages: this
 * list answers "what is running", and a window's internal pages are a property of
 * that window, shown in the stage's own tab strip. Listing them again under the
 * row said the same thing twice, and a split repeated a page underneath itself.
 */
interface DockRow {
  root: EmbeddedTab;
  /** Page this row stands for: the pinned page in a split, else the active one. */
  page: EmbeddedTab;
  /** Zero-based slot this row occupies; absent when the instance is off stage. */
  slot?: number;
  /**
   * Pages open in the instance, as a count.
   *
   * Only the number: it answers "does this window hold more than the page I am
   * looking at", which the stage's strip then answers in detail. The pages are
   * deliberately not carried — nothing in the dock draws them any more.
   */
  pageCount: number;
}

/**
 * Rows for one view block, in the workspace's own list order.
 *
 * Order comes from the tab list, not from the slot array.
 *
 * Deriving it from `slotTabs` looked equivalent and was not: clicking an
 * off-stage instance swaps it into the focused cell, so the list re-sorted itself
 * on every selection and the row you just clicked jumped to the first line. The
 * list is a list — its order should only change when the user drags something —
 * and which cell an instance occupies is a separate fact, shown as the number.
 */
function dockRows(view: EmbeddedView): DockRow[] {
  const rows: DockRow[] = [];
  // A split instance appears once per cell it occupies; count first so a single
  // row can be drawn per instance in the common case.
  const slotCounts = new Map<string, number>();
  for (const rootId of view.slotTabs) {
    const root = rootId ? embedded.state.tabs.find((tab) => tab.id === rootId) : undefined;
    if (!root) continue;
    slotCounts.set(root.instanceId, (slotCounts.get(root.instanceId) ?? 0) + 1);
  }

  for (const root of embedded.viewInstances(view.id)) {
    const pages = pagesOf(root);
    const slotCount = slotCounts.get(root.instanceId) ?? 0;
    if (slotCount > 1) {
      // A split instance fills several cells, so it has several rows — one per
      // cell, because each cell can show a different page of it.
      view.slotTabs.forEach((rootId, index) => {
        if (rootId !== root.id) return;
        const pinnedId = view.slotPages?.[index] ?? null;
        const pinned = pinnedId ? pages.find((page) => page.id === pinnedId) : undefined;
        rows.push({
          root,
          page: pinned ?? activePageOf(root),
          slot: index,
          pageCount: pages.length,
        });
      });
      continue;
    }
    rows.push({
      root,
      page: activePageOf(root),
      ...(slotCount === 1 ? { slot: view.slotTabs.indexOf(root.id) } : {}),
      pageCount: pages.length,
    });
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
 * panel clips its own overflow and each view block clips too — so the hint has
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

/** Group boundary tinted by the group it opens, so colour carries the grouping. */
function groupRuleStyle(color: RoleColor | undefined): Record<string, string> {
  if (!color) return {};
  return { background: `color-mix(in srgb, var(--role-${color}) 45%, var(--line))` };
}

/**
 * Hover label for an icon-only strip.
 *
 * Drawn by `v-tooltip` and not by the OS: the strip's controls are the only way
 * to tell one instance from another, so their labels have to appear at the app's
 * own scale and light up immediately. `placement: "top"` keeps the label inside
 * the dock column instead of hanging past the window's right edge.
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

async function openBlankInView(
  view: EmbeddedView,
  options?: { clean?: boolean },
): Promise<void> {
  await embedded.openTabInto(view.id, options);
}
</script>

<template>
  <!--
    Collapsed, the dock keeps a column of site icons — one per running instance,
    the way a vertical tab strip does. Collapsing should reclaim width, not hide
    the fact that several pages are running: clicking an icon switches to that
    instance, and the last button reopens the panel.

    No width and no caption band of its own any more: this is the top half of
    `AppSidebar.vue`, which owns the column's width, its resize handle and the
    drag band. The dock used to be the whole right-hand column; the sidebar's
    navigation now sits under it, so the two have to share one box.
  -->
  <div
    class="dock"
    :class="{ collapsed, resizing }"
    :data-platform="platform"
  >
    <!--
      The expand control sits where the collapse control sits in the expanded
      panel — top right. A control that jumps from the bottom of the strip to the
      top of the panel makes the same action feel like two different actions.
    -->
    <div v-show="collapsed" class="mini">
      <button
        type="button"
        class="expand"
        v-tooltip="t('app.browserExpandDock')"
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
            v-tooltip="{ text: miniLabel(root), placement: 'top' }"
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
      <!--
        The header doubles as the window's drag band.

        The sidebar used to reserve a blank 34px strip above this row for the
        native caption buttons — which are painted on the right, so the strip
        reserved nothing and just pushed this row down a full title bar. Now the
        header takes that height itself: it starts at the window's top edge,
        lines up with the tab strip beside it, and is the one row in the column
        with nothing clickable to lose, so it is where the window is dragged.
        Every control inside it is `no-drag`.
      -->
      <header class="dock-head drag-region">
        <span class="dock-title">{{ t("app.browserExpandedDock") }}</span>
        <span class="count mono">{{ totalRunning }}</span>
        <button
          type="button"
          class="add-view no-drag"
          v-tooltip="t('app.browserNewViewHint')"
          @click="newView"
        >
          <Plus :size="12" />
          <span>{{ t("app.browserNewView") }}</span>
        </button>
        <button
          type="button"
          class="icon-btn collapse-btn no-drag"
          v-tooltip="t('app.browserCollapseDock')"
          :aria-label="t('app.browserCollapseDock')"
          @click="toggleCollapsed"
        >
          <PanelLeftClose :size="13" />
        </button>
      </header>

      <div class="scroll">
        <!-- Views: block level, coloured, collapsible; instances are rows. -->
        <section
          v-for="view in embedded.views"
          :key="view.id"
          class="view-block"
          :class="[
            viewDropClass(view.id),
            {
              active: view.id === embedded.state.activeViewId,
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
              v-tooltip="view.collapsed ? t('app.expand') : t('app.collapse')"
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
                v-tooltip="t('app.browserRenameHint')"
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
              @open-blank-clean="openBlankInView(view, { clean: true })"
              @open-daily="openSiteInView(view, $event)"
              @open-clean="openSiteInView(view, $event, { clean: true })"
              @open-identity="openIdentityInView(view, $event)"
            />
            <button
              type="button"
              class="icon-btn"
              v-tooltip="t('app.browserCloseView')"
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
                <!-- The page count, not the pages: the stage's own strip lists
                     them, and repeating that list here is what the dock stopped
                     doing. -->
                <span v-if="row.pageCount > 1" class="pages-badge mono">
                  {{ row.pageCount }}
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
              @open-blank-clean="embedded.openCleanLooseTab()"
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
              v-tooltip="t('app.switchTo')"
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
      </div>

      <footer v-if="workspace.instances.length" class="dock-foot">
        <button type="button" class="stop-all" @click="workspace.stopAll()">
          <Power :size="11" />
          {{ t("app.closeAll") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/*
 * The dock fills the top half of the sidebar.
 *
 * It used to *be* the sidebar: a fixed-width right-hand column with its own
 * border, its own caption-button band and its own resize handle. All three moved
 * to `AppSidebar.vue` when the navigation took the bottom half — a child that
 * kept them would draw a second border inside the sidebar's border and reserve
 * the window controls it no longer touches. The background stays, because the
 * group rules and header bands below are mixed from `--text` and are measured
 * against this surface.
 */
.dock {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  /* No top padding: the header below is the window's top row now. */
  padding: 0 2px 2px;
  gap: 10px;
  flex: 1 1 auto;
  width: 100%;
  background: var(--bg);
}

/* The sidebar animates its own width; the dock only carries the resizing state
   so its rows can drop hover styling while a drag is in flight. */
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
    opacity var(--motion-base) var(--ease-out),
    visibility var(--motion-base);
}

/* The contents stay mounted and fade out while the width collapses, so the
   animation reads as one motion instead of the panel emptying first. Taken out
   of flow once hidden: the icon strip needs the full height, and the panel is
   invisible anyway. */
.dock-main.hidden {
  position: absolute;
  inset: 2px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

/* The collapsed strip still animates, so expanding and collapsing read as one
   motion instead of the panel popping in. */
.dock.collapsed {
  padding: 0;
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
  background: var(--selected);
  color: var(--text-secondary);
}

/* Selected instance: a neutral raised step, no outline, no accent. An outline
   around a rounded tile is a raised-button cue, and the collapsed strip is a
   column of flat targets. The accent is deliberately not used here: amber reads
   as "warning" or "switched on", while this only means "this is the page the
   stage shows". */
.mini-tab.current {
  background: var(--selected-strong);
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
   are one control in one place rather than two ends of the window.
   It borrows the title bar's height, not the 32px of a row below it: this tile
   sits exactly where the header sits when the panel is open, so the collapsed
   column starts on the same line as the tab strip beside it. */
.expand {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: var(--titlebar-height);
  flex: 0 0 auto;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--text) 9%, var(--bg));
  color: var(--muted);
  cursor: pointer;
}

.expand:hover {
  background: var(--selected);
  color: var(--text);
}

/*
 * Sits inside the button's top-right corner, over the icon. Hanging it outside
 * (`top: -4px`) put it past the dock's top edge — the collapsed strip starts on
 * the window's top row on purpose (aligned with the tab strip beside it), so
 * the dock will not find room for an overhanging badge and `overflow: hidden`
 * clipped it in half.
 */
.badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-foreground);
  font-size: 9px;
  display: grid;
  place-items: center;
  box-shadow: 0 0 0 1px var(--bg);
}

.dock-head {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  /* The window's title bar height, because that is what this row is: the drag
     band the sidebar used to reserve above itself. Matching the tab strip
     beside it is what makes the two columns start on the same line. */
  height: var(--titlebar-height);
  padding: 0 6px;
  box-sizing: border-box;
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
/* Neutral surface, and the accent is spent on the glyph instead of the label.
 *
 * This was a gold-tinted chip with deep-gold text (#7a4e05). Text has to be dark
 * enough to read, and dark gold is exactly the shade that reads as dirty rather
 * than as gold — the chip looked like a stain on the frame. The label now uses
 * the normal secondary text colour, which is legible by construction, and the
 * only gold left is the plus sign: a mark, at the size where gold works. */
.add-view {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--chrome);
  color: var(--text-secondary);
  font-size: 10.5px;
  white-space: nowrap;
  cursor: pointer;
  flex: none;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.add-view :deep(svg) {
  color: var(--accent);
}

.add-view:hover {
  background: var(--field);
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  color: var(--text);
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
 *
 * Removing the boxes went too far the other way: with nothing but an 8px gap
 * between them, two groups of rows read as one long list, and the header of the
 * lower group looked like another row. What separates them now is structure —
 * a hairline between blocks, and a guide the rows hang from — rather than a
 * surface. A rule can say "new group" without turning the dock into cards.
 */
.view-block {
  border: 0;
  border-radius: 0;
  overflow: visible;
  flex: none;
  /* Rows draw their own leading rule; the block only supplies the gap. */
  padding-bottom: 2px;
}

/* The boundary between groups.
 *
 * Two things went wrong before this. First the rule was `--line-soft`, which is
 * a step *lighter* than the dock's `--bg` in the light theme (#eceff3 over
 * #dee2e7) — a border in a lighter colour than its own background draws nothing.
 * Every token in that family (`--line`, `--line-soft`) is tuned for white
 * surfaces, and the dock is not one. Second, even a visible hairline is a weak
 * signal at 0.67px. So the rule is mixed from `--text`, which moves away from the
 * background in both themes, and it is reinforced with real space above it. */
.view-block + .view-block {
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--text) 16%, transparent);
}

/* Active is a filled header, not an outline: a 1px accent border around the
   whole group drew a box around rows that are not themselves selected. */
.view-block.active > .block-head {
  color: var(--text);
}

.view-block.active > .block-head .view-name {
  color: var(--text);
}

/* Active blocks mark themselves through the selected row inside them. The dot
   used to get an amber halo, which put a second, competing "selected" marker on
   the header while the row already said it. */
.view-block.active > .block-head .view-dot {
  box-shadow: none;
}

.view-block.drop-into {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}

/*
 * Every block header uses the same columns in the same order, so the layout
 * picker, "+" and "×" land on the same pixel in every group. Spacers keep the
 * loose block — which has no layout picker and no close button — aligned.
 *
 * A faint filled band, not a bare label: the dock's rows are 28px tall and a
 * 24px caption of the same weight reads as one more row, which is exactly how
 * two groups turned into one list. The band is a caption surface — it names what
 * is below it and never looks like something you can select into.
 */
.block-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  margin-bottom: 3px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--text) 6%, transparent);
  cursor: pointer;
  min-width: 0;
}

.block-head.static {
  cursor: default;
}

/* One step brighter than the resting band, so the header responds to the
   pointer without a second kind of surface appearing. */
.block-head:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
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

/* The selected row is a neutral filled surface. Its left edge used to carry a
   2px accent bar, which on a rounded row is a straight line running into two
   rounded corners — an ornament, not structure, and amber read as an alert. The
   fill says "this is the page on stage" without borrowing the accent. */
.tab-row.focused {
  background: var(--selected);
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

.tab-icon-wrap {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
}

/* The identity colour rides the favicon's corner — the same mark the collapsed
   strip paints on its tiles — instead of a free-standing dot that pushed every
   root row 11px deeper than its children. Drawn always: with a placeholder
   icon the corner is the only thing saying which account the row belongs to.
 *
 * Six pixels, not four, and ringed in the row's own background.
 *
 * At 4px with a grey ring the mark did not read as "this row's account"; it read
 * as a smudge stuck to the icon's lower-left corner — a couple of users took it
 * for a rendering misalignment rather than a colour. The mark needs enough area
 * to show its hue, and the ring has to be the surface colour so it punches the
 * icon out underneath it instead of blending with it. */
.row-role {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px var(--chrome);
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
  color: var(--accent-text);
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
 * its overflow — so it opens leftwards from the badge, which is the one
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

/* Pages of one instance are not listed here — the dock is a list of windows, and
   a window's pages belong to the stage's own tab strip. Only the count remains,
   as a badge on the row. */

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
  border-top-color: var(--accent-text);
  border-radius: 50%;
  animation: spin var(--motion-slow) linear infinite;
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
