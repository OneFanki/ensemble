<script setup lang="ts">
import type { Bookmark, BookmarkDraft, BookmarkFolder, BookmarkFolderDraft } from "@shared/types";
import { ChevronDown, Globe, Pencil, Trash2 } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import BookmarkBarFolder from "./BookmarkBarFolder.vue";
import BookmarkDialog from "./BookmarkDialog.vue";
import BookmarkFolderDialog from "./BookmarkFolderDialog.vue";
import { provideBookmarkFlyout } from "./bookmarkFlyout";

/**
 * The one-row bookmark strip at the top of a blank page.
 *
 * Only the new-tab surface gets it — the browser chrome above the stage has no
 * bookmark bar at all, so on any other page the strip simply is not there. That
 * is the same default every desktop browser ships: the bar is a property of the
 * empty page, not of every tab.
 *
 * It is a working surface, not a read-only view of the tree: rows reorder by
 * dragging, and a right-click offers rename and remove. The management page
 * edits the same records; this is the copy in front of the user at the moment
 * they want to change one.
 *
 * Folders open on hover, with one open path for the whole bar
 * (`bookmarkFlyout.ts`), so opening a sibling closes the previous branch instead
 * of leaving both on screen. Rows that do not fit collapse into a trailing
 * overflow menu instead of being clipped: names and favicons make widths
 * unpredictable, so the bar renders every row, reads the real widths, then hides
 * the tail in the same task.
 */
const props = defineProps<{
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
}>();

const emit = defineEmits<{ open: [bookmark: Bookmark] }>();

const workspace = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();
const flyout = provideBookmarkFlyout();

interface Entry {
  kind: "folder" | "bookmark";
  order: number;
  folder?: BookmarkFolder;
  bookmark?: Bookmark;
}

/** Top-level rows: unfiled bookmarks and folders without a parent. */
const entries = computed<Entry[]>(() => {
  const folderIds = new Set(props.folders.map((folder) => folder.id));
  const out: Entry[] = [];
  for (const folder of props.folders) {
    if (folder.parentId && folderIds.has(folder.parentId)) continue;
    out.push({ kind: "folder", order: folder.order, folder });
  }
  for (const bookmark of props.bookmarks) {
    // A bookmark pointing at a folder that no longer exists is shown at the
    // root rather than becoming invisible.
    if (bookmark.folderId && folderIds.has(bookmark.folderId)) continue;
    out.push({ kind: "bookmark", order: bookmark.order, bookmark });
  }
  return out.sort((left, right) => left.order - right.order);
});

const bar = ref<HTMLElement | null>(null);
/** How many rows fit; everything past this lands in the overflow menu. */
const fit = ref(Number.MAX_SAFE_INTEGER);
const overflowOpen = ref(false);

const hidden = computed(() => entries.value.slice(Math.max(0, fit.value)));

const GAP = 2;
/** Room reserved for the overflow button while measuring. */
const MORE_WIDTH = 30;

function rowKey(entry: Entry): string {
  return entry.kind === "folder" ? `f:${entry.folder!.id}` : `b:${entry.bookmark!.id}`;
}

async function measure(): Promise<void> {
  const el = bar.value;
  if (!el) return;
  // Measure with every row visible: the hidden ones have no width to read.
  if (fit.value !== entries.value.length) {
    fit.value = entries.value.length;
    await nextTick();
  }
  const rows = [...el.querySelectorAll<HTMLElement>("[data-bar-row]")];
  const widths = rows.map((row) => row.offsetWidth);
  const total = (count: number): number =>
    widths.slice(0, count).reduce((sum, width) => sum + width, 0) +
    Math.max(0, count - 1) * GAP;
  const available = el.clientWidth;
  let count = widths.length;
  while (count > 0 && total(count) + MORE_WIDTH > available) count -= 1;
  fit.value = count;
  if (count >= widths.length) overflowOpen.value = false;
}

let observer: ResizeObserver | undefined;

