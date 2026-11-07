<script setup lang="ts">
import type { Bookmark, BookmarkDraft, BookmarkFolder, BookmarkFolderDraft } from "@shared/types";
import {
  Bookmark as BookmarkIcon,
  Check,
  ChevronRight,
  Folder,
  Globe,
  Pencil,
  Plus,
  Star,
  Trash2,
} from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import BookmarkDialog from "./BookmarkDialog.vue";
import BookmarkFolderDialog from "./BookmarkFolderDialog.vue";
import BookmarkImportDialog from "./BookmarkImportDialog.vue";
import SelectField from "./SelectField.vue";
import AppButton from "./ui/AppButton.vue";
import PageHeader from "./ui/PageHeader.vue";
import SplitPane from "./ui/SplitPane.vue";

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

/** Bookmarks that belong to no folder — the root row's count. */
const unfiledCount = computed(
  () => bookmarks.value.filter((bookmark) => !bookmark.folderId).length,
);

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
  walk(
    folders.value.filter((folder) => !folder.parentId),
    0,
  );
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

// --- Bulk selection ---------------------------------------------------------
/**
 * A picking mode for rows the user wants gone in one confirm.
 *
 * Row clicks navigate by default; in picking mode they toggle instead, and the
 * header actions become the selection controls. A picked folder takes its whole
 * subtree with it — the point of a selection is "these are unwanted", and
 * re-parenting survivors (the single-delete rule) would pour the contents of
 * every picked folder back onto the list being emptied.
 */
const picking = ref(false);
const picked = ref(new Set<string>());

function pickKey(kind: "folder" | "bookmark", id: string): string {
  return `${kind[0]}:${id}`;
}

function togglePick(kind: "folder" | "bookmark", id: string): void {
  const next = new Set(picked.value);
  const key = pickKey(kind, id);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  picked.value = next;
}

function startPicking(): void {
  picking.value = true;
  picked.value = new Set();
}

function stopPicking(): void {
  picking.value = false;
  picked.value = new Set();
}

/** Escape leaves picking mode, the way a file manager's selection does. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && picking.value) stopPicking();
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

function onFolderRowClick(folder: BookmarkFolder): void {
  if (picking.value) togglePick("folder", folder.id);
  else selected.value = { kind: "folder", id: folder.id };
}

/** Folder ids picked outright; the subtree they imply is counted, not listed. */
const pickedFolderIds = computed(() =>
  [...picked.value].filter((key) => key.startsWith("f:")).map((key) => key.slice(2)),
);

/** Whole subtree of the picked folders — the same math the core delete runs. */
const doomedFolderIds = computed(() => {
  const doomed = new Set(pickedFolderIds.value);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders.value) {
      if (folder.parentId && doomed.has(folder.parentId) && !doomed.has(folder.id)) {
        doomed.add(folder.id);
        grew = true;
      }
    }
  }
  return doomed;
});

const pickedCounts = computed(() => ({
  folders: pickedFolderIds.value.length,
  bookmarks: bookmarks.value.filter(
    (bookmark) =>
      picked.value.has(pickKey("bookmark", bookmark.id)) ||
      (bookmark.folderId && doomedFolderIds.value.has(bookmark.folderId)),
  ).length,
}));

function pickAllVisible(): void {
  const next = new Set<string>();
  for (const folder of view.value.folders) next.add(pickKey("folder", folder.id));
  for (const bookmark of view.value.bookmarks) next.add(pickKey("bookmark", bookmark.id));
  picked.value = next;
}

