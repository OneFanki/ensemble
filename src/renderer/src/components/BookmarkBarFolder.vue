<script setup lang="ts">
import type { Bookmark, BookmarkFolder } from "@shared/types";
import { ChevronDown, Folder, Globe } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useBookmarkFlyout } from "./bookmarkFlyout";

/**
 * One folder in the new-tab bookmark bar, with its flyout.
 *
 * Which panel is open is not this component's own state: the bar keeps one path
 * (see `bookmarkFlyout.ts`), so opening a sibling closes the previous branch
 * instead of stacking panels, while a child keeps its ancestors. The grace
 * period below still covers the one crossing the path cannot help with — the
 * pointer travelling from a row into that row's own panel.
 *
 * Rendered recursively: a folder's children are the same component one level
 * deeper, so the depth limit is the data's, not the markup's. `ancestors`
 * carries the path down so a folder whose parent chain loops back on itself
 * (corrupt data) ends at the first repeat instead of recursing forever.
 */
const props = defineProps<{
  folder: BookmarkFolder;
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
  /** 0 = a row in the bar itself; deeper levels open their flyout sideways. */
  level: number;
  ancestors: string[];
}>();

const emit = defineEmits<{
  open: [bookmark: Bookmark];
  /** Right-click: the bar owns the menu, this only reports which row. */
  menu: [entity: { kind: "folder" | "bookmark"; id: string }, event: MouseEvent];
}>();

const { t } = useI18n();

const flyout = useBookmarkFlyout();
/** Used only when this row is rendered outside a bar. */
const localOpen = ref(false);
const open = computed(() =>
  flyout ? flyout.path.value.includes(props.folder.id) : localOpen.value,
);
/** Open to the left instead of the right when there is no room. */
const flip = ref(false);
const root = ref<HTMLElement | null>(null);

interface Entry {
  kind: "folder" | "bookmark";
  order: number;
  folder?: BookmarkFolder;
  bookmark?: Bookmark;
}

/** Children in stored order, folders and bookmarks interleaved by sort key. */
const children = computed<Entry[]>(() => {
  const out: Entry[] = [];
  for (const folder of props.folders) {
    if (folder.parentId !== props.folder.id) continue;
    if (props.ancestors.includes(folder.id)) continue;
    out.push({ kind: "folder", order: folder.order, folder });
  }
  for (const bookmark of props.bookmarks) {
    if (bookmark.folderId === props.folder.id) {
      out.push({ kind: "bookmark", order: bookmark.order, bookmark });
    }
  }
  return out.sort((left, right) => left.order - right.order);
});

function show(): void {
  cancelClose();
  // Measured on entry, not on every frame: the flyout is 220px wide, so a row
  // in the right third of the window has to open towards the middle.
  const rect = root.value?.getBoundingClientRect();
  flip.value = Boolean(rect && rect.left + 240 > window.innerWidth);
  if (flyout) flyout.open(props.folder.id, props.ancestors);
  else localOpen.value = true;
}

/**
 * Start the grace period.
 *
 * When this row lost the pointer because another folder opened, the shared path
 * no longer contains it and there is nothing to wait for — the reopen below is
 * guarded by the path, so this timer only ever runs for the one journey it is
 * meant for: leaving a row towards its own panel across the gap.
 */
function hide(): void {
  cancelClose();
  closeTimer = window.setTimeout(() => {
    closeTimer = 0;
    if (flyout) flyout.close(props.folder.id);
    else localOpen.value = false;
  }, 180);
}

let closeTimer = 0;

function cancelClose(): void {
  if (!closeTimer) return;
  window.clearTimeout(closeTimer);
  closeTimer = 0;
}

onBeforeUnmount(cancelClose);

function toggle(): void {
  cancelClose();
  if (open.value) {
    if (flyout) flyout.close(props.folder.id);
    else localOpen.value = false;
    return;
  }
  if (flyout) flyout.open(props.folder.id, props.ancestors);
  else localOpen.value = true;
}

function pick(bookmark: Bookmark): void {
  flyout?.closeAll();
  localOpen.value = false;
  emit("open", bookmark);
}
</script>

