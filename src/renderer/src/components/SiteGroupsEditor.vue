<script setup lang="ts">
import type { RoleColor, SiteGroup } from "@shared/types";
import { GripVertical, Pencil, Plus, Tags, Trash2 } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";
import EmptyState from "./ui/EmptyState.vue";
import FormField from "./ui/FormField.vue";
import IconButton from "./ui/IconButton.vue";
import TextField from "./ui/TextField.vue";

/**
 * Site groups: the sections a site can be filed under.
 *
 * The same component serves both entrances — the account page's inline panel
 * (where sites are arranged, so the grouping is set up next to them) and the
 * settings tab. Two implementations of "create a group" would drift on the
 * first change.
 *
 * Both writing actions happen in one dialog. A group is a name and a colour, and
 * creating and editing are the same two fields — an inline form in the page body
 * pushed the list around, and a row that turned into inputs made the list jump
 * by a row height every time it was used.
 */
const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const GROUP_COLORS: RoleColor[] = ["amber", "teal", "violet", "rose", "blue", "slate"];

const groups = computed(() => store.siteGroups);

/**
 * The dialog's draft. `group` absent means "create", present means "edit that
 * row"; `color` is kept here rather than read from the row so the swatches can
 * preview a choice without saving it.
 */
const dialog = ref<{ group?: SiteGroup; name: string; color: RoleColor } | null>(null);
const error = ref("");

function openCreate(): void {
  error.value = "";
  dialog.value = { name: "", color: "slate" };
}

function openEdit(group: SiteGroup): void {
  error.value = "";
  dialog.value = { group, name: group.name, color: group.color };
}

async function submit(): Promise<void> {
  const draft = dialog.value;
  if (!draft) return;
  const name = draft.name.trim();
  if (!name) {
    error.value = t("app.errGroupName");
    return;
  }
  // `run` in the store reports failures as a toast and answers `undefined`, so
  // the dialog only closes when the write landed.
  const saved = await store.saveSiteGroup({
    ...(draft.group ? { id: draft.group.id } : {}),
    name,
    color: draft.color,
  });
  if (saved === undefined) return;
  // Closing is written here rather than through a `close()` helper: the guard
  // above has to *precede* it in the same block, and a helper call hides that
  // ordering from a reader (and from the contract test that locks it).
  dialog.value = null;
  error.value = "";
}

/*
 * Reordering by dragging the row's grip.
 *
 * The grip rather than the whole row: a row is also a pair of action buttons, and
 * making the whole row draggable swallowed the first click of every edit. The
 * list is never filtered, so the visible index is the stored index.
 */
const draggedId = ref<string | null>(null);
const dropId = ref<string | null>(null);

function onDragStart(group: SiteGroup, event: DragEvent): void {
  draggedId.value = group.id;
  event.dataTransfer?.setData("text/plain", group.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function onDragOver(group: SiteGroup, event: DragEvent): void {
  if (!draggedId.value || draggedId.value === group.id) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropId.value = group.id;
}

function onDragLeave(group: SiteGroup): void {
  if (dropId.value === group.id) dropId.value = null;
}

async function onDrop(group: SiteGroup): Promise<void> {
  const movingId = draggedId.value;
  onDragEnd();
  if (!movingId || movingId === group.id) return;
  const toIndex = groups.value.findIndex((item) => item.id === group.id);
  if (toIndex >= 0) await store.moveSiteGroup(movingId, toIndex);
}

function onDragEnd(): void {
  draggedId.value = null;
  dropId.value = null;
}

/** "3 个站点", so an empty group is obvious. */
function usage(group: SiteGroup): string {
  return t("app.groupUsageSites", { count: store.sitesInGroup(group.id).length });
}

function isEmpty(group: SiteGroup): boolean {
  return store.sitesInGroup(group.id).length === 0;
}

async function remove(group: SiteGroup): Promise<void> {
  const accepted = await confirm.ask({
    title: t("app.delete"),
    body: t("app.deleteGroupConfirm", { name: group.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteSiteGroup(group.id);
}
</script>

<template>
  <div class="site-groups-editor">
    <div class="editor-toolbar">
      <span class="editor-title">{{ $t("app.siteGroups") }}</span>
      <AppButton data-group-new @click="openCreate">
        <Plus :size="12" />
        {{ $t("app.groupCreate") }}
      </AppButton>
    </div>

    <div v-if="groups.length" class="list">
      <div
        v-for="group in groups"
        :key="group.id"
        class="row"
        :class="{ dragging: draggedId === group.id, drop: dropId === group.id }"
        :style="{ '--tag': `var(--role-${group.color})` }"
        :data-group-id="group.id"
        @dragover="onDragOver(group, $event)"
        @dragleave="onDragLeave(group)"
        @drop.prevent="onDrop(group)"
      >
        <span
          class="grip"
          draggable="true"
          :title="$t('app.dragReorder')"
          :aria-label="$t('app.dragReorder')"
          @dragstart="onDragStart(group, $event)"
          @dragend="onDragEnd"
        >
          <GripVertical :size="12" />
        </span>
        <span class="dot"></span>
        <span class="name">{{ group.name }}</span>
        <span class="usage mono" :class="{ unused: isEmpty(group) }">{{ usage(group) }}</span>
        <IconButton
          :ariaLabel="$t('app.edit')"
          :title="$t('app.groupEdit')"
          :data-group-edit="group.id"
          @click="openEdit(group)"
        >
          <Pencil :size="12" />
        </IconButton>
        <IconButton
          variant="danger"
          :ariaLabel="$t('app.delete')"
          :title="$t('app.delete')"
          :data-group-delete="group.id"
          @click="remove(group)"
        >
          <Trash2 :size="12" />
        </IconButton>
      </div>
    </div>

    <EmptyState v-else :text="$t('app.noSiteGroups')">
      <template #icon><Tags :size="18" /></template>
      <AppButton @click="openCreate">
        <Plus :size="12" />
        {{ $t("app.groupCreate") }}
      </AppButton>
    </EmptyState>

    <Modal
      v-if="dialog"
      :open="true"
      :title="dialog.group ? $t('app.groupEdit') : $t('app.groupCreate')"
      width="420px"
      @close="dialog = null"
    >
      <form class="form" @submit.prevent="submit">
        <FormField :label="$t('app.groupName')">
          <TextField
            v-model="dialog.name"
            type="text"
            maxlength="60"
            :placeholder="$t('app.groupNamePlaceholder')"
            data-group-name
          />
        </FormField>
        <FormField as="div" :label="$t('app.groupColor')">
          <span class="color-row">
            <button
              v-for="color in GROUP_COLORS"
              :key="color"
              type="button"
              class="color-dot"
              :class="{ picked: dialog.color === color }"
              :style="{ background: `var(--role-${color})` }"
              :aria-label="color"
              :data-group-color="color"
              @click="dialog.color = color"
            ></button>
          </span>
        </FormField>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="dialog = null">{{ $t("app.cancel") }}</AppButton>
        <AppButton variant="primary" data-group-save @click="submit">
          {{ dialog.group ? $t("app.save") : $t("app.groupCreate") }}
        </AppButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.site-groups-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

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

/* The chosen swatch keeps its full colour and gets a ring outside it: a border
   inside the circle would turn the colour into a donut. */
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

.editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.editor-title {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--faint);
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
  padding: 7px 9px;
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

/* Insertion line: the row below the pointer receives the dragged group. */
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
</style>
