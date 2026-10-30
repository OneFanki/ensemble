<script setup lang="ts">
import type { Bookmark, BookmarkFolder } from "@shared/types";
import { Folder, Pencil, Trash2 } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

/**
 * The bookmark grid on a blank page.
 *
 * A bookmark is a name and an address, nothing more — it opens in the daily
 * profile, so a site the user is signed in to simply appears. That is the whole
 * difference from a site: a site is a login recipe that starts a session, a
 * bookmark is a place you already have a session for.
 *
 * Tiles are reorderable by dragging. The order is stored, not derived from the
 * name, because a grid the user arranged by hand must not reshuffle itself.
 */
const props = defineProps<{
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
}>();

const emit = defineEmits<{
  open: [bookmark: Bookmark];
  rename: [bookmark: Bookmark, name: string];
  remove: [bookmark: Bookmark];
  move: [bookmark: Bookmark, toIndex: number];
  /** Dropping a tile on a folder chip files it into that folder. */
  file: [bookmark: Bookmark, folderId: string];
}>();

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const editingId = ref<string | null>(null);
const draftName = ref("");
const menu = ref<{ bookmark: Bookmark; x: number; y: number } | null>(null);
const draggingId = ref<string | null>(null);
const dropIndex = ref<number | null>(null);

const count = computed(() => props.bookmarks.length);

watch(editingId, async (id) => {
  if (!id) return;
  await nextTick();
  // Found through the root rather than a template ref: a ref inside `v-for`
  // collects into an array, so focusing it directly would silently do nothing.
  const input = root.value?.querySelector<HTMLInputElement>(".tile-rename");
  input?.focus();
  input?.select();
});

/** Fails of anything that is not http(s) never reach here; the URL is stored. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A stable colour for a bookmark without an icon.
 *
 * Derived from the host rather than the index so a tile keeps its colour when
 * the grid is reordered, and two bookmarks on the same site look the same.
 */
function fallbackStyle(url: string): Record<string, string> {
  let hash = 0;
  const host = hostOf(url);
  for (let i = 0; i < host.length; i += 1) hash = (hash * 31 + host.charCodeAt(i)) % 360;
  return { background: `hsl(${hash} 42% 32%)`, color: "rgb(255 255 255 / 88%)" };
}

function initial(bookmark: Bookmark): string {
  const source = bookmark.name.trim() || hostOf(bookmark.url);
  return [...source][0]?.toUpperCase() ?? "?";
}

function startRename(bookmark: Bookmark): void {
  closeMenu();
  draftName.value = bookmark.name;
  editingId.value = bookmark.id;
}

function openTile(bookmark: Bookmark): void {
  if (editingId.value === bookmark.id) return;
  emit("open", bookmark);
}

function commitRename(bookmark: Bookmark): void {
  const name = draftName.value.trim();
  editingId.value = null;
  if (!name || name === bookmark.name) return;
  emit("rename", bookmark, name);
}

function openMenu(bookmark: Bookmark, event: MouseEvent): void {
  editingId.value = null;
  // Keep the menu inside the window: it is teleported to `body`, so a click on a
  // tile near the right or bottom edge would otherwise open it off-screen.
  const width = 132;
  const height = 74;
  menu.value = {
    bookmark,
    x: Math.min(event.clientX, window.innerWidth - width - 8),
    y: Math.min(event.clientY, window.innerHeight - height - 8),
  };
}

function closeMenu(): void {
  menu.value = null;
}

function onWindowPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest(".bookmark-menu")) return;
  closeMenu();
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeMenu();
}

watch(menu, (value) => {
  if (value) {
    window.addEventListener("pointerdown", onWindowPointerDown, true);
    window.addEventListener("keydown", onWindowKeydown, true);
  } else {
    window.removeEventListener("pointerdown", onWindowPointerDown, true);
    window.removeEventListener("keydown", onWindowKeydown, true);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onWindowPointerDown, true);
  window.removeEventListener("keydown", onWindowKeydown, true);
});

function renameFromMenu(): void {
  const bookmark = menu.value?.bookmark;
  closeMenu();
  if (bookmark) startRename(bookmark);
}

function removeFromMenu(): void {
  const bookmark = menu.value?.bookmark;
  closeMenu();
  if (bookmark) emit("remove", bookmark);
}

