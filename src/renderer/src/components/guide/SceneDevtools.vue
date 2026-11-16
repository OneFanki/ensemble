<script setup lang="ts">
/**
 * "Developer tools: device emulation and the performance monitor."
 *
 * Two beats in one frame, because they are one feature — the docked panel — seen
 * at two of its tabs. The device beat narrows the page and swaps the pointer for
 * a touch dot; the performance beat grows a few curves. Doing them in sequence
 * says "the same panel does both", which two separate diagrams would not.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene devtools"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneDevtoolsAlt')"
  >
    <!-- The stage. -->
    <rect x="8" y="8" width="504" height="364" rx="12" class="shell" />

    <!-- Desktop page: wide, mouse pointer. -->
    <g class="desktop-page">
      <rect x="30" y="34" width="286" height="196" rx="9" class="page" />
      <rect x="46" y="50" width="90" height="9" rx="4.5" class="bar" />
      <rect x="46" y="70" width="254" height="8" rx="4" class="bar dim" />
      <rect x="46" y="86" width="212" height="8" rx="4" class="bar dim" />
      <rect x="46" y="102" width="238" height="8" rx="4" class="bar dim" />
    </g>

    <!-- Phone page: narrow, touch dot, and a resize grip in the corner. -->
    <g class="phone-page">
      <rect x="132" y="34" width="220" height="196" rx="9" class="page" />
      <rect x="146" y="48" width="192" height="168" rx="6" class="viewport" />
      <rect x="158" y="62" width="60" height="8" rx="4" class="bar" />
      <rect x="158" y="78" width="168" height="7" rx="3.5" class="bar dim" />
      <rect x="158" y="92" width="140" height="7" rx="3.5" class="bar dim" />
      <rect x="158" y="106" width="156" height="7" rx="3.5" class="bar dim" />
      <g class="touch-dot">
        <circle cx="240" cy="150" r="9" class="touch-ring" />
        <circle cx="240" cy="150" r="3.5" class="touch-core" />
      </g>
      <g class="grip">
        <path d="M338 216h12v12" class="grip-line" />
        <path d="M342 224h8" class="grip-line" />
      </g>
    </g>

    <!-- The docked panel: device tab and performance tab share the frame. -->
    <g class="panel">
      <rect x="330" y="34" width="162" height="196" rx="9" class="panel-shell" />
      <rect x="342" y="46" width="44" height="16" rx="5" class="chrome-tab" />
      <rect x="390" y="46" width="44" height="16" rx="5" class="chrome-tab" />
      <rect x="438" y="46" width="44" height="16" rx="5" class="chrome-tab" />

      <!-- Performance curves, drawn row by row. -->
      <g class="charts">
        <path d="M342 96h138" class="chart-rule" />
        <path d="M342 86l18 4 16-12 18 18 16-8 14 6 18-14 16 10 22-6" class="chart chart-1" />
        <path d="M342 138h138" class="chart-rule" />
        <path d="M342 132l20-8 14 14 20-10 16 6 18-12 16 8 18-4 16 6" class="chart chart-2" />
        <path d="M342 180h138" class="chart-rule" />
        <path d="M342 178l22 2 14-10 18 8 16-4 18 6 16-8 14 4 20-2" class="chart chart-3" />
      </g>
    </g>

    <text x="260" y="262" text-anchor="middle" class="beat-label beat-label-device">
      {{ t("app.guideSceneDevtoolsDevice") }}
    </text>
    <text x="260" y="262" text-anchor="middle" class="beat-label beat-label-perf">
      {{ t("app.guideSceneDevtoolsPerf") }}
    </text>

    <text x="260" y="330" text-anchor="middle" class="caption">
      {{ t("app.guideSceneDevtoolsCaption") }}
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
  fill: color-mix(in srgb, var(--surface-2) 45%, transparent);
  stroke: var(--line);
}
.page {
  fill: var(--surface);
  stroke: var(--line);
}
.viewport {
  fill: color-mix(in srgb, var(--surface-2) 70%, transparent);
  stroke: var(--line-soft);
}
.bar {
  fill: var(--text-secondary);
  opacity: 0.45;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.32;
}
.panel-shell {
  fill: var(--surface);
  stroke: var(--line);
}
.chrome-tab {
  fill: var(--faint);
  opacity: 0.18;
}
.chart-rule {
  stroke: var(--line-soft);
  stroke-width: 1;
}
.chart {
  fill: none;
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.chart-1 {
  stroke: var(--accent);
}
.chart-2 {
  stroke: var(--blue);
}
.chart-3 {
  stroke: var(--green);
}
.touch-ring {
  fill: color-mix(in srgb, var(--accent) 22%, transparent);
  stroke: var(--accent);
  stroke-width: 1.4;
}
.touch-core {
  fill: var(--accent);
}
.grip-line {
  fill: none;
  stroke: var(--faint);
  stroke-width: 1.4;
  stroke-linecap: round;
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}
.beat-label {
  fill: var(--muted);
  font-size: 11.5px;
  font-family: var(--font-sans);
}

/*
 * Two beats, played once: the dialogue narrows to a phone and the touch dot
 * lands on it, then the panel fills with performance curves. The panel frame
 * stays put the whole time — it is the constant that makes the two beats read as
 * one panel rather than two screenshots.
 *
 * The scene ends on the performance beat and stays there. Looping would have been
 * wrong twice over: a diagram that keeps returning to its blank desktop frame
 * looks like it is failing to load, and the two tabs are a tour of one panel, not
 * an oscillation.
 */
