<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { HttpAuthChallenge } from "@shared/ipc";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";
import FormField from "./ui/FormField.vue";
import TextField from "./ui/TextField.vue";

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
      <FormField plain :label="t('app.username')">
        <TextField
          ref="userField"
          v-model="username"
          type="text"
          autocomplete="off"
        />
      </FormField>
      <FormField plain :label="t('app.password')">
        <TextField v-model="password" type="password" autocomplete="off" />
      </FormField>
      <div class="actions">
        <AppButton variant="ghost" @click="dismiss">{{ t("app.cancel") }}</AppButton>
        <!-- Click rather than type=submit: Enter in either field submits the
             form, which is the whole keyboard story this prompt needs, and a
             click target is what a mouse user reaches for anyway. -->
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

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