async function removePicked(): Promise<void> {
  const bookmarkIds = [...picked.value]
    .filter((key) => key.startsWith("b:"))
    .map((key) => key.slice(2));
  const folderIds = pickedFolderIds.value;
  if (bookmarkIds.length === 0 && folderIds.length === 0) return;
  const { folders: folderCount, bookmarks: bookmarkCount } = pickedCounts.value;
  const ok = await confirm.ask({
    title: t("app.bookmarksBulkDeleteTitle"),
    body: t("app.bookmarksBulkDeleteBody", {
      folders: folderCount,
      bookmarks: bookmarkCount,
    }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!ok) return;
  if (!(await workspace.deleteBookmarksBulk(bookmarkIds, folderIds))) return;
  workspace.notify(
    t("app.bookmarksBulkDeleted", { folders: folderCount, bookmarks: bookmarkCount }),
    "success",
  );
  // The open folder may be picked, or live inside one; either way it is gone.
  if (selected.value.kind === "folder" && doomedFolderIds.value.has(selected.value.id)) {
    selected.value = { kind: "all" };
  }
  stopPicking();
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
/**
 * Edge of a folder row a dragged folder would land on, for the sibling reorder.
 * `null` means the pointer is in the middle third, where the drop files into
 * the folder instead.
 */
const dropFolderEdge = ref<{ id: string; side: "before" | "after" } | null>(null);
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
  dropFolderEdge.value = null;
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
  // The outer thirds of a folder row mean "insert before/after among siblings";
  // the middle keeps the original meaning, "file into this folder". Only a
  // folder can reorder, and only against a sibling — `order` ranks siblings
  // only, so a cross-level drop has no position to mean.
  if (folderId) {
    const zone = folderZone(folderId, event);
    if (zone !== "into") {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      dropFolderEdge.value = { id: folderId, side: zone };
      dropFolder.value = null;
      dropRow.value = null;
      return;
    }
  }
  if (!canDropInto(folderId)) return;
  event.preventDefault();
  dropFolder.value = folderId;
  dropFolderEdge.value = null;
  dropRow.value = null;
}

/** Sibling folders under one parent, in stored order. */
function siblingsOf(parentId: string | undefined): BookmarkFolder[] {
  return folders.value
    .filter((folder) => (folder.parentId ?? undefined) === parentId)
    .sort((left, right) => left.order - right.order);
}

/** Which third of the row the pointer is in, when a sibling folder is dragged. */
function folderZone(folderId: string, event: DragEvent): "before" | "into" | "after" {
  const drag = dragging.value;
  if (drag?.kind !== "folder" || drag.id === folderId) return "into";
  const target = folders.value.find((folder) => folder.id === folderId);
  const moving = folders.value.find((folder) => folder.id === drag.id);
  if (!target || !moving) return "into";
  if ((target.parentId ?? undefined) !== (moving.parentId ?? undefined)) return "into";
  const row = event.currentTarget as HTMLElement | null;
  if (!row) return "into";
  const rect = row.getBoundingClientRect();
  // A pointer outside the row is not "the top edge" — it is a drop whose
  // position was never set (programmatic drags do this). Keep the old meaning
  // there instead of turning every such drop into a reorder.
  const offset = event.clientY - rect.top;
  if (offset < 0 || offset > rect.height) return "into";
  const ratio = offset / rect.height;
  if (ratio < 0.3) return "before";
  if (ratio > 0.7) return "after";
  return "into";
}

/** Drops on a folder row: a sibling edge reorders, everything else files. */
async function onDropOnFolder(folderId: string): Promise<void> {
  const drag = dragging.value;
  const edge = dropFolderEdge.value;
  if (drag?.kind === "folder" && edge?.id === folderId) {
    const target = folders.value.find((folder) => folder.id === folderId);
    const siblings = target ? siblingsOf(target.parentId ?? undefined) : [];
    const from = siblings.findIndex((folder) => folder.id === drag.id);
    const to = siblings.findIndex((folder) => folder.id === folderId);
    onDragEnd();
    if (!target || from < 0 || to < 0) return;
    // The service inserts at the final index after the moving row is removed,
    // so the target's index shifts when the drag started above it.
    const base = from < to ? to - 1 : to;
    await workspace.moveBookmarkFolder(drag.id, edge.side === "after" ? base + 1 : base);
    return;
  }
  await onDropIntoFolder(folderId);
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
  // A bookmark row ends the folder-edge gesture; without this the edge line
  // stayed lit on the folder row the pointer had already left.
  dropFolderEdge.value = null;
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
  dropFolderEdge.value = null;
  dropRow.value = null;
}
</script>

<template>
  <section class="page bookmarks-page" @dragleave.self="onDropOnNothing">
    <PageHeader :title="t('app.bookmarksPageTitle')" :note="t('app.bookmarksPageHint')">
      <template #actions>
        <!--
          Picking mode swaps creation for the selection actions: the count, a
          select-all for the folder being viewed, and the delete that goes with
          them. New rows can wait; the user asked to remove rows.
        -->
        <template v-if="picking">
          <span class="pick-count mono">{{ t("app.bookmarksPicked", { count: picked.size }) }}</span>
          <AppButton @click="pickAllVisible">{{ t("app.bookmarksPickAll") }}</AppButton>
          <AppButton
            variant="danger"
            :disabled="picked.size === 0"
            @click="removePicked"
          >
            <Trash2 :size="13" />
            {{ t("app.delete") }}
          </AppButton>
          <AppButton @click="stopPicking">{{ t("app.cancel") }}</AppButton>
        </template>
        <template v-else>
          <AppButton @click="startPicking">{{ t("app.bookmarksPickMode") }}</AppButton>
          <AppButton @click="openImport">{{ t("app.bookmarksPageImport") }}</AppButton>
          <AppButton @click="openNewFolder(selected.kind === 'folder' ? selected.id : undefined)">
            <Folder :size="13" />
            {{ t("app.bookmarksPageNewFolder") }}
          </AppButton>
          <AppButton variant="primary" @click="openNewBookmark">
            <Plus :size="13" />
            {{ t("app.bookmarksPageNew") }}
          </AppButton>
        </template>
      </template>
    </PageHeader>

    <!--
      The empty state carries the action, not just the explanation.
      A bare sentence under the header left the page looking like it had failed
      to load: the only two buttons that fix it are in the header, 200px above
      and far to the right, so the sentence named a star button that was not on
      screen.
    -->
    <div v-if="!bookmarks.length && !folders.length" class="empty">
      <BookmarkIcon :size="22" />
      <p>{{ t("app.bookmarksEmpty") }}</p>
      <div class="empty-actions">
        <AppButton @click="openImport">{{ t("app.bookmarksPageImport") }}</AppButton>
        <AppButton variant="primary" @click="openNewBookmark">
          <Plus :size="13" />
          {{ t("app.bookmarksPageNew") }}
        </AppButton>
      </div>
    </div>

    <SplitPane v-else dense>
      <template #list>
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
          <!-- Zero reads as noise at the right edge of every empty folder; a
               file manager shows nothing until there is something. -->
          <span v-if="unfiledCount > 0" class="tree-count mono">{{ unfiledCount }}</span>
        </button>
        <!-- A folder row is a div because it nests three more buttons (child,
             edit, delete); a button inside a button is invalid HTML and the
             nested actions would break it. -->
        <div
          v-for="{ folder, depth, hasChildren } in treeRows"
          :key="folder.id"
          class="tree-row"
          :class="{
            on: selected.kind === 'folder' && selected.id === folder.id,
            drop: dropFolder === folder.id,
            'drop-before': dropFolderEdge?.id === folder.id && dropFolderEdge.side === 'before',
            'drop-after': dropFolderEdge?.id === folder.id && dropFolderEdge.side === 'after',
          }"
          :style="{ paddingLeft: `${4 + depth * 13}px` }"
          role="button"
          tabindex="0"
          @click="selected = { kind: 'folder', id: folder.id }"
          @keydown.enter.prevent="selected = { kind: 'folder', id: folder.id }"
          @dragover="onDragOverFolder(folder.id, $event)"
          @drop.prevent="onDropOnFolder(folder.id)"
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
          <span v-if="countOf(folder.id) > 0" class="tree-count mono">{{ countOf(folder.id) }}</span>
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
      </template>

      <template #detail>
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
            :class="{
              drop: dropFolder === folder.id,
              dragging: dragging?.id === folder.id,
              picked: picking && picked.has(pickKey('folder', folder.id)),
              'drop-before': dropFolderEdge?.id === folder.id && dropFolderEdge.side === 'before',
              'drop-after': dropFolderEdge?.id === folder.id && dropFolderEdge.side === 'after',
            }"
            :draggable="!picking"
            role="button"
            tabindex="0"
            @click="onFolderRowClick(folder)"
            @keydown.enter.prevent="onFolderRowClick(folder)"
            @dragstart="onDragStart('folder', folder.id, $event)"
            @dragend="onDragEnd"
            @dragover="onDragOverFolder(folder.id, $event)"
            @drop.prevent="onDropOnFolder(folder.id)"
          >
            <span v-if="picking" class="pick-box" :class="{ on: picked.has(pickKey('folder', folder.id)) }">
              <Check v-if="picked.has(pickKey('folder', folder.id))" :size="10" />
            </span>
            <span class="row-icon"><Folder :size="11" /></span>
            <span class="row-name">{{ folder.name }}</span>
            <span class="row-url mono">{{ t("app.bookmarkFolderRowHint", { count: countOf(folder.id) }) }}</span>
            <span v-if="!picking" class="tree-actions" @click.stop @keydown.stop>
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
            :class="{
              drop: dropRow === bookmark.id,
              dragging: dragging?.id === bookmark.id,
              picked: picking && picked.has(pickKey('bookmark', bookmark.id)),
            }"
            :draggable="!picking"
            role="button"
            tabindex="0"
            @click="picking && togglePick('bookmark', bookmark.id)"
            @keydown.enter.prevent="picking && togglePick('bookmark', bookmark.id)"
            @dragstart="onDragStart('bookmark', bookmark.id, $event)"
            @dragend="onDragEnd"
            @dragover="onDragOverRow(bookmark, $event)"
            @drop.prevent="onDropOnRow(bookmark)"
          >
            <span v-if="picking" class="pick-box" :class="{ on: picked.has(pickKey('bookmark', bookmark.id)) }">
              <Check v-if="picked.has(pickKey('bookmark', bookmark.id))" :size="10" />
            </span>
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
              v-if="!picking"
              class="row-folder"
              compact
              :model-value="bookmark.folderId ?? ''"
              :options="folderOptions"
              :aria-label="t('app.bookmarkFolderLabel')"
              @update:model-value="moveTo(bookmark, $event ?? '')"
              @click.stop
            />
            <button v-if="!picking" type="button" class="icon-btn" :title="t('app.bookmarkEdit')" @click="openEditBookmark(bookmark)">
              <Pencil :size="11" />
            </button>
            <button
              v-if="!picking"
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
      </template>
    </SplitPane>

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
/*
 * Two independent scrollers inside the shared page frame.
 *
 * The page once scrolled as one document, so the tree and the list moved
 * together and a long tree dragged the breadcrumb out of view. The header and
 * the list's breadcrumb stay put; the tree and the rows scroll alone, like the
 * two panes of the file manager this page imitates.
 */
