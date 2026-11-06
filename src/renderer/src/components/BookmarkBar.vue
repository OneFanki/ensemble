<script setup lang="ts">
import type { Bookmark, BookmarkFolder } from "@shared/types";
import { ChevronDown, Globe } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import BookmarkBarFolder from "./BookmarkBarFolder.vue";

/**
 * The one-row bookmark strip at the top of a blank page.
 *
 * Only the new-tab surface gets it — the browser chrome above the stage has no
 * bookmark bar at all, so on any other page the strip simply is not there. That
 * is the same default every desktop browser ships: the bar is a property of the
 * empty page, not of every tab.
 *
 * Folders open on hover (see `BookmarkBarFolder`), and rows that do not fit
 * collapse into a trailing overflow menu instead of being clipped. The fit is
 * measured rather than computed from a guess: names and favicons make widths
 * unpredictable, so the bar renders every row, reads the real widths, then
 * hides the tail in the same task — the user never sees the measuring pass.
 */
const props = defineProps<{
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
}>();

const emit = defineEmits<{ open: [bookmark: Bookmark] }>();

const { t } = useI18n();

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
  emit("open", bookmark);
}

function toggleOverflow(): void {
  overflowOpen.value = !overflowOpen.value;
}
</script>

<template>
  <div ref="bar" class="bookmark-bar" role="toolbar" :aria-label="t('app.bookmarkBar')">
    <template v-for="(entry, index) in entries" :key="rowKey(entry)">
      <div v-if="index < fit" class="bb-cell" data-bar-row>
        <BookmarkBarFolder
          v-if="entry.kind === 'folder'"
          :folder="entry.folder!"
          :bookmarks="bookmarks"
          :folders="folders"
          :level="0"
          :ancestors="[]"
          @open="openBookmark"
        />
        <button
          v-else
          type="button"
          class="bb-entry"
          :title="`${entry.bookmark!.name}\n${entry.bookmark!.url}`"
          @click="openBookmark(entry.bookmark!)"
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
            />
            <button
              v-else
              type="button"
              role="menuitem"
              class="bb-entry bb-row"
              :title="`${entry.bookmark!.name}\n${entry.bookmark!.url}`"
              @click="openBookmark(entry.bookmark!)"
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
