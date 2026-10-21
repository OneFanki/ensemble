<script setup lang="ts">
import type { FocusLabelPayload } from "@shared/types";
import { onMounted, onUnmounted, ref } from "vue";

/**
 * Transient label shown over a browser window right after it is raised.
 *
 * The window hosting this root is frameless, click-through and never focused, so
 * the pill can sit on top of the page without stealing input. Pages that look
 * identical are exactly the case where the window itself gives no clue about
 * which account it holds, so the label stays for a couple of seconds and fades.
 */
const payload = ref<FocusLabelPayload | null>(null);

let dispose: (() => void) | undefined;

onMounted(() => {
  dispose = window.ensemble.onFocusLabelShow((next) => {
    // A new payload replaces the previous one outright. There is deliberately no
    // leave transition: an out-going pill would sit next to the new one while it
    // faded, and two labels on screen at once read as "two windows are focused".
    payload.value = next;
  });
});

onUnmounted(() => dispose?.());
</script>

<template>
  <div class="stage">
    <!-- Only ever one pill: the key forces a fresh element so its entrance
         animation replays, and Vue removes the previous node immediately. -->
    <div
      v-if="payload"
      :key="payload.seq"
      class="pill"
      :style="{ '--role': `var(--role-${payload.color})` }"
    >
      <span class="dot"></span>
      <span class="copy">
        <span class="name">{{ payload.label }}</span>
        <span v-if="payload.role || payload.environment" class="meta">
          <span v-if="payload.role" class="role">{{ payload.role }}</span>
          <span v-if="payload.role && payload.environment" class="sep">·</span>
          <span v-if="payload.environment" class="env">{{ payload.environment }}</span>
        </span>
      </span>
    </div>
  </div>
</template>

<style scoped>
/*
 * The host window is transparent and borderless. Its own size is fixed by the
 * main process, so everything here is positioned inside it.
 */
:global(html[data-mode="focus-label"]),
:global(html[data-mode="focus-label"] body),
:global(html[data-mode="focus-label"] #app) {
  height: 100%;
  min-height: 0;
  background: transparent;
  overflow: hidden;
}

.stage {
  height: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 4px;
  pointer-events: none;
}

/*
 * Dark translucent chrome on purpose, in both app themes: this pill floats over
 * an arbitrary web page, and a same-tone panel would vanish on pages with a
 * matching background. The blur keeps the name readable over busy content.
 *
 * The corners are a gentle 10px, not a full capsule: identity is carried by a
 * round dot, and a pill-shaped container with a coloured edge inside it made
 * that edge look clipped at the rounded ends.
 */
.pill {
  --role: var(--role-slate);
  display: inline-flex;
  align-items: center;
  gap: 9px;
  max-width: 396px;
  padding: 8px 13px;
  border: 1px solid rgb(255 255 255 / 12%);
  background: rgb(17 20 25 / 86%);
  border-radius: 10px;
  backdrop-filter: blur(14px);
  box-shadow: 0 10px 26px rgb(0 0 0 / 35%);
  color: #eef0f3;
  user-select: none;
  animation: pill-in 180ms ease-out both;
}

/* Plain dot, no halo: a glowing ring inside the rounded corner read as a
   decoration the shape did not agree with. */
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 7px;
  background: var(--role);
}

.copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.name {
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 10px;
  line-height: 1.25;
  color: rgb(238 240 243 / 62%);
}

.role,
.env {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sep {
  opacity: 0.5;
}

/* Entrance only. The old pill is unmounted the moment a new one arrives, so
   there is no exit animation to overlap with. */
@keyframes pill-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pill {
    animation-duration: 1ms;
  }
}
</style>
