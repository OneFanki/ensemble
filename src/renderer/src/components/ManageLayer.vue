<script setup lang="ts">
/**
 * 管理浮层的内容：站点 / 账号 / 更多。
 *
 * 壳（`ui/FloatingPane.vue`）只管遮罩、Esc 与让位，这里决定哪一页进去。三页
 * 都是原样嵌入，不重新实现——浮层是它们的容身之处。
 *
 * 同一时刻只挂一个浮层：`layer` 是一个值，不是一组布尔标志。切换就是换这个
 * 值，所以不会出现两层叠起来、后点的被前一层盖住的情况。
 */
import type { LoginCaptureNotice } from "@shared/types";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import AiActivityPage from "./AiActivityPage.vue";
import BookmarksPage from "./BookmarksPage.vue";
import IdentitiesPage from "./IdentitiesPage.vue";
import MessagesPage from "./MessagesPage.vue";
import SitesPage from "./SitesPage.vue";
import TagsPage from "./TagsPage.vue";
import FloatingPane from "./ui/FloatingPane.vue";

export type ManageLayerId = "sites" | "identities" | "more";

/**
 * 「更多」里的次级分区。
 *
 * 书签 / 标签 / 消息在这里各占一格；AI 记录暂时也挂在这里，等它有自己的
 * 浮层入口后再挪走。
 *
 * TODO(下一步): AI 记录接入自己的浮层入口（工具栏 AI 面板直达），并从「更多」
 * 里撤出。
 */
export type MoreTab = "bookmarks" | "tags" | "messages" | "ai";

const props = withDefaults(
  defineProps<{
    /** 当前浮层；`null` 表示没开。 */
    layer: ManageLayerId | null;
    /** 「更多」的当前分区；壳持有，外部可以点名直达某一页。 */
    moreTab?: MoreTab;
  }>(),
  { moreTab: "bookmarks" },
);

const emit = defineEmits<{
  close: [];
  newSite: [];
  editSite: [siteId?: string];
  openSite: [siteId: string];
  addIdentity: [siteId?: string];
  newIdentity: [siteId?: string];
  editIdentity: [identityId: string];
  sessionHealth: [];
  saveCapture: [notice: LoginCaptureNotice];
  /** 「更多」的分区被切换；壳记录，关开之间记住来时的位置。 */
  updateMoreTab: [tab: MoreTab];
}>();

const { t } = useI18n();

const title = computed(() => {
  switch (props.layer) {
    case "sites":
      return t("app.sites");
    case "identities":
      return t("app.identities");
    default:
      return t("app.more");
  }
});

const moreTabs: Array<{ id: MoreTab; labelKey: string }> = [
  { id: "bookmarks", labelKey: "app.bookmarks" },
  { id: "tags", labelKey: "app.tags" },
  { id: "messages", labelKey: "app.messages" },
  { id: "ai", labelKey: "app.aiActivityTitle" },
];
</script>

<template>
  <FloatingPane v-if="layer" :label="title" @close="emit('close')">
    <SitesPage
      v-if="layer === 'sites'"
      @new-site="emit('newSite')"
      @edit-site="emit('editSite', $event)"
      @open-site="emit('openSite', $event)"
      @add-identity="emit('addIdentity', $event)"
    />
    <IdentitiesPage
      v-else-if="layer === 'identities'"
      @new-identity="emit('newIdentity', $event)"
      @edit-identity="emit('editIdentity', $event)"
      @session-health="emit('sessionHealth')"
    />
    <div v-else class="more">
      <nav class="more-tabs" role="tablist" :aria-label="t('app.more')">
        <button
          v-for="tab in moreTabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="more-tab"
          :class="{ active: moreTab === tab.id }"
          :aria-selected="moreTab === tab.id"
          :data-more-tab="tab.id"
          @click="emit('updateMoreTab', tab.id)"
        >
          {{ t(tab.labelKey) }}
        </button>
      </nav>
      <div class="more-body">
        <BookmarksPage v-if="moreTab === 'bookmarks'" />
        <TagsPage v-else-if="moreTab === 'tags'" />
        <MessagesPage v-else-if="moreTab === 'messages'" @save-capture="emit('saveCapture', $event)" />
        <AiActivityPage v-else />
      </div>
    </div>
  </FloatingPane>
</template>

<style scoped>
/* 次级分区的页签：一行，和页面自己的头部同高，滚动区在它下面。 */
.more {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.more-tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px;
  height: 38px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--chrome);
}

.more-tab {
  height: 24px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.more-tab:hover {
  background: var(--surface-2);
  color: var(--text);
}

.more-tab.active {
  background: var(--selected);
  color: var(--text);
}

.more-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
