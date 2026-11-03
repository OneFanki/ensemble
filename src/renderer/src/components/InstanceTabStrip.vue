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
import { Minimize2, Plus, X } from "lucide-vue-next";
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
  /**
   * True when this instance occupies more than one cell of the view.
   *
   * Then the strip stops being a page switcher and becomes a label: the cell is
   * already pinned to one page, and showing the full page list in both cells made
   * the two strips identical — the user could not tell which page each cell was
   * actually displaying, and clicking a pill in one cell looked like it changed
   * both. The remaining controls are the current page and a way back to
   * "un-split, one cell follows the instance".
   */
  split?: boolean;
}>();

const emit = defineEmits<{
  /** A page was picked; the caller decides whether that also focuses the cell. */
  select: [pageId: string];
  /** Right-clicked a page; the caller freezes the stage and opens its menu. */
  menu: [page: EmbeddedTab, event: MouseEvent];
  /** This split cell should go back to following the instance. */
  merge: [];
}>();

const store = useEmbeddedStore();
const { t } = useI18n();

const allPages = computed<EmbeddedTab[]>(() =>
  props.instanceId ? store.instancePages(props.instanceId) : [],
);

/**
 * Pills to draw.
 *
 * Normally every page of the instance, because the strip is how a window's tabs
 * are switched. In a split the cell is already committed to one page, so only
 * that page is shown: two identical full strips were the visible symptom of the
 * split being invisible in the chrome.
 */
const pages = computed<EmbeddedTab[]>(() => {
  if (!props.split) return allPages.value;
  return allPages.value.filter((page) => page.id === props.currentId);
});

/**
 * A page can be dragged onto another cell.
 *
 * Dropping it there splits the instance: two cells of the same browser window
 * showing two different pages, which is how one account gets compared side by
 * side. The drag carries the *page* id, not the instance id — that difference is
 * what the drop handler reads to decide between "move this window here" (dock
 * rows drag instance roots) and "show this page in that cell".
 *
 * `dragTab` freezes the stage for the same reason the dock's drag does: native
 * pages swallow every drag event, so a cell only becomes a drop target while its
 * view is parked.
 */
function onDragStart(page: EmbeddedTab, event: DragEvent): void {
  store.dragTab(page.id);
  event.dataTransfer?.setData("text/plain", page.id);
  event.dataTransfer?.setData("application/x-ensemble-page", page.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd(): void {
  store.dragTab(null);
}

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
      draggable="true"
      @click.stop="emit('select', page.id)"
      @mousedown.stop
      @dragstart="onDragStart(page, $event)"
      @dragend="onDragEnd"
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
    <!--
      In a split the strip is a label, not a switcher: this cell shows exactly
      one page, and the way out is to give the cell back to the instance. A "+"
      here would add a page the cell cannot show, so it gives way to the merge
      control instead of sitting next to it doing something different.
    -->
    <button
      v-if="split"
      type="button"
      class="slot-tab-merge"
      :title="t('app.browserUnsplit')"
      :aria-label="t('app.browserUnsplit')"
      data-unsplit
      @click.stop="emit('merge')"
      @mousedown.stop
    >
      <Minimize2 :size="10" />
    </button>
    <button
      v-else
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
 * A page tab: text on the strip, and a fill only when it is the current one.
 *
 * Every tab used to sit in its own recessed pill and the current one was a
 * pill with a border — the raised/recessed pairing this shell is moving away
 * from. Browser tabs are the same surface as their strip; the current one is
 * simply brighter, which is how every browser does it and why this band now
 * reads as tabs rather than as a row of chips.
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
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
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
  border-color: var(--line-soft);
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

/* Same footprint as the "+" it replaces, so a split cell's strip does not
   reflow when the instance is split or merged. */
.slot-tab-merge {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 3px;
  color: var(--faint);
  flex: 0 0 18px;
}

.slot-tab-merge:hover {
  background: var(--surface-3);
  color: var(--text);
}
</style>
