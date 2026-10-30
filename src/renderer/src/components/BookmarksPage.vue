<script setup lang="ts">
import type { Bookmark, BookmarkDraft, BookmarkFolder, BookmarkFolderDraft } from "@shared/types";
import { ChevronRight, Folder, Globe, Pencil, Plus, Star, Trash2 } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import BookmarkDialog from "./BookmarkDialog.vue";
import BookmarkFolderDialog from "./BookmarkFolderDialog.vue";
import BookmarkImportDialog from "./BookmarkImportDialog.vue";
import SelectField from "./SelectField.vue";
import AppButton from "./ui/AppButton.vue";

/**
 * Bookmark management, away from the new-tab page.
 *
 * The page behaves like a file manager, because that is the interaction users
 * already know: the tree on the left and the breadcrumb above the list both
 * navigate, the list shows one folder's own subfolders and bookmarks, and
 * rows drag — onto a folder (tree node or folder row) to file them, onto
 * another row to reorder. 「全部」 is the root of that world, so it lists
 * top-level folders and unfiled bookmarks instead of one flat cross-folder
 * pile; nothing here is ever a flat dump of the whole tree.
 */
const workspace = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const bookmarks = computed(() => workspace.bookmarks);
const folders = computed(() => workspace.bookmarkFolders);

/** Children by parent id; `folders` arrives sorted, and children keep that order. */
const childrenOf = computed(() => {
  const map = new Map<string, BookmarkFolder[]>();
  for (const folder of folders.value) {
    if (!folder.parentId) continue;
    const list = map.get(folder.parentId) ?? [];
    list.push(folder);
    map.set(folder.parentId, list);
  }
  return map;
});

/** A folder's own bookmarks, not its subtree's — every badge is a per-level count. */
function countOf(folderId: string): number {
  return bookmarks.value.filter((bookmark) => bookmark.folderId === folderId).length;
}

/**
 * Collapsed rather than expanded ids: a folder created after the page loaded is
 * visible without anyone updating the set, which is what an "expanded" set
 * would need.
 */
const collapsed = ref(new Set<string>());

function toggle(folder: BookmarkFolder): void {
  const next = new Set(collapsed.value);
  if (next.has(folder.id)) next.delete(folder.id);
  else next.add(folder.id);
  collapsed.value = next;
}

type Selection = { kind: "all" } | { kind: "folder"; id: string };
const selected = ref<Selection>({ kind: "all" });

/** Ancestors of a folder, root first — the breadcrumb walks the same chain. */
function ancestorsOf(folderId: string): BookmarkFolder[] {
  const chain: BookmarkFolder[] = [];
  let cursor = folders.value.find((folder) => folder.id === folderId);
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentId
      ? folders.value.find((folder) => folder.id === cursor?.parentId)
      : undefined;
  }
  return chain;
}

/** Full path label for the row's move dropdown, where depth cannot be drawn. */
function pathOf(folderId: string): string {
  return ancestorsOf(folderId)
    .map((folder) => folder.name)
    .join(" / ");
}

const folderOptions = computed(() => [
  { value: "", label: t("app.bookmarkFolderNone") },
  ...folders.value.map((folder) => ({ value: folder.id, label: pathOf(folder.id) })),
]);

const crumbs = computed(() => {
  const items: Array<{ label: string; select: Selection }> = [
    { label: t("app.bookmarkAllFolders"), select: { kind: "all" } },
  ];
  if (selected.value.kind === "folder") {
    for (const folder of ancestorsOf(selected.value.id)) {
      items.push({ label: folder.name, select: { kind: "folder", id: folder.id } });
    }
  }
  return items;
});

/** The open folder's own content: subfolders to enter, then its bookmarks. */
const view = computed(() => {
  const current = selected.value;
  if (current.kind === "all") {
    return {
      folders: folders.value.filter((folder) => !folder.parentId),
      bookmarks: bookmarks.value.filter((bookmark) => !bookmark.folderId),
    };
  }
  return {
    folders: childrenOf.value.get(current.id) ?? [],
    bookmarks: bookmarks.value.filter((bookmark) => bookmark.folderId === current.id),
  };
});

