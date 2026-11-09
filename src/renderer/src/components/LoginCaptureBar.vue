<script setup lang="ts">
import type { LoginCaptureNotice } from "@shared/types";
import { ChevronDown, ChevronUp, KeyRound, X } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import AppButton from "./ui/AppButton.vue";
import HintIcon from "./ui/HintIcon.vue";
import IconButton from "./ui/IconButton.vue";

/**
 * "Save this login?" prompt, modelled on the browser's own password bubble.
 *
 * It never shows or receives the password: the main process holds it behind a
 * token, so accepting opens the account form with the username pre-filled and
 * the secret saved on submit.
 *
 * The prompt is only the head of a list. Closing it used to lose the capture —
 * the password stayed in main, but nothing in the interface could ask for it
 * again, so recovering the prompt meant signing out and in again. Now every
 * login that has not been saved is still there, one click away, for as long as
 * the app runs.
 */
const props = defineProps<{
  notices: LoginCaptureNotice[];
  siteNameOf: (notice: LoginCaptureNotice) => string | undefined;
  /** Explained behind the title's info glyph: saving leaves the default profile alone. */
  profileNote: string;
}>();

const emit = defineEmits<{
  save: [notice: LoginCaptureNotice];
  dismiss: [notice: LoginCaptureNotice];
  /** Hides the bar without discarding anything; the message centre is the way back. */
  hide: [];
}>();

const { t } = useI18n();
const expanded = ref(false);
const head = computed(() => props.notices[0]);

function save(notice: LoginCaptureNotice): void {
  expanded.value = false;
  emit("save", notice);
}

function dismiss(notice: LoginCaptureNotice): void {
  if (props.notices.length <= 1) expanded.value = false;
  emit("dismiss", notice);
}
</script>

<template>
  <!--
    Expanded, the prompt becomes the record.

    Showing the list *under* the bar put the newest login on screen twice and
    left the rest looking like leftovers. One surface at a time instead: the
    panel is the whole list, newest first, and every row saves or discards
    itself. It is also the only place a capture can be declined — without it a
    prompt the user does not want could only be hidden.
  -->
  <div
    v-if="head && expanded"
    class="more"
    role="dialog"
    :aria-label="t('app.loginCaptureList')"
  >
    <div class="more-head">
      <KeyRound :size="12" />
      <span class="more-title">{{ t("app.loginCaptureTitle") }}</span>
      <HintIcon :text="profileNote" />
      <IconButton
        :ariaLabel="t('app.loginCaptureCollapse')"
        data-capture-collapse
        @click="expanded = false"
      >
        <ChevronDown :size="12" />
      </IconButton>
    </div>
    <div v-for="notice in notices" :key="notice.token" class="row">
      <span class="row-user mono">{{ notice.username }}</span>
      <span class="row-site">{{ siteNameOf(notice) ?? notice.origin }}</span>
      <button type="button" class="row-save" @click="save(notice)">
        {{ t("app.loginCaptureSave") }}
      </button>
      <button
        type="button"
        class="row-drop"
        :aria-label="t('app.loginCaptureDismiss')"
        @click="dismiss(notice)"
      >
        <X :size="10" />
      </button>
    </div>
  </div>

  <div
    v-if="head && !expanded"
    class="capture-stack"
    role="dialog"
    :aria-label="t('app.loginCaptureTitle')"
  >
    <div class="capture">
      <span class="icon"><KeyRound :size="14" /></span>
      <div class="copy">
        <p class="title">
          {{ t("app.loginCaptureTitle") }}
          <HintIcon :text="profileNote" />
        </p>
        <p class="detail mono">
          {{ siteNameOf(head) ?? head.origin }} · {{ head.username }}
        </p>
      </div>
      <AppButton variant="primary" @click="save(head)">
        {{ t("app.loginCaptureSave") }}
      </AppButton>
      <IconButton
        :ariaLabel="t('app.loginCaptureList')"
        :title="t('app.loginCaptureList')"
        data-capture-list
        :aria-expanded="expanded"
        @click="expanded = true"
      >
        <ChevronUp :size="12" />
      </IconButton>
      <IconButton
        :ariaLabel="t('app.loginCaptureHide')"
        data-capture-hide
        @click="emit('hide')"
      >
        <X :size="12" />
      </IconButton>
    </div>
  </div>
</template>

<style scoped>
.capture-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.capture {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  box-shadow: var(--shadow-menu);
}

.more {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  padding: 6px 10px 8px;
  max-height: 220px;
  overflow-y: auto;
}

/* Same key icon and accent tint as the bar, so expanding reads as the same
   prompt unfolding rather than a different panel arriving. */
.more-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 4px;
  color: var(--text-secondary);
}

.more-head > svg {
  color: var(--accent);
}

.more-title {
  font-size: var(--fs-sm);
  color: var(--text);
  flex: 1;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-top: 1px solid var(--line-soft);
}

.row:first-of-type {
  border-top: 0;
}

.row-user {
  font-size: 11px;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-site {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-save,
.row-drop {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--accent);
  padding: 2px 6px;
  border-radius: 4px;
}

.row-save:hover,
.row-drop:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.row-drop {
  color: var(--faint);
  display: inline-flex;
  align-items: center;
}

.icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent-text);
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

/* The chevron flips to point back down when the list is open. */
.turned svg {
  transform: rotate(180deg);
}
</style>
