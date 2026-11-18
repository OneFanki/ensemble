<script setup lang="ts">
/**
 * The instance rail: the window's first row.
 *
 * One entry per running browser instance — the account it belongs to, the site
 * it is on, the AI state dot, and its own close button. Clicking an entry puts
 * that instance on the stage; every other instance keeps running in the
 * background (its logins stay alive and the MCP tools keep driving it — only
 * the pixels wait), which is the single-stage model of ADR 0012.
 *
 * The row ends with [+ 启动] (pick several accounts, launch them all: the first
 * takes the stage, the rest sit in the list) and, at the far right, [管理] —
 * the standing entrance to the management pane.
 *
 * Overflow folds rather than scrolls away: entries that do not fit collapse
 * into a "+N" button whose menu lists them, so an entry is never reachable by
 * scrolling alone.
 */
import { onClickOutside } from "@vueuse/core";
import type { EmbeddedTab } from "@shared/embedded";
import { aiDotState, lastActionAtByTab } from "@shared/ai-dot";
import type { RoleColor } from "@shared/types";
import {
  ChevronDown,
  ExternalLink,
  LayoutGrid,
  Plus,
  X,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import TabIcon from "./TabIcon.vue";

/** Width reserved for the "+N" fold button while measuring, so fitting and
    rendering agree about the space the row needs. */
const FOLD_RESERVED_PX = 52;

const workspace = useWorkspaceStore();
const embedded = useEmbeddedStore();
const { t } = useI18n();

const platform = computed(() => workspace.snapshot?.platform ?? "win32");

/**
 * One rail entry: a browser instance, never a page.
 *
 * Pages an instance opened (`target="_blank"`, OAuth popups) belong to the same
 * entry; the second row lists the focused instance's pages. The AI dot state is
 * resolved here rather than in the template, so the mapping (shared/ai-dot) is
 * the only place that decides it.
 */
interface RailItem {
  /** Root page id; also the stable key. */
  id: string;
  instanceId: string;
  /** Page the stage would show when this entry is clicked. */
  pageId: string;
  account: string;
  color: RoleColor;
  favicon?: string;
  onStage: boolean;
  /** AI state of this instance: breathing / steady / no dot. */
  dot: "active" | "recent" | "idle";
  /** Text of the dot's hover hint; absent when there is no dot to explain. */
  dotTip?: string;
  /** External (system-browser) instance: clicking focuses that window. */
  external?: boolean;
}

/** The page of an instance the stage would show: its active one. */
function activePageOf(root: EmbeddedTab): EmbeddedTab {
  const pages = embedded.instancePages(root.instanceId);
  return pages.find((page) => page.active) ?? root;
}

function accountOf(root: EmbeddedTab): string {
  const identity = workspace.identities.find((item) => item.id === root.identityId);
  if (identity) return identity.name;
  return root.clean ? t("app.cleanSession") : t("app.dailyProfile");
}

/**
 * AI state for one instance: the newest activity across its pages.
 *
 * The log is keyed by tab; an instance is the set of its pages, so the dot
 * answers for the instance, not for whichever page is on stage.
 */
const aiLastActionByTab = computed(() => lastActionAtByTab(workspace.aiActivity));

/** Drives the active→recent transition without waiting for a state push. */
const now = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 5_000);
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});

