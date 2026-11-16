<script setup lang="ts">
/**
 * "One system, four roles, side by side" — why the isolation matters.
 *
 * The four cells fill in sequence, and each one reveals a different amount of
 * chrome: an admin cell has a delete action, a member cell does not, a guest
 * cell is masked. That difference is the whole reason someone opens this app, so
 * the animation is a role-by-role comparison rather than four identical boxes.
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
    <!-- The stage the four cells sit on. -->
    <rect x="8" y="8" width="504" height="364" rx="12" class="shell" />

    <!-- Cell 1: admin — full rows plus a destructive action. -->
    <g class="cell cell-1">
      <rect x="26" y="34" width="226" height="130" rx="9" class="surface" />
      <circle cx="44" cy="52" r="5" class="role-a" />
      <text x="56" y="56" class="cell-label">{{ t("app.guideSceneRoleAdmin") }}</text>
      <rect x="42" y="72" width="194" height="18" rx="5" class="row" />
      <rect x="42" y="96" width="194" height="18" rx="5" class="row" />
      <rect x="42" y="120" width="194" height="18" rx="5" class="row" />
      <rect x="150" y="124" width="34" height="10" rx="3" class="danger" />
      <rect x="190" y="124" width="34" height="10" rx="3" class="bar dim" />
    </g>

    <!-- Cell 2: member — the same rows, no destructive action. -->
    <g class="cell cell-2">
      <rect x="266" y="34" width="226" height="130" rx="9" class="surface" />
      <circle cx="284" cy="52" r="5" class="role-b" />
      <text x="296" y="56" class="cell-label">{{ t("app.guideSceneRoleMember") }}</text>
      <rect x="282" y="72" width="194" height="18" rx="5" class="row" />
      <rect x="282" y="96" width="194" height="18" rx="5" class="row" />
      <rect x="282" y="120" width="194" height="18" rx="5" class="row" />
      <rect x="430" y="124" width="34" height="10" rx="3" class="bar dim" />
    </g>

    <!-- Cell 3: guest — the data itself is masked. -->
    <g class="cell cell-3">
      <rect x="26" y="178" width="226" height="130" rx="9" class="surface" />
      <circle cx="44" cy="196" r="5" class="role-c" />
      <text x="56" y="200" class="cell-label">{{ t("app.guideSceneRoleGuest") }}</text>
      <rect x="42" y="216" width="194" height="18" rx="5" class="row" />
      <rect x="42" y="240" width="194" height="18" rx="5" class="row" />
      <rect x="42" y="264" width="194" height="18" rx="5" class="row" />
      <g class="masked">
        <rect x="52" y="221" width="60" height="8" rx="4" class="bar dim" />
        <rect x="52" y="245" width="72" height="8" rx="4" class="bar dim" />
        <rect x="52" y="269" width="48" height="8" rx="4" class="bar dim" />
      </g>
    </g>

    <!-- Cell 4: reviewer — one extra verb nobody else has. -->
    <g class="cell cell-4">
      <rect x="266" y="178" width="226" height="130" rx="9" class="surface" />
      <circle cx="284" cy="196" r="5" class="role-d" />
      <text x="296" y="200" class="cell-label">{{ t("app.guideSceneRoleReviewer") }}</text>
      <rect x="282" y="216" width="194" height="18" rx="5" class="row" />
      <rect x="282" y="240" width="194" height="18" rx="5" class="row" />
      <rect x="282" y="264" width="194" height="18" rx="5" class="row" />
      <rect x="404" y="268" width="30" height="10" rx="3" class="approve" />
      <rect x="440" y="268" width="26" height="10" rx="3" class="bar dim" />
    </g>

    <text x="260" y="336" text-anchor="middle" class="caption">
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

.shell {
  fill: color-mix(in srgb, var(--surface-2) 45%, transparent);
  stroke: var(--line);
}
.surface {
  fill: var(--surface);
  stroke: var(--line);
}
.row {
  fill: var(--faint);
  opacity: 0.14;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.4;
}
.cell-label {
  fill: var(--text-secondary);
  font-size: 11px;
  font-family: var(--font-sans);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}
.danger {
  fill: color-mix(in srgb, var(--red) 42%, transparent);
}
.approve {
  fill: color-mix(in srgb, var(--green) 42%, transparent);
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
.role-d {
  fill: var(--role-blue);
}

/* Each cell lands on its own beat and stays. The two cells whose chrome differs
   the most (delete vs. none, approve vs. none) land last so the difference is the
   thing still on screen at rest. */
.cell {
  transform-box: fill-box;
  transform-origin: center;
  animation: cell-in 0.45s ease-out forwards;
}
.cell-1 {
  animation-delay: 0s;
}
.cell-2 {
  animation-delay: 0.14s;
}
.cell-3 {
  animation-delay: 0.28s;
}
.cell-4 {
  animation-delay: 0.42s;
}

/* The mask draws over the guest's rows after its cell has landed: it is the
   difference that needs a beat of its own to be noticed. */
.masked {
  animation: mask-in 0.5s ease-out 0.62s forwards;
}

@keyframes cell-in {
  0% {
    opacity: 0;
    transform: translateY(7px) scale(0.99);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes mask-in {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cell,
  .masked {
    animation: none;
    opacity: 1;
  }
}
</style>
