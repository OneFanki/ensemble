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
 */
import type { LoginCaptureNotice } from "@shared/types";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import IdentitiesPage from "./IdentitiesPage.vue";
import FloatingPane from "./ui/FloatingPane.vue";

/**
 * 能当浮层打开的目的地。
 *
 * 只剩账号：左栏底部也只有它这一个入口。类型收窄到这里，是因为再没有任何
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
</script>

<template>
  <FloatingPane v-if="layer" :label="title" @close="emit('close')">
    <IdentitiesPage
      @new-site="emit('newSite')"
      @edit-site="emit('editSite', $event)"
      @new-identity="emit('newIdentity', $event)"
      @edit-identity="emit('editIdentity', $event)"
      @session-health="emit('sessionHealth')"
    />
  </FloatingPane>
</template>