function lastActionOf(root: EmbeddedTab): number | undefined {
  let latest: number | undefined;
  for (const page of embedded.instancePages(root.instanceId)) {
    const at = aiLastActionByTab.value.get(page.id);
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

function dotOf(root: EmbeddedTab): { dot: "active" | "recent" | "idle"; tip?: string } {
  const at = lastActionOf(root);
  const state = aiDotState(at, now.value);
  if (state === "idle" || at === undefined) return { dot: "idle" };
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return { dot: state };
  const sameDay = new Date().toDateString() === date.toDateString();
  const time = sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
  return { dot: state, tip: t("app.aiDotLastAction", { time }) };
}

/** Built-in instances, in tab order (the order they were launched in). */
const embeddedItems = computed<RailItem[]>(() => {
  const seen = new Set<string>();
  const items: RailItem[] = [];
  for (const tab of embedded.tabs) {
    if (seen.has(tab.instanceId)) continue;
    seen.add(tab.instanceId);
    const root = embedded.instanceRoot(tab);
    if (!root) continue;
    const page = activePageOf(root);
    const resolved = dotOf(root);
    items.push({
      id: root.id,
      instanceId: root.instanceId,
      pageId: page.id,
      account: accountOf(root),
      color: root.color ?? "amber",
      ...(page.favicon ? { favicon: page.favicon } : {}),
      onStage: embedded.isOnStage(page),
      dot: resolved.dot,
      ...(resolved.tip ? { dotTip: resolved.tip } : {}),
    });
  }
  return items;
});

/** External instances join the rail: same idea, different surface. */
const externalItems = computed<RailItem[]>(() =>
  workspace.instances.map((instance) => ({
    id: instance.id,
    instanceId: instance.id,
    pageId: instance.id,
    account: instance.label,
    color: "amber" as RoleColor,
    onStage: false,
    dot: "idle" as const,
    external: true,
  })),
);

const items = computed<RailItem[]>(() => [...embeddedItems.value, ...externalItems.value]);

/** Entries hidden behind the fold; clicking the fold menu puts one on stage. */
const overflowItems = ref<RailItem[]>([]);
const visibleCount = ref<number | null>(null);

const railBox = ref<HTMLElement | null>(null);
const chipRow = ref<HTMLElement | null>(null);

/**
 * Folds the row by measurement, not by estimate.
 *
 * Every entry is laid out, then the ones past the row's width collapse into
 * "+N". The measurement runs when the entries or the window change, and the
 * fold button's width is reserved up front so a growing list cannot oscillate.
 */
function measure(): void {
  const row = chipRow.value;
  const box = railBox.value;
  if (!row || !box) return;
  const available = box.clientWidth - FOLD_RESERVED_PX;
  const children = Array.from(row.children) as HTMLElement[];
  let fit = children.length;
  let used = 0;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (!child) break;
    if (index > 0) used += 2; // the row's own gap
    used += child.offsetWidth;
    if (used > available) {
      fit = index;
      break;
    }
  }
  visibleCount.value = fit >= items.value.length ? null : Math.max(0, fit);
}

watch(
  () => [items.value, railBox.value?.clientWidth] as const,
  () => {
    void nextTick(measure);
  },
);

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  if (railBox.value && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(railBox.value);
  }
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const visibleItems = computed<RailItem[]>(() =>
  visibleCount.value === null ? items.value : items.value.slice(0, visibleCount.value),
);

/* Everything not visible folds into the "+N" menu; one watcher owns the split. */
watch([items, visibleItems], ([all, visible]) => {
  const shown = new Set(visible.map((item) => item.id));
  overflowItems.value = all.filter((item) => !shown.has(item.id));
});

function activate(item: RailItem): void {
  if (item.external) {
    void workspace.focusInstance(item.instanceId);
    return;
  }
  void embedded.activate(item.pageId);
}

/** Closes an embedded instance and every page it opened. */
async function closeItem(item: RailItem): Promise<void> {
  if (item.external) {
    await workspace.stopInstance(item.instanceId);
    return;
  }
  for (const page of embedded.instancePages(item.instanceId)) {
    await embedded.closeTab(page.id);
  }
}

/* ------------------------------------------------------------------ */
/* + 启动: pick accounts, launch them all.                            */
/* ------------------------------------------------------------------ */

const launchOpen = ref(false);
const launchRoot = ref<HTMLElement | null>(null);
const launchPanel = ref<HTMLElement | null>(null);
const launchPicked = ref<string[]>([]);

onClickOutside(launchRoot, (event) => {
  const target = event.target as Node | null;
  if (target && launchPanel.value?.contains(target)) return;
  launchOpen.value = false;
});

function onLaunchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") launchOpen.value = false;
}