.bookmarks-page {
  gap: 0;
}

.tree {
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 4px;
  /*
   * Grow to the content; the pane scrolls.
   *
   * As a flex item with the default `flex: 0 1 auto` inside a scrolling column,
   * the tree was shrunk to the pane's height and its remaining rows simply
   * painted outside the bordered box — a long tree looked like two lists, one
   * inside a frame and one spilling below it. The list column already owns the
   * scroll (`SplitPane`), so this box must not be shortened at all.
   */
  flex: 0 0 auto;
}

.list {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tree-row {
  /* Anchor for the hover actions: they overlay the row's right edge instead of
     taking part in the layout. */
  position: relative;
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

/* The hover background doubles as the backdrop colour for the actions that
   fade in over the row's right edge. */
.tree-row:hover {
  --row-bg: var(--surface-2);
  background: var(--surface-2);
}

.tree-row.on {
  --row-bg: color-mix(in srgb, var(--accent) 14%, transparent);
  background: var(--row-bg);
  color: var(--text);
}

/* Shared drop highlight with the list rows: one visual word for "lands here". */
.tree-row.drop,
.row.drop {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  outline: 1px dashed color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: -2px;
}

/* Edge drops reorder among siblings, so they read as an insertion line rather
   than as "this folder receives the drag". */
.tree-row.drop-before,
.row.drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}

.tree-row.drop-after,
.row.drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
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
  transition: transform var(--motion-fast) var(--ease-out);
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
  /* Pinned to the row's true right edge. The hover actions used to sit here in
     the layout while invisible, shoving every count left by their reserved
     width — numbers floated mid-row and the tree looked broken. */
  margin-left: auto;
  font-size: 9.5px;
  color: var(--faint);
  transition: opacity var(--motion-fast) var(--ease-out);
}

