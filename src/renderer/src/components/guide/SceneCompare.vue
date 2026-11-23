<script setup lang="ts">
/**
 * "One system, two roles, two windows side by side" — why any of this matters.
 *
 * The stage holds one page; the way to see two accounts at once is to pop a
 * page out (or open a second Ensemble window) and put the pictures next to each
 * other. So the diagram draws two separate OS windows — each with its own
 * title bar, no shell around them — and the difference lands last: the admin's
 * page carries a delete action the member's page simply does not have. Two
 * frames inside one shell would draw the split-screen story this app retired.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene compare"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneCompareAlt')"
  >
    <!-- The admin's window: full rows plus the destructive action. -->
    <g class="win win-admin">
      <rect x="24" y="44" width="228" height="252" rx="10" class="surface" />
      <!-- Its own title bar: an independent window, not a cell on a stage. -->
      <circle cx="42" cy="62" r="4" class="win-dot" />
      <circle cx="56" cy="62" r="4" class="win-dot" />
      <circle cx="70" cy="62" r="4" class="win-dot" />
      <circle cx="96" cy="84" r="6" class="role-a" />
      <text x="110" y="88" class="win-label">{{ t("app.guideSceneRoleAdmin") }}</text>
      <rect x="40" y="106" width="196" height="20" rx="5" class="row" />
      <rect x="40" y="132" width="196" height="20" rx="5" class="row" />
      <rect x="40" y="158" width="196" height="20" rx="5" class="row" />
      <rect x="40" y="184" width="196" height="20" rx="5" class="row" />
      <!-- The delete action only the admin has. It lands last on purpose. -->
      <g class="danger">
        <rect x="150" y="188" width="40" height="12" rx="4" class="danger-fill" />
        <rect x="196" y="188" width="30" height="12" rx="4" class="bar dim" />
      </g>
    </g>

    <!-- The member's window: the same rows, and no destructive action. -->
    <g class="win win-member">
      <rect x="268" y="44" width="228" height="252" rx="10" class="surface" />
      <circle cx="286" cy="62" r="4" class="win-dot" />
      <circle cx="300" cy="62" r="4" class="win-dot" />
      <circle cx="314" cy="62" r="4" class="win-dot" />
      <circle cx="340" cy="84" r="6" class="role-b" />
      <text x="354" y="88" class="win-label">{{ t("app.guideSceneRoleMember") }}</text>
      <rect x="284" y="106" width="196" height="20" rx="5" class="row" />
      <rect x="284" y="132" width="196" height="20" rx="5" class="row" />
      <rect x="284" y="158" width="196" height="20" rx="5" class="row" />
      <rect x="284" y="184" width="196" height="20" rx="5" class="row" />
      <rect x="424" y="188" width="46" height="12" rx="4" class="bar dim" />
    </g>

    <text x="260" y="332" text-anchor="middle" class="caption">
      {{ t("app.guideSceneCompareCaption") }}
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
.win-dot {
  fill: var(--faint);
  opacity: 0.5;
}
.row {
  fill: var(--faint);
  opacity: 0.14;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.4;
}
.win-label {
  fill: var(--text-secondary);
  font-size: 12px;
  font-family: var(--font-sans);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}
.danger-fill {
  fill: color-mix(in srgb, var(--red) 42%, transparent);
}
.role-a {
  fill: var(--role-amber);
}
.role-b {
  fill: var(--role-teal);
}

/* The windows land in sequence and stay; the delete chip arrives last, so the
   difference between the two windows is the thing still happening at rest. */
.win {
  transform-box: fill-box;
  transform-origin: center;
  animation: win-in 0.45s ease-out forwards;
}
.win-admin {
  animation-delay: 0s;
}
.win-member {
  animation-delay: 0.18s;
}
.danger {
  animation: chip-in 0.4s ease-out 0.55s forwards;
}

@keyframes win-in {
  0% {
    opacity: 0;
    transform: translateY(7px) scale(0.99);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes chip-in {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .win,
  .danger {
    animation: none;
    opacity: 1;
  }
}
</style>
