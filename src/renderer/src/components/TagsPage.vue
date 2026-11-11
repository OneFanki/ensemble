<script setup lang="ts">
import type { RoleColor, Tag } from "@shared/types";
import { GripVertical, Pencil, Tag as TagIcon, Trash2 } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import PageHeader from "./ui/PageHeader.vue";

/**
 * Tag management.
 *
 * Tags are one namespace for sites, accounts and views, so their home is a
 * top-level page in the rail rather than a settings tab: tagging is something
 * the user does while arranging accounts, not a one-off configuration step.
 *
 * Each tag also shows where it is used: a tag nobody applies is either a typo or
 * a leftover, and that is the only way to notice.
 */
const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const TAG_COLORS: RoleColor[] = ["amber", "teal", "violet", "rose", "blue", "slate"];

const newTagName = ref("");
const newTagColor = ref<RoleColor>("slate");
const tagError = ref("");
/** Tag being edited inline; `null` means no row is in edit mode. */
const editingTagId = ref<string | null>(null);
const editTagName = ref("");
/**
 * Colour the row's edit mode is showing.
 *
 * Held separately from `tag.color`: the row must be able to preview a colour
 * without saving it, and Esc has to be able to drop the change.
 */
const editTagColor = ref<RoleColor>("slate");
const editInput = ref<HTMLInputElement[] | null>(null);

const tags = computed(() => store.snapshot?.tags ?? []);

/*
 * Reordering by dragging the row's grip.
 *
 * The grip rather than the whole row: a row also carries an inline name input
 * and a colour picker, and a draggable row would swallow text selection and the
 * first click of an edit. The tag list is never filtered, so the visible index
 * is the stored index and no translation is needed.
 */
const draggedTagId = ref<string | null>(null);
const dropTagId = ref<string | null>(null);

