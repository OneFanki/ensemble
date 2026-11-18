<script setup lang="ts">
/**
 * 左栏：运行中的账号，竖向一列。
 *
 * 每个条目是一个浏览器实例（不是页面）：站点图标、账号名、AI 三态点、冻结标识
 * 与它自己的关闭按钮。点一下把该实例的当前页放上舞台；其余实例继续在后台运行
 * ——登录态保持、AI 可继续驱动，只是不占像素（ADR 0012 的单舞台模型）。
 *
 * 逻辑是从旧的 `InstanceRail` 搬来的，不是重写：AI 三态点、冻结三态映射、
 * 「5 秒时钟」与账号名解析都维持原来的实现，选择器（`data-ai-dot` /
 * `data-freeze` / `data-instance-chip`）也保留，e2e 仍在用。
 *
 * 它不是旧实例行的竖向翻版，去掉的东西见文件末尾的说明。
 */

import { aiDotState, lastActionAtByTab } from "@shared/ai-dot";
import type { EmbeddedTab } from "@shared/embedded";
import { type InstanceFreezeState, instanceFreezeState } from "@shared/instance-freeze";
import type { RoleColor } from "@shared/types";
import { onClickOutside } from "@vueuse/core";
import {
  ExternalLink,
  Globe,
  MoreHorizontal,
  PictureInPicture2,
  Plus,
  Users,
  X,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import TabIcon from "./TabIcon.vue";

/** 管理浮层的三个入口。 */
export type AccountRailLayer = "sites" | "identities" | "more";

const props = defineProps<{
  /** 当前开着的管理浮层；左栏要据此做「再点一次收起」与高亮。 */
  activeLayer?: AccountRailLayer | null;
}>();
const emit = defineEmits<{
  /** 打开一个管理浮层。 */
  openLayer: [layer: AccountRailLayer];
  /** 关掉当前的管理浮层。 */
  closeLayer: [];
}>();

const workspace = useWorkspaceStore();
const embedded = useEmbeddedStore();
const { t } = useI18n();

const platform = computed(() => workspace.snapshot?.platform ?? "win32");

/**
 * 一个条目：一个浏览器实例，永远不是一页。
 *
 * 页面自己用 `target="_blank"` 打开的新页（OAuth 弹窗等）属于同一个实例，
 * 不新增条目。
 */
interface RailItem {
  /** 根页面 id；同时是稳定 key。 */
  id: string;
  instanceId: string;
  /** 点这个条目时上台的页。 */
  pageId: string;
  account: string;
  color: RoleColor;
  favicon?: string;
  onStage: boolean;
  /** AI 状态：呼吸 / 常亮 / 无标。 */
  dot: "active" | "recent" | "idle";
  /** 状态点的悬停说明；没有点时为 undefined。 */
  dotTip?: string;
  /** 实例全部页面的冻结状态；映射在 `shared/instance-freeze`。 */
  freeze: InstanceFreezeState;
  /** 冻结标识的悬停说明；没有标识时为 undefined。 */
  freezeTip?: string;
  /** 系统浏览器实例：点击是提窗。 */
  external?: boolean;
  /** 该实例的页面全部拆到了独立窗口：点击只提窗，不占舞台。 */
  poppedOut?: boolean;
}

/** 实例在台上会显示的那一页：它自己的活跃页。 */
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
 * 一个实例的 AI 状态：它全部页面里最新的一次动作。
 *
 * 日志按页记录，而条目回答的是实例，所以取并集，不是「台上那一页」。
 */
const aiLastActionByTab = computed(() => lastActionAtByTab(workspace.aiActivity));

/** 驱动 active→recent 的降级，不必等一次状态推送。 */
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

/** 一个实例的冻结标识：按它全部页面映射，并给出悬停说明。 */
function freezeOf(root: EmbeddedTab): { freeze: InstanceFreezeState; tip?: string } {
  const pages = embedded.instancePages(root.instanceId);
  const freeze = instanceFreezeState(pages);
  if (freeze === "awake") return { freeze };
  return {
    freeze,
    tip:
      freeze === "full"
        ? t("app.freezeFullTip", { count: pages.length })
        : t("app.freezePartialTip", {
            frozen: pages.filter((page) => page.sleeping).length,
            count: pages.length,
          }),
  };
}

/** 内置实例，按标签顺序（也就是启动顺序）。 */
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
    const frozen = freezeOf(root);
    const pages = embedded.instancePages(root.instanceId);
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
      freeze: frozen.freeze,
      ...(frozen.tip ? { freezeTip: frozen.tip } : {}),
      ...(pages.length > 0 && pages.every((item) => item.popout) ? { poppedOut: true } : {}),
    });
  }
  return items;
});

/** 系统浏览器实例也进这一列：同一件事，不同的承载面。 */
const externalItems = computed<RailItem[]>(() =>
  workspace.instances.map((instance) => ({
    id: instance.id,
    instanceId: instance.id,
    pageId: instance.id,
    account: instance.label,
    color: "amber" as RoleColor,
    onStage: false,
    dot: "idle" as const,
    freeze: "awake" as const,
    external: true,
  })),
);

