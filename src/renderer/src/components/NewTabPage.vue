<script setup lang="ts">
import type { EmbeddedTab } from "@shared/embedded";
import { NEW_TAB_BACKDROPS, newTabBackdrop } from "@shared/newtab";
import { enginePreview, isValidEngineTemplate, resolveBrowserInput } from "@shared/search";
import type { Bookmark } from "@shared/types";
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  Palette,
  Plus,
  Search,
  Star,
  X,
} from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import BookmarkGrid from "./BookmarkGrid.vue";
import Logo from "./Logo.vue";
import AppButton from "./ui/AppButton.vue";

/**
 * What a blank page shows instead of an empty white rectangle.
 *
 * One field, one engine picker, and — when the user has any — a grid of plain
 * bookmarks. It resolves whatever is typed — a domain, an IP, `localhost:3000`
 * or a scheme navigates directly, everything else goes to the selected engine —
 * so it never needs a second input or a row of buttons explaining the rule.
 *
 * The backdrop is a preset, not an image file: this surface has to paint before
 * any network call, and the choice is a settings string that survives export.
 */
const props = defineProps<{ tab: EmbeddedTab }>();

const emit = defineEmits<{
  /** A bookmark was clicked; the browser page navigates this tab. */
  openBookmark: [bookmark: Bookmark];
}>();

const store = useEmbeddedStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const query = ref("");
const error = ref("");
const engineOpen = ref(false);
const adding = ref(false);
const draftName = ref("");
const draftTemplate = ref("");
const nameInput = ref<HTMLInputElement | null>(null);
/** The backdrop picker is a temporary overlay state, never persisted. */
const picking = ref(false);

const engine = computed(() => workspace.searchEngine);
const input = computed(() => query.value.trim());
const preview = computed(() => enginePreview(draftTemplate.value, "示例 query"));
const backdrop = computed(() => newTabBackdrop(workspace.settings.newTabBackground));
/**
 * Bookmarks are shown only when both sides agree: the setting is on, and there
 * is something to show. An empty grid would be a permanently empty box.
 */
const bookmarks = computed(() => (workspace.settings.newTabBookmarks ? workspace.bookmarks : []));
/** Folders follow the same switch, or the grid would show folder tiles alone. */
const gridFolders = computed(() =>
  workspace.settings.newTabBookmarks ? workspace.bookmarkFolders : [],
);

async function submit(): Promise<void> {
  error.value = "";
  const value = input.value;
  if (!value) return;
  // A highlighted suggestion is the pick: Enter opens it instead of searching.
  const picked = suggestions.value[suggestIndex.value];
  if (picked) {
    openSuggestion(picked);
    return;
  }
  const url = resolveBrowserInput(value, engine.value);
  if (!url) {
    error.value = t("app.newTabBadInput");
    return;
  }
  query.value = "";
  await store.navigate(props.tab.id, url);
}

/** Host of a bookmark URL for the suggestion row's secondary label. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Bookmarks matching the typed text, across the whole tree.
 *
 * Deep folder trees make search the fast path: a bookmark four levels down is
 * reachable with a few keystrokes instead of four clicks into the grid. Name
 * matches rank above URL matches; the cap keeps the panel a suggestion, not a
 * second grid.
 */
