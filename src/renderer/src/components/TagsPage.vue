<script setup lang="ts">
import type { RoleColor, Tag } from "@shared/types";
import { Pencil, Tag as TagIcon, Trash2 } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";

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
  <section class="tags">
    <header class="head">
      <div class="head-copy">
        <h1>{{ $t("app.tags") }}</h1>
        <p class="head-note">{{ $t("app.tagsSubtitle") }}</p>
      </div>
    </header>

    <div class="create">
      <input
        v-model="newTagName"
        type="text"
        :placeholder="$t('app.tagNamePlaceholder')"
        @keydown.enter.prevent="createTag"
      />
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
      <AppButton variant="primary" @click="createTag">
        {{ $t("app.tagCreate") }}
      </AppButton>
    </div>
    <p v-if="tagError" class="error">{{ tagError }}</p>

    <!-- One row per tag: name, colour, where it is used. A chip list hides the
         usage counts, and those are what make an unused tag worth deleting. -->
    <div v-if="tags.length" class="list">
      <div
        v-for="tag in tags"
        :key="tag.id"
        class="row"
        :class="{ editing: editingTagId === tag.id }"
        :style="{ '--tag': `var(--role-${editingTagId === tag.id ? editTagColor : tag.color})` }"
      >
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
  </section>
</template>

<style scoped>
/* Matches the other top-level pages: own scroll area, own header padding. */
.tags {
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px 16px;
  overflow-y: auto;
}

.head-copy h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.015em;
}

.head-note {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--faint);
  line-height: 1.55;
  max-width: 620px;
}

.create {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.create input {
  flex: 1 1 200px;
  min-width: 140px;
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 12px;
  outline: 0;
}

.create input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.color-row {
  display: flex;
  gap: 4px;
  /* Never shrink the swatches: in the edit row they sit between the name input
     and the usage column, and squeezing them makes them unclickable. */
  flex: 0 0 auto;
}

.color-dot {
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
}

.color-dot.picked {
  border-color: var(--text);
}

/* Edit mode: keep the usage column readable instead of letting it collapse
   against the swatches. */
.row.editing .usage {
  min-width: 60px;
}

/* Every page carries its own copy of the button skin; this component is
   rendered inside SettingsPage, whose scoped styles do not reach it. */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 11px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
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

.empty {
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  padding: 26px 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.empty p {
  margin: 0;
}

.empty .note {
  font-size: 11px;
  color: var(--faint);
  max-width: 420px;
  line-height: 1.6;
}
</style>
