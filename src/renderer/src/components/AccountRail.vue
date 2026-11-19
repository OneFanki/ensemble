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
import type { Identity, RoleColor } from "@shared/types";
import { onClickOutside } from "@vueuse/core";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  PictureInPicture2,
  Plus,
  Users,
  X,
} from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";

/**
 * 左栏能打开的管理浮层。
 *
 * 只剩账号页：站点并进了账号页的分组，书签/消息/流程住在设置页。类型收窄在这里，
 * 而不是留着三个值再逐个成为死代码。
 */
export type AccountRailLayer = "identities";

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
  /** 没有站点图标时的文字头像：站点名首字；默认会话固定「默」。 */
  initial: string;
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
      initial: avatarInitialOf(root),
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
    initial: instance.label.slice(0, 1),
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
/* + 启动：站点 → 账号两级，点一个账号就拉起。                          */
/* ------------------------------------------------------------------ */

const launchOpen = ref(false);
const launchRoot = ref<HTMLElement | null>(null);
const launchPanel = ref<HTMLElement | null>(null);
/** 单选：数组保留批量的形状，但这里永远只装一个 id。 */
const launchPicked = ref<string[]>([]);
/** 当前看的是哪个站点；`null` 表示第一级（站点列表）。 */
const launchSiteId = ref<string | null>(null);
/** 搜索词：第一级按站点名或账号名筛，第二级按账号筛。 */
const launchTerm = ref("");
/** 站点图标加载失败的条目，退回文字头像。 */
const failedAvatars = ref<Set<string>>(new Set());

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
    launchSiteId.value = null;
    launchTerm.value = "";
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

/** 一个站点分组：站点和它下面的账号；孤儿账号自成一组。 */
interface LaunchGroup {
  id: string;
  name: string;
  accounts: Array<{ identity: Identity; running: boolean }>;
}

const ORPHAN_GROUP_ID = "__orphan__";

/** 站点列表按站点分，账号不会跨站点混在一屏；孤儿账号沿用账号页的叫法。 */
const launchGroups = computed<LaunchGroup[]>(() => {
  const result: LaunchGroup[] = [];
  for (const site of workspace.sites) {
    const accounts = launchChoices.value.filter(
      (choice) => choice.identity.siteId === site.id,
    );
    if (!accounts.length) continue;
    result.push({ id: site.id, name: site.name, accounts });
  }
  const orphans = launchChoices.value.filter(
    (choice) => !workspace.sites.some((site) => site.id === choice.identity.siteId),
  );
  if (orphans.length) {
    result.push({ id: ORPHAN_GROUP_ID, name: t("app.identityOrphanSite"), accounts: orphans });
  }
  return result;
});

function matchesTerm(identity: Identity, term: string): boolean {
  return (
    identity.name.toLowerCase().includes(term) ||
    identity.username.toLowerCase().includes(term) ||
    identity.role.toLowerCase().includes(term)
  );
}

/** 第一级：搜索命中的站点名，或站点里至少有一个账号命中。 */
const filteredGroups = computed<LaunchGroup[]>(() => {
  const term = launchTerm.value.trim().toLowerCase();
  if (!term) return launchGroups.value;
  return launchGroups.value
    .map((group) =>
      group.name.toLowerCase().includes(term)
        ? group
        : { ...group, accounts: group.accounts.filter((choice) => matchesTerm(choice.identity, term)) },
    )
    .filter((group) => group.accounts.length > 0);
});

const activeGroup = computed<LaunchGroup | null>(
  () => launchGroups.value.find((group) => group.id === launchSiteId.value) ?? null,
);

/** 第二级：当前站点下的账号，按同一个搜索词过滤。 */
const visibleAccounts = computed<Array<{ identity: Identity; running: boolean }>>(() => {
  const group = activeGroup.value;
  if (!group) return [];
  const term = launchTerm.value.trim().toLowerCase();
  if (!term) return group.accounts;
  return group.accounts.filter((choice) => matchesTerm(choice.identity, term));
});

function groupAccountCount(group: LaunchGroup): number {
  return filteredGroups.value.find((item) => item.id === group.id)?.accounts.length ?? 0;
}

function enterSite(group: LaunchGroup): void {
  launchSiteId.value = group.id;
  // 第一级的搜索词是在找站点；带进第二级会把账号一并筛掉。
  launchTerm.value = "";
  void nextTick(() =>
    launchPanel.value?.querySelector<HTMLElement>("[data-launch-row]")?.focus(),
  );
}