function onDragStart(bookmark: Bookmark, event: DragEvent): void {
  // Renaming in place and dragging do not mix: a text selection would start a
  // drag of the input instead of the tile.
  if (editingId.value) {
    event.preventDefault();
    return;
  }
  draggingId.value = bookmark.id;
  event.dataTransfer?.setData("text/plain", bookmark.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragOver(index: number, event: DragEvent): void {
  if (!draggingId.value) return;
  event.preventDefault();
  dropIndex.value = index;
}

function onDragLeave(index: number): void {
  if (dropIndex.value === index) dropIndex.value = null;
}

function onDrop(bookmark: Bookmark, index: number, event: DragEvent): void {
  event.preventDefault();
  const id = draggingId.value;
  draggingId.value = null;
  dropIndex.value = null;
  if (!id || id === bookmark.id) return;
  const moving = props.bookmarks.find((item) => item.id === id);
  if (!moving) return;
  // Dropping on a tile takes that tile's place, which is exactly the index the
  // service's splice-out-then-insert produces.
  emit("move", moving, index);
}

function onDragEnd(): void {
  draggingId.value = null;
  dropIndex.value = null;
}

/**
 * The strip shows the top level of the folder tree, one chip per folder that
 * has anything in it anywhere below. The tree itself stays on the management
 * page: a start page shows folders to filter by, and a nested outline there
 * would turn the grid into a file manager.
 */
const childrenMap = computed(() => {
  const map = new Map<string, string[]>();
  for (const folder of props.folders) {
    if (!folder.parentId) continue;
    const list = map.get(folder.parentId) ?? [];
    list.push(folder.id);
    map.set(folder.parentId, list);
  }
  return map;
});

/** A folder and every folder under it — a chip counts and filters the subtree. */
function subtreeIds(rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const current = stack.pop();
    for (const child of childrenMap.value.get(current ?? "") ?? []) {
      if (!ids.has(child)) {
        ids.add(child);
        stack.push(child);
      }
    }
  }
  return ids;
}

const chips = computed(() => {
  const out: Array<{ id: string; name: string; count: number }> = [];
  for (const folder of props.folders) {
    if (folder.parentId) continue;
    const ids = subtreeIds(folder.id);
    const count = props.bookmarks.filter(
      (bookmark) => bookmark.folderId && ids.has(bookmark.folderId),
    ).length;
    // An empty folder exists by choice now that folders are records, but the
    // strip answers "which folder has anything in it" — so it stays hidden.
    if (count === 0) continue;
    out.push({ id: folder.id, name: folder.name, count });
  }
  return out;
});

/** `null` means "all", which is what an untouched start page should show. */
const activeFolder = ref<string | null>(null);

// A filter pointing at a folder that no longer exists would silently show an
// empty grid, so it falls back to "all".
watch(
  () => props.folders,
  (list) => {
    if (activeFolder.value && !list.some((folder) => folder.id === activeFolder.value)) {
      activeFolder.value = null;
    }
  },
);

const shown = computed(() => {
  if (activeFolder.value === null) return props.bookmarks;
  const ids = subtreeIds(activeFolder.value);
  return props.bookmarks.filter((bookmark) => bookmark.folderId && ids.has(bookmark.folderId));
});

/**
 * Clicking the folder that is already open returns to "all".
 *
 * A filter with no way out except a separate "all" chip doubles the row for one
 * word, and people press the same chip twice before looking for it.
 */
function pickFolder(id: string | null): void {
  activeFolder.value = activeFolder.value === id ? null : id;
}

/** Chip the pointer is over while a tile is dragged, for the drop highlight. */
const dropChip = ref<string | null>(null);

function onDragOverChip(id: string, event: DragEvent): void {
  if (!draggingId.value) return;
  event.preventDefault();
  dropChip.value = id;
}

function onDropChip(id: string): void {
  const dragged = props.bookmarks.find((item) => item.id === draggingId.value);
  draggingId.value = null;
  dropChip.value = null;
  if (dragged) emit('file', dragged, id);
}
</script>

<template>
  <div v-if="count" ref="root" class="bookmark-area">
    <!-- Folder strip: the whole bar, or one top-level folder at a time. The
         count is part of the label because "which folder has anything in it"
         is the question this row exists to answer. -->
    <div v-if="chips.length" class="folder-strip" role="tablist">
      <button
        type="button"
        role="tab"
        class="folder-chip"
        :class="{ active: activeFolder === null }"
        :aria-selected="activeFolder === null"
        @click="pickFolder(null)"
      >
        {{ t("app.bookmarkAllFolders") }}
        <span class="folder-count mono">{{ count }}</span>
      </button>
      <button
        v-for="chip in chips"
        :key="chip.id"
        type="button"
        role="tab"
        class="folder-chip"
        :class="{ active: activeFolder === chip.id, drop: dropChip === chip.id }"
        :aria-selected="activeFolder === chip.id"
        @click="pickFolder(chip.id)"
        @dragover="onDragOverChip(chip.id, $event)"
        @dragleave="dropChip === chip.id ? dropChip = null : null"
        @drop.prevent="onDropChip(chip.id)"
      >
        <Folder :size="11" />
        {{ chip.name }}
        <span class="folder-count mono">{{ chip.count }}</span>
      </button>
    </div>

    <div class="bookmarks" :aria-label="t('app.bookmarks')">
      <button
        v-for="(bookmark, index) in shown"
        :key="bookmark.id"
        type="button"
        class="tile"
        :class="{ dragging: draggingId === bookmark.id, drop: dropIndex === index }"
        :title="`${bookmark.name}\n${bookmark.url}`"
        draggable="true"
        @click="openTile(bookmark)"
        @dblclick.prevent="startRename(bookmark)"
        @contextmenu.prevent.stop="openMenu(bookmark, $event)"
        @dragstart="onDragStart(bookmark, $event)"
        @dragover="onDragOver(index, $event)"
        @dragleave="onDragLeave(index)"
        @drop="onDrop(bookmark, index, $event)"
        @dragend="onDragEnd"
      >
        <span class="tile-icon" :style="bookmark.favicon ? {} : fallbackStyle(bookmark.url)">
          <img v-if="bookmark.favicon" :src="bookmark.favicon" alt="" draggable="false" />
          <span v-else class="tile-initial">{{ initial(bookmark) }}</span>
        </span>
        <input
          v-if="editingId === bookmark.id"
          v-model="draftName"
          class="tile-rename"
          type="text"
          maxlength="120"
          @click.stop
          @keydown.enter.prevent="commitRename(bookmark)"
          @keydown.esc.prevent="editingId = null"
          @blur="commitRename(bookmark)"
        />
        <span v-else class="tile-name">{{ bookmark.name }}</span>
      </button>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="menu" class="bookmark-menu" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button type="button" role="menuitem" class="menu-row" @click="renameFromMenu">
        <Pencil :size="11" />
        {{ t("app.bookmarkRename") }}
      </button>
      <button type="button" role="menuitem" class="menu-row danger" @click="removeFromMenu">
        <Trash2 :size="11" />
        {{ t("app.bookmarkRemove") }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* Folder strip + grid, as one block under the search box. */
.bookmark-area {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.folder-strip {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  margin-top: 14px;
}

.folder-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--faint);
  font-size: 11px;
  cursor: pointer;
}

.folder-chip:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}