const items = computed<RailItem[]>(() => [...embeddedItems.value, ...externalItems.value]);

/**
 * 点一个条目。
 *
 * 三件事按顺序决定：
 *
 * 1. 管理浮层开着就先收掉——用户点账号是要看那一页，不是要在浮层上叠一层。
 * 2. 已经在台上的条目不再重复激活；再次点它只是把浮层收掉。
 * 3. 内置实例的「提窗」语义由主进程判定：页面已拆到独立窗口时，`activate`
 *    把那个窗口提到前台，舞台不动。所以这里不需要第二套调用；也正因为提窗
 *    才是动作本身，拆出的条目**不能**被「已经在台上」挡掉——它的像素不在
 *    舞台里，点击的唯一意义就是抬起那个窗口。
 */
function activate(item: RailItem, event: MouseEvent): void {
  // 关闭按钮自己 stop 了事件；这里再挡一次，避免拖拽起点的按下被当成点击。
  if ((event.target as HTMLElement | null)?.closest(".item-close")) return;
  if (props.activeLayer) emit("closeLayer");
  if (item.external) {
    void workspace.focusInstance(item.instanceId);
    return;
  }
  if (item.onStage && !item.poppedOut) return;
  void embedded.activate(item.pageId);
}

/** 三个入口：已经开着的那一层再点一次 = 收起。 */
function toggleLayer(layer: AccountRailLayer): void {
  if (props.activeLayer === layer) emit("closeLayer");
  else emit("openLayer", layer);
}

/** 关掉一个内置实例的全部页面 / 停掉一个外部实例。 */
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
/* + 启动：多选账号，一次拉起。                                        */
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

/** 已经在跑的账号不能再启动一次：列表里直接标出来。 */
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
</script>

<template>
  <aside
    class="account-rail drag-region"
    :data-platform="platform"
    data-account-rail
    :aria-label="t('app.railLabel')"
  >
    <div class="rail-list no-drag" role="tablist" :aria-label="t('app.railLabel')">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        role="tab"
        class="rail-item"
        :class="{ 'on-stage': item.onStage }"
        :aria-selected="item.onStage"
        :data-account-item="item.instanceId"
        :data-instance-chip="item.instanceId"
        :data-on-stage="item.onStage ? '1' : '0'"
        v-tooltip="item.account"
        @click="activate(item, $event)"
      >
        <!-- 身份色条：条目的第一眼归类，比一个色块更安静。 -->
        <span
          v-if="!item.external"
          class="item-color"
          :style="{ background: `var(--role-${item.color})` }"
          aria-hidden="true"
        ></span>
        <ExternalLink v-else :size="12" class="item-ext" aria-hidden="true" />
        <TabIcon v-if="item.favicon" :src="item.favicon" :size="13" class="chip-site" />
        <span class="chip-account">{{ item.account }}</span>
        <!-- 全部页面拆到独立窗口：点击提到那个窗口，不换舞台上的页。 -->
        <PictureInPicture2
          v-if="item.poppedOut"
          :size="11"
          class="item-popout"
          aria-hidden="true"
          data-popout-mark
        />
        <!-- AI 状态点：呼吸 = 正在操作，常亮 = 30 分钟内动过，无标 = 其它。 -->
        <span
          v-if="!item.external && item.dot !== 'idle'"
          class="ai-dot"
          :class="item.dot"
          :data-ai-dot="item.dot"
          v-tooltip="item.dotTip"
        ></span>
        <!-- 冻结标识：灰标 = 全部页面休眠，半标 = 部分休眠，无标 = 全醒。 -->
        <span
          v-if="!item.external && item.freeze !== 'awake'"
          class="freeze-dot"
          :class="item.freeze"
          :data-freeze="item.freeze"
          v-tooltip="item.freezeTip"
        ></span>
        <span
          class="item-close"
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

    <div class="rail-foot no-drag">
      <!-- [+ 启动]：多选账号，一次拉起；第一个上台，其余后台待命。 -->
      <div ref="launchRoot" class="rail-launch">
        <button
          type="button"
          class="launch-btn"
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
        <div v-if="launchOpen" ref="launchPanel" class="launch-panel" data-launch-panel>
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
                  class="row-color"
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

      <!-- 三个管理入口：站点 / 账号 / 更多。同一时刻只会开一个浮层。 -->
      <nav class="rail-entries no-drag" :aria-label="t('app.railManage')">
        <button
          type="button"
          class="entry-btn"
          :class="{ active: activeLayer === 'sites' }"
          :aria-label="t('app.sites')"
          :aria-pressed="activeLayer === 'sites'"
          v-tooltip="t('app.sites')"
          data-rail-entry="sites"
          @click="toggleLayer('sites')"
        >
          <Globe :size="14" />
          <span>{{ t("app.sites") }}</span>
        </button>
        <button
          type="button"
          class="entry-btn"
          :class="{ active: activeLayer === 'identities' }"
          :aria-label="t('app.identities')"
          :aria-pressed="activeLayer === 'identities'"
          v-tooltip="t('app.identities')"
          data-rail-entry="identities"
          @click="toggleLayer('identities')"
        >
          <Users :size="14" />
          <span>{{ t("app.identities") }}</span>
        </button>
        <button
          type="button"
          class="entry-btn"
          :class="{ active: activeLayer === 'more' }"
          :aria-label="t('app.more')"
          :aria-pressed="activeLayer === 'more'"
          v-tooltip="t('app.more')"
          data-rail-entry="more"
          @click="toggleLayer('more')"
        >
          <MoreHorizontal :size="15" />
          <span>{{ t("app.more") }}</span>
        </button>
      </nav>
    </div>
  </aside>
