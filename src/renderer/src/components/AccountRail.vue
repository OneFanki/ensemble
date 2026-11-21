<script setup lang="ts">
/**
 * 账号条：窗口首行左半，横向一排条目。
 *
 * 每个条目是一个浏览器实例（不是页面）：站点图标、账号名、AI 三态点、冻结标识。
 * 点一下把该实例的当前页放上舞台；其余实例继续在后台运行——登录态保持、AI 可
 * 继续驱动，只是不占像素（ADR 0012 的单舞台模型）。
 *
 * 它原来是左栏里的一列。换成横向条以后，每一段可用宽度都给了名字：列里只能
 * 显示十个字，条里能显示一整条名字，且不占页面像素。
 *
 * 它同时是新建会话的入口：会话原来只能在设置页创建，于是「再开一个身份」要先
 * 离开浏览器、建完再回来找。这一栏本来就是「哪些会话在跑」的清单，加号放在
 * 它的头部才是同一件事。
 *
 * AI 三态点、冻结三态映射与账号名解析是从旧的 `InstanceRail` 搬来的，选择器
 * （`data-ai-dot` / `data-freeze` / `data-instance-chip`）保留，e2e 仍在用。
 */

import { lastActionAtByTab } from "@shared/ai-dot";
import type { EmbeddedTab } from "@shared/embedded";
import { type InstanceFreezeState, instanceFreezeState } from "@shared/instance-freeze";
import type { Identity, RoleColor } from "@shared/types";
import { ExternalLink, PictureInPicture2, Plus, UsersRound, X } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAiDotTip } from "../composables/aiDotTip";
import { useNowMs } from "../composables/useNowMs";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";
import FormField from "./ui/FormField.vue";
import TextField from "./ui/TextField.vue";

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
  /**
   * 状态点的悬停说明；没有点时为 undefined。
   *
   * 不是一句话，而是一层小结构：先一颗同色点说明说的是哪个标记，再一句
   * 状态。完整账号名不在这里，由 `labelOf` 拼上去——它回答的是另一个问题
   * （「这一行是谁」），没有点时也照样要给。
   */
  aiTip?: { text: string; color: string };
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

/**
 * What a chip is called.
 *
 * Three cases, in order of specificity: it is an account, it is a throwaway, or
 * it is one of the named identities. The identity branch has to read the page's
 * own `profileId` rather than assume the default — a page opened in a
 * user-created identity was labelled "默认身份" here, which is not a cosmetic
 * slip: the chip's whole job is telling the user which jar a window belongs to,
 * and the one they created is exactly the one they cannot infer.
 */
function accountOf(root: EmbeddedTab): string {
  const identity = workspace.identities.find((item) => item.id === root.identityId);
  if (identity) return identity.name;
  if (root.clean) return t("app.cleanSession");
  const profiles = workspace.settings.profiles ?? [];
  const profile =
    profiles.find((item) => item.id === root.profileId) ??
    profiles.find((item) => item.id === workspace.settings.defaultProfileId);
  // The built-in row's stored name is data, not copy: an install that predates a
  // vocabulary change still holds the old string, so the built-ins are labelled
  // from the message table and only user rows use their own name.
  if (!profile || profile.builtin) return t("app.dailyProfile");
  return profile.name;
}

/**
 * 一个实例的 AI 状态：它全部页面里最新的一次动作。
 *
 * 日志按页记录，而条目回答的是实例，所以取并集，不是「台上那一页」。
 */
const aiLastActionByTab = computed(() => lastActionAtByTab(workspace.aiActivity));

/** 驱动 active→recent 的降级，不必等一次状态推送。 */
const now = useNowMs();
const aiTip = useAiDotTip();

function lastActionOf(root: EmbeddedTab): number | undefined {
  let latest: number | undefined;
  for (const page of embedded.instancePages(root.instanceId)) {
    const at = aiLastActionByTab.value.get(page.id);
    if (at !== undefined && (latest === undefined || at > latest)) latest = at;
  }
  return latest;
}

