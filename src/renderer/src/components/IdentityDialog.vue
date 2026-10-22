<script setup lang="ts">
import { ROLE_COLORS } from "@shared/defaults";
import type { Engine, IdentityDraft, RoleColor } from "@shared/types";
import { Eye, EyeOff, Link2, RotateCcw, Trash2, Unlink } from "lucide-vue-next";
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import ComboBox from "./ComboBox.vue";
import ExtraLoginFields from "./ExtraLoginFields.vue";
import Modal from "./Modal.vue";
import SelectField from "./SelectField.vue";

const props = defineProps<{
  draft: IdentityDraft;
  engines: Engine[];
  passwordSet: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: IdentityDraft];
  delete: [];
}>();

const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();
const form = reactive<IdentityDraft>({ ...props.draft });
const password = ref("");
const reveal = ref(false);
const error = ref<string | null>(null);
/** In inherit mode the password input stays hidden until the user asks to edit. */
const editingSitePassword = ref(false);

watch(
  () => props.draft,
  (next) => {
    Object.assign(form, next);
    password.value = "";
    editingSitePassword.value = false;
  },
);

/** Role is a displayed label, so the suggestions are localized words, not keys. */
const roleSuggestions = computed<string[]>(() => [
  t("app.roleAdmin"),
  t("app.roleEditor"),
  t("app.roleReviewer"),
  t("app.roleViewer"),
  t("app.roleGuest"),
]);

const envPasswordSet = computed(() => Boolean(store.credentials?.site[form.siteId]));

/**
 * Candidate sources for a reference: identities on the same site that are not
 * themselves references. References are one level deep by design, so offering a
 * reference here would only produce an error on save.
 */
const referenceOptions = computed(() => {
  const excluded = new Set([form.id]);
  return store.identities
    .filter(
      (identity) =>
        !excluded.has(identity.id) &&
        identity.siteId !== form.siteId &&
        identity.passwordMode !== "reference",
    )
    .map((identity) => {
      const site = store.sites.find((item) => item.id === identity.siteId);
      return {
        id: identity.id,
        name: identity.name,
        username: identity.username,
        siteName: site?.name ?? "",
      };
    });
});

const referencing = computed(() => form.passwordMode === "reference");

const referenceSource = computed(() =>
  form.credentialFrom
    ? store.identities.find((identity) => identity.id === form.credentialFrom)
    : undefined,
);

const referenceSourceSite = computed(() => {
  const source = referenceSource.value;
  if (!source) return undefined;
  return store.sites.find((item) => item.id === source.siteId);
});

const referencingDependents = computed(() =>
  form.id ? store.identities.filter((identity) => identity.credentialFrom === form.id) : [],
);

/**
 * Detaching is only meaningful for an identity that is already saved as a
 * reference; switching the form into reference mode is not the same thing.
 */
const isSavedReference = computed(() => {
  if (!form.id) return false;
  const saved = store.identities.find((identity) => identity.id === form.id);
  return saved?.passwordMode === "reference";
});

/**
 * Choosing a reference makes the synced fields read-only: a reference means
 * "exactly the same", so the only way to diverge is to detach.
 */
function chooseSource(identityId: string): void {
  form.credentialFrom = identityId || undefined;
  const source = store.identities.find((identity) => identity.id === identityId);
  if (!source) return;
  form.name = source.name;
  form.username = source.username;
  form.role = source.role;
  form.color = source.color;
  form.note = source.note;
}

function setMode(mode: "inherit" | "custom" | "reference"): void {
  form.passwordMode = mode;
  if (mode !== "reference") form.credentialFrom = undefined;
}

async function detach(): Promise<void> {
  if (!form.id) return;
  const detached = await store.detachReference(form.id);
  if (!detached) return;
  const identity = store.identities.find((item) => item.id === form.id);
  if (!identity) return;
  form.passwordMode = "custom";
  form.credentialFrom = undefined;
  form.username = identity.username;
  form.role = identity.role;
  form.color = identity.color;
  editingSitePassword.value = false;
}

