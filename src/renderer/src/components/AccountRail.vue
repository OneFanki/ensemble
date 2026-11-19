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
import { ExternalLink, PictureInPicture2, UsersRound, X } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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

/** 站点图标加载失败的条目，退回文字头像。 */
const failedAvatars = ref<Set<string>>(new Set());

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
    <!--
      管理入口在顶部，不在底部。

      它是这一栏里唯一的高频动作：每开一个账号几乎都要经过它，而底部那一行在
      账号多的时候正好被列表压在下面。「多账号」而不是「账号」：这里管的是多个
      账号的清单，叫「账号」会读成「我自己登录的那个账号」。单条账号仍然叫账号。
    -->
    <div class="rail-head no-drag">
      <button
        type="button"
        class="entry-btn"
        :class="{ active: activeLayer === 'identities' }"
        :aria-label="t('app.railAccounts')"
        :aria-pressed="activeLayer === 'identities'"
        v-tooltip="t('app.railAccountsHint')"
        data-rail-entry="identities"
        @click="toggleLayer('identities')"
      >
        <UsersRound :size="13" />
        <span>{{ t("app.railAccounts") }}</span>
      </button>
    </div>

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
        <!--
          状态挂在头像的角上，不占行宽。

          这两个点原来各占 7px 的横向空间，加在头像与名字之间，一行里挤了三个
          元素；而它们说的是「这个头像代表的东西现在什么状态」，本来就是头像的一
          部分。作为角标挂上去之后，行宽只由名字决定，栏可以更窄。
        -->
        <span
          v-if="!item.external && item.dot !== 'idle'"
          class="ai-dot"
          :class="item.dot"
          :data-ai-dot="item.dot"
          v-tooltip="item.dotTip"
        ></span>
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
 * AI 状态点，挂成头像的角标。呼吸 = 正在操作；常亮 = 30 分钟内动过；无标 = 其它。
 * 状态同时写在 data-ai-dot 上，测试不必等动画。
 *
 * Positioned against the row, not the avatar, because the avatar is a 20px square
 * with `overflow: hidden` for the favicon — a badge inside it would be clipped.
 * The row is `position: relative`, and the offsets below are the avatar's own box
 * (7px padding + 20px) so the dot lands on its bottom-right corner. It takes no
 * layout space, which is the point: the name gets the whole remaining width.
 */
.ai-dot {
  position: absolute;
  left: 21px;
  bottom: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  /* A ring in the rail's own colour, so the dot reads as sitting on the avatar
     rather than as a hole punched in it. */
  box-shadow: 0 0 0 1.5px var(--frame);
  pointer-events: none;
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

/*
 * 冻结标识：全标 = 全部页面休眠，半标 = 部分休眠。
 *
 * Also a corner badge, on the opposite corner from the AI dot so the two never
 * collide: AI state is about the account, freeze state is about its pages, and a
 * row can honestly be both ("AI just opened it, and it has since gone to sleep").
 */
.freeze-dot {
  position: absolute;
  right: 4px;
  bottom: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text) 55%, transparent);
  box-shadow: 0 0 0 1.5px var(--frame);
  pointer-events: none;
}

.freeze-dot.partial {
  background: linear-gradient(
    to right,
    color-mix(in srgb, var(--text) 55%, transparent) 0 50%,
    color-mix(in srgb, var(--text) 18%, transparent) 50% 100%
  );
}

/* 顶部：管理入口。列表从这里往下铺，入口不会随账号变多被挤走。 */
.rail-head {
  flex: 0 0 auto;
  padding: 5px 5px 4px;
  border-bottom: 1px solid var(--line-soft);
}

/*
 * 关闭：悬停才出现，和浏览器标签上的叉一样安静。
 *
 * 绝对定位在行的右端，不参与布局：它只在悬停时出现，却一直占着 17px，等于
 * 每个账号名平时都短了两个字——窄栏里这就是「管理员 · 主…」和完整名字的差别。
 * 现在名字铺到行尾，叉在悬停时盖在上面。
 */
.item-close {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 17px;
  height: 17px;
  border-radius: 3px;
  color: var(--faint);
  background: var(--frame);
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

/*
 * 面板向上展开：按钮在最下面，往下开会被窗口边缘裁掉。
 */
@keyframes rail-panel-in {
  from {
    opacity: 0;
    transform: translateY(var(--motion-shift)) scale(var(--motion-pop-scale));
  }
}

/* 头部：第二级带返回上一级的出口，搜索框两级共用。 */
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