.phone-page,
.grip,
.touch-dot,
.charts,
.beat-label-perf {
  opacity: 0;
}
.beat-label-device {
  opacity: 1;
}

.desktop-page {
  animation: desktop-beat 1.1s ease-in-out forwards;
}
.phone-page {
  animation: phone-beat 0.5s ease-out 0.6s forwards;
}
.touch-dot {
  animation: touch-beat 0.45s ease-out 1.0s forwards;
}
.grip {
  animation: touch-beat 0.45s ease-out 1.0s forwards;
}
.charts {
  animation: perf-beat 0.4s ease-out 1.3s forwards;
}
.beat-label-device {
  animation: label-device 0.3s ease-in-out 1.2s forwards;
}
.beat-label-perf {
  animation: label-perf 0.3s ease-out 1.5s forwards;
}

.chart-1 {
  stroke-dasharray: 220;
  stroke-dashoffset: 220;
  animation: draw-chart 0.7s ease-out 1.4s forwards;
}
.chart-2 {
  stroke-dasharray: 220;
  stroke-dashoffset: 220;
  animation: draw-chart 0.7s ease-out 1.52s forwards;
}
.chart-3 {
  stroke-dasharray: 220;
  stroke-dashoffset: 220;
  animation: draw-chart 0.7s ease-out 1.64s forwards;
}

@keyframes desktop-beat {
  0%,
  55% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@keyframes phone-beat {
  0% {
    opacity: 0;
    transform: translateX(24px);
    transform-box: fill-box;
    transform-origin: center;
  }
  100% {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes touch-beat {
  0% {
    opacity: 0;
    transform: translate(18px, -12px);
    transform-box: fill-box;
    transform-origin: center;
  }
  100% {
    opacity: 1;
    transform: translate(0, 0);
  }
}

@keyframes perf-beat {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

@keyframes draw-chart {
  0% {
    stroke-dashoffset: 220;
  }
  100% {
    stroke-dashoffset: 0;
  }
}

@keyframes label-device {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@keyframes label-perf {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-page {
    animation: none;
    opacity: 0;
  }
  .phone-page,
  .grip,
  .touch-dot,
  .charts,
  .beat-label-perf {
    animation: none;
    opacity: 1;
  }
  .beat-label-device {
    animation: none;
    opacity: 0;
  }
  .chart-1,
  .chart-2,
  .chart-3 {
    animation: none;
    stroke-dashoffset: 0;
  }
}
</style>
