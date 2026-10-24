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
/** Tag being renamed inline; `null` means no chip is in edit mode. */
const renamingTagId = ref<string | null>(null);
const renameTagName = ref("");
const renameInput = ref<HTMLInputElement[] | null>(null);

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
 * Renaming happens in place on the chip: a native prompt for one short string
 * was both out of place visually and impossible to style.
 */
function startRenameTag(tag: Tag): void {
  renamingTagId.value = tag.id;
  renameTagName.value = tag.name;
  void nextTick(() => renameInput.value?.[0]?.select());
}

async function commitRenameTag(tag: Tag): Promise<void> {
  // Enter commits and unmounts the input, which also fires `blur`; the guard
  // makes the second call a no-op instead of a duplicate save.
  if (renamingTagId.value !== tag.id) return;
  const name = renameTagName.value.trim();
  renamingTagId.value = null;
  if (!name || name === tag.name) return;
  // `run` in the store reports failures as a toast; the chip keeps the old name.
  await store.saveTag({ id: tag.id, name, color: tag.color });
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
        :style="{ '--tag': `var(--role-${tag.color})` }"
      >
        <span class="dot"></span>
        <input
          v-if="renamingTagId === tag.id"
          ref="renameInput"
          v-model="renameTagName"
          class="rename"
          @keydown.enter.prevent="commitRenameTag(tag)"
          @keydown.esc.prevent="renamingTagId = null"
          @blur="commitRenameTag(tag)"
        />
        <span v-else class="name">{{ tag.name }}</span>
        <span class="usage mono" :class="{ unused: isUnused(tag) }">{{ usage(tag) }}</span>
        <IconButton :ariaLabel="$t('app.edit')"
          :title="$t('app.tagRename')"
          @click="startRenameTag(tag)">
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
}

.color-dot {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
}

.color-dot.picked {
  border-color: var(--text);
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
