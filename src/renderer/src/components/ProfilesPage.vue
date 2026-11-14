<script setup lang="ts">
/**
 * Browser profile management.
 *
 * A profile is a cookie jar with a name: the everyday one the user signs into
 * sites with, a second one to check what a colleague sees. They sit in the
 * browser half of the sidebar next to bookmarks because that is where they are
 * used — a profile is not a setting about the app, it is one of the places
 * browsing happens.
 *
 * Every row launches, and launching is what this page is for: a jar nobody opens
 * is a list entry with no purpose. The launch control offers the built-in surface
 * and every external browser the app found, because "open this jar in Chrome" is the
 * same question as "open it here" — only the surface differs.
 *
 * The clean session is listed last, drawn differently, and offers no rename or
 * delete. It is the one fixed throwaway rather than a jar anyone keeps, so it
 * belongs here as an opening, not as a managed row.
 */
import type { BrowserProfile } from "@shared/types";
import { Layers, Pencil, Plus, ShieldOff, Trash2 } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";
import FormField from "./ui/FormField.vue";
import TextField from "./ui/TextField.vue";
import IconButton from "./ui/IconButton.vue";
import LaunchSplitButton from "./ui/LaunchSplitButton.vue";
import PageHeader from "./ui/PageHeader.vue";

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const { t } = useI18n();

/** The profiles this page manages; the clean session is listed apart. */
const persistent = computed(() =>
  (store.settings.profiles ?? []).filter((profile) => profile.retention !== "ephemeral"),
);
const cleanProfile = computed(() =>
  (store.settings.profiles ?? []).find((profile) => profile.retention === "ephemeral"),
);
/** Everything the page lists, in order: the jars, then the throwaway. */
const profiles = computed(() => [
  ...persistent.value,
  ...(cleanProfile.value ? [cleanProfile.value] : []),
]);
const defaultId = computed(() => store.settings.defaultProfileId);

/**
 * The one dialog, doing double duty.
 *
 * A name is the only field a profile has, so creating and renaming are the same
 * form: `profile` absent means "create", present means "rename that row". Both
 * used to happen in the page body, which pushed the list down and — for create —
 * stayed open after a successful write, so the row appeared under a form that
 * still looked pending.
 */
const dialog = ref<{ profile?: BrowserProfile; name: string } | null>(null);
const error = ref("");

function openCreate(): void {
  error.value = "";
  dialog.value = { name: "" };
}

/** Built-ins have nothing to rename: the row carries no affordance for it. */
function openRename(profile: BrowserProfile): void {
  error.value = "";
  dialog.value = { profile, name: profile.name };
}