</template>

<style scoped>
/*
 * 左栏：一条竖向的框架色列，从地址栏下面开始，到窗口底部结束。
 *
 * 空白处是拖拽区（浮层打开时由 `data-floating` 收回，见 base.css），
 * 条目与按钮都是 `no-drag`。
 */
.account-rail {
  flex: 0 0 var(--account-rail-width);
  width: var(--account-rail-width);
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--frame);
  border-right: 1px solid var(--line-soft);
}

/* 列表是唯一滚动区：账号多了往下滚，底部入口永远在。 */
.rail-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 6px 8px;
}

/*
 * 一个条目：色条 + 站点图标 + 账号名 + 状态点 + 关闭。
 *
 * 竖向排列之后它更像列表行而不是芯片，但「账号」这一层仍然是填充式的选中
 * 表达：台上那一条铺 `--selected`，和页面标签的选中态是同一个台阶。
 */
.rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 4px 0 8px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
  flex: 0 0 auto;
  min-width: 0;
}

.rail-item:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.rail-item.on-stage {
  background: var(--selected);
  color: var(--text);
}

/* 色条贴着条目左缘：它是「谁」的标记，不参与点击目标的居中。 */
.item-color {
  width: 3px;
  height: 16px;
  border-radius: 2px;
  flex: 0 0 3px;
}

.item-ext {
  color: var(--faint);
  flex: 0 0 12px;
}

.chip-site {
  flex: 0 0 13px;
}

.chip-account {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 auto;
}

/* 拆窗标记：说明这一条的像素在另一个窗口里，点击是提窗。 */
.item-popout {
  color: var(--faint);
  flex: 0 0 11px;
}

/*
 * AI 状态点。呼吸 = 正在操作；常亮 = 30 分钟内动过；无标 = 其它。
 * 状态同时写在 data-ai-dot 上，测试不必等动画。
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

/* 冻结标识：全标 = 全部页面休眠，半标 = 部分休眠。 */
.freeze-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
  background: color-mix(in srgb, var(--text) 55%, transparent);
}

.freeze-dot.partial {
  background: linear-gradient(
    to right,
    color-mix(in srgb, var(--text) 55%, transparent) 0 50%,
    color-mix(in srgb, var(--text) 18%, transparent) 50% 100%
  );
}

/* 关闭：悬停才出现，和浏览器标签上的叉一样安静。 */
.item-close {
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 3px;
  color: var(--faint);
  flex: 0 0 17px;
  opacity: 0;
  cursor: pointer;
}

.rail-item:hover .item-close,
.item-close:focus-visible {
  opacity: 1;
}

.item-close:hover {
  background: color-mix(in srgb, var(--red) 20%, transparent);
  color: var(--red);
}

/* 底部：启动 + 三个管理入口。 */
.rail-foot {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 6px 10px;
  border-top: 1px solid var(--line-soft);
}

.rail-launch {
  position: relative;
}

.launch-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  width: 100%;
  height: 28px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--chrome);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.launch-btn svg {
  color: var(--accent);
}

.launch-btn:hover {
  background: var(--field);
  border-color: color-mix(in srgb, var(--line) 60%, var(--accent));
  color: var(--text);
}

/*
 * 面板向上展开：按钮在最下面，往下开会被窗口边缘裁掉。
 */
.launch-panel {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 70;
  width: 260px;
  padding: 4px;
  border-radius: var(--radius-md);
  border: 1px solid var(--line);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  display: flex;
  flex-direction: column;
  gap: 4px;
  animation: rail-panel-in var(--motion-base) var(--ease-out);
  transform-origin: bottom left;
}

@keyframes rail-panel-in {
  from {
    opacity: 0;
    transform: translateY(var(--motion-shift)) scale(var(--motion-pop-scale));
  }
}

.panel-list {
  max-height: 280px;
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

.row-color {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 8px;
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

/*
 * 三个入口一排。图标在上、文字在下：196px 的列宽放得下三个 60px 的格子，
 * 一行文字缩到 10px 也读得出来；换成三行会把这列的下半截全占掉。
 */
.rail-entries {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
}

.entry-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 44px;
  border-radius: var(--radius);
  color: var(--muted);
  font-size: var(--fs-2xs);
  white-space: nowrap;
}

.entry-btn:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.entry-btn.active {
  background: var(--selected-on-frame);
  color: var(--text);
}
</style>