function onTagDragStart(tag: Tag, event: DragEvent): void {
  draggedTagId.value = tag.id;
  event.dataTransfer?.setData("text/plain", tag.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onTagDragOver(tag: Tag, event: DragEvent): void {
  if (!draggedTagId.value || draggedTagId.value === tag.id) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTagId.value = tag.id;
}

function onTagDragLeave(tag: Tag): void {
  if (dropTagId.value === tag.id) dropTagId.value = null;
}

async function onTagDrop(tag: Tag): Promise<void> {
  const movingId = draggedTagId.value;
  onTagDragEnd();
  if (!movingId || movingId === tag.id) return;
  const toIndex = tags.value.findIndex((item) => item.id === tag.id);
  if (toIndex >= 0) await store.moveTag(movingId, toIndex);
}

function onTagDragEnd(): void {
  draggedTagId.value = null;
  dropTagId.value = null;
}

/** "3 个站点 · 5 个账号 · 1 个视图", so an unused tag is obvious. */
function usage(tag: Tag): string {
  const sites = store.sites.filter((site) => site.tagIds?.includes(tag.id)).length;
  const identities = store.identities.filter((identity) => {
    if (identity.tagIds?.includes(tag.id)) return true;
    const site = store.sites.find((item) => item.id === identity.siteId);
    return Boolean(site?.tagIds?.includes(tag.id));
  }).length;
  const views = store.views.filter((view) => store.tagsForView(view).includes(tag.id)).length;
  const parts = [
    t("app.tagUsageSites", { count: sites }),
    t("app.tagUsageIdentities", { count: identities }),
    t("app.tagUsageViews", { count: views }),
  ];
  return parts.join(" · ");
}

function isUnused(tag: Tag): boolean {
  return (
    !store.sites.some((site) => site.tagIds?.includes(tag.id)) &&
    !store.identities.some((identity) => {
      if (identity.tagIds?.includes(tag.id)) return true;
      const site = store.sites.find((item) => item.id === identity.siteId);
      return Boolean(site?.tagIds?.includes(tag.id));
    }) &&
    !store.views.some((view) => store.tagsForView(view).includes(tag.id))
  );
}

async function createTag() {
  tagError.value = "";
  const name = newTagName.value.trim();
  if (!name) {
    tagError.value = t("app.errTagName");
    return;
  }
  // `run` in the store turns a rejection into a toast; a failed save comes back
  // as `undefined`, so the draft is only cleared on success.
  const saved = await store.saveTag({ name, color: newTagColor.value });
  if (saved !== undefined) newTagName.value = "";
}

/**
 * Editing happens in place on the row: a native prompt for one short string was
 * both out of place visually and impossible to style. The row carries the name
 * and the colour together, so one mode covers both — a tag's colour is part of
 * what it looks like everywhere it is applied, not a separate setting.
 */
function startEditTag(tag: Tag): void {
  editingTagId.value = tag.id;
  editTagName.value = tag.name;
  editTagColor.value = tag.color;
  void nextTick(() => editInput.value?.[0]?.select());
}

async function commitEditTag(tag: Tag): Promise<void> {
  // Enter commits and unmounts the input, which also fires `blur`; the guard
  // makes the second call a no-op instead of a duplicate save.
  if (editingTagId.value !== tag.id) return;
  const name = editTagName.value.trim();
  const color = editTagColor.value;
  editingTagId.value = null;
  // An emptied name is the user backing out, not a request to save a nameless
  // tag. A colour-only change still counts as an edit and must be saved.
  if (!name || (name === tag.name && color === tag.color)) return;
  // `run` in the store reports failures as a toast; the row keeps the old name.
  await store.saveTag({ id: tag.id, name, color });
}

/** Leaves edit mode without saving, including a colour that was only previewed. */
function cancelEditTag(): void {
  editingTagId.value = null;
}

async function removeTag(tag: Tag) {
  const accepted = await confirm.ask({
    title: t("app.delete"),
    body: t("app.deleteTagConfirm", { name: tag.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteTag(tag.id);
}

import AppButton from "./ui/AppButton.vue";
import IconButton from "./ui/IconButton.vue";
</script>

<template>
  <section class="page tags">
    <PageHeader :title="$t('app.tags')" />

    <div class="page-body">
      <!--
        One row: name, colour, create.

        The controls were stacked in a narrow card, which put the create button
        below the field it commits and left the rest of the pane empty. A tag is
        a name and a colour — two short values — so they read as one line, and
        the action closes that line at the column's right edge, where every other
        page's primary action sits.
      -->
      <form class="create" @submit.prevent="createTag">
        <label class="create-field">
          <span>{{ $t("app.tagName") }}</span>
          <input
            v-model="newTagName"
            type="text"
            :placeholder="$t('app.tagNamePlaceholder')"
            @keydown.enter.prevent="createTag"
          />
        </label>
        <div class="create-colors">
          <span class="create-label">{{ $t("app.tagColor") }}</span>
          <span class="color-row">
            <button
              v-for="color in TAG_COLORS"
              :key="color"
              type="button"
              class="color-dot"
              :class="{ picked: newTagColor === color }"
              :style="{ background: `var(--role-${color})` }"
              :aria-label="color"
              @click="newTagColor = color"
            ></button>
          </span>
        </div>
        <AppButton class="create-submit" variant="primary" type="submit">
          {{ $t("app.tagCreate") }}
        </AppButton>
      </form>
      <p v-if="tagError" class="error">{{ tagError }}</p>

      <!-- One row per tag: name, colour, where it is used. A chip list hides the
           usage counts, and those are what make an unused tag worth deleting. -->
      <div v-if="tags.length" class="list">
        <div
          v-for="tag in tags"
          :key="tag.id"
          class="row"
          :class="{
            editing: editingTagId === tag.id,
            dragging: draggedTagId === tag.id,
            drop: dropTagId === tag.id,
          }"
          :style="{ '--tag': `var(--role-${editingTagId === tag.id ? editTagColor : tag.color})` }"
          @dragover="onTagDragOver(tag, $event)"
          @dragleave="onTagDragLeave(tag)"
          @drop.prevent="onTagDrop(tag)"
        >
          <span
            class="grip"
            draggable="true"
            :title="$t('app.dragReorder')"
            :aria-label="$t('app.dragReorder')"
            @dragstart="onTagDragStart(tag, $event)"
            @dragend="onTagDragEnd"
          >
            <GripVertical :size="12" />
          </span>
          <span class="dot"></span>
          <input
            v-if="editingTagId === tag.id"
            ref="editInput"
            v-model="editTagName"
            class="rename"
            @keydown.enter.prevent="commitEditTag(tag)"
            @keydown.esc.prevent="cancelEditTag"
            @blur="commitEditTag(tag)"
          />
          <span v-else class="name">{{ tag.name }}</span>
          <!--
            The colour picker lives inside the edit mode rather than behind its own
            popover: the row already owns a mode for the name, and a colour is part
            of what the tag looks like, not a separate setting.
            `mousedown.prevent` keeps the name input from losing focus — a blur
            would commit the edit and unmount the swatches before the click lands.
          -->
          <span v-if="editingTagId === tag.id" class="color-row edit-colors">
            <button
              v-for="color in TAG_COLORS"
              :key="color"
              type="button"
              class="color-dot"
              :class="{ picked: editTagColor === color }"
              :style="{ background: `var(--role-${color})` }"
              :aria-label="color"
              @mousedown.prevent
              @click="editTagColor = color"
            ></button>
          </span>
          <span class="usage mono" :class="{ unused: isUnused(tag) }">{{ usage(tag) }}</span>
          <IconButton :ariaLabel="$t('app.edit')"
            :title="$t('app.tagEdit')"
            @click="startEditTag(tag)">
            <Pencil :size="12" />
          </IconButton>
          <IconButton variant="danger" :ariaLabel="$t('app.delete')"
            @click="removeTag(tag)">
            <Trash2 :size="12" />
          </IconButton>
        </div>
      </div>
      <div v-else class="empty">
        <TagIcon :size="20" />
        <p>{{ $t("app.noTags") }}</p>
        <p class="note">{{ $t("app.tagsEmptyHint") }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/*
 * The create row, full width like the list under it.
 *
 * It used to be a 720px card with the controls stacked, while sites, accounts
 * and views filled the pane: the page read as a card pinned to the top-left with
 * a third of the width left empty, so switching to it felt like the layout had
 * shifted. A tag is a name and a colour, so the two read as one line, and the
 * action closes that line at the column's right edge — the same right edge the
 * header action sits on everywhere else.
 */
.create {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--space-6);
  padding: var(--space-5) var(--space-6);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.create-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /*
   * Narrow on purpose. A tag name is a word or two, and a field stretched across
   * the whole card is a 700px box for a four-character value — the row stops
   * reading as a form and starts reading as a toolbar. It still shrinks on a
   * narrow window, where the action wraps under it.
   */
  flex: 0 1 320px;
  min-width: 0;
}

.create-field > span,
.create-label {
  font-size: var(--fs-2xs);
  letter-spacing: 0.04em;
  color: var(--faint);
}

.create-colors {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 0 0 auto;
}

/* Pushed to the row's right edge: the form footer's commit side. */
.create-submit {
  margin-left: auto;
}

.create input {
  width: 100%;
  height: var(--control-md);
  padding: 0 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: var(--fs-base);
  outline: 0;
}

.create input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.color-row {
  display: flex;
  /* Wide enough for the selected swatch's outer ring to sit clear of its
     neighbours; at the old 4px the ring touched the next circle. */
  gap: 8px;
  /* Never shrink the swatches: in the edit row they sit between the name input
     and the usage column, and squeezing them makes them unclickable. */
  flex: 0 0 auto;
}

.color-dot {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
  border-radius: 50%;
  border: 0;
  padding: 0;
}

/*
 * The chosen swatch keeps its full colour and gets a ring outside it.
 *
 * A 2px border sat inside the 15px circle, so the selection turned the colour
 * into a donut — the one thing you are picking was the one thing made smaller.
 * The ring is drawn outside the fill, separated from it by a hairline of page
 * background, which is legible on both themes without touching the colour.
 */
.color-dot.picked {
  box-shadow:
    0 0 0 2px var(--surface),
    0 0 0 3.5px var(--text);
}

/* Edit mode: keep the usage column readable instead of letting it collapse
   against the swatches. */
.row.editing .usage {
  min-width: 60px;
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

.list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  background: var(--surface);
}

.row + .row {
  border-top: 1px solid var(--line-soft);
}

/* Drag handle: the row also edits inline, so only this grip starts a drag. */
.grip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  color: var(--faint);
  cursor: grab;
}

.grip:active {
  cursor: grabbing;
}

.row.dragging {
  opacity: 0.5;
}

/* Insertion line: the row below the pointer receives the dragged tag. */
.row.drop {
  box-shadow: inset 0 2px 0 var(--accent);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tag);
  flex: 0 0 7px;
}

.name {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 90px;
}

.rename {
  width: 120px;
  border: none;
  border-bottom: 1px solid var(--tag);
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 0 0 1px;
  outline: none;
}

.usage {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage.unused {
  color: color-mix(in srgb, var(--accent) 62%, var(--faint));
}

/* An unused tag list is a prompt, not an empty table: the dashed box was drawn
   at full page width and read like a broken surface. Centre the message in the
   space the list would have taken. */
/* Only the second line is this page's own: the frame comes from the shared
   `.empty` rule. */
.empty .note {
  font-size: var(--fs-sm);
  color: var(--faint);
  max-width: 420px;
  line-height: 1.6;
}
</style>