/** Tree rows as a flat walk of the expanded tree, so one v-for draws any depth. */
const treeRows = computed(() => {
  const out: Array<{ folder: BookmarkFolder; depth: number; hasChildren: boolean }> = [];
  const walk = (list: BookmarkFolder[], depth: number) => {
    for (const folder of list) {
      const children = childrenOf.value.get(folder.id) ?? [];
      out.push({ folder, depth, hasChildren: children.length > 0 });
      if (children.length && !collapsed.value.has(folder.id)) walk(children, depth + 1);
    }
  };
  walk(folders.value.filter((folder) => !folder.parentId), 0);
  return out;
});

/** Dialog state; `null` means closed. The parent performs the actual saves. */
const bookmarkDialog = ref<{ draft: BookmarkDraft } | null>(null);
const folderDialog = ref<{ draft: BookmarkFolderDraft; self?: BookmarkFolder } | null>(null);
const importDialog = ref(false);

function openNewBookmark(): void {
  bookmarkDialog.value = {
    draft: {
      name: "",
      url: "",
      // A folder open on the left is where a new bookmark expects to land.
      ...(selected.value.kind === "folder" ? { folderId: selected.value.id } : {}),
    },
  };
}

function openEditBookmark(bookmark: Bookmark): void {
  bookmarkDialog.value = {
    draft: {
      id: bookmark.id,
      name: bookmark.name,
      url: bookmark.url,
      folderId: bookmark.folderId ?? "",
    },
  };
}

async function onBookmarkSave(draft: BookmarkDraft): Promise<void> {
  // The store's run() turns a failure into an error toast and returns
  // undefined — the falsy check is what keeps success from lying.
  if (await workspace.saveBookmark(draft)) bookmarkDialog.value = null;
}

function openNewFolder(parentId?: string): void {
  folderDialog.value = { draft: { name: "", ...(parentId ? { parentId } : {}) } };
}