<template>
  <div
    ref="root"
    class="bb-folder"
    :class="{ 'level-root': level === 0 }"
    @mouseenter="show"
    @mouseleave="hide"
  >
    <button
      type="button"
      class="bb-entry"
      :aria-expanded="open"
      :aria-haspopup="true"
      :title="folder.name"
      @click="toggle"
      @contextmenu.prevent.stop="emit('menu', { kind: 'folder', id: folder.id }, $event)"
      @keydown.esc="hide"
    >
      <Folder :size="13" class="bb-icon folder-icon" aria-hidden="true" />
      <span class="bb-name">{{ folder.name }}</span>
      <ChevronDown :size="10" class="bb-chev" :class="{ open }" aria-hidden="true" />
    </button>
    <Transition name="bb-pop">
      <div
        v-if="open"
        class="bb-flyout"
        :class="{ flip }"
        role="menu"
        :aria-label="folder.name"
      >
        <template v-for="entry in children" :key="entry.kind === 'folder' ? `f:${entry.folder!.id}` : `b:${entry.bookmark!.id}`">
          <BookmarkBarFolder
            v-if="entry.kind === 'folder'"
            :folder="entry.folder!"
            :bookmarks="bookmarks"
            :folders="folders"
            :level="level + 1"
            :ancestors="[...ancestors, folder.id]"
            @open="emit('open', $event)"
            @menu="(entity, event) => emit('menu', entity, event)"
          />
          <button
            v-else
            type="button"
            role="menuitem"
            class="bb-entry bb-row"
            :title="`${entry.bookmark!.name}\n${entry.bookmark!.url}`"
            @click="pick(entry.bookmark!)"
            @contextmenu.prevent.stop="emit('menu', { kind: 'bookmark', id: entry.bookmark!.id }, $event)"
          >
            <img
              v-if="entry.bookmark!.favicon"
              class="bb-icon favicon"
              :src="entry.bookmark!.favicon"
              alt=""
              draggable="false"
            />
            <Globe v-else :size="13" class="bb-icon" aria-hidden="true" />
            <span class="bb-name">{{ entry.bookmark!.name }}</span>
          </button>
        </template>
        <p v-if="!children.length" class="bb-empty">{{ t("app.bookmarkFolderEmpty") }}</p>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.bb-folder {
  position: relative;
  flex: 0 0 auto;
}

.bb-folder.level-root {
  height: 100%;
  display: flex;
}

.bb-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  white-space: nowrap;
  max-width: 190px;
}

.bb-entry:hover {
  background: var(--selected);
  color: var(--text);
}

.bb-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

.folder-icon {
  color: var(--muted);
}

.favicon {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  object-fit: contain;
}

.bb-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bb-chev {
  flex: 0 0 auto;
  color: var(--faint);
  transition: transform var(--motion-base) var(--ease-out);
}

.bb-chev.open {
  transform: rotate(180deg);
}

/* Inside a flyout the rows are full-width and the chevron points sideways: the
   child panel opens beside the row, not under it. */
.bb-folder:not(.level-root) > .bb-entry {
  width: 100%;
  max-width: none;
  height: 26px;
}

.bb-folder:not(.level-root) > .bb-entry .bb-chev {
  margin-left: auto;
  transform: rotate(-90deg);
}

.bb-folder:not(.level-root) > .bb-entry .bb-chev.open {
  transform: rotate(-90deg);
}

/* The panel is a child of the row, which is what keeps the row hovered while
   the pointer is inside it. */
.bb-flyout {
  position: absolute;
  z-index: 6;
  top: calc(100% + 4px);
  left: 0;
  min-width: 184px;
  max-width: 260px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.bb-flyout.flip {
  left: auto;
  right: 0;
}

/*
 * An invisible bridge over the gap between a row and its panel.
 *
 * The panel starts 4px below (or beside) the row, and an immediate close on
 * `mouseleave` fired during that crossing — the pointer was over neither
 * element, so the panel vanished just as the user moved towards it. The strip
 * belongs to the panel, so crossing it keeps the panel hovered; the grace timer
 * in `hide()` covers diagonal moves it does not reach.
 */
.bb-flyout::before {
  content: "";
  position: absolute;
  top: -6px;
  bottom: 100%;
  left: -8px;
  right: -8px;
}

/* Past the first level the flyout opens beside its row rather than below it:
   stacked panels marching down the screen would cover the parent's siblings. */
.bb-folder:not(.level-root) > .bb-flyout {
  top: -4px;
  left: calc(100% + 4px);
}

/* Beside, not below: the bridge moves to the panel's left edge. */
.bb-folder:not(.level-root) > .bb-flyout::before {
  top: -4px;
  bottom: -4px;
  left: -6px;
  right: 100%;
}

.bb-folder:not(.level-root) > .bb-flyout.flip {
  left: auto;
  right: calc(100% + 4px);
}

.bb-folder:not(.level-root) > .bb-flyout.flip::before {
  top: -4px;
  bottom: -4px;
  left: 100%;
  right: -6px;
}

.bb-row {
  width: 100%;
  max-width: none;
  height: 26px;
  justify-content: flex-start;
  text-align: left;
}

.bb-empty {
  margin: 0;
  padding: 7px 9px;
  font-size: 11px;
  color: var(--faint);
  white-space: nowrap;
}

/* Enter and leave both animate so a hover chain reads as moving, not swapping. */
.bb-pop-enter-active {
  animation: bb-in var(--motion-base) var(--ease-out);
}

.bb-pop-leave-active {
  animation: bb-out 100ms ease-in forwards;
  pointer-events: none;
}

@keyframes bb-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.985);
  }
}

@keyframes bb-out {
  to {
    opacity: 0;
    transform: translateY(-4px) scale(0.99);
  }
}
</style>
