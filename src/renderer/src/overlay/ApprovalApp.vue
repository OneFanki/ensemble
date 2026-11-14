<script setup lang="ts">
/**
 * The authorization card: an AI request that needs the person's answer.
 *
 * This is a window of its own, in the bottom-right corner of the desktop, and
 * deliberately not a dialog in the console. The AI works in pages the user may
 * not be looking at — a request that waited for someone to notice a modal behind
 * several browser windows would time out every time. A card in the corner is
 * visible over whatever is in front, and needs no window switch to answer.
 *
 * ## Why the card is the whole surface
 *
 * The host window is 420×214 and transparent. There is no title bar, no close
 * button of the system's, and no page around it: an OS chrome would add a
 * fourth visual language to an app that has three. The window closes when the
 * question is answered or expires, so there is nothing to "minimise".
 *
 * ## The countdown
 *
 * Drawn here from `expiresAt` (a timestamp from the main process, so the number
 * on screen and the timer that ends the request cannot disagree), and it is
 * informational: the main process refuses the call when the time is up whether
 * or not this window has repainted.
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ApprovalRequest } from "@shared/ipc";
import type { AiApprovalDecision } from "@shared/types";
import { type Locale, setLocale } from "../i18n";
import AppButton from "../components/ui/AppButton.vue";
import { useWorkspaceStore } from "../stores/workspace";

const store = useWorkspaceStore();
const { t } = useI18n();

/**
 * The card is its own renderer, so App.vue's startup — locale, theme — never
 * runs here. Repeating it for one attribute is cheaper than a shared bootstrap
 * that would also have to know about the switcher and the focus label.
 */
function applyTheme(): void {
  const theme = store.settings.theme;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.dataset["theme"] = resolved;
}

const request = ref<ApprovalRequest | null>(null);
const remaining = ref(0);
let ticker: ReturnType<typeof setInterval> | null = null;
let disposeRequest: (() => void) | undefined;
let disposeDismiss: (() => void) | undefined;

/**
 * Seconds left, floored, so the card never shows "1 s" for 1.9 seconds and then
 * jumps to zero while the AI is still waiting.
 */
function updateRemaining(): void {
  if (!request.value) return;
  remaining.value = Math.max(0, Math.ceil((request.value.expiresAt - Date.now()) / 1000));
}

function stopTicker(): void {
  if (ticker === null) return;
  clearInterval(ticker);
  ticker = null;
}

function startTicker(): void {
  stopTicker();
  updateRemaining();
  ticker = setInterval(updateRemaining, 250);
}

async function answer(decision: AiApprovalDecision): Promise<void> {
  const current = request.value;
  if (!current) return;
  // Cleared first: the window is about to close, and a second click on a button
  // that is still around for a frame must not send a second answer.
  request.value = null;
  stopTicker();
  await window.ensemble.respondApproval(current.id, decision);
}

async function dismiss(): Promise<void> {
  const current = request.value;
  if (!current) return;
  request.value = null;
  stopTicker();
  await window.ensemble.cancelApproval(current.id);
}

/** Escape refuses, which is the same meaning as closing the card. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") void dismiss();
}

watch(
  () => request.value?.id,
  async (id) => {
    if (!id) return;
    startTicker();
    // Focus the primary answer so a keyboard user can act without tabbing
    // through three buttons — the window is shown inactive, so it does not have
    // focus until they give it some.
    await nextTick();
    document.querySelector<HTMLElement>("[data-approval-allow-once]")?.focus();
  },
);

onMounted(async () => {
  await store.init();
  // A second renderer: App.vue's startup never runs here, so the card applies the
  // theme and language for itself.
  setLocale(store.settings.locale as Locale);
  applyTheme();
  disposeRequest = window.ensemble.onApprovalRequest((next) => {
    request.value = next;
  });
  disposeDismiss = window.ensemble.onApprovalDismiss(() => {
    request.value = null;
    stopTicker();
  });
  /*
   * The push is sent when the window finishes loading, which can be before this
   * component has subscribed — so the first question of a run would be invisible
   * while the AI waited for an answer. Asking once on mount closes that gap; a
   * late push for the same request just replaces it with the same content.
   */
  const current = await window.ensemble.currentApproval();
  if (current && !request.value) request.value = current;
  window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  stopTicker();
  disposeRequest?.();
  disposeDismiss?.();
  window.removeEventListener("keydown", onKeydown);
});

