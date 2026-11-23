<script setup lang="ts">
/**
 * "One click from an account to its signed-in page."
 *
 * The left card is one site with two accounts in it — the shape the accounts
 * page really has. The amber row lifts and takes the active edge, an arrow
 * carries the pick across, and the page that lands on the right is fenced in
 * the same amber with a signed-in pill already lit. Colour does the pairing,
 * the way it does in the app: the account's colour is the colour you watch.
 *
 * Like every scene, it runs its entrance once and holds — see the animation
 * block at the bottom.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene accounts"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneAccountsAlt')"
  >
    <!-- Left: one site card with its accounts. -->
    <g class="site">
      <rect x="24" y="60" width="216" height="228" rx="12" class="surface" />
      <text x="44" y="92" class="col-title">{{ t("app.guideSceneAccountsSite") }}</text>
      <rect x="44" y="104" width="96" height="7" rx="3.5" class="bar dim" />

      <!-- The account that gets picked. It carries the active edge, so the eye
           knows which row the arrow is talking about. -->
      <g class="row row-a">
        <rect x="40" y="128" width="184" height="56" rx="9" class="row-line" />
        <circle cx="66" cy="156" r="9" class="role-a" />
        <rect x="86" y="146" width="86" height="8" rx="4" class="bar" />
        <rect x="86" y="164" width="58" height="6" rx="3" class="bar dim" />
        <path d="M196 150l6 6-6 6" class="row-chev" />
        <text x="86" y="181" class="row-role">{{ t("app.guideSceneRoleAdmin") }}</text>
      </g>

      <!-- The account that stays put. -->
      <g class="row row-b">
        <rect x="40" y="196" width="184" height="56" rx="9" class="row-line" />
        <circle cx="66" cy="224" r="9" class="role-b" />
        <rect x="86" y="214" width="70" height="8" rx="4" class="bar dim" />
        <rect x="86" y="232" width="48" height="6" rx="3" class="bar dim" />
        <text x="86" y="249" class="row-role">{{ t("app.guideSceneRoleMember") }}</text>
      </g>
    </g>

    <!-- The arrow is the click: it leaves the picked row and lands on a page
         that does not exist yet. It draws before the page appears. -->
    <path d="M252 156h72" class="click-arrow" />
    <path d="M318 149l10 7-10 7" class="click-arrow head" />

    <!-- Right: the page that opens — fenced in the picked account's colour,
         already signed in. The pill is the "signed in" state, not a button. -->
    <g class="page">
      <rect x="340" y="76" width="156" height="196" rx="10" class="surface" />
      <rect x="340" y="76" width="156" height="196" rx="10" class="fence" />
      <rect x="356" y="94" width="78" height="8" rx="4" class="bar" />
      <rect x="356" y="112" width="112" height="6" rx="3" class="bar dim" />
      <rect x="356" y="128" width="90" height="6" rx="3" class="bar dim" />
      <g class="pill">
        <rect x="356" y="152" width="104" height="24" rx="7" class="pill-line" />
        <path d="M367 164l4 4 7-8" class="pill-check" />
        <rect x="384" y="161" width="62" height="6" rx="3" class="bar dim" />
      </g>
      <circle cx="366" cy="216" r="6" class="role-a" />
      <rect x="380" y="211" width="64" height="7" rx="3.5" class="bar dim" />
      <rect x="380" y="228" width="46" height="6" rx="3" class="bar dim" />
    </g>

    <text x="260" y="330" text-anchor="middle" class="caption">
      {{ t("app.guideSceneAccountsCaption") }}
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
.col-title {
  fill: var(--text);
  font-size: 12px;
  font-weight: 500;
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
.row-role {
  fill: var(--faint);
  font-size: 10px;
  font-family: var(--font-sans);
}

.row-line {
  fill: color-mix(in srgb, var(--surface-2) 70%, transparent);
  stroke: transparent;
}
/* The picked row: its edge and chevron arrive with the beat that lifts it. */
.row-a .row-line {
  stroke: var(--role-amber);
}
.row-chev {
  fill: none;
  stroke: var(--role-amber);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.click-arrow {
  fill: none;
  stroke: var(--text-secondary);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-dasharray: 76;
  stroke-dashoffset: 76;
  animation: draw-arrow 0.45s ease-out 0.7s forwards;
}
.click-arrow.head {
  stroke-dasharray: none;
  stroke-dashoffset: 0;
  opacity: 0;
  animation: fade-in 0.3s ease-out 1.05s forwards;
}

.fence {
  fill: none;
  stroke: var(--role-amber);
  stroke-width: 1.6;
  /* The frame announces itself by drawing, not fading: a fence appearing is
     the same word SceneIsolation uses for isolation. */
  stroke-dasharray: 700;
  stroke-dashoffset: 700;
  animation: draw-fence 0.55s ease-out 1.15s forwards;
}

.pill-line {
  fill: color-mix(in srgb, var(--green) 14%, transparent);
  stroke: var(--green);
  stroke-width: 1.2;
}
.pill-check {
  fill: none;
  stroke: var(--green);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Beats: site first, then the pick, then the arrow, then the page. Each lands
   in its own moment so "one click" is something the reader sees happen. */
.site,
.page {
  opacity: 0;
  transform: translateY(8px);
  animation: fade-up 0.5s ease-out forwards;
}
.site {
  animation-delay: 0.05s;
}
.page {
  animation-delay: 1.3s;
}
.row-a {
  opacity: 0;
  animation: fade-in 0.4s ease-out 0.45s forwards;
}
.row-b {
  opacity: 0;
  animation: fade-in 0.4s ease-out 0.3s forwards;
}

@keyframes draw-arrow {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes draw-fence {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes fade-in {
  to {
    opacity: 1;
  }
}

@keyframes fade-up {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .site,
  .page,
  .row-a,
  .row-b,
  .click-arrow.head {
    animation: none;
    opacity: 1;
    transform: none;
  }
  .click-arrow,
  .fence {
    animation: none;
    stroke-dashoffset: 0;
  }
}
</style>
