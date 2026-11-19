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
 * 视图切换放在浮层的标题栏里，不在页面正文里：它选的是「浮层的哪一面」，那是
 * 关于浮层本身的事实。切到编辑面时标题栏右侧会多出「新建账号」等写操作——放在
 * 标题栏就不会把正文顶下去。
 */
import type { LoginCaptureNotice } from "@shared/types";
import { Globe, LayoutGrid, Pencil, Plus } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import IdentitiesPage from "./IdentitiesPage.vue";
import FloatingPane from "./ui/FloatingPane.vue";
import AppButton from "./ui/AppButton.vue";

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
</script>

<template>
  <FloatingPane v-if="layer" :label="title" @close="emit('close')">
    <template #head>
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
        </button>
      </div>
      <!-- The write actions ride in the same head as the face switch: on the edit
           face they are the pane's primary action, and giving them their own row
           under a 36px head left a near-empty band above the filters. -->
      <template v-if="mode === 'edit'">
        <AppButton variant="primary" data-new-account @click="emit('newIdentity')">
          <Plus :size="13" />
          {{ t("app.newIdentity") }}
        </AppButton>
        <button
          type="button"
          class="head-icon"
          :aria-label="t('app.newSite')"
          :title="t('app.newSite')"
          data-new-site
          @click="emit('newSite')"
        >
          <Globe :size="13" />
        </button>
      </template>
    </template>
    <IdentitiesPage
      ref="page"
      @new-site="emit('newSite')"
      @edit-site="emit('editSite', $event)"
      @new-identity="emit('newIdentity', $event)"
      @edit-identity="emit('editIdentity', $event)"
      @session-health="emit('sessionHealth')"
    />
  </FloatingPane>
</template>

<style scoped>
.mode-switch {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.mode {
  display: grid;
  place-items: center;
  width: 22px;
  height: 20px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.mode:hover {
  color: var(--text-secondary);
}

.mode.on {
  background: var(--surface-3);
  color: var(--text);
}

/* The site door: same target size as the face switch, quieter than the primary
   button beside it. */
.head-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.head-icon:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}
</style>