const engineOptions = computed(() => [
  { value: "__inherit__", label: t("app.inheritSiteDefault") },
  ...props.engines.map((engine) => ({
    value: engine.id,
    label: `${engine.brand} ${engine.version ?? ""}`.trim(),
    hint: engine.cdp ? t("app.cdpMode") : t("app.externalMode"),
  })),
]);

const engineValue = computed(() => form.engineId ?? "__inherit__");

/** Reference sources as app-styled dropdown options (site · name · username). */
const referenceSelectOptions = computed(() =>
  referenceOptions.value.map((option) => ({
    value: option.id,
    label: `${option.siteName} · ${option.name}`,
    hint: option.username,
  })),
);

// Reactive so the swatch tooltips follow a runtime language switch.
const colorLabels = computed<Record<RoleColor, string>>(() => ({
  amber: t("app.colorAmber"),
  teal: t("app.colorTeal"),
  violet: t("app.colorViolet"),
  rose: t("app.colorRose"),
  blue: t("app.colorBlue"),
  slate: t("app.colorSlate"),
}));

function submit() {
  error.value = null;
  if (form.passwordMode === "reference") {
    if (!form.credentialFrom) {
      error.value = t("app.errReferenceSource");
      return;
    }
    emit("save", {
      ...form,
      name: form.name.trim(),
      username: form.username.trim(),
      role: form.role.trim() || "member",
      password: undefined,
    });
    return;
  }
  if (!form.name.trim()) {
    error.value = t("app.errDisplayName");
    return;
  }
  if (!form.username.trim()) {
    error.value = t("app.errUsername");
    return;
  }
  emit("save", {
    ...form,
    name: form.name.trim(),
    username: form.username.trim(),
    role: form.role.trim() || "member",
    password: password.value || undefined,
  });
}

async function saveSitePassword() {
  const envId = form.siteId;
  if (!password.value) {
    error.value = t("app.errPasswordFirst");
    return;
  }
  await store.setPassword({ kind: "site", id: envId }, password.value);
  password.value = "";
}

async function copyDefaultPassword() {
  await store.copyPassword({ kind: "site", id: form.siteId });
}

async function saveIdentityPassword() {
  if (!form.id || !password.value) return;
  const saved = await store.setPassword({ kind: "identity", id: form.id }, password.value);
  if (saved !== undefined) password.value = "";
}

async function rebuildProfile() {
  if (!form.id) return;
  const confirmed = await confirm.ask({
    title: t("app.rebuildProfile"),
    body: t("app.rebuildConfirm"),
    confirmLabel: t("app.rebuildProfile"),
    tone: "danger",
  });
  if (!confirmed) return;
  const result = await store.rebuildIdentityProfile(form.id);
  if (result) emit("close");
}
</script>