function backToSites(): void {
  launchSiteId.value = null;
  void nextTick(() =>
    launchPanel.value?.querySelector<HTMLElement>("[data-launch-site]")?.focus(),
  );
}

/** 方向键在行间移动；第一级 → 键进入站点，第二级 ← 键返回。Esc 由文档监听统一关闭。 */
function onPanelKeydown(event: KeyboardEvent): void {
  const rows = Array.from(
    launchPanel.value?.querySelectorAll<HTMLElement>("[data-launch-item]:not([disabled])") ?? [],
  );
  if (!rows.length) return;
  const active = document.activeElement as HTMLElement | null;
  const index = active ? rows.indexOf(active) : -1;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    rows[(index + 1 + rows.length) % rows.length]?.focus();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    rows[(index - 1 + rows.length) % rows.length]?.focus();
  } else if (event.key === "ArrowRight" && index >= 0) {
    if (rows[index]?.hasAttribute("data-launch-site")) {
      event.preventDefault();
      rows[index]?.click();
    }
  } else if (event.key === "ArrowLeft" && launchSiteId.value) {
    event.preventDefault();
    backToSites();
  }
}

const launching = ref(false);

/** 点一个账号就拉起：单选没有「确认」这一步。 */
async function launchChoice(choice: { identity: Identity; running: boolean }): Promise<void> {
  if (choice.running || launching.value) return;
  launchPicked.value = [choice.identity.id];
  await launchPickedIdentities();
}

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

/**
 * 条目的文字头像：站点名首字；没有账号的会话按类型给字。
 *
 * 默认会话固定「默」，干净会话「干」——两者都没有站点可借。
 */
function avatarInitialOf(root: EmbeddedTab): string {
  const identity = workspace.identities.find((item) => item.id === root.identityId);
  if (!identity) {
    return root.clean
      ? t("app.cleanSession").slice(0, 1)
      : t("app.dailyProfile").slice(0, 1);
  }
  const site = workspace.sites.find((item) => item.id === identity.siteId);
  return (site?.name ?? t("app.identityOrphanSite")).slice(0, 1);
}

function markAvatarBroken(instanceId: string): void {
  failedAvatars.value = new Set(failedAvatars.value).add(instanceId);
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
        <!-- 头像就是站点：有图标用图标，没有就用站点名首字；默认会话固定「默」。 -->
        <span
          v-if="item.external"
          class="avatar external"
          aria-hidden="true"
        >
          <ExternalLink :size="11" />
        </span>
        <span
          v-else
          class="avatar chip-site"
          :style="{ '--role': `var(--role-${item.color})` }"
          aria-hidden="true"
        >
          <img
            v-if="item.favicon && !failedAvatars.has(item.instanceId)"
            :src="item.favicon"
            alt=""
            draggable="false"
            @error="markAvatarBroken(item.instanceId)"
          />
          <span v-else class="avatar-letter">{{ item.initial }}</span>
        </span>
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
      <!-- [+ 启动]：站点 → 账号两级，点一个账号就立刻拉起。 -->
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
        <div
          v-if="launchOpen"
          ref="launchPanel"
          class="launch-panel"
          data-launch-panel
          @keydown="onPanelKeydown"
        >
          <p v-if="!launchChoices.length" class="panel-empty">{{ t("app.noIdentitiesYet") }}</p>
          <p v-else-if="!launchGroups.length" class="panel-empty">{{ t("app.railLaunchNoSites") }}</p>
          <template v-else>
            <div class="panel-head">
              <button
                v-if="launchSiteId"
                type="button"
                class="panel-back"
                :aria-label="t('app.railLaunchBack')"
                data-launch-back
                v-tooltip="t('app.railLaunchBack')"
                @click="backToSites"
              >
                <ChevronLeft :size="12" />
                <span class="panel-site-name">{{ activeGroup?.name }}</span>
              </button>
              <input
                v-model="launchTerm"
                class="panel-search"
                type="search"
                :placeholder="
                  launchSiteId ? t('app.railLaunchSearchAccounts') : t('app.railLaunchSearchSites')
                "
                data-launch-search
              />
            </div>

            <!-- 第一级：站点。每行是「站点名 + 该站点下的账号数」。 -->
            <div
              v-if="!launchSiteId"
              class="panel-list"
              role="group"
              :aria-label="t('app.railLaunchPickSite')"
            >
              <button
                v-for="group in filteredGroups"
                :key="group.id"
                type="button"
                class="launch-row launch-site"
                data-launch-site
                data-launch-item
                :data-launch-site-id="group.id"
                @click="enterSite(group)"
              >
                <Globe :size="12" class="row-icon" aria-hidden="true" />
                <span class="chip-account">{{ group.name }}</span>
                <span class="row-state">
                  {{ t("app.railLaunchAccountCount", { count: groupAccountCount(group) }) }}
                </span>
                <ChevronRight :size="11" class="row-chev" aria-hidden="true" />
              </button>
              <p v-if="!filteredGroups.length" class="panel-empty">{{ t("app.railLaunchNoMatch") }}</p>
            </div>

            <!-- 第二级：该站点下的账号。点一行即启动。 -->
            <div
              v-else
              class="panel-list"
              role="group"
              :aria-label="t('app.railLaunchPick')"
            >
              <button
                v-for="choice in visibleAccounts"
                :key="choice.identity.id"
                type="button"
                class="launch-row"
                :class="{ running: choice.running }"
                data-launch-row
                data-launch-item
                :data-launch-row-id="choice.identity.id"
                :disabled="choice.running"
                @click="launchChoice(choice)"
              >
                <span
                  class="row-color"
                  :style="{ background: `var(--role-${choice.identity.color ?? 'amber'})` }"
                  aria-hidden="true"
                ></span>
                <span class="chip-account">{{ choice.identity.name }}</span>
                <span v-if="choice.running" class="row-state">{{ t("app.railRunning") }}</span>
              </button>
              <p v-if="!visibleAccounts.length" class="panel-empty">
                {{ t("app.railLaunchNoMatch") }}
              </p>
            </div>
          </template>
        </div>
      </div>

      <!-- 管理入口：账号页。站点页与「更多」都并入了账号页。 -->
      <nav class="rail-entries no-drag" :aria-label="t('app.railManage')">
        <button
          type="button"
          class="entry-btn"
          :class="{ active: activeLayer === 'identities' }"
          :aria-label="t('app.railAccounts')"
          :aria-pressed="activeLayer === 'identities'"
          v-tooltip="t('app.railAccounts')"
          data-rail-entry="identities"
          @click="toggleLayer('identities')"
        >
          <Users :size="14" />
          <span>{{ t("app.railAccounts") }}</span>
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
  gap: 0;
  padding: 4px 0 6px;
}