watch(
  () => store.settings.theme,
  () => applyTheme(),
);
</script>

<template>
  <div class="stage">
    <section
      v-if="request"
      class="card"
      role="alertdialog"
      aria-labelledby="approval-title"
      data-approval-card
    >
      <header class="head">
        <span id="approval-title" class="kicker">{{ t("app.aiApprovalTitle") }}</span>
        <span class="countdown mono" :data-approval-countdown="remaining">{{ remaining }}s</span>
      </header>

      <p class="action" data-approval-action>
        {{ t(request.actionKey, request.actionParams ?? {}) }}
      </p>

      <div class="target">
        <span class="target-name">{{ request.siteName || request.origin }}</span>
        <span class="target-origin mono">{{ request.origin }}</span>
        <span v-if="request.context" class="target-context">{{ request.context }}</span>
      </div>

      <p class="note">{{ t("app.aiApprovalNote") }}</p>

      <footer class="actions">
        <AppButton size="sm" variant="ghost" data-approval-deny @click="dismiss">
          {{ t("app.aiApprovalDeny") }}
        </AppButton>
        <span class="gap"></span>
        <AppButton size="sm" data-approval-allow-always @click="answer('allow-always')">
          {{ t("app.aiApprovalAllowAlways") }}
        </AppButton>
        <AppButton size="sm" data-approval-allow-session @click="answer('allow-session')">
          {{ t("app.aiApprovalAllowSession") }}
        </AppButton>
        <AppButton size="sm" variant="primary" data-approval-allow-once @click="answer('allow-once')">
          {{ t("app.aiApprovalAllowOnce") }}
        </AppButton>
      </footer>
    </section>
  </div>
</template>

<style scoped>
/* The host window is transparent and frameless; everything lives inside it. */
:global(html[data-mode="approval"]),
:global(html[data-mode="approval"] body),
:global(html[data-mode="approval"] #app) {
  height: 100%;
  min-height: 0;
  background: transparent;
  overflow: hidden;
}

.stage {
  height: 100%;
  padding: 2px;
  display: flex;
}

/*
 * Dark translucent chrome in both app themes, like the switcher's captions: this
 * card floats over an arbitrary page, and a panel that matched the app's own
 * theme would vanish on a page with a similar background.
 */
.card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 12px 14px 12px;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 12px;
  background: rgb(17 20 25 / 92%);
  backdrop-filter: blur(16px);
  box-shadow: 0 16px 40px rgb(0 0 0 / 45%);
  color: #eef0f3;
  animation: card-in 180ms var(--ease-out, ease-out) both;
  overflow: hidden;
}.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.kicker {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgb(238 240 243 / 55%);
}

/* Amber while there is time, red at the end: the colour is the last warning that
   this answer is about to be assumed. */
.countdown {
  font-size: 11px;
  color: #e0a44e;
}

.action {
  margin: 0;
  font-size: 13px;
  line-height: 1.45;
  color: #f4f6f8;
}

.target {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  font-size: 11px;
}

.target-name {
  flex: 0 1 auto;
  max-width: 46%;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-origin {
  flex: 1 1 auto;
  min-width: 0;
  color: rgb(238 240 243 / 62%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-context {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgb(255 255 255 / 9%);
  color: rgb(238 240 243 / 78%);
}

.note {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.4;
  color: rgb(238 240 243 / 50%);
}

.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

/* Deny is separated from the three permits: a row of four same-weight buttons
   makes the refusal one slip of the pointer away from the most common answer. */
.gap {
  flex: 1 1 auto;
}

@keyframes card-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .card {
    animation-duration: 1ms;
  }
}
</style>