<template>
  <Modal
    :open="true"
    :title="form.id ? $t('app.editIdentityTitle') : $t('app.newIdentityTitle')"
    :description="$t('app.identityDialogDesc')"
    width="600px"
    @close="emit('close')"
  >
    <div class="form">
      <div class="row">
        <label class="field grow">
          <span class="label">{{ $t("app.displayName") }}</span>
          <input
            v-model="form.name"
            class="input"
            :readonly="referencing"
            :placeholder="$t('app.displayNameExample')"
          />
        </label>
        <label class="field" style="width: 150px">
          <span class="label">{{ $t("app.role") }}</span>
          <ComboBox
            v-model="form.role"
            :suggestions="roleSuggestions"
            :placeholder="t('app.rolePlaceholder')"
            :disabled="referencing"
          />
        </label>
      </div>

      <label class="field">
        <span class="label">{{ $t("app.username") }}</span>
        <input
          v-model="form.username"
          class="input mono"
          placeholder="admin@test.local"
          :readonly="referencing"
        />
      </label>

      <div class="field">
        <span class="label">{{ $t("app.identityColor") }}</span>
        <div class="colors" :class="{ locked: referencing }">
          <button
            v-for="color in ROLE_COLORS"
            :key="color"
            type="button"
            class="color"
            :class="{ on: form.color === color }"
            :style="{ '--role': `var(--role-${color})` }"
            :aria-label="colorLabels[color]"
            :title="colorLabels[color]"
            :disabled="referencing"
            @click="form.color = color"
          ></button>
        </div>
      </div>

      <section class="group">
        <div class="group-head">
          <span class="group-title">{{ $t("app.loginFormGroup") }}</span>
          <span class="group-note">{{ $t("app.loginFormGroupNote") }}</span>
        </div>

        <div class="field">
          <span class="label">{{ $t("app.credentialsLabel") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: form.passwordMode === 'inherit' }"
              @click="setMode('inherit')"
            >
              {{ $t("app.passwordInherit") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: form.passwordMode === 'custom' }"
              @click="setMode('custom')"
            >
              {{ $t("app.passwordCustom") }}
            </button>
            <!-- Referencing another site's account is the default way to reuse a
                 login; it is only offered when a source exists. -->
            <button
              type="button"
              class="seg"
              :class="{ on: referencing }"
              :disabled="!referenceOptions.length && !referencing"
              :title="
                referenceOptions.length
                  ? $t('app.referenceHint')
                  : $t('app.referenceNoSource')
              "
              @click="setMode('reference')"
            >
              {{ $t("app.passwordReference") }}
            </button>
          </div>
        </div>

        <div v-if="referencing" class="ref-box">
          <div class="ref-head">
            <Link2 :size="12" />
            <span>{{ $t("app.referenceFrom") }}</span>
          </div>
          <SelectField
            :model-value="form.credentialFrom ?? undefined"
            :options="referenceSelectOptions"
            :placeholder="$t('app.referencePick')"
            :aria-label="$t('app.referenceFrom')"
            @update:model-value="chooseSource($event ?? '')"
          />
          <p class="note">
            {{
              referenceSourceSite && referenceSource
                ? $t("app.referenceSyncNote", {
                    site: referenceSourceSite.name,
                    name: referenceSource.name,
                  })
                : $t("app.referencePickHint")
            }}
          </p>
          <button
            v-if="isSavedReference"
            type="button"
            class="btn"
            :disabled="store.busy === 'identity'"
            @click="detach"
          >
            <Unlink :size="12" />
            {{ $t("app.detachReference") }}
          </button>
        </div>

        <p v-if="referencingDependents.length && !referencing" class="note warn">
          {{ $t("app.referenceHasDependentsNote", { count: referencingDependents.length }) }}
        </p>

        <!-- Inheriting shows the state, not an input: two password boxes for the
             same secret was the confusing part. Editing the site default
             is possible, but has to be asked for. -->
        <div v-if="form.passwordMode === 'inherit'" class="cred-row">          <span class="cred-copy">
            <span class="cred-name">{{ $t("app.defaultPassword") }}</span>
            <span class="cred-state mono" :class="{ unset: !envPasswordSet }">
              {{ envPasswordSet ? $t("app.passwordSet") : $t("app.passwordNotSet") }}
            </span>
          </span>
          <button
            type="button"
            class="btn ghost"
            :disabled="!envPasswordSet"
            @click="copyDefaultPassword"
          >
            {{ $t("app.copy") }}
          </button>
          <button type="button" class="btn" @click="editingSitePassword = !editingSitePassword">
            {{ editingSitePassword ? $t("app.cancel") : $t("app.editSitePassword") }}
          </button>
        </div>

        <div v-if="form.passwordMode === 'custom' || editingSitePassword" class="password-row">
          <div class="pw-input">
            <input
              v-model="password"
              class="input mono"
              :type="reveal ? 'text' : 'password'"
              :placeholder="
                editingSitePassword
                  ? $t('app.envPasswordPlaceholder')
                  : $t('app.customPasswordPlaceholder')
              "
              autocomplete="new-password"
            />
            <button
              type="button"
              class="pw-btn"
              :aria-label="reveal ? $t('app.hide') : $t('app.show')"
              @click="reveal = !reveal"
            >
              <EyeOff v-if="reveal" :size="13" />
              <Eye v-else :size="13" />
            </button>
          </div>
          <button
            v-if="editingSitePassword"
            type="button"
            class="btn"
            :disabled="!password"
            @click="saveSitePassword"
          >
            {{ $t("app.saveAsSiteDefault") }}
          </button>
          <button
            v-else-if="form.id"
            type="button"
            class="btn"
            :disabled="!password"
            @click="saveIdentityPassword"
          >
            {{ $t("app.saveToIdentity") }}
          </button>
        </div>

        <p class="note">
          <template v-if="form.passwordMode === 'inherit'">
            {{ $t("app.inheritNote") }}
          </template>
          <template v-else-if="form.passwordMode === 'custom'">
            {{ $t("app.customNote") }}
          </template>
        </p>

        <ExtraLoginFields
          v-model="form.extraFields"
          :scope-hint="$t('app.identityFieldsScope')"
        />
      </section>

      <div class="row">
        <label class="field grow">
          <span class="label">{{ $t("app.startPathLabel") }}</span>
          <input v-model="form.startPath" class="input mono" placeholder="/" />
        </label>
        <label class="field grow">
          <span class="label">{{ $t("app.engineOverride") }}</span>
          <SelectField
            :model-value="engineValue"
            :options="engineOptions"
            @update:model-value="
              form.engineId = $event === '__inherit__' ? undefined : $event
            "
          />
        </label>
      </div>

      <label class="field">
        <span class="label">{{ $t("app.noteOptional") }}</span>
        <input
          v-model="form.note"
          class="input"
          :readonly="referencing"
          :placeholder="$t('app.noteExample')"
        />
      </label>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <button v-if="form.id" type="button" class="btn danger" @click="emit('delete')">
        <Trash2 :size="12" />
        {{ $t("app.delete") }}
      </button>
      <button
        v-if="form.id"
        type="button"
        class="btn"
        :disabled="store.busy === 'identity'"
        @click="rebuildProfile"
      >
        <RotateCcw :size="12" />
        {{ $t("app.rebuildProfile") }}
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn" @click="emit('close')">{{ $t("app.cancel") }}</button>
      <button type="button" class="btn primary" @click="submit">{{ $t("app.save") }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.row {
  display: flex;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.grow {
  flex: 1 1 0;
}

.label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 9px;
  font-size: 11.5px;
  color: var(--text);
  outline: 0;
}

.input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.colors {
  display: flex;
  gap: 6px;
}

.color {
  --role: var(--role-slate);
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--role) 30%, transparent);
  border: 1px solid color-mix(in srgb, var(--role) 50%, transparent);
  position: relative;
}

.color.on::after {
  content: "";
  position: absolute;
  inset: 5px;
  border-radius: 3px;
  background: var(--role);
}

.segmented {
  display: flex;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 2px;
  align-self: flex-start;
}

.seg {
  padding: 5px 10px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--muted);
}

