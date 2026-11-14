<script setup lang="ts">
import type { RoleColor, Tag } from "@shared/types";
import { GripVertical, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import FormField from "./ui/FormField.vue";
import IconButton from "./ui/IconButton.vue";
import PageHeader from "./ui/PageHeader.vue";
import TextField from "./ui/TextField.vue";

/**
 * Tag management.
 *
 * Tags are one namespace for sites, accounts and views, so their home is a
 * top-level page in the rail rather than a settings tab: tagging is something
 * the user does while arranging accounts, not a one-off configuration step.
 *
 * Each tag also shows where it is used: a tag nobody applies is either a typo or
 * a leftover, and that is the only way to notice.
 *
 * Both writing actions happen in one dialog. A tag is a name and a colour, and
 * creating and editing are the same two fields — an inline form in the page body
 * pushed the list around, and a row that turned into inputs made the list jump
 * by a row height every time it was used.
 */
const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const TAG_COLORS: RoleColor[] = ["amber", "teal", "violet", "rose", "blue", "slate"];

const tags = computed(() => store.snapshot?.tags ?? []);

/**
 * The dialog's draft. `tag` absent means "create", present means "edit that
 * row"; `color` is kept here rather than read from the row so the swatches can
 * preview a choice without saving it.
 */
const dialog = ref<{ tag?: Tag; name: string; color: RoleColor } | null>(null);
const error = ref("");

function openCreate(): void {
  error.value = "";
  dialog.value = { name: "", color: "slate" };
}

function openEdit(tag: Tag): void {
  error.value = "";
  dialog.value = { tag, name: tag.name, color: tag.color };
}

async function submit(): Promise<void> {
  const draft = dialog.value;
  if (!draft) return;
  const name = draft.name.trim();
  if (!name) {
    error.value = t("app.errTagName");
    return;
  }
  // `run` in the store reports failures as a toast and answers `undefined`, so
  // the dialog only closes when the write landed.
  const saved = await store.saveTag({
    ...(draft.tag ? { id: draft.tag.id } : {}),
    name,
    color: draft.color,
  });
  if (saved === undefined) return;
  dialog.value = null;
  error.value = "";
}

/*
 * Reordering by dragging the row's grip.
 *
 * The grip rather than the whole row: a row is also a pair of action buttons and
 * a drag region, and making the whole row draggable swallowed the first click of
 * every edit. The tag list is never filtered, so the visible index is the stored
 * index and no translation is needed.
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

async function removeTag(tag: Tag): Promise<void> {
  const accepted = await confirm.ask({
    title: t("app.delete"),
    body: t("app.deleteTagConfirm", { name: tag.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteTag(tag.id);
}
</script>

<template>
  <section class="page tags">
    <PageHeader :title="$t('app.tags')">
      <template #actions>
        <AppButton variant="primary" data-tag-new @click="openCreate">
          <Plus :size="13" />
          {{ $t("app.tagCreate") }}
        </AppButton>
      </template>
    </PageHeader>

    <div class="page-body">
      <!-- One row per tag: colour, name, where it is used. A chip list hides the
           usage counts, and those are what make an unused tag worth deleting. -->
      <div v-if="tags.length" class="list">
        <div
          v-for="tag in tags"
          :key="tag.id"
          class="row"
          :class="{ dragging: draggedTagId === tag.id, drop: dropTagId === tag.id }"
          :style="{ '--tag': `var(--role-${tag.color})` }"
          :data-tag-id="tag.id"
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
          <span class="name">{{ tag.name }}</span>
          <span class="usage mono" :class="{ unused: isUnused(tag) }">{{ usage(tag) }}</span>
          <IconButton
            :ariaLabel="$t('app.edit')"
            :title="$t('app.tagEdit')"
            :data-tag-edit="tag.id"
            @click="openEdit(tag)"
          >
            <Pencil :size="12" />
          </IconButton>
          <IconButton
            variant="danger"
            :ariaLabel="$t('app.delete')"
            :title="$t('app.delete')"
            :data-tag-delete="tag.id"
            @click="removeTag(tag)"
          >
            <Trash2 :size="12" />
          </IconButton>
        </div>
      </div>
      <EmptyState
        v-else
        :text="$t('app.noTags')"
        :note="$t('app.tagsEmptyHint')"
      >
        <template #icon><TagIcon :size="20" /></template>
      </EmptyState>
    </div>

    <Modal
      v-if="dialog"
      :open="true"
      :title="dialog.tag ? $t('app.tagEdit') : $t('app.tagCreate')"
      width="420px"
      @close="dialog = null"
    >
      <form class="form" @submit.prevent="submit">
        <FormField :label="$t('app.tagName')">
          <TextField
            v-model="dialog.name"
            type="text"
            maxlength="60"
            :placeholder="$t('app.tagNamePlaceholder')"
            data-tag-name
          />
        </FormField>
        <FormField as="div" :label="$t('app.tagColor')">
          <span class="color-row">
            <button
              v-for="color in TAG_COLORS"
              :key="color"
              type="button"
              class="color-dot"
              :class="{ picked: dialog.color === color }"
              :style="{ background: `var(--role-${color})` }"
              :aria-label="color"
              :data-tag-color="color"
              @click="dialog.color = color"
            ></button>
          </span>
        </FormField>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="dialog = null">{{ $t("app.cancel") }}</AppButton>
        <AppButton variant="primary" data-tag-save @click="submit">
          {{ dialog.tag ? $t("app.save") : $t("app.tagCreate") }}
        </AppButton>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.color-row {
  display: flex;
  /* Wide enough for the selected swatch's outer ring to sit clear of its
     neighbours; at 4px the ring touched the next circle. */
  gap: 8px;
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

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

.spacer {
  flex: 1;
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

/* Drag handle: only this grip starts a drag. */
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