onMounted(async () => {
  await nextTick();
  await measure();
  if (bar.value) {
    observer = new ResizeObserver(() => {
      void measure();
    });
    observer.observe(bar.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
});

// Bookmark edits change widths and row count; both need a fresh fit. Hidden
// rows changing does not, which is why the key is the id list.
watch(
  () => entries.value.map(rowKey).join("|"),
  () => {
    void nextTick().then(() => measure());
  },
);

function openBookmark(bookmark: Bookmark): void {
  overflowOpen.value = false;
  flyout.closeAll();
  emit("open", bookmark);
}

function toggleOverflow(): void {
  flyout.closeAll();
  overflowOpen.value = !overflowOpen.value;
}

// --- Reorder by dragging ---------------------------------------------------
//
// A row is dragged onto another row and takes that row's place. The index is
// resolved against the workspace's own array, never against the visible strip:
// the strip hides rows behind the overflow menu and sorts folders and bookmarks
// by a shared `order`, so a position counted here would land the row elsewhere.

const dragging = ref<{ kind: "folder" | "bookmark"; id: string } | null>(null);

function isDragging(entry: Entry): boolean {
  if (!dragging.value || dragging.value.kind !== entry.kind) return false;
  return dragging.value.id === (entry.kind === "folder" ? entry.folder!.id : entry.bookmark!.id);
}

function onDragStart(entry: Entry, event: DragEvent): void {
  // A drag beginning inside an open panel belongs to the panel's own rows.
  flyout.closeAll();
  dragging.value =
    entry.kind === "folder"
      ? { kind: "folder", id: entry.folder!.id }
      : { kind: "bookmark", id: entry.bookmark!.id };
  event.dataTransfer?.setData("text/plain", dragging.value.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd(): void {
  dragging.value = null;
}

/** Dropping a row onto a row of the same kind takes that row's place. */
async function onDrop(target: Entry, event: DragEvent): Promise<void> {
  event.preventDefault();
  const drag = dragging.value;
  dragging.value = null;
  if (!drag || drag.kind !== target.kind) return;
  if (drag.kind === "bookmark") {
    const targetId = target.bookmark!.id;
    if (drag.id === targetId) return;
    const all = props.bookmarks;
    const from = all.findIndex((item) => item.id === drag.id);
    const to = all.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    // The service removes the moving row and *then* inserts at the index it was
    // given, so a downward move must subtract one: passing the target's
    // pre-removal index drops the row after the target instead of in its place.
    await workspace.moveBookmark(drag.id, from < to ? to - 1 : to);
    return;
  }
  const targetId = target.folder!.id;
  if (drag.id === targetId) return;
  // Folders rank among their siblings only; both rows here are top-level, so a
  // drop between them is meaningful.
  const siblings = props.folders
    .filter((folder) => !folder.parentId)
    .sort((left, right) => left.order - right.order);
  const from = siblings.findIndex((folder) => folder.id === drag.id);
  const to = siblings.findIndex((folder) => folder.id === targetId);
  if (from < 0 || to < 0) return;
  // The service inserts at the final index after removing the moving row, so
  // the target's index shifts when the drag started above it.
  await workspace.moveBookmarkFolder(drag.id, from < to ? to - 1 : to);
}

// --- Right-click menu ------------------------------------------------------

type MenuTarget = { kind: "bookmark" | "folder"; id: string; name: string };

const menu = ref<{ target: MenuTarget; x: number; y: number } | null>(null);
const bookmarkDialog = ref<BookmarkDraft | null>(null);
const folderDialog = ref<{ draft: BookmarkFolderDraft; self?: BookmarkFolder } | null>(null);

function openMenu(entity: { kind: "bookmark" | "folder"; id: string }, event: MouseEvent): void {
  flyout.closeAll();
  overflowOpen.value = false;
  // Resolved here rather than passed down: the folder rows are recursive and
  // only know their own record, while the menu needs a name for its body text.
  const name =
    entity.kind === "folder"
      ? props.folders.find((item) => item.id === entity.id)?.name
      : props.bookmarks.find((item) => item.id === entity.id)?.name;
  if (!name) return;
  // Kept inside the window: the bar is at the very top, so a row near the right
  // edge would otherwise push the panel past it.
  const width = 150;
  const height = 84;
  menu.value = {
    target: { ...entity, name },
    x: Math.min(event.clientX, window.innerWidth - width - 8),
    y: Math.min(event.clientY, window.innerHeight - height - 8),
  };
}

function closeMenu(): void {
  menu.value = null;
}

function onWindowPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest(".bb-menu")) return;
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

/** Open the shared edit dialog for whatever the menu points at. */
function editFromMenu(): void {
  const target = menu.value?.target;
  closeMenu();
  if (!target) return;
  if (target.kind === "bookmark") {
    const bookmark = props.bookmarks.find((item) => item.id === target.id);
    if (!bookmark) return;
    bookmarkDialog.value = {
      id: bookmark.id,
      name: bookmark.name,
      url: bookmark.url,
      folderId: bookmark.folderId ?? "",
    };
    return;
  }
  const folder = props.folders.find((item) => item.id === target.id);
  if (!folder) return;
  folderDialog.value = {
    draft: { id: folder.id, name: folder.name, parentId: folder.parentId ?? "" },
    self: folder,
  };
}

async function removeFromMenu(): Promise<void> {
  const target = menu.value?.target;
  closeMenu();
  if (!target) return;
  const ok = await confirm.ask({
    title:
      target.kind === "folder" ? t("app.bookmarkFolderDeleteTitle") : t("app.bookmarkRemove"),
    body:
      target.kind === "folder"
        ? t("app.bookmarkFolderDeleteBody", { name: target.name })
        : target.name,
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!ok) return;
  if (target.kind === "folder") {
    if (await workspace.deleteBookmarkFolder(target.id)) {
      workspace.notify(t("app.bookmarkFolderDeleted", { name: target.name }), "success");
    }
    return;
  }
  if (await workspace.deleteBookmark(target.id)) {
    workspace.notify(t("app.bookmarkRemoved", { name: target.name }), "success");
  }
}

async function onBookmarkSave(draft: BookmarkDraft): Promise<void> {
  if (await workspace.saveBookmark(draft)) bookmarkDialog.value = null;
}

async function onFolderSave(draft: BookmarkFolderDraft): Promise<void> {
  const editing = Boolean(draft.id);
  if (!(await workspace.saveBookmarkFolder(draft))) return;
  folderDialog.value = null;
  workspace.notify(
    editing
      ? t("app.bookmarkFolderUpdated", { name: draft.name })
      : t("app.bookmarkFolderCreated", { name: draft.name }),
    "success",
  );
}
</script>

<template>
  <div ref="bar" class="bookmark-bar" role="toolbar" :aria-label="t('app.bookmarkBar')">
    <template v-for="(entry, index) in entries" :key="rowKey(entry)">
      <div
        v-if="index < fit"
        class="bb-cell"
        data-bar-row
        :class="{ dragging: isDragging(entry) }"
        draggable="true"
        @dragstart="onDragStart(entry, $event)"
        @dragend="onDragEnd"
        @dragover.prevent
        @drop="onDrop(entry, $event)"
      >
        <BookmarkBarFolder
          v-if="entry.kind === 'folder'"
          :folder="entry.folder!"
          :bookmarks="bookmarks"
          :folders="folders"
          :level="0"
          :ancestors="[]"
          @open="openBookmark"
          @menu="openMenu"
        />
        <button
          v-else
          type="button"
          class="bb-entry"
          :title="`${entry.bookmark!.name}\n${entry.bookmark!.url}`"
          @click="openBookmark(entry.bookmark!)"
          @contextmenu.prevent.stop="
            openMenu({ kind: 'bookmark', id: entry.bookmark!.id }, $event)
          "
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
      </div>
    </template>

    <div v-if="hidden.length" class="bb-more" data-bar-row>
      <button
        type="button"
        class="bb-entry ov-btn"
        :aria-expanded="overflowOpen"
        :title="t('app.bookmarkBarMore')"
        :aria-label="t('app.bookmarkBarMore')"
        @click="toggleOverflow"
      >
        <ChevronDown :size="13" aria-hidden="true" />
      </button>
      <Transition name="bb-pop">
        <div v-if="overflowOpen" class="bb-flyout overflow-menu" role="menu">
          <template v-for="entry in hidden" :key="rowKey(entry)">
            <BookmarkBarFolder
              v-if="entry.kind === 'folder'"
              :folder="entry.folder!"
              :bookmarks="bookmarks"
              :folders="folders"
              :level="0"
              :ancestors="[]"
              @open="openBookmark"
              @menu="openMenu"
            />
            <button
              v-else
              type="button"
              role="menuitem"
              class="bb-entry bb-row"
              :title="`${entry.bookmark!.name}\n${entry.bookmark!.url}`"
              @click="openBookmark(entry.bookmark!)"
              @contextmenu.prevent.stop="
                openMenu({ kind: 'bookmark', id: entry.bookmark!.id }, $event)
              "
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
        </div>
      </Transition>
    </div>

    <!-- Right-click menu. Positioned inside the bar: it sits at y=0, so a panel
         anchored at the pointer always stays within the page. -->
    <div v-if="menu" class="bb-menu" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button type="button" role="menuitem" class="bb-menu-row" @click="editFromMenu">
        <Pencil :size="11" />
        {{ menu.target.kind === "folder" ? t("app.bookmarkEdit") : t("app.bookmarkRename") }}
      </button>
      <button type="button" role="menuitem" class="bb-menu-row danger" @click="removeFromMenu">
        <Trash2 :size="11" />
        {{
          menu.target.kind === "folder" ? t("app.bookmarkFolderDeleteTitle") : t("app.bookmarkRemove")
        }}
      </button>
    </div>

    <BookmarkDialog
      v-if="bookmarkDialog"
      :draft="bookmarkDialog"
      :folders="folders"
      @save="onBookmarkSave"
      @close="bookmarkDialog = null"
    />
    <BookmarkFolderDialog
      v-if="folderDialog"
      :draft="folderDialog.draft"
      :folders="folders"
      :self="folderDialog.self"
      @save="onFolderSave"
      @close="folderDialog = null"
    />
  </div>
</template>

<style scoped>
/*
 * A translucent strip: the backdrop image belongs to the page, and an opaque
 * bar would cut it in half. The rule under it is what separates the strip from
 * the empty space it decorates.
 */
.bookmark-bar {
  position: relative;
  z-index: 4;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  /* 28 rather than 34: a cell header is 32 and this row sits directly under the
     toolbar, so it was reading as the taller of the two. The bar is decoration
     for a blank page; the cell header names the account and holds the page
     tabs, and it is the one that needs the height. */
  height: 28px;
  padding: 0 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--line-soft) 60%, transparent);
  background: color-mix(in srgb, var(--surface) 46%, transparent);
  backdrop-filter: blur(8px);
}

.bb-cell {
  display: flex;
  align-items: center;
  height: 100%;
  min-width: 0;
  /* Never shrink, even while every row is on screen for the measuring pass.
     As a default `flex: 0 1 auto` item the cell was squeezed below its entry's
     width, so rows' labels overlapped their neighbours AND `offsetWidth` read
     the squeezed number — the fit counted more rows than the bar could hold. */
  flex: 0 0 auto;
}

/* The dragged row fades, the way every other draggable list in the app marks
   its source. */
.bb-cell.dragging {
  opacity: 0.45;
}

.bookmark-bar .bb-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  max-width: 190px;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.bookmark-bar .bb-entry:hover {
  background: var(--selected);
  color: var(--text);
}

.bb-icon {
  flex: 0 0 auto;
  color: var(--faint);
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

.bb-more {
  position: relative;
  flex: 0 0 30px;
  display: flex;
  align-items: center;
  height: 100%;
}

.ov-btn {
  justify-content: center;
  width: 30px;
  padding: 0;
  color: var(--faint);
}

.bb-flyout {
  position: absolute;
  z-index: 6;
  top: calc(100% + 5px);
  left: 0;
  min-width: 184px;
  max-width: 260px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.overflow-menu {
  left: auto;
  right: 0;
  max-height: min(420px, 60vh);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* Rows inside any flyout span the panel, whatever their trigger was. */
.bb-flyout :deep(.bb-row),
.bb-flyout :deep(.bb-folder > .bb-entry) {
  width: 100%;
  max-width: none;
  height: 28px;
  justify-content: flex-start;
  text-align: left;
}

/*
 * The right-click menu.
 *
 * Fixed, not absolute: the coordinates come from the pointer, and the bar's own
 * `overflow: hidden` would otherwise clip a panel that opens downward. The bar
 * sits at the top of the page, so `fixed` and the bar's own space agree — and
 * `position: fixed` inside a stacking context still paints above the rows.
 */
.bb-menu {
  position: fixed;
  z-index: 90;
  min-width: 150px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  animation: bb-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

@keyframes bb-menu-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
}

.bb-menu-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}

.bb-menu-row:hover {
  background: var(--surface-2);
  color: var(--text);
}

.bb-menu-row.danger:hover {
  background: color-mix(in srgb, var(--red) 14%, transparent);
  color: var(--red);
}

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
