<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Trash2 } from "lucide-vue-next";
import Modal from "./Modal.vue";
import ExtraLoginFields from "./ExtraLoginFields.vue";
import type { Engine, EnvironmentDraft, EnvironmentKind } from "@shared/types";

const props = defineProps<{
  draft: EnvironmentDraft;
  engines: Engine[];
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: EnvironmentDraft];
  delete: [];
}>();

const form = reactive<EnvironmentDraft>({ ...props.draft });
const { t } = useI18n();
const error = reactive<{ message: string | null }>({ message: null });

watch(
  () => props.draft,
  (next) => Object.assign(form, next),
);

function submit() {
  error.message = null;
  if (!form.name.trim()) {
    error.message = t("app.errEnvName");
    return;
  }
  if (!/^https?:\/\/[^\s]+$/i.test(form.baseUrl.trim())) {
    error.message = t("app.errEnvUrl");
    return;
  }
  if (!form.loginPath.startsWith("/")) {
    error.message = t("app.errLoginPath");
    return;
  }
  if (form.authCheckPath && !form.authCheckPath.startsWith("/")) {
    error.message = t("app.errCheckPath");
    return;
  }
  emit("save", { ...form, name: form.name.trim(), baseUrl: form.baseUrl.trim() });
}

// Reactive so the segmented labels follow a runtime language switch.
const kinds = computed<Array<{ value: EnvironmentKind; label: string; hint: string }>>(() => [
  { value: "local", label: t("app.kindLocal"), hint: t("app.kindLocalHint") },
  { value: "staging", label: t("app.kindStaging"), hint: t("app.kindStagingHint") },
  { value: "prod", label: t("app.kindProd"), hint: t("app.kindProdHint") },
]);

function normalizePath(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.value.trim();
  if (value && !value.startsWith("/")) {
    const key = input.dataset["field"];
    if (key === "loginPath") form.loginPath = `/${value}`;
    if (key === "authCheckPath") form.authCheckPath = `/${value}`;
  }
}
</script>

<template>
  <Modal
    :open="true"
    :title="form.id ? $t('app.editEnvironmentTitle') : $t('app.newEnvironmentTitle')"
    :description="$t('app.envDialogDesc')"
    @close="emit('close')"
  >
    <div class="form">
      <div class="row">
        <label class="field grow">
          <span class="label">{{ $t("app.envNameLabel") }}</span>
          <input v-model="form.name" class="input" :placeholder="$t('app.envNameExample')" />
        </label>
        <fieldset class="field">
          <legend class="label">{{ $t("app.kind") }}</legend>
          <div class="segmented">
            <button
              v-for="kind in kinds"
              :key="kind.value"
              type="button"
              class="seg"
              :class="{ on: form.kind === kind.value, danger: kind.value === 'prod' && form.kind === 'prod' }"
              :title="kind.hint"
              @click="form.kind = kind.value"
            >
              {{ kind.label }}
            </button>
          </div>
        </fieldset>
      </div>

      <label class="field">
        <span class="label">{{ $t("app.envUrlLabel") }}</span>
        <input v-model="form.baseUrl" class="input mono" placeholder="http://localhost:5173" />
      </label>

      <div class="row">
        <label class="field grow">
          <span class="label">{{ $t("app.loginEntry") }}</span>
          <input
            v-model="form.loginPath"
            class="input mono"
            data-field="loginPath"
            placeholder="/login"
            @blur="normalizePath"
          />
        </label>
        <label class="field grow">
          <span class="label">{{ $t("app.loginCheckOptional") }}</span>
          <input
            v-model="form.authCheckPath"
            class="input mono"
            data-field="authCheckPath"
            placeholder="/api/me"
            @blur="normalizePath"
          />
        </label>
      </div>

      <label class="field">
        <span class="label">{{ $t("app.defaultEngine") }}</span>
        <select v-model="form.defaultEngineId" class="input">
          <option :value="undefined">{{ $t("app.autoPickEngine") }}</option>
          <option v-for="engine in engines" :key="engine.id" :value="engine.id">
            {{ engine.brand }} {{ engine.version ?? "" }}
            <template v-if="engine.status === 'blocked'">{{ $t("app.engineBlockedSuffix") }}</template>
            <template v-else-if="!engine.cdp">{{ $t("app.engineExternalSuffix") }}</template>
          </option>
        </select>
      </label>

      <label class="check">
        <input v-model="form.autoSubmit" type="checkbox" />
        <span>{{ $t("app.autoSubmitNote") }}</span>
      </label>

      <ExtraLoginFields
        v-model="form.extraFields"
        :scope-hint="$t('app.envFieldsScope')"
      />

      <p v-if="error.message" class="error" role="alert">{{ error.message }}</p>
    </div>

    <template #footer>
      <button v-if="form.id" type="button" class="btn danger" @click="emit('delete')">
        <Trash2 :size="12" />
        {{ $t("app.delete") }}
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
  border: 0;
  margin: 0;
  padding: 0;
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
  padding: 0;
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

.segmented {
  display: flex;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 2px;
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

.seg.on.danger {
  background: color-mix(in srgb, var(--red) 14%, transparent);
  color: var(--red);
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
}

.check input {
  margin-top: 2px;
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
  padding: 7px 12px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
}

.btn:hover {
  background: var(--surface-3);
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 34%, var(--line));
}

.spacer {
  flex: 1;
}
</style>
