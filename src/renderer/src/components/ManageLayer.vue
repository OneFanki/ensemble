<script setup lang="ts">
/**
 * 管理浮层的内容：账号。
 *
 * 壳（`ui/FloatingPane.vue`）只管遮罩、Esc 与让位，这里决定哪一页进去。账号页
 * 原样嵌入，不重新实现——浮层是它的容身之处。
 *
 * 站点不再是独立的一层：一个账号本来就属于一个站点，站点因此以分组头的形式
 * 长在账号页里，站点的增删改也从那里发起。书签、消息、流程与站点分组是内容，
 * 住在设置页里；AI 记录的全量视图由地址栏的 AI 面板打开。
 *
 * 标题栏只放两样东西：标题，和「这一面是什么」的开关。写操作（新建账号、新建
 * 站点）挪进了账号页自己的操作行——它们改的是那份清单，和筛选、批量选择是同一
 * 类动作，跟清单待在一起比挂在标题栏上更说得通。更实际的理由是：它们只在编辑
 * 面存在，放在标题栏里就会在切换时把右侧挤出一截，开关跟着位移。
 */
import type { LoginCaptureNotice } from "@shared/types";
import { LayoutGrid, Pencil } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import IdentitiesPage from "./IdentitiesPage.vue";
import FloatingPane from "./ui/FloatingPane.vue";

/**
 * 能当浮层打开的目的地。
 *
 * 只剩账号：左栏顶部也只有它这一个入口。类型收窄到这里，是因为再没有任何
 * 调用方需要打开第二种浮层。
 */
export type ManageLayerId = "identities";

const props = defineProps<{
  /** 当前浮层；`null` 表示没开。 */
  layer: ManageLayerId | null;
}>();

const emit = defineEmits<{
  close: [];
  newSite: [];
  editSite: [siteId?: string];
  newIdentity: [siteId?: string];
  editIdentity: [identityId: string];
  sessionHealth: [];
  saveCapture: [notice: LoginCaptureNotice];
}>();

const { t } = useI18n();

const title = computed(() => t("app.railAccounts"));

/** The pane's face; the page holds it, the head draws the switch for it. */
const page = ref<InstanceType<typeof IdentitiesPage> | null>(null);
const mode = computed(() => page.value?.mode ?? "use");

function setMode(next: "use" | "edit"): void {
  page.value?.setMode(next);
}

/*
 * Every opening starts on the launch face.
 *
 * The pane is mounted for the window's lifetime now, so its page keeps whatever
 * face it was last left on — and a pane that reopens in edit mode is the wrong
 * default: opening it is almost always "which account do I open now". Resetting
 * on open (not on close) also means the face does not visibly flip while the
 * leave animation is still playing.
 */
watch(
  () => props.layer,
  (layer) => {
    if (layer) page.value?.setMode("use");
  },
);
</script>

<template>
  <!--
    Mounted for the window's lifetime, closed through the `open` prop.

    It used to be `v-if="layer"` here, which unmounted the whole component the
    instant the pane closed — so the pane's own `<Transition>` never reached its
    leave phase and the panel vanished in one frame. A `Transition` can only
    animate an element that is still mounted, so the closing state has to reach
    the shell before the component goes away.
  -->
  <FloatingPane :open="Boolean(layer)" :label="title" @close="emit('close')">
    <template #head>
      <!--
        The face switch is the head's only control, and it never moves.

        It used to share the right side with the write actions, which only exist
        on the edit face — so switching faces shoved the switch left by the width
        of two buttons. A control that jumps when you press it is the one thing a
        segmented switch cannot do: the pointer is resting on it and the eye is
        following it. The write actions moved into the page's own action row,
        which is where they belong anyway.
      -->
      <div class="mode-switch" role="group" :aria-label="t('app.accountMode')">
        <button
          type="button"
          class="mode"
          :class="{ on: mode === 'use' }"
          :aria-pressed="mode === 'use'"
          data-mode-use
          v-tooltip="t('app.accountModeUseHint')"
          @click="setMode('use')"
        >
          <LayoutGrid :size="13" />
          <span>{{ t("app.accountModeUse") }}</span>
        </button>
        <button
          type="button"
          class="mode"
          :class="{ on: mode === 'edit' }"
          :aria-pressed="mode === 'edit'"
          data-mode-edit
          v-tooltip="t('app.accountModeEditHint')"
          @click="setMode('edit')"
        >
          <Pencil :size="13" />
          <span>{{ t("app.accountModeEdit") }}</span>
        </button>
      </div>
    </template>
    <IdentitiesPage
      ref="page"
      @new-site="emit('newSite')"
      @edit-site="emit('editSite', $event)"
      @new-identity="emit('newIdentity', $event)"
      @edit-identity="emit('editIdentity', $event)"
      @session-health="emit('sessionHealth')"
      @launched="emit('close')"
    />
  </FloatingPane>
</template>

<style scoped>
/*
 * The face switch names its two faces.
 *
 * It was two icon-only buttons. A grid glyph and a pencil are guesses — the
 * pencil could be "edit this account" as easily as "edit this list", and the
 * grid could be "show a grid" — so the control explained itself only on hover.
 * The head has room for two short words; the icons stay as the leading marks.
 */
.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 9px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.mode:hover {
  color: var(--text-secondary);
}

.mode.on {
  background: var(--surface-3);
  color: var(--text);
}

/* The mark takes the weight of the state; the word stays a word. */
.mode.on svg {
  color: var(--accent);
}
</style>
