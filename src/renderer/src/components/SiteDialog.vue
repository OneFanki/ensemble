<script setup lang="ts">
import type { SiteDraft, Tag } from "@shared/types";
import { Trash2 } from "lucide-vue-next";
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import SelectField from "./SelectField.vue";
import TagPicker from "./TagPicker.vue";
import AppButton from "./ui/AppButton.vue";

const props = defineProps<{
  draft: SiteDraft;
  tags?: Tag[];
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: SiteDraft];
  delete: [];
}>();

const form = reactive<SiteDraft>({ ...props.draft });
const { t } = useI18n();
const store = useWorkspaceStore();
const error = reactive<{ message: string | null }>({ message: null });
const tags = computed(() => props.tags ?? []);

/**
 * The auto-submit choice as three options instead of a boolean.
 *
 * `default` stores nothing, so the site follows Settings → auto-submit after
 * filling. That has to be the default state of the control: a new site should
 * not carry a private copy of a global answer.
 */
type SubmitMode = "default" | "always" | "never";

const submitMode = computed<SubmitMode>(() => {
  if (form.autoSubmit === true) return "always";
  if (form.autoSubmit === false) return "never";
  return "default";
});

const submitModeOptions = computed(() => [
  { value: "default", label: t("app.autoSubmitFollowGlobal") },
  { value: "always", label: t("app.autoSubmitAlways") },
  { value: "never", label: t("app.autoSubmitNever") },
]);

function setSubmitMode(value: string | undefined): void {
  if (value === "always") form.autoSubmit = true;
  else if (value === "never") form.autoSubmit = false;
  else delete form.autoSubmit;
}

watch(
  () => props.draft,
  (next) => Object.assign(form, next),
);

function submit() {
  error.message = null;
  if (!form.name.trim()) {
    error.message = t("app.errSiteName");
    return;
  }
  if (!/^https?:\/\/[^\s]+$/i.test(form.baseUrl.trim())) {
    error.message = t("app.errSiteUrl");
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
  emit("save", {
    ...form,
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    authCheckPath: (form.authCheckPath ?? "").trim() || undefined,
    authCheckSignedOut: (form.authCheckSignedOut ?? "").trim() || undefined,
  });
}

const namePlaceholder = computed(() => t("app.siteNameExample"));

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
    :title="form.id ? $t('app.editSiteTitle') : $t('app.newSiteTitle')"
    :description="$t('app.siteDialogDesc')"
    width="620px"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span class="label">{{ $t("app.envNameLabel") }}</span>
        <input v-model="form.name" class="input" :placeholder="namePlaceholder" />
        <span class="hint">{{ $t("app.siteNameHint") }}</span>
      </label>

      <div class="field">
        <span class="label">{{ $t("app.tags") }}</span>
        <TagPicker v-model="form.tagIds" :tags="tags" />
        <span class="hint">{{ $t("app.siteTagHint") }}</span>
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
            :placeholder="$t('app.authCheckPlaceholder')"
            @blur="normalizePath"
          />
        </label>
      </div>

      <label class="field">
        <span class="label">{{ $t("app.loginMarkerOptional") }}</span>
        <input
          v-model="form.authCheckSignedOut"
          class="input mono"
          data-field="authCheckSignedOut"
          :placeholder="$t('app.loginMarkerPlaceholder')"
        />
        <span class="hint">{{ $t("app.loginMarkerHint") }}</span>
      </label>

      <section class="group">
        <div class="group-head">
          <span class="group-title">{{ $t("app.loginFormGroup") }}</span>
          <span class="group-note">{{ $t("app.loginFormGroupNote") }}</span>
        </div>

        <!--
          Three states, not a checkbox: the boolean could not express "whatever
          the global default says", and that default is now the answer for almost
          every site. An override is stored only when someone means *this* site,
          so changing the global setting still reaches sites with no opinion.

          The resolved value sits under the field rather than inside the dropdown:
          "follow global" is the answer for most sites, and an option hint is only
          visible while the list is open — i.e. exactly when the question is moot.
        -->
        <label class="field">
          <span class="label">{{ $t("app.autoSubmitLabel") }}</span>
          <SelectField
            :model-value="submitMode"
            :options="submitModeOptions"
            @update:model-value="setSubmitMode"
          />
          <span v-if="submitMode === 'default'" class="hint" data-submit-effective>
            {{
              $t("app.autoSubmitEffective", {
                state: store.settings.autoSubmitLogin
                  ? $t("app.autoSubmitAlways")
                  : $t("app.autoSubmitNever"),
              })
            }}
          </span>
          <span class="hint">{{ $t("app.autoSubmitNote") }}</span>
        </label>
      </section>

      <p v-if="error.message" class="error" role="alert">{{ error.message }}</p>
    </div>

    <template #footer>
      <AppButton variant="danger" v-if="form.id" @click="emit('delete')">
        <Trash2 :size="12" />
        {{ $t("app.delete") }}
      </AppButton>
      <span class="spacer"></span>
      <AppButton @click="emit('close')">{{ $t("app.cancel") }}</AppButton>
      <AppButton variant="primary" @click="submit">{{ $t("app.save") }}</AppButton>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
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

.hint {
  font-size: 10.5px;
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

/* `.btn:hover` matches primary buttons too; restate the gradient so the button
   does not turn gray while the cursor is over it. */
.btn.primary:hover:not(:disabled) {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  filter: brightness(1.07);
}

.spacer {
  flex: 1;
}
</style>
