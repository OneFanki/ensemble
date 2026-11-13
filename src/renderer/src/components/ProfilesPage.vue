<script setup lang="ts">
/**
 * Browser profile management.
 *
 * A profile is a cookie jar with a name: the everyday one the user signs into
 * sites with, a second one to check what a colleague sees, and the throwaway
 * that forgets everything on quit. They sit in the browser half of the sidebar
 * next to bookmarks because that is where they are used — a profile is not a
 * setting about the app, it is one of the places browsing happens.
 *
 * The list is never empty: the two built-ins are re-inserted by the service if a
 * settings file loses them, so this page only ever manages additions.
 */
import type { BrowserProfile } from "@shared/types";
import { Layers, Pencil, Plus, Trash2 } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import AppButton from "./ui/AppButton.vue";
import IconButton from "./ui/IconButton.vue";
import PageHeader from "./ui/PageHeader.vue";

const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const profiles = computed(() => store.settings.profiles ?? []);
const defaultId = computed(() => store.settings.defaultProfileId);

/**
 * New profile being named.
 *
 * Created from the header rather than a row at the bottom of the list: the list
 * grows downward, and a form under it would drift out of view exactly when there
 * are enough profiles to need one.
 */
const draftName = ref("");
const creating = ref(false);
const error = ref("");

/** Row being renamed in place; `null` means the list is in its normal state. */
const editingId = ref<string | null>(null);
const editName = ref("");
const editInput = ref<HTMLInputElement[] | null>(null);

function openCreate(): void {
  creating.value = true;
  error.value = "";
}

function cancelCreate(): void {
  creating.value = false;
  draftName.value = "";
  error.value = "";
}

async function createProfile(): Promise<void> {
  const name = draftName.value.trim();
  if (!name) {
    error.value = t("app.profileNeedsName");
    return;
  }
  // `run` in the store turns a rejection into a toast and answers `undefined`,
  // so the form only closes when the profile was actually written.
  const saved = await store.createProfile(name);
  if (saved === undefined) return;
  cancelCreate();
}

/**
 * Renaming happens in the row.
 *
 * A native prompt would be unstyled and would sit over the whole window for a
 * one-word edit; the row already has exactly one thing to change, so it becomes
 * an input for as long as that change takes.
 */
function startRename(profile: BrowserProfile): void {
  editingId.value = profile.id;
  editName.value = profile.name;
  void nextTick(() => editInput.value?.[0]?.select());
}

async function commitRename(profile: BrowserProfile): Promise<void> {
  // Enter unmounts the input, which also fires `blur`; the guard keeps the
  // second call from saving twice.
  if (editingId.value !== profile.id) return;
  const name = editName.value.trim();
  editingId.value = null;
  if (!name || name === profile.name) return;
  await store.renameProfile(profile.id, name);
}

function cancelRename(): void {
  editingId.value = null;
}