async function submit(): Promise<void> {
  const draft = dialog.value;
  if (!draft) return;
  const name = draft.name.trim();
  if (!name) {
    error.value = t("app.profileNeedsName");
    return;
  }
  // `run` in the store turns a rejection into a toast and answers `undefined`,
  // so the dialog only closes when the write actually landed.
  const saved = draft.profile
    ? await store.renameProfile(draft.profile.id, name)
    : await store.createProfile(name);
  if (saved === undefined) return;
  dialog.value = null;
  error.value = "";
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
 * Opens a blank browser in this jar, on the surface the user picked.
 *
 * The built-in half goes through the embedded store, which reads the row's own
 * retention — an ephemeral profile gets a throwaway in-memory session, which is
 * what makes the clean row actually clean.
 */
async function launchProfile(profile: BrowserProfile): Promise<void> {
  await embedded.openProfileTab(profile.id);
}

/** The same jar in one external browser. */
async function launchProfileExternal(profile: BrowserProfile, engineId: string): Promise<void> {
  await store.launchProfile(profile.id, { engineId });
}
</script>

<template>
  <section class="page profiles">
    <PageHeader :title="t('app.profiles')">
      <template #note>{{ t("app.profilesNote", { count: persistent.length }) }}</template>
      <template #actions>
        <AppButton variant="primary" data-profile-new @click="openCreate">
          <Plus :size="13" />
          {{ t("app.profileNew") }}
        </AppButton>
      </template>
    </PageHeader>

    <div class="page-body">
      <div class="list">
        <div
          v-for="profile in persistent"
          :key="profile.id"
          class="row"
          :data-profile-id="profile.id"
        >
          <span class="row-icon"><Layers :size="13" /></span>
          <span class="row-name">{{ profile.name }}</span>
          <span v-if="profile.id === defaultId" class="badge">{{ t("app.profileDefaultBadge") }}</span>
          <span class="row-spacer"></span>
          <AppButton
            v-if="profile.id !== defaultId"
            class="row-default"
            size="sm"
            :data-profile-default="profile.id"
            @click="store.setDefaultProfile(profile.id)"
          >
            {{ t("app.profileSetDefault") }}
          </AppButton>
          <span v-if="!profile.builtin" class="row-reserve">
            <IconButton
              :ariaLabel="t('app.profileRename')"
              :title="t('app.profileRename')"
              :data-profile-rename="profile.id"
              @click="openRename(profile)"
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
          <!-- A built-in row reserves both slots and leaves them empty: a greyed
               icon would read as "available but broken" rather than as "not an
               option", and the empty boxes keep the buttons aligned. -->
          <template v-else>
            <span class="row-reserve"></span>
            <span class="row-reserve"></span>
          </template>
          <LaunchSplitButton
            compact
            :aria-label="t('app.profileOpen')"
            :data-hook="`profile-${profile.id}`"
            @launch="launchProfile(profile)"
            @launch-external="launchProfileExternal(profile, $event)"
          />
        </div>

        <!-- The throwaway, last and dashed.
             It offers the same launch control as a profile — opening a clean jar in
             an external browser is a legitimate reason to be here — but no rename, no
             delete and no "make default": it is one fixed empty jar, not a row
             anyone manages. -->
        <div
          v-if="cleanProfile"
          class="row dashed"
          :data-profile-id="cleanProfile.id"
          :data-profile-clean="cleanProfile.id"
        >
          <span class="row-icon"><ShieldOff :size="13" /></span>
          <span class="row-name">{{ cleanProfile.name }}</span>
          <span class="row-spacer"></span>
          <span class="row-reserve"></span>
          <span class="row-reserve"></span>
          <LaunchSplitButton
            compact
            :aria-label="t('app.profileOpen')"
            :data-hook="`profile-${cleanProfile.id}`"
            @launch="launchProfile(cleanProfile)"
            @launch-external="launchProfileExternal(cleanProfile, $event)"
          />
        </div>
      </div>
    </div>

    <Modal
      v-if="dialog"
      :open="true"
      :title="dialog.profile ? t('app.profileRename') : t('app.profileNew')"
      width="420px"
      @close="dialog = null"
    >
      <form class="form" @submit.prevent="submit">
        <FormField :label="t('app.profileNameLabel')">
          <TextField
            v-model="dialog.name"
            type="text"
            maxlength="60"
            :placeholder="t('app.profileNamePlaceholder')"
            data-profile-name
          />
        </FormField>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>
      <template #footer>
        <span class="spacer"></span>
        <AppButton @click="dialog = null">{{ t("app.cancel") }}</AppButton>
        <AppButton variant="primary" data-profile-create @click="submit">
          {{ dialog.profile ? t("app.save") : t("app.profileCreate") }}
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

/* Keeps the actions pinned to the right edge instead of following the name. */
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

/* One icon button's box, empty on a built-in row: reserving the same width is
   what keeps every row's actions ending at the same x. */
.row-reserve {
  flex: 0 0 auto;
  display: inline-flex;
  width: 24px;
}

/* The clean session: the same row, drawn as the throwaway it is. A dashed edge
   and no action buttons say "an opening, not a jar you keep" without a caption
   repeating it. */
.row.dashed {
  border-top: 1px dashed var(--line);
}

.row.dashed .row-name {
  color: var(--muted);
}
</style>