/*
 * 一个条目：站点头像 + 账号名 + 状态点 + 关闭。
 *
 * 整行贴着栏边，只靠内边距分出空白：这不是卡片，是这一列的列表行，
 * 一屏要塞下尽可能多的账号。选中仍然用填充表达，铺到底、不留边。
 */
.rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 27px;
  padding: 0 5px 0 7px;
  border-radius: 0;
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

/*
 * 头像就是站点：有 favicon 用 favicon，没有就用站点名首字。
 *
 * 固定方块，两种来源共用一个盒子，图标晚到时行不会跳。
 */
.avatar {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  overflow: hidden;
  background: color-mix(in srgb, var(--role, var(--role-slate)) 16%, var(--frame));
  color: color-mix(in srgb, var(--role, var(--text)) 85%, var(--text));
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* 外部实例没有站点：保留方向箭头，说明它是一个独立的系统窗口。 */
.avatar.external {
  background: transparent;
  color: var(--faint);
  border-radius: 4px;
}

.avatar-letter {
  display: block;
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
  z-index: var(--z-popover);
  width: 268px;
  padding: 4px;
  border-radius: var(--radius);
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

/* 头部：第二级带返回上一级的出口，搜索框两级共用。 */
.panel-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
}

.panel-back {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px 0 4px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  min-width: 0;
  flex: 0 1 auto;
}

.panel-back:hover {
  background: var(--surface-3);
  color: var(--text);
}

.panel-site-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-search {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--field);
  font-size: var(--fs-sm);
  color: var(--text);
  outline: 0;
}

.panel-search:focus {
  border-color: var(--line);
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
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  cursor: pointer;
  min-width: 0;
  text-align: left;
}

.launch-row:hover {
  background: var(--surface-3);
  color: var(--text);
}

.launch-row:disabled,
.launch-row.running {
  opacity: 0.55;
  cursor: default;
}

.launch-row.running:hover {
  background: transparent;
  color: var(--text-secondary);
}

/* 站点行用图标，账号行用角色色块：两级一眼分得开，不会和名字首字重复。 */
.row-icon {
  color: var(--faint);
  flex: 0 0 12px;
}

.row-color {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 8px;
}

.row-chev {
  color: var(--faint);
  flex: 0 0 11px;
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

/* 只剩一个管理入口：整行一个格子，不必再撑成三栏的图标网格。 */
.rail-entries {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
}

.entry-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
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