function openEditFolder(folder: BookmarkFolder): void {
  folderDialog.value = {
    draft: { id: folder.id, name: folder.name, parentId: folder.parentId ?? "" },
    self: folder,
  };
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

async function openImport(): Promise<void> {
  importDialog.value = true;
  await workspace.loadBookmarkImportSources();
}

async function removeFolder(folder: BookmarkFolder): Promise<void> {
  const ok = await confirm.ask({
    title: t("app.bookmarkFolderDeleteTitle"),
    body: t("app.bookmarkFolderDeleteBody", { name: folder.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!ok) return;
  // Capture the subtree first: after the delete the ids are re-parented and the
  // question "was the open folder inside?" must be answered with the old shape.
  const doomed = new Set<string>([folder.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of folders.value) {
      if (candidate.parentId && doomed.has(candidate.parentId) && !doomed.has(candidate.id)) {
        doomed.add(candidate.id);
        grew = true;
      }
    }
  }
  if (!(await workspace.deleteBookmarkFolder(folder.id))) return;
  workspace.notify(t("app.bookmarkFolderDeleted", { name: folder.name }), "success");
  if (selected.value.kind === "folder" && doomed.has(selected.value.id)) {
    selected.value = { kind: "all" };
  }
}

async function remove(bookmark: Bookmark): Promise<void> {
  const ok = await confirm.ask({
    title: t("app.bookmarkRemove"),
    body: bookmark.name,
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!ok) return;
  await workspace.deleteBookmark(bookmark.id);
}

/**
 * Moving between folders is the whole point of this page, so it is a select on
 * the row rather than a submenu: one dropdown change, no dialog.
 */
async function moveTo(bookmark: Bookmark, folderId: string): Promise<void> {
  await workspace.saveBookmark({
    id: bookmark.id,
    name: bookmark.name,
    url: bookmark.url,
    folderId: folderId || undefined,
  });
}

// --- Drag & drop -----------------------------------------------------------
// One gesture vocabulary everywhere: a row (or a tile on the start page) is
// dragged, and the drop target decides what happens — a folder files the drag
// into itself, a bookmark row receives a reorder.

const dragging = ref<{ kind: "bookmark" | "folder"; id: string } | null>(null);
/** Folder the pointer is over; `""` is the root (unfiled). Null is no target. */
const dropFolder = ref<string | null>(null);
/** Bookmark row the pointer is over, for the reorder rule. */
const dropRow = ref<string | null>(null);

function onDragStart(kind: "bookmark" | "folder", id: string, event: DragEvent): void {
  dragging.value = { kind, id };
  event.dataTransfer?.setData("text/plain", id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragEnd(): void {
  dragging.value = null;
  dropFolder.value = null;
  dropRow.value = null;
}

/** A folder cannot be filed into itself or its own subtree — the loop cut. */
function canDropInto(folderId: string): boolean {
  if (!dragging.value) return false;
  if (dragging.value.kind === "bookmark") return true;
  if (dragging.value.id === folderId) return false;
  const doomed = new Set<string>([dragging.value.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of folders.value) {
      if (candidate.parentId && doomed.has(candidate.parentId) && !doomed.has(candidate.id)) {
        doomed.add(candidate.id);
        grew = true;
      }
    }
  }
  return !doomed.has(folderId);
}

function onDragOverFolder(folderId: string, event: DragEvent): void {
  if (!canDropInto(folderId)) return;
  event.preventDefault();
  dropFolder.value = folderId;
  dropRow.value = null;
}

async function onDropIntoFolder(folderId: string): Promise<void> {
  const drag = dragging.value;
  onDragEnd();
  if (!drag) return;
  const parentId = folderId || undefined;
  if (drag.kind === "bookmark") {
    const bookmark = bookmarks.value.find((item) => item.id === drag.id);
    if (bookmark) await moveTo(bookmark, folderId);
    return;
  }
  const folder = folders.value.find((item) => item.id === drag.id);
  if (folder && folder.parentId !== parentId) {
    await workspace.saveBookmarkFolder({ id: folder.id, name: folder.name, parentId });
  }
}

function onDragOverRow(bookmark: Bookmark, event: DragEvent): void {
  if (dragging.value?.kind !== "bookmark" || dragging.value.id === bookmark.id) return;
  event.preventDefault();
  dropRow.value = bookmark.id;
  dropFolder.value = null;
}

async function onDropOnRow(bookmark: Bookmark): Promise<void> {
  const drag = dragging.value;
  onDragEnd();
  if (!drag || drag.id === bookmark.id) return;
  // Dropping on a row takes that row's place, which is exactly the index the
  // service's splice-out-then-insert produces.
  const targetIndex = bookmarks.value.findIndex((item) => item.id === bookmark.id);
  if (targetIndex >= 0) await workspace.moveBookmark(drag.id, targetIndex);
}

function onDropOnNothing(): void {
  // Leaving the list clears the highlight; the drag itself ends with onDragEnd.
  dropFolder.value = null;
  dropRow.value = null;
}
</script>

<template>
  <section class="bookmarks-page" data-tour="bookmarks-page" @dragleave.self="onDropOnNothing">
    <header class="page-head">
      <div>
        <h1>{{ t("app.bookmarksPageTitle") }}</h1>
        <p class="hint">{{ t("app.bookmarksPageHint") }}</p>
      </div>
      <div class="head-actions">
        <AppButton @click="openImport">{{ t("app.bookmarksPageImport") }}</AppButton>
        <AppButton @click="openNewFolder(selected.kind === 'folder' ? selected.id : undefined)">
          <Folder :size="13" />
          {{ t("app.bookmarksPageNewFolder") }}
        </AppButton>
        <AppButton variant="primary" @click="openNewBookmark">
          <Plus :size="13" />
          {{ t("app.bookmarksPageNew") }}
        </AppButton>
      </div>
    </header>

    <p v-if="!bookmarks.length && !folders.length" class="empty">
      {{ t("app.bookmarksEmpty") }}
    </p>

    <div v-else class="layout">
      <aside class="tree" @dragleave.self="onDropOnNothing">
        <!-- The root is a real drop target: filing a bookmark onto it unfiles it. -->
        <button
          type="button"
          class="tree-row root"
          :class="{ on: selected.kind === 'all', drop: dropFolder === '' }"
          @click="selected = { kind: 'all' }"
          @dragover="onDragOverFolder('', $event)"
          @drop.prevent="onDropIntoFolder('')"
        >
          <Globe :size="12" />
          <span class="tree-name">{{ t("app.bookmarkAllFolders") }}</span>
          <span class="tree-count mono">
            {{ bookmarks.filter((bookmark) => !bookmark.folderId).length }}
          </span>
        </button>
        <!-- A folder row is a div because it nests three more buttons (child,
             edit, delete); a button inside a button is invalid HTML and the
             nested actions would break it. -->
        <div
          v-for="{ folder, depth, hasChildren } in treeRows"
          :key="folder.id"
          class="tree-row"
          :class="{ on: selected.kind === 'folder' && selected.id === folder.id, drop: dropFolder === folder.id }"
          :style="{ paddingLeft: `${4 + depth * 13}px` }"
          role="button"
          tabindex="0"
          @click="selected = { kind: 'folder', id: folder.id }"
          @keydown.enter.prevent="selected = { kind: 'folder', id: folder.id }"
          @dragover="onDragOverFolder(folder.id, $event)"
          @drop.prevent="onDropIntoFolder(folder.id)"
        >
          <span class="twist">
            <button
              v-if="hasChildren"
              type="button"
              class="twist-btn"
              :aria-label="folder.name"
              @click.stop="toggle(folder)"
            >
              <ChevronRight :size="11" :class="{ open: !collapsed.has(folder.id) }" />
            </button>
          </span>
          <Folder :size="12" class="tree-icon" />
          <span class="tree-name">{{ folder.name }}</span>
          <span class="tree-count mono">{{ countOf(folder.id) }}</span>
          <span class="tree-actions" @click.stop @keydown.stop>
            <button
              type="button"
              class="icon-btn"
              :title="t('app.bookmarksPageNewFolder')"
              @click="openNewFolder(folder.id)"
            >
              <Plus :size="11" />
            </button>
            <button
              type="button"
              class="icon-btn"
              :title="t('app.bookmarkEdit')"
              @click="openEditFolder(folder)"
            >
              <Pencil :size="11" />
            </button>
            <button
              type="button"
              class="icon-btn danger"
              :title="t('app.bookmarkFolderDeleteTitle')"
              @click="removeFolder(folder)"
            >
              <Trash2 :size="11" />
            </button>
          </span>
        </div>
      </aside>

      <div class="list" @dragleave.self="onDropOnNothing">
        <nav class="crumbs" :aria-label="t('app.bookmarks')">
          <template v-for="(crumb, index) in crumbs" :key="index">
            <span v-if="index > 0" class="crumb-sep">/</span>
            <button
              type="button"
              class="crumb"
              :disabled="index === crumbs.length - 1"
              @click="selected = crumb.select"
            >
              {{ crumb.label }}
            </button>
          </template>
        </nav>

        <p v-if="!view.folders.length && !view.bookmarks.length" class="empty in-folder">
          {{ selected.kind === "all" ? t("app.bookmarksEmpty") : t("app.bookmarkFolderEmpty") }}
        </p>

        <div v-else class="rows">
          <!-- Subfolders first, the way a file manager lists a directory. -->
          <div
            v-for="folder in view.folders"
            :key="folder.id"
            class="row folder"
            :class="{ drop: dropFolder === folder.id, dragging: dragging?.id === folder.id }"
            draggable="true"
            role="button"
            tabindex="0"
            @click="selected = { kind: 'folder', id: folder.id }"
            @keydown.enter.prevent="selected = { kind: 'folder', id: folder.id }"
            @dragstart="onDragStart('folder', folder.id, $event)"
            @dragend="onDragEnd"
            @dragover="onDragOverFolder(folder.id, $event)"
            @drop.prevent="onDropIntoFolder(folder.id)"
          >
            <span class="row-icon"><Folder :size="11" /></span>
            <span class="row-name">{{ folder.name }}</span>
            <span class="row-url mono">{{ t("app.bookmarkFolderRowHint", { count: countOf(folder.id) }) }}</span>
            <span class="tree-actions" @click.stop @keydown.stop>
              <button
                type="button"
                class="icon-btn"
                :title="t('app.bookmarksPageNewFolder')"
                @click="openNewFolder(folder.id)"
              >
                <Plus :size="11" />
              </button>
              <button
                type="button"
                class="icon-btn"
                :title="t('app.bookmarkEdit')"
                @click="openEditFolder(folder)"
              >
                <Pencil :size="11" />
              </button>
              <button
                type="button"
                class="icon-btn danger"
                :title="t('app.bookmarkFolderDeleteTitle')"
                @click="removeFolder(folder)"
              >
                <Trash2 :size="11" />
              </button>
            </span>
          </div>

          <div
            v-for="bookmark in view.bookmarks"
            :key="bookmark.id"
            class="row"
            :class="{ drop: dropRow === bookmark.id, dragging: dragging?.id === bookmark.id }"
            draggable="true"
            @dragstart="onDragStart('bookmark', bookmark.id, $event)"
            @dragend="onDragEnd"
            @dragover="onDragOverRow(bookmark, $event)"
            @drop.prevent="onDropOnRow(bookmark)"
          >
            <span class="row-icon" :style="bookmark.favicon ? {} : { background: 'var(--surface-3)' }">
              <img v-if="bookmark.favicon" :src="bookmark.favicon" alt="" />
              <Star v-else :size="11" />
            </span>
            <span class="row-name">{{ bookmark.name }}</span>
            <span class="row-url mono">{{ bookmark.url }}</span>
            <!-- Moving is a dropdown on the row: one pick, no dialog. The
                 options label folders by full path, since depth cannot be
                 drawn inside a flat dropdown. -->
            <SelectField
              class="row-folder"
              compact
              :model-value="bookmark.folderId ?? ''"
              :options="folderOptions"
              :aria-label="t('app.bookmarkFolderLabel')"
              @update:model-value="moveTo(bookmark, $event ?? '')"
              @click.stop
            />
            <button type="button" class="icon-btn" :title="t('app.bookmarkEdit')" @click="openEditBookmark(bookmark)">
              <Pencil :size="11" />
            </button>
            <button
              type="button"
              class="icon-btn danger"
              :title="t('app.bookmarkRemove')"
              @click="remove(bookmark)"
            >
              <Trash2 :size="11" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <BookmarkDialog
      v-if="bookmarkDialog"
      :draft="bookmarkDialog.draft"
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
    <BookmarkImportDialog v-if="importDialog" @close="importDialog = false" />
  </section>
</template>

<style scoped>
.bookmarks-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 22px 28px;
  min-height: 0;
  overflow-y: auto;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-head h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.hint {
  margin: 6px 0 0;
  max-width: 62ch;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--faint);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.layout {
  display: grid;
  grid-template-columns: 235px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.tree {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 4px;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
  min-width: 0;
  cursor: pointer;
}

div.tree-row {
  cursor: default;
}

.tree-row:hover {
  background: var(--surface-2);
}

.tree-row.on {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--text);
}

/* Shared drop highlight with the list rows: one visual word for "lands here". */
.tree-row.drop,
.row.drop {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  outline: 1px dashed color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: -2px;
}

.tree-row.root {
  cursor: pointer;
}

.twist {
  flex: 0 0 13px;
  display: grid;
  place-items: center;
}

.twist-btn {
  display: grid;
  place-items: center;
  width: 13px;
  height: 13px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--faint);
  padding: 0;
}

.twist-btn:hover {
  color: var(--text);
  background: var(--surface-3);
}

.twist-btn svg {
  transition: transform 0.12s ease;
}

.twist-btn svg.open {
  transform: rotate(90deg);
}

.tree-icon {
  flex: none;
  color: var(--faint);
}

.tree-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-count {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--faint);
}

.tree-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
  opacity: 0;
}

.tree-row:hover .tree-actions,
.row:hover .tree-actions {
  opacity: 1;
}

.tree-row.on .tree-count {
  color: var(--text-secondary);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 8px;
  font-size: 11.5px;
}

.crumb {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--muted);
  font-size: 11.5px;
  cursor: pointer;
}

.crumb:hover:not(:disabled) {
  color: var(--text);
}

.crumb:disabled {
  color: var(--text-secondary);
  cursor: default;
}

.crumb-sep {
  color: var(--faint);
}

.rows {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--bg);
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  border-top: 1px solid var(--line-soft);
  font-size: 11.5px;
}

.row:first-child {
  border-top: none;
}

.row:hover {
  background: var(--surface-2);
}

/* A dragged source fades, the same pair of marks the start-page grid uses. */
.row.dragging {
  opacity: 0.45;
}

.row.folder {
  cursor: pointer;
}

.row.folder .row-name {
  color: var(--text);
}

.row-icon {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  flex: none;
  overflow: hidden;
  color: var(--faint);
}

.row-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.row-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.row-url {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--faint);
}

.row-folder {
  flex: none;
  width: 150px;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  opacity: 0;
}

.row:hover .icon-btn,
.tree-row:hover .icon-btn {
  opacity: 1;
}

.icon-btn:hover {
  background: var(--surface-3);
  color: var(--text);
}

.icon-btn.danger:hover {
  color: var(--red);
}

.empty {
  margin: 24px 0;
  font-size: 12px;
  color: var(--faint);
}

.empty.in-folder {
  margin: 18px 2px;
  font-size: 11.5px;
}
</style>