function dotOf(root: EmbeddedTab): {
  dot: "active" | "recent" | "idle";
  aiTip?: { text: string; color: string };
} {
  const tip = aiTip.tipOf(lastActionOf(root), now.value);
  if (!tip) return { dot: "idle" };
  return { dot: tip.state, aiTip: { text: tip.text, color: tip.color } };
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
      ...(resolved.aiTip ? { aiTip: resolved.aiTip } : {}),
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
 * 一行的悬停说明。
 *
 * 三种内容合成一层：有 AI 状态点时先给同色点、再给状态句，然后是完整账号名；
 * 冻结标识的说明排在最后。合在一层而不是各挂各的，是因为两个角标都
 * `pointer-events: none`——它们的「悬停」其实就是行的悬停，分成几个 tooltip 只
 * 会让它们互相覆盖。
 *
 * 名字放在状态句下面而不是并进句子里：栏很窄，名字会被截断，而 tooltip 是它
 * 唯一完整出现的地方；但状态才是这一行此刻要说明的东西，所以它在前面。
 */
function labelOf(item: RailItem): { text: string; dot?: string; detail?: string[] } {
  const detail: string[] = [];
  if (item.aiTip) detail.push(item.account);
  if (item.freezeTip) detail.push(item.freezeTip);
  if (!item.aiTip) return { text: item.account, ...(detail.length ? { detail } : {}) };
  return {
    text: item.aiTip.text,
    dot: item.aiTip.color,
    ...(detail.length ? { detail } : {}),
  };
}


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
  if (props.activeLayer) emit("closeLayer");
  if (item.external) {
    void workspace.focusInstance(item.instanceId);
    return;
  }
  if (item.onStage && !item.poppedOut) return;
  void embedded.activate(item.pageId);
}

/**
 * 一个条目的右键菜单。
 *
 * 关闭原来是一颗常驻在行末的小叉。在竖向列表里它还站得住——行很宽、叉在右端
 * 一格；换成顶栏的横向条目后，一颗叉要吃掉 16px，而条目本身只有一条名字那么
 * 宽，「关掉它」把一个只有一行的条变成两段信息，还很容易误点。
 *
 * 关一个会话本来也不是随手动作，所以它挪到右键菜单：浏览器里关标签、关窗口都
 * 在菜单里，这里沿用同一套。菜单项按条目类型分——内置实例是「关闭」，系统浏览
 * 器实例是「停止」。
 */
const menu = ref<{ item: RailItem; x: number; y: number } | null>(null);

function openMenu(item: RailItem, event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  // 菜单贴着指针；靠近窗口右下角时向内翻，免得菜单跑到窗外。
  const width = 132;
  const height = 34;
  menu.value = {
    item,
    x: Math.min(event.clientX, window.innerWidth - width - 8),
    y: Math.min(event.clientY, window.innerHeight - height - 8),
  };
}

/** 菜单开着时，任何一次别处的按下、Esc 或滚动都收起它。 */
function onMenuDismiss(event: Event): void {
  const target = event.target as Node | null;
  if (target && (target as HTMLElement).closest?.("[data-rail-menu]")) return;
  menu.value = null;
}

watch(menu, (open) => {
  if (open) {
    document.addEventListener("pointerdown", onMenuDismiss, true);
    document.addEventListener("keydown", onMenuKeydown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
  } else {
    document.removeEventListener("pointerdown", onMenuDismiss, true);
    document.removeEventListener("keydown", onMenuKeydown);
    window.removeEventListener("resize", closeMenu);
    window.removeEventListener("scroll", closeMenu, true);
  }
});

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeMenu();
}

function closeMenu(): void {
  menu.value = null;
}

onBeforeUnmount(closeMenu);

async function closeFromMenu(): Promise<void> {
  const target = menu.value?.item;
  menu.value = null;
  if (target) await closeItem(target);
}

/** 三个入口：已经开着的那一层再点一次 = 收起。 */
function toggleLayer(layer: AccountRailLayer): void {
  if (props.activeLayer === layer) emit("closeLayer");
  else emit("openLayer", layer);
}

/**
 * 在这一栏里新建一个会话。
 *
 * 会话原本只能在设置页里创建，于是「想再开一个干净身份看看」这条路上，用户
 * 得离开浏览器去管理页，建完再回来，再在这一栏里找它。这一栏本来就是「哪些
 * 会话在跑」的清单，新建入口放在它的头部，是同一件事的加号。
 *
 * 建成即启动：用户来这里是为了那个会话产生的页面，不是为了在磁盘上多一条
 * 记录。名字留空则以「会话 N」补位，仍走 store 的校验。
 */
const creating = ref(false);
const createName = ref("");
const createError = ref("");

function openCreate(): void {
  createName.value = "";
  createError.value = "";
  creating.value = true;
}

async function submitCreate(): Promise<void> {
  const name = createName.value.trim();
  if (!name) {
    createError.value = t("app.sessionNeedsName");
    return;
  }
  // The id comes from the diff, not from the name: two sessions may legitimately
  // share a name, and `find` by name would then launch the wrong one.
  const before = new Set((workspace.settings.profiles ?? []).map((profile) => profile.id));
  const saved = await workspace.createProfile(name);
  // `run` in the store answers `undefined` after toasting the rejection, so a
  // dialog that closes here only ever closes on a write that landed.
  if (saved === undefined) return;
  const created = saved.profiles.find((profile) => !before.has(profile.id));
  creating.value = false;
  if (created) await embedded.openProfileTab(created.id);
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
    // The letter follows the same rule as the name: a user-created identity shows
    // its own first character, the two built-ins show theirs from the message
    // table. One source for both, or a chip could say 工 in an avatar above a name
    // that reads 默认身份.
    return accountOf(root).slice(0, 1);
  }
  const site = workspace.sites.find((item) => item.id === identity.siteId);
  return (site?.name ?? t("app.identityOrphanSite")).slice(0, 1);
}