const suggestions = computed(() => {
  const q = input.value.toLowerCase();
  if (!q || !workspace.settings.newTabBookmarks) return [];
  const scored: Array<{ bookmark: Bookmark; rank: number }> = [];
  for (const bookmark of workspace.bookmarks) {
    const name = bookmark.name.toLowerCase();
    const url = bookmark.url.toLowerCase();
    let rank = -1;
    if (name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (url.includes(q)) rank = 2;
    if (rank >= 0) scored.push({ bookmark, rank });
  }
  return scored
    .sort((left, right) => left.rank - right.rank)
    .slice(0, 8)
    .map((entry) => entry.bookmark);
});

/** The suggestion Enter will open; `-1` means none highlighted — Enter searches. */
const suggestIndex = ref(-1);

watch(query, () => {
  suggestIndex.value = -1;
});

function onInputKeydown(event: KeyboardEvent): void {
  if (!suggestions.value.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    suggestIndex.value = (suggestIndex.value + 1) % suggestions.value.length;
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    suggestIndex.value =
      suggestIndex.value < 0
        ? suggestions.value.length - 1
        : (suggestIndex.value - 1 + suggestions.value.length) % suggestions.value.length;
  } else if (event.key === "Escape") {
    suggestIndex.value = -1;
  }
}

function openSuggestion(bookmark: Bookmark): void {
  query.value = "";
  suggestIndex.value = -1;
  emit("openBookmark", bookmark);
}

async function chooseEngine(id: string): Promise<void> {
  engineOpen.value = false;
  if (id === engine.value.id) return;
  await workspace.saveSettings({ searchEngineId: id });
}

async function pickBackdrop(id: string): Promise<void> {
  picking.value = false;
  if (id === backdrop.value.id) return;
  await workspace.saveSettings({ newTabBackground: id });
}

async function startAdding(): Promise<void> {
  engineOpen.value = false;
  adding.value = true;
  draftName.value = "";
  draftTemplate.value = "";
  await nextTick();
  nameInput.value?.focus();
}

async function saveEngine(): Promise<void> {
  const name = draftName.value.trim();
  const template = draftTemplate.value.trim();
  if (!name || !isValidEngineTemplate(template)) {
    error.value = t("app.newTabEngineInvalid");
    return;
  }
  const id = `custom-${Date.now().toString(36)}`;
  const next = [...workspace.settings.customSearchEngines, { id, name, urlTemplate: template }];
  await workspace.saveSettings({ customSearchEngines: next, searchEngineId: id });
  adding.value = false;
  error.value = "";
}

/**
 * A bookmark tile opens in this tab.
 *
 * Navigating the existing page rather than opening a new one is what a new-tab
 * page does in every browser: the blank tab is the destination, not a launcher.
 */
function openBookmark(bookmark: Bookmark): void {
  query.value = "";
  emit("openBookmark", bookmark);
}

async function renameBookmark(bookmark: Bookmark, name: string): Promise<void> {
  await workspace.saveBookmark({ id: bookmark.id, name, url: bookmark.url });
}

async function removeBookmark(bookmark: Bookmark): Promise<void> {
  await workspace.deleteBookmark(bookmark.id);
  workspace.notify(t("app.bookmarkRemoved", { name: bookmark.name }), "success");
}

async function moveBookmark(bookmark: Bookmark, toIndex: number): Promise<void> {
  await workspace.moveBookmark(bookmark.id, toIndex);
}

/** Dropping a tile on a folder tile or breadcrumb crumb files it there. */
async function fileBookmark(bookmark: Bookmark, folderId: string): Promise<void> {
  await workspace.saveBookmark({
    id: bookmark.id,
    name: bookmark.name,
    url: bookmark.url,
    // An empty id is the root crumb: "unfile", not "store an empty label".
    folderId: folderId || undefined,
  });
}
</script>

<template>
  <div class="new-tab">
    <div class="nt-bg" :style="{ background: workspace.newTabBackdropStyle }"></div>
    <div class="nt-inner">
      <!--
        The product's own name, above the field.
        A new-tab page with a lone search box reads as an error state: the
        surface is empty, so nothing on it says "this is ready". The mark plus
        the wordmark give the empty page a subject, and they are the only
        content here that is not a control.
      -->
      <div class="nt-brand">
        <Logo :size="28" />
        <span class="nt-wordmark">Ensemble</span>
      </div>

      <form class="nt-box" @submit.prevent="submit">
        <Search :size="15" class="nt-magnifier" aria-hidden="true" />
        <input
          v-model="query"
          class="nt-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('app.newTabPlaceholder')"
          :aria-label="t('app.newTabPlaceholder')"
          @input="error = ''"
          @keydown="onInputKeydown"
        />
        <!-- Bookmark suggestions across the whole tree: the deep-path escape
             hatch. Enter with a row highlighted opens it; otherwise the
             default (URL or search engine) applies. -->
        <div v-if="suggestions.length" class="nt-suggest" role="listbox" :aria-label="t('app.bookmarks')">
          <button
            v-for="(bookmark, index) in suggestions"
            :key="bookmark.id"
            type="button"
            role="option"
            class="nt-suggest-row"
            :class="{ active: index === suggestIndex }"
            :aria-selected="index === suggestIndex"
            :title="`${bookmark.name}\n${bookmark.url}`"
            @mouseenter="suggestIndex = index"
            @click="openSuggestion(bookmark)"
          >
            <span class="nt-suggest-icon">
              <img v-if="bookmark.favicon" :src="bookmark.favicon" alt="" draggable="false" />
              <Star v-else :size="11" />
            </span>
            <span class="nt-suggest-name">{{ bookmark.name }}</span>
            <span class="nt-suggest-url mono">{{ hostOf(bookmark.url) }}</span>
          </button>
        </div>
        <!--
          The engine sits at the field's trailing edge, the way a browser puts
          its search engine there: it is an attribute of the box, not a prefix
          to the words being typed.
        -->
        <div class="nt-engine">
          <button
            type="button"
            class="nt-engine-btn"
            :aria-label="t('app.newTabEngine')"
            :aria-expanded="engineOpen"
            @click="engineOpen = !engineOpen"
          >
            <span class="nt-engine-name">{{ engine.name }}</span>
            <ChevronDown :size="12" class="chev" :class="{ flip: engineOpen }" />
          </button>
          <div v-if="engineOpen" class="nt-engine-menu" role="listbox">
            <button
              v-for="item in workspace.searchEngines"
              :key="item.id"
              type="button"
              role="option"
              class="nt-engine-item"
              :class="{ active: item.id === engine.id }"
              :aria-selected="item.id === engine.id"
              @click="chooseEngine(item.id)"
            >
              <Check v-if="item.id === engine.id" :size="11" class="nt-check" />
              <span v-else class="nt-check"></span>
              {{ item.name }}
            </button>
            <button type="button" class="nt-engine-item add" @click="startAdding">
              <Plus :size="11" />
              {{ t("app.newTabEngineAdd") }}
            </button>
          </div>
        </div>
        <!-- Only while there is something to submit. A permanently disabled
             glyph is a control that never does anything, and the field already
             submits on Enter. -->
        <button
          v-if="input"
          type="submit"
          class="nt-go"
          :aria-label="t('app.newTabGo')"
          :title="t('app.newTabGo')"
        >
          <CornerDownLeft :size="14" />
        </button>
      </form>

      <form v-if="adding" class="nt-custom" @submit.prevent="saveEngine">
        <div class="nt-custom-head">
          <span>{{ t("app.newTabEngineAdd") }}</span>
          <button type="button" class="nt-close" :aria-label="t('app.cancel')" @click="adding = false">
            <X :size="12" />
          </button>
        </div>
        <div class="nt-custom-row">
          <input
            ref="nameInput"
            v-model="draftName"
            type="text"
            :placeholder="t('app.newTabEngineName')"
            :aria-label="t('app.newTabEngineName')"
          />
          <input
            v-model="draftTemplate"
            type="text"
            class="mono"
            spellcheck="false"
            placeholder="https://example.com/search?q=%s"
            :aria-label="t('app.newTabEngineTemplate')"
          />
        </div>
        <p class="nt-custom-note">
          {{ t("app.newTabEngineTemplateHint") }}
          <span v-if="preview" class="mono preview">{{ preview }}</span>
        </p>
        <AppButton size="sm" variant="primary" @click="saveEngine">
          {{ t("app.save") }}
        </AppButton>
      </form>

      <BookmarkGrid
        v-if="bookmarks.length || gridFolders.length"
        :bookmarks="bookmarks"
        :folders="gridFolders"
        @open="openBookmark"
        @rename="renameBookmark"
        @remove="removeBookmark"
        @move="moveBookmark"
        @file="fileBookmark"
      />

      <p v-if="error" class="nt-error">{{ error }}</p>
    </div>

    <!--
      Backdrop picker. A corner control rather than a settings row: the choice
      is only interesting while looking at the page it changes, and this keeps
      it out of the way of the search box.
    -->
    <div class="nt-look">
      <div v-if="picking" class="nt-swatches" role="radiogroup" :aria-label="t('app.newTabBackground')">
        <button
          v-for="item in NEW_TAB_BACKDROPS"
          :key="item.id"
          type="button"
          role="radio"
          class="nt-swatch"
          :class="{ active: item.id === backdrop.id }"
          :aria-checked="item.id === backdrop.id"
          :title="t(item.labelKey)"
          :aria-label="t(item.labelKey)"
          :style="{ background: item.swatch }"
          @click="pickBackdrop(item.id)"
        ></button>
      </div>
      <button
        type="button"
        class="nt-look-btn"
        :aria-label="t('app.newTabBackground')"
        :aria-expanded="picking"
        @click="picking = !picking"
      >
        <Palette :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.new-tab {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow: auto;
  background: var(--bg);
}

/* Backdrop layer: the pattern presets are tiled, so they are faded out at the
   edges. It has to be its own layer — a mask on the surface would fade the
   search box with it. */
.nt-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  mask-image: radial-gradient(120% 100% at 50% 45%, #000 55%, transparent 100%);
}

.nt-inner {
  position: relative;
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* The mark and the wordmark, centred over the field: the one line on this
   surface that names what the empty page is. */
.nt-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding-bottom: 2px;
}

.nt-wordmark {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--text-secondary);
}