/*
 * Row actions overlay the count instead of reserving space: hidden they cost
 * nothing, on hover they fade in over the spot the count vacates — the file
 * manager pattern. The backdrop fades from the row's own background so a long
 * name sliding underneath still reads.
 */
.tree-actions {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 2px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 14px;
  background: linear-gradient(to right, transparent, var(--row-bg, var(--bg)) 10px);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast) var(--ease-out);
}

/*
 * The management list is wider than its content ever is, so pinning the hover
 * actions to the row's right edge put them a full screen away from the row the
 * cursor is on. In the list they follow the content instead, and the address
 * gives up its unlimited stretch for a cap that still fits a real URL; the
 * gradient is a tree-strip trick and has nothing to sit on here.
 */
.rows .row .tree-actions {
  position: static;
  padding-left: 0;
  background: none;
  flex: none;
  top: auto;
  bottom: auto;
  right: auto;
}

.rows .row-url {
  flex: 0 1 auto;
  max-width: 46%;
}

.tree-row:hover .tree-actions,
.row:hover .tree-actions {
  opacity: 1;
  pointer-events: auto;
}

.tree-row:hover .tree-count {
  opacity: 0;
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
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg);
  flex: 1 1 auto;
  min-height: 0;
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

/*
 * Picking mode: a checkbox column and a lit row.
 *
 * The box is a fixed slot even when unchecked, so rows do not reflow when a
 * check appears; the row itself takes the accent tint, which is how the rest
 * of this shell marks "this one is selected".
 */
.pick-box {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 3px;
  border: 1px solid var(--line);
  color: var(--bg);
}

.pick-box.on {
  background: var(--accent);
  border-color: var(--accent);
}

.row.picked {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 2px 0 0 var(--accent);
}

.pick-count {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
  margin-right: 4px;
}

/* The page-level empty state: a bordered prompt with its two ways out. The
   in-folder variant below stays a plain line — it is a row inside a list, not a
   page waiting to be filled. */
/* The page-level frame comes from the shared `.empty` rule; the in-folder
   variant is this page's own, because there it is one row inside a list rather
   than a page waiting to be filled. */
.empty.in-folder {
  border: none;
  padding: 18px 2px;
  align-items: flex-start;
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--faint);
  width: auto;
  margin: 0;
}
</style>
