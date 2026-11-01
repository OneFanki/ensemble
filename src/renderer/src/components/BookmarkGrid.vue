<script setup lang="ts">
import type { Bookmark, BookmarkFolder } from "@shared/types";
import { ChevronDown, Folder, Pencil, Trash2 } from "lucide-vue-next";
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

function onDrop(bookmark: Bookmark, event: DragEvent): void {
  event.preventDefault();
  const id = draggingId.value;
  draggingId.value = null;
  dropIndex.value = null;
  if (!id || id === bookmark.id) return;
  const moving = props.bookmarks.find((item) => item.id === id);
  if (!moving) return;
  // Dropping on a tile takes that tile's place. The index resolves against the
  // full workspace order, not the visible level: the service splices the
  // stored array, and a level-filtered position would land the tile elsewhere.
  const targetIndex = props.bookmarks.findIndex((item) => item.id === bookmark.id);
  if (targetIndex >= 0) emit("move", moving, targetIndex);
}

function onDragEnd(): void {
  draggingId.value = null;
  dropIndex.value = null;
}

/**
 * The grid navigates one level at a time, like the management page.
 *
 * It used to show every bookmark in the workspace flat, which turned a browser
 * import — hundreds of bookmarks in a deep tree — into one endless page of
 * tiles. Now the current level's folders come first as tiles that drill in,
 * then that folder's own bookmarks; the strip above is a breadcrumb of the
 * open path and doubles as a drop target, so a tile dropped on a crumb is
 * filed into that folder.
 */
const path = ref<BookmarkFolder[]>([]);

const childrenMap = computed(() => {
  const map = new Map<string, BookmarkFolder[]>();
  for (const folder of props.folders) {
    if (!folder.parentId) continue;
    const list = map.get(folder.parentId) ?? [];
    list.push(folder);
    map.set(folder.parentId, list);
  }
  return map;
});

/** A folder and every folder under it — a tile's count covers the subtree. */
function subtreeIds(rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const current = stack.pop();
    for (const child of childrenMap.value.get(current ?? "") ?? []) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return ids;
}

/** Bookmark count in a folder's subtree — what entering the folder yields. */
function subtreeCount(folder: BookmarkFolder): number {
  const ids = subtreeIds(folder.id);
  return props.bookmarks.filter(
    (bookmark) => bookmark.folderId && ids.has(bookmark.folderId),
  ).length;
}

const currentFolder = computed(() => path.value[path.value.length - 1] ?? null);

/** Folders one level below the open path; the root lists top-level folders. */
const levelFolders = computed(() =>
  currentFolder.value
    ? (childrenMap.value.get(currentFolder.value.id) ?? [])
    : props.folders.filter((folder) => !folder.parentId),
);

/** The open folder's own bookmarks; at the root, the unfiled ones. */
const levelBookmarks = computed(() =>
  props.bookmarks.filter(
    (bookmark) => (bookmark.folderId ?? null) === (currentFolder.value?.id ?? null),
  ),
);

/** The strip's crumbs; the first one is always the root ("all"). */
const crumbs = computed(() => [
  { folder: null as BookmarkFolder | null },
  ...path.value.map((folder) => ({ folder })),
]);

function enter(folder: BookmarkFolder): void {
  openCrumb.value = null;
  path.value = [...path.value, folder];
}

/** Jump back to a crumb; index 0 clears the path. */
function jumpTo(index: number): void {
  openCrumb.value = null;
  path.value = path.value.slice(0, index);
}

/**
 * The caret on a crumb drops that level's child folders, so a deep tree is
 * crossable without walking in and back out: pick any sibling level directly.
 */
const openCrumb = ref<number | null>(null);

function crumbChildren(index: number): BookmarkFolder[] {
  const folder = crumbs.value[index]?.folder;
  return folder
    ? (childrenMap.value.get(folder.id) ?? [])
    : props.folders.filter((item) => !item.parentId);
}

function toggleCrumb(index: number): void {
  openCrumb.value = openCrumb.value === index ? null : index;
}

function jumpInto(index: number, child: BookmarkFolder): void {
  openCrumb.value = null;
  path.value = [...path.value.slice(0, index), child];
}

function onWindowPointerDownForCrumb(event: PointerEvent): void {
  if (event.target instanceof HTMLElement && event.target.closest(".crumb-wrap")) return;
  openCrumb.value = null;
}

watch(openCrumb, (value) => {
  if (value === null) {
    window.removeEventListener("pointerdown", onWindowPointerDownForCrumb, true);
  } else {
    window.addEventListener("pointerdown", onWindowPointerDownForCrumb, true);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onWindowPointerDownForCrumb, true);
});

// A path into a folder that no longer exists would dead-end, so it truncates
// back to the last survivor.
watch(
  () => props.folders,
  (list) => {
    const kept: BookmarkFolder[] = [];
    for (const folder of path.value) {
      if (!list.some((item) => item.id === folder.id)) break;
      kept.push(folder);
    }
    if (kept.length !== path.value.length) path.value = kept;
  },
);

/** Folder id the pointer is over while a tile is dragged, for the highlight. */
const dropFolder = ref<string | null>(null);