.nt-box {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 46px;
  padding: 0 6px 0 14px;
  border: 1px solid var(--line);
  /* A rounded rectangle, not a pill. Height/2 radius on a 46px box is the
     search pill of a phone home screen; on a desktop window it was the only
     fully-round shape in the product. */
  border-radius: var(--radius-lg);
  background: var(--surface);
  /* No elevation: the border already separates the field from the backdrop, and
     a drop shadow under a search box made this surface read as a floating
     widget instead of part of the page. */
}

.nt-box:focus-within {
  border-color: color-mix(in srgb, var(--line) 45%, var(--accent));
}

/* The magnifier leads the field, as it does in every browser's omnibox; the
   engine picker trails it, because the engine is a property of the search and
   not a prefix to what is being typed. */
.nt-magnifier {
  flex: 0 0 15px;
  color: var(--faint);
}

.nt-engine {
  position: relative;
  flex: 0 0 auto;
}

.nt-engine-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 9px;
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  white-space: nowrap;
}

.nt-engine-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.nt-engine-name {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chev {
  color: var(--faint);
  transition: transform 0.15s ease;
}

.chev.flip {
  transform: rotate(180deg);
}

.nt-engine-menu {
  position: absolute;
  z-index: 2;
  top: calc(100% + 6px);
  left: 0;
  min-width: 180px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.nt-engine-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.nt-engine-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.nt-engine-item.active {
  color: var(--accent);
}

.nt-check {
  width: 11px;
  flex: 0 0 11px;
  color: var(--accent);
}

.nt-engine-item.add {
  margin-top: 2px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  color: var(--faint);
}

.nt-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 34px;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-md);
  outline: none;
}

