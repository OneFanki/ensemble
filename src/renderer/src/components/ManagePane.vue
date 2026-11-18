<script setup lang="ts">
/**
 * The management pane: sites, accounts, AI activity and settings in one place.
 *
 * The browser page's [管理] button opens it; the arrow in its band goes back.
 * Inside, a column of sections stands in for the retired top-level navigation —
 * the four standing sections (站点 / 账号 / AI 记录 / 设置) first, then the
 * quieter ones (书签 / 标签 / 消息) below a rule. Each section renders its page
 * component as-is: the pane is where they live now, not a re-implementation.
 *
 * The section is owned by the shell (`section` prop) so the pane's state
 * survives closing and reopening, and so the app menu, the AI panel and the
 * bell can all land the user on a specific section without threading a
 * handler through this component.
 */
import type { LoginCaptureNotice } from "@shared/types";
import type { UpdateCheckResult } from "@shared/update";
import { ChevronLeft } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import SitesPage from "./SitesPage.vue";
import IdentitiesPage from "./IdentitiesPage.vue";
import AiActivityPage from "./AiActivityPage.vue";
import SettingsPage, { type SettingsSection } from "./SettingsPage.vue";
import BookmarksPage from "./BookmarksPage.vue";
import TagsPage from "./TagsPage.vue";
import MessagesPage from "./MessagesPage.vue";

export type ManageSection =
  | "sites"
  | "identities"
  | "ai"
  | "settings"
  | "bookmarks"
  | "tags"
  | "messages";

defineProps<{
  /** The section on screen; the shell owns the value. */
  section: ManageSection;
  /** Settings' own requested tab (the AI entry and the native menu ask for one). */
  settingsSection?: SettingsSection;
  /** Bumped per request, so a repeated request for the same tab still lands. */
  settingsSectionSeq?: number;
}>();

const emit = defineEmits<{
  /** Back to the browser: the band's arrow. */
  close: [];
  /** A section was chosen inside the pane; the shell records it. */
  navigate: [section: ManageSection];
  /** Settings changed the theme or locale; the shell applies it. */
  theme: [theme: "dark" | "light" | "system"];
  locale: [locale: "system" | "zh" | "en"];
  updateFound: [result: UpdateCheckResult];
  /** Page actions, forwarded to the shell which owns the dialogs. */
  newSite: [];
  editSite: [siteId?: string];
  openSite: [siteId: string];
  addIdentity: [siteId?: string];
  newIdentity: [siteId?: string];
  editIdentity: [identityId: string];
  sessionHealth: [];
  saveCapture: [notice: LoginCaptureNotice];
}>();

const { t } = useI18n();

/**
 * The pane's sections, in display order.
 *
 * The data attribute (`data-manage-item`) is what the e2e navigation library
 * addresses, and it keeps the names the destinations have always had.
 */
const SECTIONS: Array<{ id: ManageSection; labelKey: string }> = [
  { id: "sites", labelKey: "app.sites" },
  { id: "identities", labelKey: "app.identities" },
  { id: "ai", labelKey: "app.aiActivityTitle" },
  { id: "settings", labelKey: "app.settings" },
];

/** The quieter destinations, listed below the rule. */
const MORE_SECTIONS: Array<{ id: ManageSection; labelKey: string }> = [
  { id: "bookmarks", labelKey: "app.bookmarks" },
  { id: "tags", labelKey: "app.tags" },
  { id: "messages", labelKey: "app.messages" },
];
</script>

<template>
  <section class="manage-pane" data-manage-pane>
    <!--
      The band the native window controls own, and the way back. Same height as
      the browser's rows, so switching between the browser and the pane does not
      move the window's own buttons.
    -->
    <header class="manage-band drag-region">
      <button
        type="button"
        class="pane-back no-drag"
        :aria-label="t('app.backToBrowser')"
        v-tooltip="t('app.backToBrowser')"
        data-nav="browser"
        @click="emit('close')"
      >
        <ChevronLeft :size="14" />
      </button>
      <span class="manage-title">{{ t("app.railManage") }}</span>
    </header>

    <div class="manage-body">
      <nav class="manage-side" role="tablist" :aria-label="t('app.railManage')">
        <button
          v-for="entry in SECTIONS"
          :key="entry.id"
          type="button"
          role="tab"
          class="manage-item"
          :class="{ active: section === entry.id }"
          :aria-selected="section === entry.id"
          :data-manage-item="entry.id"
          @click="emit('navigate', entry.id)"
        >
          {{ t(entry.labelKey) }}
        </button>
        <div class="manage-rule" role="separator"></div>
        <button
          v-for="entry in MORE_SECTIONS"
          :key="entry.id"
          type="button"
          role="tab"
          class="manage-item"
          :class="{ active: section === entry.id }"
          :aria-selected="section === entry.id"
          :data-manage-item="entry.id"
          @click="emit('navigate', entry.id)"
        >
          {{ t(entry.labelKey) }}
        </button>
      </nav>

      <div class="manage-main">
        <SitesPage
          v-if="section === 'sites'"
          @new-site="emit('newSite')"
          @edit-site="emit('editSite', $event)"
          @open-site="emit('openSite', $event)"
          @add-identity="emit('addIdentity', $event)"
        />
        <IdentitiesPage
          v-else-if="section === 'identities'"
          @new-identity="emit('newIdentity', $event)"
          @edit-identity="emit('editIdentity', $event)"
          @session-health="emit('sessionHealth')"
        />
        <AiActivityPage v-else-if="section === 'ai'" />
        <SettingsPage
          v-else-if="section === 'settings'"
          embedded
          :section="settingsSection"
          :section-seq="settingsSectionSeq"
          @theme="emit('theme', $event)"
          @locale="emit('locale', $event)"
          @update-found="emit('updateFound', $event)"
        />
        <BookmarksPage v-else-if="section === 'bookmarks'" />
        <TagsPage v-else-if="section === 'tags'" />
        <MessagesPage v-else @save-capture="emit('saveCapture', $event)" />
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * The pane holds the whole area under the window's top edge when the browser
 * is not showing, the same way a management page used to: opaque above the
 * parked guests, stacked by number rather than by arrival order.
 */
.manage-pane {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--content);
  position: relative;
  z-index: 2;
  overflow: hidden;
}

/*
 * The caption band above the pane. Same height as the browser's rows, so
 * switching between the browser and the pane does not move the window's own
 * buttons; the right padding reserves the caption area on Windows/Linux.
 */
.manage-band {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--titlebar-height);
  padding-right: var(--window-controls-width, 138px);
  background: var(--frame);
}

/* The way back to the browser, at the band's leading edge. */
.pane-back {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  margin-left: 6px;
  border-radius: var(--radius);
  color: var(--muted);
}

.pane-back:hover {
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
}

.manage-title {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.manage-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

/*
 * The section column. It replaces the retired top-level navigation; the four
 * standing sections come first and the quieter ones sit below a rule, so the
 * order on screen says which are which without a caption saying it.
 */
.manage-side {
  flex: 0 0 168px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border-right: 1px solid var(--line-soft);
  background: var(--frame);
  overflow-y: auto;
}

.manage-item {
  display: flex;
  align-items: center;
  height: 30px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
  white-space: nowrap;
}

.manage-item:hover {
  background: var(--surface-3);
  color: var(--text);
}

.manage-item.active {
  background: var(--selected);
  color: var(--text);
}

.manage-rule {
  height: 1px;
  margin: 6px 4px;
  background: var(--line-soft);
  flex: 0 0 auto;
}

/* The section's page fills the rest; `.page` is a flex frame already. */
.manage-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