watch(launchOpen, (open) => {
  if (open) {
    launchPicked.value = [];
    document.addEventListener("keydown", onLaunchKeydown);
    void nextTick(() => launchPanel.value?.querySelector<HTMLElement>("input")?.focus());
  } else {
    document.removeEventListener("keydown", onLaunchKeydown);
  }
});

/** Accounts already running cannot be launched again: the entry says so. */
const launchChoices = computed(() => {
  const running = new Set(embeddedItems.value.map((item) => item.instanceId));
  return workspace.identities.map((identity) => {
    const pages = embedded.tabs.filter((tab) => tab.identityId === identity.id);
    const instanceRunning = pages.some((tab) => running.has(tab.instanceId));
    return { identity, running: instanceRunning };
  });
});

const pickedCount = computed(() => launchPicked.value.length);

function togglePicked(identityId: string): void {
  const index = launchPicked.value.indexOf(identityId);
  if (index >= 0) launchPicked.value.splice(index, 1);
  else launchPicked.value.push(identityId);
}

const launching = ref(false);

async function launchPickedIdentities(): Promise<void> {
  if (!launchPicked.value.length || launching.value) return;
  launching.value = true;
  try {
    await embedded.openIdentitiesInNewView(launchPicked.value.slice());
  } finally {
    launching.value = false;
    launchOpen.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* 管理: the standing entrance to the management pane.                */
/* ------------------------------------------------------------------ */

const emit = defineEmits<{
  /** Open the management pane; the shell owns it and its sections. */
  manage: [];
}>();

/* ------------------------------------------------------------------ */
/* The fold's menu: the entries the row could not fit.                */
/* ------------------------------------------------------------------ */

const foldOpen = ref(false);
const foldRoot = ref<HTMLElement | null>(null);
const foldPanel = ref<HTMLElement | null>(null);

onClickOutside(foldRoot, (event) => {
  const target = event.target as Node | null;
  if (target && foldPanel.value?.contains(target)) return;
  foldOpen.value = false;
});

function onFoldKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") foldOpen.value = false;
}

watch(foldOpen, (open) => {
  if (open) {
    document.addEventListener("keydown", onFoldKeydown);
    void nextTick(() => {
      foldPanel.value?.querySelector<HTMLElement>("button")?.focus();
    });
  } else {
    document.removeEventListener("keydown", onFoldKeydown);
  }
});

function activateFromFold(item: RailItem): void {
  foldOpen.value = false;
  activate(item);
}
</script>

<template>
  <div class="rail drag-region" :data-platform="platform">
    <div ref="railBox" class="rail-box no-drag">
      <div ref="chipRow" class="rail-chips" role="tablist" :aria-label="t('app.railLabel')">
        <button
          v-for="item in visibleItems"
          :key="item.id"
          type="button"
          role="tab"
          class="rail-chip"
          :class="{ 'on-stage': item.onStage }"
          :aria-selected="item.onStage"
          :data-instance-chip="item.instanceId"
          :data-on-stage="item.onStage ? '1' : '0'"
          v-tooltip="item.account"
          @click="activate(item)"
        >
          <span
            v-if="!item.external"
            class="chip-avatar"
            :style="{ background: `var(--role-${item.color})` }"
            aria-hidden="true"
          ></span>
          <ExternalLink v-else :size="12" class="chip-ext" aria-hidden="true" />
          <span class="chip-account">{{ item.account }}</span>
          <TabIcon v-if="item.favicon" :src="item.favicon" :size="12" class="chip-site" />
          <!-- AI 状态点：呼吸 = 正在操作，常亮 = 30 分钟内动过，无标 = 其它。 -->
          <span
            v-if="!item.external && item.dot !== 'idle'"
            class="ai-dot"
            :class="item.dot"
            :data-ai-dot="item.dot"
            v-tooltip="item.dotTip"
          ></span>
          <span
            class="chip-close"
            role="button"
            tabindex="0"
            :aria-label="t('app.stop')"
            :data-close-instance="item.instanceId"
            @click.stop="closeItem(item)"
            @keydown.enter.stop="closeItem(item)"
            @keydown.space.prevent.stop="closeItem(item)"
          >
            <X :size="11" />
          </span>
        </button>
      </div>

      <div v-if="overflowItems.length" ref="foldRoot" class="rail-fold">
        <button
          type="button"
          class="fold-btn"
          :aria-label="t('app.railFoldMore', { count: overflowItems.length })"
          :aria-expanded="foldOpen"
          data-rail-fold
          @click="foldOpen = !foldOpen"
        >
          +{{ overflowItems.length }}
          <ChevronDown :size="11" />
        </button>
        <div v-if="foldOpen" ref="foldPanel" class="fold-menu" role="menu">
          <button
            v-for="item in overflowItems"
            :key="item.id"
            type="button"
            role="menuitem"
            class="fold-item"
            :data-fold-item="item.instanceId"
            @click="activateFromFold(item)"
          >
            <span
              v-if="!item.external"
              class="chip-avatar"
              :style="{ background: `var(--role-${item.color})` }"
              aria-hidden="true"
            ></span>
            <ExternalLink v-else :size="12" class="chip-ext" aria-hidden="true" />
            <span class="chip-account">{{ item.account }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- [+ 启动]: multi-pick accounts; the first takes the stage. -->
    <div ref="launchRoot" class="rail-launch">
      <button
        type="button"
        class="rail-btn"
        :aria-label="t('app.railLaunch')"
        :aria-expanded="launchOpen"
        :aria-haspopup="true"
        data-launch-btn
        v-tooltip="t('app.railLaunch')"
        @click="launchOpen = !launchOpen"
      >
        <Plus :size="13" />
        <span>{{ t("app.railLaunch") }}</span>
      </button>
      <div v-if="launchOpen" ref="launchPanel" class="rail-panel" data-launch-panel>
        <p v-if="!launchChoices.length" class="panel-empty">{{ t("app.noIdentitiesYet") }}</p>
        <template v-else>
          <div class="panel-list" role="group" :aria-label="t('app.railLaunchPick')">
            <label
              v-for="choice in launchChoices"
              :key="choice.identity.id"
              class="launch-row"
              :class="{ running: choice.running }"
              :data-launch-row="choice.identity.id"
            >
              <input
                type="checkbox"
                :checked="launchPicked.includes(choice.identity.id)"
                :disabled="choice.running"
                @change="togglePicked(choice.identity.id)"
              />
              <span
                class="chip-avatar"
                :style="{ background: `var(--role-${choice.identity.color ?? 'amber'})` }"
                aria-hidden="true"
              ></span>
              <span class="chip-account">{{ choice.identity.name }}</span>
              <span v-if="choice.running" class="row-state">{{ t("app.railRunning") }}</span>
            </label>
          </div>
          <button
            type="button"
            class="launch-go"
            :disabled="!pickedCount || launching"
            data-launch-go
            @click="launchPickedIdentities"
          >
            {{ t("app.railLaunchGo", { count: pickedCount }) }}
          </button>
        </template>
      </div>
    </div>

    <!-- 管理: the standing entrance to the management pane. -->
    <div class="rail-manage">
      <button
        type="button"
        class="rail-btn"
        :aria-label="t('app.railManage')"
        data-manage-btn
        v-tooltip="t('app.railManage')"
        @click="emit('manage')"
      >
        <LayoutGrid :size="13" />
        <span>{{ t("app.railManage") }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * The window's first row, in the frame colour.
 *
 * It shares the tab strip's band so the two rows read as one header; the right
 * padding clears the native caption buttons on Windows/Linux, the left one the
 * traffic lights on macOS. The row's empty stretches drag the window, like a
 * browser's tab strip.
 */
.rail {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--titlebar-height);
  padding-left: 6px;
  background: var(--frame);
  min-width: 0;
}

.rail[data-platform="win32"],
.rail[data-platform="linux"] {
  padding-right: calc(var(--window-controls-width, 138px) + 6px);
}

.rail[data-platform="darwin"] {
  padding-left: 82px;
}

/* The scrolling region: entries fit here or fold, never squeeze. */
.rail-box {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

.rail-chips {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

/*
 * An entry: avatar block + account name + site icon + AI dot + close.
 *
 * Deliberately unlike a page tab (the row below): a page tab is text-led with a
 * favicon and a close cross; this entry leads with the account's colour and
 * name and carries the state dot, so the two rows cannot be mistaken for each
 * other (P1-1 acceptance).
 */
.rail-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 4px 0 6px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  flex: 0 0 auto;
  max-width: 200px;
}

.rail-chip:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

/* The entry on stage is a filled surface, the same step an active tab uses. */
.rail-chip.on-stage {
  background: var(--selected);
  color: var(--text);
}

.chip-avatar {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: 0 0 10px;
}

.chip-ext {
  color: var(--faint);
  flex: 0 0 12px;
}

.chip-account {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-sm);
}

.chip-site {
  flex: 0 0 12px;
}

/*
 * The AI dot. Breathing = an operation is running right now; steady = the
 * instance was driven within the last 30 minutes; absent otherwise. The state
 * is also published as an attribute so tests can assert the mapping without
 * timing pixels.
 */
.ai-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
  background: var(--accent);
}

.ai-dot.active {
  animation: ai-breathe 1.6s ease-in-out infinite;
}

.ai-dot.recent {
  animation: none;
  opacity: 0.9;
}

@keyframes ai-breathe {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

/* The close cross reveals on hover, quiet at rest like a browser tab's. */
.chip-close {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  border-radius: 3px;
  color: var(--faint);
  flex: 0 0 15px;
  opacity: 0;
  cursor: pointer;
}

.rail-chip:hover .chip-close,
.chip-close:focus-visible {
  opacity: 1;
}

.chip-close:hover {
  background: color-mix(in srgb, var(--red) 20%, transparent);
  color: var(--red);
}

/* The fold: "+N" for everything past the row's width. */
.rail-fold {
  position: relative;
  flex: 0 0 auto;
}

.fold-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 7px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.fold-btn:hover {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  color: var(--text);
}

.fold-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 70;
  min-width: 180px;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: rail-panel-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

.fold-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
}

.fold-item:hover {
  background: var(--surface-3);
  color: var(--text);
}

/* [+ 启动] and [管理]: labelled buttons at the row's end. */
.rail-launch,
.rail-manage {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}

.rail-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--chrome);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.rail-btn :deep(svg),
.rail-btn svg {
  color: var(--accent);
}

.rail-btn:hover {
  background: var(--field);
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  color: var(--text);
}

/* The launch picker's dropdown panel. */
.rail-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 70;
  min-width: 250px;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation: rail-panel-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

@keyframes rail-panel-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
}

.panel-list {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.launch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  cursor: pointer;
  min-width: 0;
}

.launch-row:hover {
  background: var(--surface-3);
  color: var(--text);
}

.launch-row.running {
  opacity: 0.55;
  cursor: default;
}

.row-state {
  margin-left: auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
  flex: none;
}

.panel-empty {
  margin: 0;
  padding: 10px;
  font-size: var(--fs-sm);
  color: var(--faint);
}

.launch-go {
  margin: 2px 4px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--chrome);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
}

.launch-go:not(:disabled):hover {
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  color: var(--text);
  background: var(--field);
}

.launch-go:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