/*
 * Suggestion panel, anchored to the search box. It covers the grid behind it
 * (z-index over the tiles) and scrolls if eight rows outgrow the box.
 */
.nt-suggest {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 3;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.nt-suggest-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 11.5px;
  text-align: left;
}

.nt-suggest-row:hover,
.nt-suggest-row.active {
  background: var(--surface-2);
  color: var(--text);
}

.nt-suggest-icon {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  border-radius: 4px;
  overflow: hidden;
  color: var(--faint);
}

.nt-suggest-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.nt-suggest-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nt-suggest-url {
  margin-left: auto;
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--faint);
}

/* Appears only while there is input to submit, so it never renders as a
   permanently disabled glyph with nothing to do. */
.nt-go {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  flex: 0 0 34px;
}

.nt-go:hover {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
}

.nt-custom {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--surface);
  align-items: flex-start;
}

.nt-custom-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.nt-close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--faint);
}

.nt-close:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.nt-custom-row {
  display: flex;
  gap: 6px;
  width: 100%;
}

.nt-custom-row input {
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 11.5px;
  outline: none;
}

.nt-custom-row input:focus {
  border-color: color-mix(in srgb, var(--line) 50%, var(--accent));
}

.nt-custom-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--faint);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.nt-custom-note .preview {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nt-error {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: var(--red);
}

.nt-look {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.nt-swatches {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: var(--shadow-menu);
}

.nt-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  cursor: pointer;
}

.nt-swatch.active {
  box-shadow:
    0 0 0 1px var(--surface),
    0 0 0 2px var(--accent);
}

.nt-look-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  color: var(--faint);
}

.nt-look-btn:hover {
  color: var(--text);
  border-color: var(--line);
}
</style>