async function removeProfile(profile: BrowserProfile): Promise<void> {
  const accepted = await confirm.ask({
    title: t("app.profileDeleteTitle"),
    body: t("app.profileDeleteBody", { name: profile.name }),
    confirmLabel: t("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteProfile(profile.id);
}

/**
 * The two lifetimes, as words a user can act on.
 *
 * Not "persist"/"ephemeral": those describe the mechanism. What matters when
 * choosing a row is whether the sign-in is still there tomorrow.
 */
function retentionNote(profile: BrowserProfile): string {
  return profile.retention === "ephemeral"
    ? t("app.profileEphemeralNote")
    : t("app.profilePersistNote");
}
</script>

<template>
  <section class="page profiles">
    <PageHeader :title="t('app.profiles')">
      <template #note>{{ t("app.profilesNote", { count: profiles.length }) }}</template>
      <template #actions>
        <AppButton variant="primary" data-profile-new @click="openCreate">
          <Plus :size="13" />
          {{ t("app.profileNew") }}
        </AppButton>
      </template>
    </PageHeader>

    <div class="page-body">
      <form v-if="creating" class="create" @submit.prevent="createProfile">
        <input
          v-model="draftName"
          class="create-input"
          type="text"
          :placeholder="t('app.profileNamePlaceholder')"
          data-profile-name
          @keydown.esc.prevent="cancelCreate"
        />
        <AppButton type="submit" variant="primary" data-profile-create>
          {{ t("app.profileCreate") }}
        </AppButton>
        <AppButton type="button" @click="cancelCreate">{{ t("app.cancel") }}</AppButton>
      </form>
      <p v-if="error" class="error">{{ error }}</p>

      <div class="list">
        <div
          v-for="profile in profiles"
          :key="profile.id"
          class="row"
          :class="{ editing: editingId === profile.id }"
          :data-profile-id="profile.id"
          v-tooltip="{ text: retentionNote(profile) }"
        >
          <span class="row-icon"><Layers :size="13" /></span>
          <input
            v-if="editingId === profile.id"
            ref="editInput"
            v-model="editName"
            class="rename"
            :data-profile-rename-input="profile.id"
            @keydown.enter.prevent="commitRename(profile)"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename(profile)"
          />
          <span v-else class="row-name">{{ profile.name }}</span>
          <span v-if="profile.id === defaultId" class="badge">{{ t("app.profileDefaultBadge") }}</span>
          <span class="row-spacer"></span>
          <AppButton
            v-if="profile.retention !== 'ephemeral' && profile.id !== defaultId"
            class="row-default"
            :data-profile-default="profile.id"
            @click="store.setDefaultProfile(profile.id)"
          >
            {{ t("app.profileSetDefault") }}
          </AppButton>
          <span class="row-reserve">
            <IconButton
              :ariaLabel="t('app.profileRename')"
              :title="t('app.profileRename')"
              :data-profile-rename="profile.id"
              @click="startRename(profile)"
            >
              <Pencil :size="12" />
            </IconButton>
          </span>
          <span v-if="!profile.builtin" class="row-reserve">
            <IconButton
              variant="danger"
              :ariaLabel="t('app.profileDeleteTitle')"
              :title="t('app.profileDeleteTitle')"
              :data-profile-delete="profile.id"
              @click="removeProfile(profile)"
            >
              <Trash2 :size="12" />
            </IconButton>
          </span>
          <!-- A built-in row reserves the delete slot and leaves it empty: a
               greyed icon would read as "deletable but broken" rather than as
               "not an option", and an empty box still keeps the notes aligned. -->
          <span v-else class="row-reserve"></span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.create {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.create-input {
  flex: 0 1 320px;
  min-width: 0;
  height: var(--control-md);
  padding: 0 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: var(--fs-base);
  outline: 0;
}

.create-input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
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
  padding: 9px 10px;
  background: var(--surface);
}

.row + .row {
  border-top: 1px solid var(--line-soft);
}

.row-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--faint);
}

.row-name {
  font-size: 12px;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The default marker is a state, not an action: a quiet chip on the row, in the
   same shape as the role dots elsewhere, so it never competes with the buttons.
   `--selected-strong` with a hairline rather than a bare `--selected`: in the
   dark theme the lighter step was only a shade off the row behind it and read as
   a smudge instead of a label. */
.badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--selected-strong);
  box-shadow: inset 0 0 0 1px var(--line);
  color: var(--text-secondary);
  font-size: var(--fs-2xs);
  letter-spacing: 0.02em;
}

/* A spacer where the note used to be. The lifetime is now on hover (it is
   something you learn once), but the row still needs the flexible column so the
   actions stay pinned to the right edge instead of following the name. */
.row-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

/* A default candidate only shows its button on hover: the list is usually in a
   settled state, and five always-visible "make default" buttons read as noise. */
.row-default {
  flex: 0 0 auto;
  opacity: 0;
}

.row:hover .row-default,
.row:focus-within .row-default {
  opacity: 1;
}

.rename {
  min-width: 120px;
  flex: 0 1 220px;
  border: none;
  border-bottom: 1px solid var(--accent);
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 0 0 1px;
  outline: none;
}

/* One icon button's box, empty on a built-in row: reserving the same width is
   what keeps every row's note ending at the same x. */
.row-reserve {
  flex: 0 0 auto;
  display: inline-flex;
  width: 24px;
}
</style>
