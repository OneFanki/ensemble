<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { HttpAuthChallenge } from "@shared/ipc";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";

/**
 * The sign-in form for an HTTP authentication challenge (a server — or a
 * proxy — that answered with 401 and `WWW-Authenticate`).
 *
 * The dialog only collects what the user types: both fields go straight back to
 * the main process, which hands them to Chromium's auth callback. Nothing is
 * stored — not by this component (cleared on every open), not by the main
 * process beyond the in-memory per-session cache, and not on disk.
 *
 * Closing the dialog by any route (cancel button, Esc, clicking outside) means
 * "answer this challenge with nothing", which is what makes the request show
 * its 401 page — the same outcome an ordinary browser produces.
 */
const props = defineProps<{ challenge: HttpAuthChallenge | null }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const username = ref("");
const password = ref("");
const userField = ref<HTMLInputElement | null>(null);

watch(
  () => props.challenge,
  async (next) => {
    if (!next) return;
    username.value = "";
    password.value = "";
    await nextTick();
    userField.value?.focus();
  },
);

async function submit(): Promise<void> {
  const current = props.challenge;
  if (!current || !username.value.trim()) return;
  await window.ensemble.httpAuthRespond(current.id, username.value.trim(), password.value);
  emit("close");
}

/** Any dismissal is a cancellation: the challenge is answered with nothing. */
async function dismiss(): Promise<void> {
  const current = props.challenge;
  if (current) await window.ensemble.httpAuthCancel(current.id);
  emit("close");
}
</script>

<template>
  <Modal
    :open="Boolean(challenge)"
    :title="challenge?.isProxy ? t('app.authProxyTitle') : t('app.authTitle', { host: challenge?.host ?? '' })"
    :description="challenge?.realm || undefined"
    width="420px"
    @close="dismiss"
  >
    <form class="auth-form" @submit.prevent="submit">
      <p class="auth-meta mono">
        {{ challenge?.scheme }} · {{ challenge?.host }}<template v-if="challenge?.port">:{{ challenge.port }}</template>
      </p>
      <label class="field">
        <span>{{ t("app.username") }}</span>
        <input
          ref="userField"
          v-model="username"
          class="input"
          type="text"
          autocomplete="off"
        />
      </label>
      <label class="field">
        <span>{{ t("app.password") }}</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="off"
        />
      </label>
      <div class="actions">
        <AppButton variant="ghost" @click="dismiss">{{ t("app.cancel") }}</AppButton>
        <!-- Click, not type=submit: AppButton pins its own type, so the form's
             submit handler is reached through the Enter key only. -->
        <AppButton variant="primary" :disabled="!username.trim()" @click="submit">
          {{ t("app.actionLogin") }}
        </AppButton>
      </div>
    </form>
  </Modal>
</template>

<style scoped>
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Technical coordinates: the challenge's address is data, not prose. */
.auth-meta {
  margin: 0;
  font-size: 11px;
  color: var(--faint);
  word-break: break-all;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
