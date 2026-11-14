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
} from "lucide-vue-next";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import BookmarkBar from "./BookmarkBar.vue";
import Logo from "./Logo.vue";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";
import FormField from "./ui/FormField.vue";
import InputShell from "./ui/InputShell.vue";
import TextField from "./ui/TextField.vue";

/**
 * What a blank page shows instead of an empty white rectangle.
 *
 * One field, one engine picker, and the bookmark strip across the top. It
 * resolves whatever is typed — a domain, an IP, `localhost:3000` or a scheme
 * navigates directly, everything else goes to the selected engine — so it never
 * needs a second input or a row of buttons explaining the rule.
 *
 * There is no tile grid here any more. It was bookmarks arranged a second way,
 * and it read as "pinned shortcuts" while actually being a view of the bookmark
 * tree: removing a bookmark changed it, reordering it changed the bookmarks'
 * stored order. A pinned row is its own feature with its own data, and until
 * that exists the strip and the search box are the whole surface.
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
/** The exposed `focus()` of the shared field. */
const nameInput = ref<{ focus: () => void } | null>(null);
/** The backdrop picker is a temporary overlay state, never persisted. */
const picking = ref(false);

const engine = computed(() => workspace.searchEngine);
const input = computed(() => query.value.trim());
const preview = computed(() => enginePreview(draftTemplate.value, "示例 query"));
const backdrop = computed(() => newTabBackdrop(workspace.settings.newTabBackground));
/**
 * Bookmarks are shown only when both sides agree: the setting is on, and there
 * is something to show. An empty strip would be a permanently empty row.
 */
