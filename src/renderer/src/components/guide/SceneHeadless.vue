<script setup lang="ts">
/**
 * "The window can be gone and the AI keeps working."
 *
 * The scene is built around one reveal: the activity trace is already running
 * *behind* the window, spanning wider than it, and when the window folds away the
 * trace is uncovered rather than started. That is the whole claim — the work was
 * going on all along; the window was only ever on top of it.
 *
 * An earlier revision folded the window down to a dot above the tray, which left
 * a speck floating in an otherwise empty half of the panel: the final frame read
 * as a broken render, not as a capability. Revealing a trace that was already
 * there fixes both halves of the problem — nothing is left hanging, and the
 * remaining frame is a complete composition with the tray beneath it.
 *
 * The trace keeps a pulse travelling along it for as long as the page is open.
 * That is the one thing that has to still be moving when the reader's eye
 * arrives, because "something is happening" is the sentence.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();

/**
 * One path, described once, so the base stroke and the travelling pulse cannot
 * drift apart. `pathLength="100"` on the pulsing element normalises its length,
 * which lets the dash maths below be in percent instead of a hand-counted pixel
 * total that silently breaks whenever the trace is edited.
 */
const TRACE =
  "M50 139h40l12-34 14 66 12-46 12 14h34l12-26 14 54 12-40 12 10h34l12-32 14 60 12-44 12 12h34l12-28 14 50 12-38 12 12h38";
</script>

<template>
  <svg
    class="scene headless"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneHeadlessAlt')"
  >
    <!-- The work, running underneath and wider than the window. Drawn first so
         the window covers it; the fold is what uncovers it. -->
    <g class="activity">
      <path :d="TRACE" class="trace-base" />
      <path :d="TRACE" pathLength="100" class="trace-pulse" />
    </g>

    <!-- The app window, which will fold away. -->
    <g class="window">
      <rect x="130" y="51" width="260" height="156" rx="12" class="shell" />
      <rect x="144" y="65" width="232" height="18" rx="5" class="title-bar" />
      <rect x="144" y="95" width="108" height="96" rx="7" class="page" />
      <rect x="264" y="95" width="112" height="44" rx="7" class="page" />
      <rect x="264" y="147" width="112" height="44" rx="7" class="page dim" />
    </g>

    <!-- The tray, and the app's dot inside it. -->
    <g class="tray">
      <rect x="196" y="231" width="128" height="30" rx="8" class="tray-bar" />
      <circle cx="220" cy="246" r="5.5" class="tray-dot" />
      <rect x="234" y="242" width="42" height="7" rx="3.5" class="bar dim" />
    </g>

    <text x="260" y="321" text-anchor="middle" class="caption">
      {{ t("app.guideSceneHeadlessCaption") }}
    </text>
  </svg>
</template>

<style scoped>
.scene {
  /* Sizing is owned by GuideDialog, so every scene fills the same stage. */
  display: block;
  overflow: visible;
}

.shell {
  fill: var(--surface);
  stroke: var(--line);
}
.title-bar {
  fill: var(--faint);
  opacity: 0.16;
}
.page {
  fill: color-mix(in srgb, var(--surface-2) 70%, transparent);
  stroke: var(--line-soft);
}
.page.dim {
  opacity: 0.55;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.4;
}
.tray-bar {
  fill: var(--surface);
  stroke: var(--line);
}
.tray-dot {
  fill: var(--green);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}

.trace-base {
  fill: none;
  stroke: color-mix(in srgb, var(--accent) 26%, transparent);
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* The pulse is a short dash that runs the whole path and then starts again. On a
   normalised `pathLength` of 100 the numbers are percentages, so the dash stays
   in proportion no matter how the trace is redrawn. */
.trace-pulse {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-dasharray: 13 87;
  animation: travel 2.6s linear infinite;
}

/*
 * The story, played once: the window is here and busy; it folds toward the tray
 * and out of the way; the tray dot lights; the trace is now the only thing left
 * on screen, and it is still running.
 *
 * The fold *stays folded*, and it ends fully transparent. A window that bounced
 * back every few seconds would read as a crash-and-restart rather than as a
 * capability, and leaving it at partial opacity left a translucent rectangle
 * hanging over the trace it is supposed to have uncovered.
 */
.window {
  transform-box: fill-box;
  transform-origin: center bottom;
  animation: fold-away 1.5s ease-in-out 0.7s forwards;
}

.tray {
  opacity: 0.5;
  animation: tray-rest 0.4s ease-out 1.6s forwards;
}

.tray-dot {
  animation: tray-on 0.4s ease-out 1.6s forwards;
}

@keyframes fold-away {
  0% {
    opacity: 1;
    transform: translate(0, 0) scale(1, 1);
  }
  55% {
    opacity: 0.6;
    transform: translate(0, 26px) scale(0.46, 0.22);
  }
  100% {
    opacity: 0;
    transform: translate(0, 56px) scale(0.1, 0.05);
  }
}

@keyframes tray-on {
  0% {
    opacity: 0.2;
    r: 5.5;
  }
  100% {
    opacity: 1;
    r: 6.5;
  }
}

@keyframes tray-rest {
  0% {
    opacity: 0.5;
  }
  100% {
    opacity: 1;
  }
}

@keyframes travel {
  0% {
    stroke-dashoffset: 13;
  }
  100% {
    stroke-dashoffset: -100;
  }
}

@media (prefers-reduced-motion: reduce) {
  .window {
    animation: none;
    opacity: 0;
  }
  .tray,
  .tray-dot {
    animation: none;
    opacity: 1;
  }
  .trace-pulse {
    animation: none;
    stroke-dashoffset: 0;
    stroke-dasharray: none;
  }
}
</style>