function markAvatarBroken(instanceId: string): void {
  failedAvatars.value = new Set(failedAvatars.value).add(instanceId);
}

</script>

<template>
  <!--
    The account bar: the top row's left half.

    It used to be a 116px column down the window's left side. The column cost the
    page a permanent strip of pixels and still could not show a name longer than
    about ten characters, while the top row — which had nothing in it but tabs —
    was the one band every browser spends on identity anyway. So the accounts
    live where the tabs used to start: a row of chips, as wide as their contents,
    capped at half the window and scrolling sideways past that.

    The chips are still the tablist of running accounts, because that is what
    they are.
  -->
  <header
    class="account-bar drag-region"
    :data-platform="platform"
    data-account-rail
    :aria-label="t('app.railLabel')"
  >
    <!--
      Two controls at the left end, and they are not chips.

      「多账号」 is the door to the pane that manages the whole list; the "+" is
      the door to a new session. They sit before the chips so the bar reads
      left-to-right as "the list, add to it, and here is what is running" — and so
      they never scroll away with a long list.
    -->
    <div class="bar-doors no-drag">
      <button
        type="button"
        class="bar-door"
        :class="{ active: activeLayer === 'identities' }"
        :aria-label="t('app.railAccounts')"
        :aria-pressed="activeLayer === 'identities'"
        v-tooltip="t('app.railAccountsHint')"
        data-rail-entry="identities"
        @click="toggleLayer('identities')"
      >
        <UsersRound :size="14" />
      </button>
      <button
        type="button"
        class="bar-door"
        :aria-label="t('app.sessionCreateHere')"
        v-tooltip="t('app.sessionCreateHere')"
        data-rail-new-session
        @click="openCreate"
      >
        <Plus :size="14" />
      </button>
      <span class="bar-sep" aria-hidden="true"></span>
    </div>

    <div class="bar-list no-drag" role="tablist" :aria-label="t('app.railLabel')" data-rail-list>
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
        v-tooltip="labelOf(item)"
        @click="activate(item, $event)"
        @contextmenu="openMenu(item, $event)"
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

          它们本身 pointer-events: none：角标只有 6px，要求用户把指针停在一个角
          上才能知道它什么意思，等于没解释。悬停说明因此挂在整条上，由 labelOf
          把状态句、完整账号名和冻结说明合成一层。
        -->
        <span
          v-if="!item.external && item.dot !== 'idle'"
          class="ai-dot"
          :class="item.dot"
          :data-ai-dot="item.dot"
        ></span>
        <span
          v-if="!item.external && item.freeze !== 'awake'"
          class="freeze-dot"
          :class="item.freeze"
          :data-freeze="item.freeze"
        ></span>
      </button>
    </div>

    <!--
      The chip's own menu: right-click, the way every browser closes a tab.

      A close control that is always drawn costs the chip a fixed slice of width
      for a rare, irreversible action — and at chip width it also became the
      easiest thing to hit by accident. The menu also gives the action a name,
      which an 11px cross never did.
    -->
    <Teleport to="body">
      <div
        v-if="menu"
        class="rail-menu"
        role="menu"
        data-rail-menu
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @pointerdown.stop
      >
        <button
          type="button"
          role="menuitem"
          class="rail-menu-item"
          :data-rail-close="menu.item.instanceId"
          @click="closeFromMenu"
        >
          <X :size="12" />
          <span>{{ menu.item.external ? t("app.stop") : t("app.closeSession") }}</span>
        </button>
      </div>
    </Teleport>
  </header>

  <!--
    Creating a session from the bar.

    It is a form, so it is a dialog (the app's rule for every write): the name is
    the only field, and a dialog puts the focus in it and the verdict one click
    away instead of opening a second surface inside a row of chips.

    The page opens as soon as the name is accepted — creating a session from this
    bar means "I want to browse as someone else", and leaving the user with a new
    chip and no window would be answering a question they did not ask.
  -->
  <Modal
    v-if="creating"
    :open="true"
    :title="t('app.sessionCreateHere')"
    width="380px"
    @close="creating = false"
  >
    <form class="create-form" @submit.prevent="submitCreate">
      <FormField :label="t('app.sessionNameLabel')">
        <TextField
          v-model="createName"
          type="text"
          maxlength="60"
          :placeholder="t('app.sessionNamePlaceholder')"
          data-rail-session-name
        />
      </FormField>
      <p v-if="createError" class="create-error" role="alert">{{ createError }}</p>
    </form>
    <template #footer>
      <span class="spacer"></span>
      <AppButton @click="creating = false">{{ t("app.cancel") }}</AppButton>
      <AppButton variant="primary" data-rail-session-create @click="submitCreate">
        {{ t("app.sessionCreate") }}
      </AppButton>
    </template>
  </Modal>
</template>

<style scoped>
/*
 * 账号条：窗口首行左半，横向一排条目。
 *
 * 它原来是左栏里的一列，从地址栏下面一直排到窗口底部。那列长期占着页面一条
 * 像素，却仍然只能显示十个字左右的名字；而首行当时除标签外什么都没有——浏览器
 * 里这一带本来就是花在「我是谁」上的。
 *
 * 宽度由内容决定，上限是窗口的一半：一屏宽度里，页面与账号条谁更重要会随窗口
 * 变化，而「一半」是两者都不至于被挤没的地方。超过上限横向滚动，而不是压扁条目
 * ——压扁会让每个名字都变成两三个字加省略号，等于全都读不出来。
 *
 * 空白处是拖拽区（浮层打开时由 `data-floating` 收回，见 base.css）；
 * 条目与按钮都是 `no-drag`。
 */
.account-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  /* Half the window, whatever the contents want. A bar sized purely by its
     contents would eat the tab strip on the first wide workspace. */
  max-width: 50vw;
  height: 100%;
  padding: 0 2px 0 4px;
}

