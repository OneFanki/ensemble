<script setup lang="ts">
/**
 * The last page: where to find this again.
 *
 * The only motion is a highlight that travels from the app-menu button down to
 * the guide row and back — a pointing gesture rather than a diagram. This page
 * has no idea to illustrate, so it should not pretend to: it is a "you are done"
 * page that also happens to be the map home.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene reopen"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneReopenAlt')"
  >
    <!-- A schematic app window: toolbar at the top, a page under it. Enough of
         the shape that the reader can match it to what is on their screen. -->
    <rect x="36" y="40" width="448" height="278" rx="12" class="shell" />
    <rect x="36" y="40" width="448" height="46" rx="12" class="toolbar" />
    <rect x="36" y="74" width="448" height="12" class="toolbar" />
    <rect x="52" y="56" width="104" height="14" rx="4" class="bar dim" />
    <rect x="172" y="56" width="164" height="14" rx="4" class="bar dim" />
    <circle cx="462" cy="63" r="4" class="bar dim" />

    <!-- The page behind the menu, so the window reads as a window and not as a
         bar with a list hanging off it. Content stops short of the menu column:
         a background that runs under the menu made the two read as one busy
         layer. -->
    <g class="page-body">
      <rect x="56" y="106" width="120" height="10" rx="5" class="bar dim" />
      <rect x="56" y="128" width="200" height="8" rx="4" class="bar dim" />
      <rect x="56" y="146" width="164" height="8" rx="4" class="bar dim" />
      <rect x="56" y="164" width="186" height="8" rx="4" class="bar dim" />
      <rect x="56" y="196" width="112" height="82" rx="7" class="card" />
      <rect x="180" y="196" width="112" height="82" rx="7" class="card" />
    </g>

    <!-- The app-menu button, the thing to press. -->
    <g class="menu-button">
      <rect x="438" y="52" width="34" height="22" rx="6" class="button-shell" />
      <circle cx="448" cy="63" r="1.8" class="bar" />
      <circle cx="455" cy="63" r="1.8" class="bar" />
      <circle cx="462" cy="63" r="1.8" class="bar" />
    </g>

    <!-- The menu that drops out of it, with the guide row highlighted. The
         highlighted row is the point of the page, so it gets a border and a
         brighter fill rather than just a tint: at this size a fill alone read as
         one more grey row. -->
    <g class="menu">
      <rect x="306" y="86" width="152" height="118" rx="9" class="menu-shell" />
      <rect x="316" y="96" width="132" height="22" rx="5" class="menu-row" />
      <rect x="316" y="122" width="132" height="22" rx="5" class="menu-row" />
      <g class="guide-row">
        <rect x="316" y="148" width="132" height="22" rx="5" class="menu-row on" />
        <rect x="316" y="148" width="132" height="22" rx="5" class="menu-row-edge" />
        <text x="328" y="163" class="menu-label">
          {{ t("app.guideTitle") }}
        </text>
      </g>
      <rect x="316" y="174" width="132" height="16" rx="5" class="menu-row dim" />
    </g>

    <!-- The travelling highlight: button → row and back. -->
    <circle cx="455" cy="63" r="13" class="ping ping-1" />
    <circle cx="455" cy="63" r="13" class="ping ping-2" />

    <text x="260" y="352" text-anchor="middle" class="caption">
      {{ t("app.guideSceneReopenCaption") }}
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
.toolbar {
  fill: var(--surface);
}
.card {
  fill: color-mix(in srgb, var(--surface-2) 60%, transparent);
  stroke: var(--line-soft);
}
.bar {
  fill: var(--text-secondary);
  opacity: 0.5;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.3;
}
.button-shell {
  fill: var(--surface);
  stroke: var(--line);
}
.menu-shell {
  fill: var(--surface);
  stroke: var(--line);
}
.menu-row {
  fill: var(--faint);
  opacity: 0.14;
}
.menu-row.on {
  fill: color-mix(in srgb, var(--accent) 22%, transparent);
}
.menu-row-edge {
  fill: none;
  stroke: color-mix(in srgb, var(--accent) 58%, transparent);
  stroke-width: 1;
}
.menu-row.dim {
  opacity: 0.08;
}
.menu-label {
  fill: var(--text);
  font-size: 10.5px;
  font-family: var(--font-sans);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}

/* The menu opens, the guide row lights up, a ping marks it — then everything
   holds. This page's job is to leave the reader looking at the answer, so it is
   the short end of a sequence, not a looping animation. */
.menu {
  transform-box: fill-box;
  transform-origin: top right;
  animation: menu-open 0.45s ease-out forwards;
}
.guide-row {
  animation: row-on 0.4s ease-out 0.3s forwards;
}

.ping {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.4;
  opacity: 0;
  animation: ping 1.1s ease-out 0.55s forwards;
}
.ping-2 {
  animation-delay: 0.85s;
}

@keyframes menu-open {
  0% {
    opacity: 0;
    transform: scale(0.94);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes row-on {
  0% {
    opacity: 0.45;
  }
  100% {
    opacity: 1;
  }
}

@keyframes ping {
  0% {
    opacity: 0;
    transform: scale(0.6);
    transform-box: fill-box;
    transform-origin: center;
  }
  30% {
    opacity: 0.85;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(1.5);
  }
}

@media (prefers-reduced-motion: reduce) {
  .menu,
  .guide-row {
    animation: none;
    opacity: 1;
  }
  .ping {
    animation: none;
    opacity: 0;
  }
}
</style>