const bookmarks = computed(() => (workspace.settings.newTabBookmarks ? workspace.bookmarks : []));
/** Folders follow the same switch, or the strip would show bookmarks without them. */
const stripFolders = computed(() =>
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

/**
 * Opens the new-engine dialog.
 *
 * The dialog rather than a form unfolding under the search box: a blank page is
 * one centred column, and a panel appearing in it pushed the box off centre —
 * the one thing on this surface that must stay where the eye expects it.
 */
async function startAdding(): Promise<void> {
  engineOpen.value = false;
  adding.value = true;
  draftName.value = "";
  draftTemplate.value = "";
  error.value = "";
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
  // Only close on a real save: `saveSettings` answers `undefined` when the write
  // failed and the toast already explained why.
  if ((await workspace.saveSettings({ customSearchEngines: next, searchEngineId: id })) === undefined) {
    return;
  }
  adding.value = false;
  error.value = "";
}

/**
 * A bookmark opens in this tab.
 *
 * Navigating the existing page rather than opening a new one is what a new-tab
 * page does in every browser: the blank tab is the destination, not a launcher.
 */
function openBookmark(bookmark: Bookmark): void {
  query.value = "";
  emit("openBookmark", bookmark);
}
</script>

<template>
  <div class="new-tab">
    <div class="nt-bg" :data-backdrop="workspace.newTabBackdropId"></div>
    <!--
      The bookmark strip belongs to the blank page, not to the browser chrome:
      it sits at the top of this surface and exists only while a blank page is
      the one on screen.
    -->
    <BookmarkBar
      v-if="bookmarks.length || stripFolders.length"
      :bookmarks="bookmarks"
      :folders="stripFolders"
      @open="openBookmark"
    />
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

      <InputShell as="form" size="hero" class="nt-box" @submit.prevent="submit">
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
          v-tooltip="t('app.newTabGo')"
        >
          <CornerDownLeft :size="14" />
        </button>
      </InputShell>

      <p v-if="error && !adding" class="nt-error">{{ error }}</p>
    </div>

    <!--
      The engine form is a dialog, not a block in the column: this surface is one
      centred search box, and anything that unfolds under it moves the box while
      the user is looking at it.
    -->
    <Modal
      v-if="adding"
      :open="true"
      :title="t('app.newTabEngineAdd')"
      width="460px"
      @close="adding = false"
    >
      <form class="engine-form" @submit.prevent="saveEngine">
        <FormField :label="t('app.newTabEngineName')">
          <TextField
            ref="nameInput"
            v-model="draftName"
            type="text"
            maxlength="40"
          />
        </FormField>
        <FormField :label="t('app.newTabEngineTemplate')">
          <TextField
            v-model="draftTemplate"
            mono
            type="text"
            spellcheck="false"
            placeholder="https://example.com/search?q=%s"
          />
          <p class="hint">
            {{ t("app.newTabEngineTemplateHint") }}
            <span v-if="preview" class="mono preview">{{ preview }}</span>
          </p>
        </FormField>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="adding = false">{{ t("app.cancel") }}</AppButton>
        <AppButton variant="primary" @click="saveEngine">{{ t("app.save") }}</AppButton>
      </template>
    </Modal>

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
          :data-backdrop="item.id"
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
  display: flex;
  /* One column: the strip on top, then the block. The block is centred by auto
     margins inside the space the strip leaves. */
  flex-direction: column;
  /* `hidden` rather than `auto`: the surface fills its slot exactly, and a
     scrollbar here was the browser drawing one for a page that does not scroll —
     it also made the whole column 15px narrower than the layout around it. */
  overflow: hidden;
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

/*
 * The backdrops, one picture per theme.
 *
 * Both the surface and the picker's swatch read `--nt-paint`, and there is
 * exactly one declaration of it per preset per theme. That is the whole point of
 * moving these out of `shared/newtab.ts`: as strings in that file the paint and
 * the swatch were two independent literals, and they had already drifted —
 * `plain` painted `--bg` and offered a swatch of `--bg-elevated`.
 *
 * The light values are not the dark ones brightened. A 5.5% teal wash that tints
 * a near-black corner disappears on near-white, so light needs about twice the
 * alpha to read as the same mood; `grid` needs a darker line than `--line-soft`,
 * which is nearly the frame colour on light. Every preset also has to stay quiet
 * enough that a search box on top of it is still the thing you look at.
 *
 * An unknown id matches no rule, so `--nt-paint` stays undefined and both layers
 * paint `--bg` — the same fallback the lookup function used to provide.
 */
.nt-bg,
.nt-swatch {
  background: var(--nt-paint, var(--bg));
}

.nt-bg[data-backdrop="aurora"],
.nt-swatch[data-backdrop="aurora"] {
  --nt-paint: radial-gradient(70% 55% at 14% 6%, rgb(45 212 191 / 5.5%), transparent 70%),
    radial-gradient(65% 55% at 88% 94%, rgb(139 92 246 / 6%), transparent 70%), var(--bg);
}

:root[data-theme="light"] .nt-bg[data-backdrop="aurora"],
:root[data-theme="light"] .nt-swatch[data-backdrop="aurora"] {
  --nt-paint: radial-gradient(70% 55% at 14% 6%, rgb(13 148 136 / 12%), transparent 70%),
    radial-gradient(65% 55% at 88% 94%, rgb(109 40 217 / 10%), transparent 70%), var(--bg);
}

.nt-bg[data-backdrop="dusk"],
.nt-swatch[data-backdrop="dusk"] {
  --nt-paint: radial-gradient(70% 55% at 82% 4%, rgb(251 146 60 / 5.5%), transparent 70%),
    radial-gradient(70% 60% at 10% 96%, rgb(244 63 94 / 5%), transparent 70%), var(--bg);
}

:root[data-theme="light"] .nt-bg[data-backdrop="dusk"],
:root[data-theme="light"] .nt-swatch[data-backdrop="dusk"] {
  --nt-paint: radial-gradient(70% 55% at 82% 4%, rgb(234 88 12 / 13%), transparent 70%),
    radial-gradient(70% 60% at 10% 96%, rgb(225 29 72 / 10%), transparent 70%), var(--bg);
}

.nt-bg[data-backdrop="night"],
.nt-swatch[data-backdrop="night"] {
  --nt-paint: radial-gradient(80% 65% at 50% -8%, rgb(59 130 246 / 7%), transparent 70%),
    radial-gradient(60% 50% at 50% 108%, rgb(30 64 175 / 7%), transparent 70%), var(--bg);
}

:root[data-theme="light"] .nt-bg[data-backdrop="night"],
:root[data-theme="light"] .nt-swatch[data-backdrop="night"] {
  --nt-paint: radial-gradient(80% 65% at 50% -8%, rgb(37 99 235 / 13%), transparent 70%),
    radial-gradient(60% 50% at 50% 108%, rgb(30 64 175 / 11%), transparent 70%), var(--bg);
}

/*
 * 24px graph paper. The dark theme draws it in `--line-soft`, which is one step
 * off the frame there; on light that token is nearly the frame colour too, so the
 * grid vanished. The lines get their own colour below rather than borrowing a
 * surface step that means something else.
 */
.nt-bg[data-backdrop="grid"],
.nt-swatch[data-backdrop="grid"] {
  --nt-paint: linear-gradient(var(--line-soft) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, var(--line-soft) 1px, transparent 1px) 0 0 / 24px 24px, var(--bg);
}

:root[data-theme="light"] .nt-bg[data-backdrop="grid"],
:root[data-theme="light"] .nt-swatch[data-backdrop="grid"] {
  --nt-paint: linear-gradient(rgb(100 116 139 / 22%) 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, rgb(100 116 139 / 22%) 1px, transparent 1px) 0 0 / 24px 24px,
    var(--bg);
}

.nt-bg[data-backdrop="plain"],
.nt-swatch[data-backdrop="plain"] {
  --nt-paint: var(--bg);
}

/*
 * The block, centred. Not a scroll container.
 *
 * It used to carry `max-height: 100%; overflow-y: auto` so a short window could
 * scroll. But the search box's engine menu is a child of this element, and a
 * scroll container clips absolutely positioned descendants — a dropdown that
 * hung past the block's right edge was cut in half. The surface never actually
 * needs to scroll: its content is one box, a strip and two short forms, and the
 * window can always grow. Centring with `margin: auto` is all this needs.
 */
.nt-inner {
  position: relative;
  width: min(560px, 100%);
  margin: auto;
  padding: 24px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* The mark and the wordmark, centred over the field: the one line on this
   surface that names what the empty page is.

   The gap is 6px, not 9px. The mark's ink now sits in the middle of its box, so
   the distance the eye reads is the distance actually set — the old 9px plus a
   built-up 2px bottom padding was three numbers compensating for one offset
   inside the SVG. */
.nt-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.nt-wordmark {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--text-secondary);
}

/* The search box is the shared `InputShell` at its hero size: the shell owns the
   border, the fill and the one-shot focus sweep, so this surface and the
   omnibox cannot drift into two different focus treatments again. Only the
   layout of its contents lives here. */
.nt-box {
  position: relative;
  width: 100%;
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
  transition: transform var(--motion-base) var(--ease-out);
}

.chev.flip {
  transform: rotate(180deg);
}

/*
 * The menu opens leftwards from the picker.
 *
 * It used to anchor `left: 0`, which put its left edge at the picker — but the
 * picker sits at the field's *right* edge, so the panel hung past the box and
 * off the window. Aligning to the picker's right edge keeps it under the field.
 */
.nt-engine-menu {
  position: absolute;
  z-index: 2;
  top: calc(100% + 6px);
  right: 0;
  min-width: 180px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  animation: nt-menu-in var(--motion-base) var(--ease-out);
  transform-origin: top right;
}

@keyframes nt-menu-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
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
  color: var(--accent-text);
}

.nt-check {
  width: 11px;
  flex: 0 0 11px;
  color: var(--accent-text);
}

.nt-engine-item.add {
  margin-top: 2px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  color: var(--faint);
}

/* The hero field is taller and larger than the toolbar's, so it overrides the
   shell's default field text. The stroke and the fill belong to the shell. */
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
  color: var(--accent-text);
  flex: 0 0 34px;
}

.nt-go:hover {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
}

/* The engine dialog's body: the same field/input shape every other dialog uses,
   so this page's one form does not invent a second style. */
.engine-form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.hint {
  margin: 0;
  font-size: 10.5px;
  color: var(--faint);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hint .preview {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

.spacer {
  flex: 1;
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
