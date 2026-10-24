<script setup lang="ts">
import type { LoginCaptureNotice } from "@shared/types";
import { KeyRound, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

/**
 * "Save this login?" prompt, modelled on the browser's own password bubble.
 *
 * It never shows or receives the password: the main process holds it behind a
 * token, so accepting opens the account form with the username pre-filled and
 * the secret saved on submit.
 */
const props = defineProps<{ notice: LoginCaptureNotice; siteName?: string }>();

const emit = defineEmits<{
  save: [notice: LoginCaptureNotice];
  dismiss: [notice: LoginCaptureNotice];
}>();

const { t } = useI18n();

import AppButton from "./ui/AppButton.vue";
import IconButton from "./ui/IconButton.vue";
</script>

<template>
  <div class="capture" role="dialog" :aria-label="t('app.loginCaptureTitle')">
    <span class="icon"><KeyRound :size="14" /></span>
    <div class="copy">
      <p class="title">{{ t("app.loginCaptureTitle") }}</p>
      <p class="detail mono">
        {{ siteName ?? props.notice.origin }} · {{ props.notice.username }}
      </p>
    </div>
    <AppButton variant="primary" @click="emit('save', props.notice)">
      {{ t("app.loginCaptureSave") }}
    </AppButton>
    <IconButton :ariaLabel="t('app.loginCaptureDismiss')"
      :title="t('app.loginCaptureDismiss')"
      @click="emit('dismiss', props.notice)">
      <X :size="12" />
    </IconButton>
  </div>
</template>

<style scoped>
.capture {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  box-shadow: 0 12px 28px rgb(0 0 0 / 34%);
}

.icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  flex: 0 0 26px;
}

.copy {
  min-width: 0;
  flex: 1;
}

.title {
  margin: 0;
  font-size: 11.5px;
  color: var(--text);
}

.detail {
  margin: 2px 0 0;
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
