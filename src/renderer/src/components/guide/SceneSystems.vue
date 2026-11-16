<script setup lang="ts">
/**
 * "Two systems that are easy to confuse" — profiles/bookmarks, and
 * sites/identities.
 *
 * Both halves are drawn from the same parts, because they really are two
 * parallel ideas; only the labels and the thing inside each card differ. The
 * motion is a divider that draws down the middle and then two arrows that hop
 * from behind it into their own halves, so the reader sees them split rather
 * than listed.
 *
 * The point of the page is not which is which — it is that both exist and that
 * they answer different questions. So the captions under each column state the
 * question, not the definition.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene systems"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneSystemsAlt')"
  >
    <!-- The divider draws itself first: the split is the idea. -->
    <line x1="260" y1="26" x2="260" y2="322" class="divider" />

    <!-- Left: the everyday browsing half. -->
    <g class="column left">
      <text x="120" y="34" text-anchor="middle" class="col-title">
        {{ t("app.guideSceneSystemsLeftTitle") }}
      </text>

      <!-- Profile: a jar with a name. -->
      <g class="card card-profile">
        <rect x="24" y="50" width="192" height="76" rx="10" class="surface" />
        <rect x="40" y="66" width="26" height="26" rx="7" class="glyph-box" />
        <path d="M45 84v-6a8 8 0 0 1 16 0v6" class="glyph-stroke" />
        <rect x="42" y="84" width="22" height="8" rx="3" class="glyph-stroke" />
        <rect x="78" y="66" width="110" height="8" rx="4" class="bar" />
        <rect x="78" y="82" width="76" height="6" rx="3" class="bar dim" />
        <rect x="78" y="98" width="52" height="6" rx="3" class="bar dim" />
      </g>

      <!-- Bookmarks: a shelf. -->
      <g class="card card-bookmarks">
        <rect x="24" y="140" width="192" height="76" rx="10" class="surface" />
        <rect x="40" y="156" width="26" height="26" rx="7" class="glyph-box" />
        <path d="M47 162h12v18l-6-5-6 5z" class="glyph-stroke" />
        <rect x="78" y="156" width="110" height="8" rx="4" class="bar" />
        <rect x="78" y="172" width="76" height="6" rx="3" class="bar dim" />
        <rect x="78" y="188" width="52" height="6" rx="3" class="bar dim" />
      </g>

      <text x="120" y="244" text-anchor="middle" class="question">
        {{ t("app.guideSceneSystemsLeftQ") }}
      </text>
    </g>

    <!-- Right: the accounts you test with. -->
    <g class="column right">
      <text x="400" y="34" text-anchor="middle" class="col-title">
        {{ t("app.guideSceneSystemsRightTitle") }}
      </text>

      <!-- Site: a system with a login door. -->
      <g class="card card-site">
        <rect x="304" y="50" width="192" height="76" rx="10" class="surface" />
        <rect x="320" y="66" width="26" height="26" rx="7" class="glyph-box" />
        <rect x="326" y="72" width="14" height="14" rx="3" class="glyph-stroke" />
        <rect x="358" y="66" width="110" height="8" rx="4" class="bar" />
        <rect x="358" y="82" width="76" height="6" rx="3" class="bar dim" />
        <rect x="358" y="98" width="52" height="6" rx="3" class="bar dim" />
      </g>

      <!-- Identities: a stack of accounts, each with its role colour. -->
      <g class="card card-identities">
        <rect x="304" y="140" width="192" height="76" rx="10" class="surface" />
        <circle cx="336" cy="164" r="7" class="role-a" />
        <rect x="352" y="160" width="72" height="8" rx="4" class="bar" />
        <circle cx="336" cy="186" r="7" class="role-b" />
        <rect x="352" y="182" width="60" height="8" rx="4" class="bar dim" />
        <circle cx="414" cy="186" r="7" class="role-c" />
        <rect x="430" y="182" width="50" height="8" rx="4" class="bar dim" />
      </g>

      <text x="400" y="244" text-anchor="middle" class="question">
        {{ t("app.guideSceneSystemsRightQ") }}
      </text>
    </g>

    <!-- The arrows point *inward*, toward the divider: the two systems meet and
         combine, they do not fly apart. The caption says "independent and freely
         combinable", and outward arrows said the opposite. -->
    <g class="arrows">
      <path d="M180 282h46" class="arrow" />
      <path d="M232 276l8 6-8 6" class="arrow-head" />
      <path d="M340 282h-46" class="arrow" />
      <path d="M288 276l-8 6 8 6" class="arrow-head" />
    </g>

    <text x="260" y="330" text-anchor="middle" class="caption">
      {{ t("app.guideSceneSystemsCaption") }}
    </text>
  </svg>
</template>

<style scoped>
.scene {
  /* Sizing is owned by GuideDialog, so every scene fills the same stage. */
  display: block;
  overflow: visible;
}

.surface {
  fill: var(--surface);
  stroke: var(--line);
}
.bar {
  fill: var(--text-secondary);
  opacity: 0.5;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.34;
}
.glyph-box {
  fill: color-mix(in srgb, var(--accent) 18%, transparent);
}
.glyph-stroke {
  fill: none;
  stroke: var(--accent-text);
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.col-title {
  fill: var(--text);
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-sans);
}
.question {
  fill: var(--faint);
  font-size: 11px;
  font-family: var(--font-sans);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}
.role-a {
  fill: var(--role-amber);
}
.role-b {
  fill: var(--role-teal);
}
.role-c {
  fill: var(--role-violet);
}

/* An entrance, not a loop: divider draws down the middle, the two columns land
   in separate beats, then the arrows point outward. Everything holds its final
   frame; only navigating back to the page replays it. */
.divider {
  stroke: var(--line);
  stroke-width: 1.2;
  stroke-dasharray: 300;
  stroke-dashoffset: 300;
  animation: draw-divider 0.7s ease-out forwards;
}

.arrow {
  fill: none;
  stroke: var(--faint);
  stroke-width: 1.4;
}
.arrow-head {
  fill: none;
  stroke: var(--faint);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.arrows {
  animation: arrows-in 0.5s ease-out 0.62s forwards;
}

/* Each column arrives in its own beat, so "two things" is something the reader
   sees happen rather than something the caption asserts. */
.column {
  transform-box: fill-box;
  transform-origin: center;
}
.left {
  animation: column-in 0.5s ease-out 0.08s forwards;
}
.right {
  animation: column-in 0.5s ease-out 0.3s forwards;
}

@keyframes draw-divider {
  0% {
    stroke-dashoffset: 300;
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  100% {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}

@keyframes column-in {
  0% {
    opacity: 0;
    transform: translateY(8px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes arrows-in {
  0% {
    opacity: 0;
    transform: translateY(-4px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .divider {
    animation: none;
    stroke-dashoffset: 0;
  }
  .column,
  .arrows {
    animation: none;
    opacity: 1;
  }
}
</style>