/* 两个入口：图标按钮，和条目同高，靠一条竖线与条目分开。 */
.bar-doors {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.bar-door {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
  color: var(--faint);
  background: transparent;
}

.bar-door:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}

/* 面板开着时入口留一个标记：填色会读成「这个账号在跑」，而 Open 态说的是
   这颗按钮开的东西正开着。 */
.bar-door.active {
  color: var(--accent);
}

.bar-door.active:hover {
  color: var(--accent);
}

.bar-sep {
  width: 1px;
  height: 16px;
  margin: 0 5px 0 3px;
  background: var(--line);
  flex: 0 0 1px;
}

/*
 * 条目区：唯一可以横向滚动的部分。
 *
 * `overflow-x: auto` 而不是 `hidden`：条目多到超过半屏时，用户要能自己找到后面
 * 的账号。滚动条按需出现（`scrollbar-width: thin`），常态不占高度。
 */
.bar-list {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  flex: 0 1 auto;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}

.bar-list::-webkit-scrollbar {
  height: 3px;
}

.bar-list::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 2px;
}

/*
 * 一个条目：站点头像 + 账号名 + 状态角标。
 *
 * 宽度由内容撑开（`flex: 0 0 auto`），上限 220px：名字长了会截断而不是把整条
 * 挤成一条缝，短名字也不会留一块空白。高度与首行同高，选中用填充表达。
 */
.rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px 0 5px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
  flex: 0 0 auto;
  min-width: 0;
  max-width: 220px;
}

.rail-item:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}

.rail-item.on-stage {
  background: var(--selected);
  color: var(--text);
}

/*
 * 头像就是站点：有 favicon 用 favicon，没有就用站点名首字。
 *
 * 固定方块，两种来源共用一个盒子，图标晚到时条目不会跳。
 */
.avatar {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
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
  flex: 0 1 auto;
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
 * Positioned against the item, not the avatar, because the avatar is an 18px
 * square with `overflow: hidden` for the favicon — a badge inside it would be
 * clipped. The item is `position: relative`, and the offsets below are the
 * avatar's own box (5px padding + 18px) so the dot lands on its bottom-right
 * corner.
 */
.ai-dot {
  position: absolute;
  left: 17px;
  bottom: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  /* A ring in the bar's own colour, so the dot reads as sitting on the avatar
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
  right: 3px;
  bottom: 2px;
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

/*
 * 条目的右键菜单。
 *
 * Teleported to `<body>` so it is not clipped by the bar's own scroll container —
 * a menu opened on a chip near the right edge would otherwise be cut off at the
 * list's boundary.
 */
.rail-menu {
  position: fixed;
  z-index: var(--z-inline-menu);
  min-width: 132px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  animation: rail-menu-in var(--motion-fast) var(--ease-out);
}

@keyframes rail-menu-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
}

.rail-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
}

.rail-menu-item:hover {
  background: color-mix(in srgb, var(--red) 14%, transparent);
  color: var(--text);
}

.rail-menu-item svg {
  color: var(--faint);
  flex: 0 0 auto;
}

.rail-menu-item:hover svg {
  color: var(--red);
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.create-error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}
</style>