.seg.on {
  background: var(--surface-3);
  color: var(--text);
}

.password-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cred-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 9px;
}

.ref-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 6%, var(--bg-elevated));
  padding: 10px;
}

.ref-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.colors.locked {
  opacity: 0.55;
}

.colors.locked .color {
  cursor: default;
}

.note.warn {
  color: var(--amber, #d9a441);
}

.input[readonly] {
  color: var(--muted);
  background: var(--surface-2);
}

.cred-copy {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}

.cred-name {
  font-size: 11.5px;
  color: var(--text-secondary);
}

.cred-state {
  font-size: 10px;
  color: var(--green);
  border: 1px solid color-mix(in srgb, var(--green) 40%, var(--line));
  border-radius: 999px;
  padding: 1px 7px;
}

.cred-state.unset {
  color: var(--faint);
  border-color: var(--line);
}

.pw-input {
  position: relative;
  flex: 1 1 auto;
}

.pw-input .input {
  padding-right: 30px;
}

.pw-btn {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
}

.pw-btn:hover {
  color: var(--text-secondary);
}

.note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--faint);
}

.group {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.group-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.group-note {
  font-size: 10.5px;
  color: var(--faint);
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 11px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
}

.btn.ghost {
  background: transparent;
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

/* `.btn:hover` matches primary buttons too; restate the gradient so the button
   does not turn gray while the cursor is over it. */
.btn.primary:hover:not(:disabled) {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  filter: brightness(1.07);
}

.btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 34%, var(--line));
}

.spacer {
  flex: 1;
}
</style>