.folder-chip.active {
  color: var(--text);
  border-color: var(--line);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
}

.folder-chip.drop {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.folder-count {
  font-size: 9.5px;
  color: var(--faint);
}

.bookmarks {
  /*
   * Full width, and that is load-bearing.
   *
   * The parent centres its children, which makes this element's width
   * `fit-content`. `repeat(auto-fill, …)` needs a definite width to compute how
   * many tracks fit, so with `fit-content` it resolves to a single column and the
   * whole grid stacks vertically under the search box. The tracks are centred by
   * `justify-content` below instead.
   */
  width: 100%;
  /*
   * Fixed-width columns, not `auto-fit`.
   *
   * `auto-fit` stretches the tracks to fill the row, so four bookmarks spread
   * across 560px as four huge islands with the search box floating above them.
   * A bookmark grid should read as a compact row of icons; the grid itself stays
   * centred under the search box.
   */
  display: grid;
  grid-template-columns: repeat(auto-fill, 92px);
  justify-content: center;
  gap: 2px;
  /* The box (or the folder strip) already sits above; a grid flush against it
     reads as part of that block rather than as its own. */
  margin-top: 10px;
}

.tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 10px 6px 9px;
  border-radius: var(--radius);
  border: 1px solid transparent;
  color: var(--text-secondary);
  text-align: center;
  min-width: 0;
}

.tile:hover {
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  border-color: var(--line-soft);
  color: var(--text);
}

/* The dragged tile and its landing spot are carried by the same pair of marks so
   the move reads as one gesture: the source fades, the target gets a rule. */
.tile.dragging {
  opacity: 0.45;
}

.tile.drop {
  border-color: color-mix(in srgb, var(--line) 40%, var(--accent));
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.tile-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  overflow: hidden;
  flex: 0 0 32px;
  background: color-mix(in srgb, var(--text) 9%, var(--surface));
}

.tile-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.tile-initial {
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
}

.tile-name {
  max-width: 100%;
  font-size: 11px;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}

.tile-rename {
  width: 100%;
  height: 18px;
  padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--line) 50%, var(--accent));
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 10.5px;
  text-align: center;
  outline: none;
}

.bookmark-menu {
  position: fixed;
  z-index: 90;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.menu-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
}

.menu-row:hover {
  background: var(--surface-2);
  color: var(--text);
}

.menu-row.danger:hover {
  background: color-mix(in srgb, var(--red) 14%, transparent);
  color: var(--red);
}
</style>
