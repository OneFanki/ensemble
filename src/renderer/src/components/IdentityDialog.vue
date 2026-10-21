<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Eye, EyeOff, RotateCcw, Trash2 } from "lucide-vue-next";
import Modal from "./Modal.vue";
import ExtraLoginFields from "./ExtraLoginFields.vue";
import ComboBox from "./ComboBox.vue";
import SelectField from "./SelectField.vue";
import { ROLE_COLORS } from "@shared/defaults";
import { useWorkspaceStore } from "../stores/workspace";
import type { Engine, IdentityDraft, RoleColor } from "@shared/types";

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
const { t } = useI18n();
const form = reactive<IdentityDraft>({ ...props.draft });
const password = ref("");
const reveal = ref(false);
const error = ref<string | null>(null);
/** In inherit mode the password input stays hidden until the user asks to edit. */
const editingEnvPassword = ref(false);

watch(
  () => props.draft,
  (next) => {
    Object.assign(form, next);
    password.value = "";
    editingEnvPassword.value = false;
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

const envPasswordSet = computed(
  () => Boolean(store.credentials?.environment[form.environmentId]),
);

const engineOptions = computed(() => [
  { value: "__inherit__", label: t("app.inheritEnvDefault") },
  ...props.engines.map((engine) => ({
    value: engine.id,
    label: `${engine.brand} ${engine.version ?? ""}`.trim(),
    hint: engine.cdp ? t("app.cdpMode") : t("app.externalMode"),
  })),
]);

const engineValue = computed(() => form.engineId ?? "__inherit__");

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

async function saveEnvironmentPassword() {
  const envId = form.environmentId;
  if (!password.value) {
    error.value = t("app.errPasswordFirst");
    return;
  }
  await store.setPassword({ kind: "environment", id: envId }, password.value);
  password.value = "";
}

async function copyDefaultPassword() {
  await store.copyPassword({ kind: "environment", id: form.environmentId });
}

async function saveIdentityPassword() {
  if (!form.id || !password.value) return;
  const saved = await store.setPassword({ kind: "identity", id: form.id }, password.value);
  if (saved !== undefined) password.value = "";
}

async function rebuildProfile() {
  if (!form.id) return;
  const confirmed = window.confirm(t("app.rebuildConfirm"));
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
          <input v-model="form.name" class="input" :placeholder="$t('app.displayNameExample')" />
        </label>
        <label class="field" style="width: 150px">
          <span class="label">{{ $t("app.role") }}</span>
          <ComboBox
            v-model="form.role"
            :suggestions="roleSuggestions"
            :placeholder="t('app.rolePlaceholder')"
          />
        </label>
      </div>

      <label class="field">
        <span class="label">{{ $t("app.username") }}</span>
        <input v-model="form.username" class="input mono" placeholder="admin@test.local" />
      </label>

      <div class="field">
        <span class="label">{{ $t("app.identityColor") }}</span>
        <div class="colors">
          <button
            v-for="color in ROLE_COLORS"
            :key="color"
            type="button"
            class="color"
            :class="{ on: form.color === color }"
            :style="{ '--role': `var(--role-${color})` }"
            :aria-label="colorLabels[color]"
            :title="colorLabels[color]"
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
              @click="form.passwordMode = 'inherit'"
            >
              {{ $t("app.passwordInherit") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: form.passwordMode === 'custom' }"
              @click="form.passwordMode = 'custom'"
            >
              {{ $t("app.passwordCustom") }}
            </button>
          </div>
        </div>

        <!-- Inheriting shows the state, not an input: two password boxes for the
             same secret was the confusing part. Editing the environment default
             is possible, but has to be asked for. -->
        <div v-if="form.passwordMode === 'inherit'" class="cred-row">
          <span class="cred-copy">
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
          <button type="button" class="btn" @click="editingEnvPassword = !editingEnvPassword">
            {{ editingEnvPassword ? $t("app.cancel") : $t("app.editEnvPassword") }}
          </button>
        </div>

        <div v-if="form.passwordMode === 'custom' || editingEnvPassword" class="password-row">
          <div class="pw-input">
            <input
              v-model="password"
              class="input mono"
              :type="reveal ? 'text' : 'password'"
              :placeholder="
                editingEnvPassword
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
            v-if="editingEnvPassword"
            type="button"
            class="btn"
            :disabled="!password"
            @click="saveEnvironmentPassword"
          >
            {{ $t("app.saveAsEnvDefault") }}
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
          <template v-else>
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
        <input v-model="form.note" class="input" :placeholder="$t('app.noteExample')" />
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
