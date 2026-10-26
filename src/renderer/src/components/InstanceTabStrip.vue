<script setup lang="ts">
/**
 * The pages of one browser instance, as a tab strip.
 *
 * This lived inline in the slot header, which meant the flat stage — the default
 * tab group — had no strip at all: no way to see or switch an instance's pages,
 * no place for the "+", and no right-click menu. The stage and a view cell hold
 * the same thing (one instance), so they have to offer the same controls.
 *
 * The class names are the same as when this was inline (`slot-tab*`): they are
 * what the design doc and the end-to-end checks address, and the point of the
 * move was to share one strip between the two places, not to invent a second
 * vocabulary for it.
 */
import type { EmbeddedTab } from "@shared/embedded";
import { Plus, X } from "lucide-vue-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";

const props = defineProps<{
  /** Root page id of the instance; every page of it is listed. */
  instanceId: string | null;
  /**
   * Which page the instance is showing. Passed in rather than derived so the
   * caller and the strip cannot disagree while the state is being replaced.
   */
  currentId?: string | undefined;
}>();

const emit = defineEmits<{
  /** A page was picked; the caller decides whether that also focuses the cell. */
  select: [pageId: string];
  /** Right-clicked a page; the caller freezes the stage and opens its menu. */
  menu: [page: EmbeddedTab, event: MouseEvent];
}>();

const store = useEmbeddedStore();
const { t } = useI18n();

const pages = computed<EmbeddedTab[]>(() =>
  props.instanceId ? store.instancePages(props.instanceId) : [],
);

/** "+" adds a page to this instance; it must never open a second window. */
function addPage(): void {
  if (props.instanceId) void store.openTabInInstance(props.instanceId);
}
</script>

<template>
  <div class="slot-tabs" role="tablist" :aria-label="t('app.browserInstancePages')">
    <div
      v-for="page in pages"
      :key="page.id"
      class="slot-tab"
      :class="{ current: page.id === currentId }"
      role="tab"
      :aria-selected="page.id === currentId"
      :data-tab-id="page.id"
      :title="page.url"
      @click.stop="emit('select', page.id)"
      @mousedown.stop
      @contextmenu.prevent.stop="emit('menu', page, $event)"
    >
      <img
        v-if="page.favicon"
        class="slot-tab-fav"
        :src="page.favicon"
        alt=""
        draggable="false"
      />
      <span class="slot-tab-label">{{ store.titleOf(page) }}</span>
      <button
        type="button"
        class="slot-tab-close"
        :aria-label="t('app.browserCloseTab')"
        :data-close-tab="page.id"
        @click.stop="store.closeTab(page.id)"
        @mousedown.stop
      >
        <X :size="9" />
      </button>
    </div>
    <button
      type="button"
      class="slot-tab-add"
      :aria-label="t('app.browserNewTabHere')"
      @click.stop="addPage"
      @mousedown.stop
    >
      <Plus :size="11" />
    </button>
  </div>
</template>

<style scoped>
.slot-tabs {
  position: relative;
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.slot-tabs::-webkit-scrollbar {
  display: none;
}

/*
 * A page tab. Unselected tabs used to be transparent text on the header's own
 * background, which made the strip indistinguishable from the slot label. They
 * now sit in their own recessed pill, the current one is raised and lit, so the
 * band reads as "window title, then tabs" at a glance.
 */
.slot-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 54px;
  max-width: 170px;
  height: 20px;
  padding: 0 4px 0 6px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  font-size: 10px;
  line-height: 18px;
  color: var(--faint);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

/* Site mark, the way every browser tab strip carries one: it survives a
   truncated title and tells two pages of the same site apart from two sites. */
.slot-tab-fav {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  border-radius: 2px;
  object-fit: contain;
}

.slot-tab:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.slot-tab.current {
  background: var(--bg-elevated);
  border-color: color-mix(in srgb, var(--line) 80%, var(--accent));
  color: var(--text);
}

.slot-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The close affordance appears on hover and on the current tab: always-on
   crosses in a 20px pill would eat the title. */
.slot-tab-close {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  color: var(--faint);
  opacity: 0;
  flex: 0 0 14px;
}

.slot-tab:hover .slot-tab-close,
.slot-tab.current .slot-tab-close {
  opacity: 1;
}

.slot-tab-close:hover {
  background: color-mix(in srgb, var(--red) 22%, transparent);
  color: var(--red);
}

.slot-tab-add {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--faint);
  flex: 0 0 18px;
}

.slot-tab-add:hover {
  background: var(--surface-3);
  color: var(--text);
}
</style>