function onDragOverFolder(id: string, event: DragEvent): void {
  if (!draggingId.value) return;
  event.preventDefault();
  dropFolder.value = id;
}

function onDropIntoFolder(id: string): void {
  const dragged = props.bookmarks.find((item) => item.id === draggingId.value);
  draggingId.value = null;
  dropFolder.value = null;
  if (dragged) emit("file", dragged, id);
}
</script>

<template>
  <div v-if="count || folders.length" ref="root" class="bookmark-area">
    <!-- Breadcrumb of the open path; a dropped tile is filed into the crumb's
         folder (the root crumb unfiles). -->
    <nav v-if="crumbs.length > 1 || levelFolders.length" class="folder-strip" :aria-label="t('app.bookmarks')">
      <template v-for="(crumb, index) in crumbs" :key="crumb.folder?.id ?? 'root'">
        <span v-if="index > 0" class="crumb-sep">/</span>
        <span class="crumb-wrap">
          <button
            type="button"
            class="folder-chip"
            :class="{
              active: index === crumbs.length - 1,
              drop: dropFolder === (crumb.folder?.id ?? ''),
            }"
            :disabled="index === crumbs.length - 1"
            @click="jumpTo(index)"
            @dragover="onDragOverFolder(crumb.folder?.id ?? '', $event)"
            @dragleave="dropFolder === (crumb.folder?.id ?? '') ? (dropFolder = null) : null"
            @drop.prevent="onDropIntoFolder(crumb.folder?.id ?? '')"
          >
            {{ crumb.folder ? crumb.folder.name : t("app.bookmarkAllFolders") }}
          </button>
          <!-- The caret drops this level's children: cross a deep tree without
               walking in and back out. Hidden when the level has no folders. -->
          <button
            v-if="crumbChildren(index).length"
            type="button"
            class="crumb-caret"
            :class="{ open: openCrumb === index }"
            :aria-label="crumb.folder ? crumb.folder.name : t('app.bookmarkAllFolders')"
            :aria-expanded="openCrumb === index"
            @click.stop="toggleCrumb(index)"
          >
            <ChevronDown :size="10" />
          </button>
          <div v-if="openCrumb === index" class="crumb-menu" role="menu">
            <button
              v-for="child in crumbChildren(index)"
              :key="child.id"
              type="button"
              role="menuitem"
              class="crumb-menu-row"
              @click.stop="jumpInto(index, child)"
            >
              <Folder :size="11" />
              <span class="crumb-menu-name">{{ child.name }}</span>
              <span class="crumb-menu-count mono">{{ subtreeCount(child) }}</span>
            </button>
          </div>
        </span>
      </template>
    </nav>

    <div class="bookmarks" :aria-label="t('app.bookmarks')">
      <!-- Folders first, the way a directory lists; a tile drills in. -->
      <button
        v-for="folder in levelFolders"
        :key="folder.id"
        type="button"
        class="tile folder-tile"
        :class="{ drop: dropFolder === folder.id }"
        :title="t('app.bookmarkFolderRowHint', { count: subtreeCount(folder) })"
        @click="enter(folder)"
        @dragover="onDragOverFolder(folder.id, $event)"
        @dragleave="dropFolder === folder.id ? (dropFolder = null) : null"
        @drop.prevent="onDropIntoFolder(folder.id)"
      >
        <span class="tile-icon folder"><Folder :size="16" /></span>
        <span class="tile-name">{{ folder.name }}</span>
        <span class="tile-count mono">{{ subtreeCount(folder) }}</span>
      </button>

      <button
        v-for="(bookmark, index) in levelBookmarks"
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
        @drop="onDrop(bookmark, $event)"
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

/* The open crumb is disabled (it is where you are), so it keeps the active
   look without the pointer affordance. */
.folder-chip:disabled {
  cursor: default;
}

.crumb-sep {
  align-self: center;
  color: var(--faint);
}

/* Crumb + caret travel as one unit so the dropdown anchors to their pair. */
.crumb-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.crumb-caret {
  display: grid;
  place-items: center;
  width: 15px;
  height: 19px;
  margin-left: -3px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--faint);
  cursor: pointer;
}

.crumb-caret:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--surface) 70%, transparent);
}

.crumb-caret svg {
  transition: transform 0.12s ease;
}

.crumb-caret.open svg {
  transform: rotate(180deg);
}

.crumb-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 4;
  min-width: 170px;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.crumb-menu-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.crumb-menu-row:hover {
  background: var(--surface-2);
  color: var(--text);
}

.crumb-menu-row svg {
  flex: none;
  color: var(--faint);
}

.crumb-menu-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumb-menu-count {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--faint);
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

/* A folder tile shares the bookmark tile's shape; the accent wash is what says
   "this one opens a level" rather than an address. */
.tile-icon.folder {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface));
  color: var(--accent);
}

/* Subtree bookmark count under the folder name — entering the folder yields
   this many bookmarks across its whole subtree. */
.tile-count {
  margin-top: -3px;
  font-size: 9.5px;
  color: var(--faint);
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
