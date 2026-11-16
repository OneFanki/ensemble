<script setup lang="ts">
/**
 * "Every browser is isolated" — three identities, three separate rooms.
 *
 * The motion carries the argument rather than decorating it: each identity's
 * colour travels from its ring into its own page frame, and a divider draws
 * itself around each frame. That divider is the point — a still picture of three
 * frames says "three windows", while a fence drawing itself around each one says
 * "these cannot see each other".
 *
 * Each scene in the guide runs its entrance once and then holds, rather than
 * looping; see the animation block at the bottom for why.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene isolation"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneIsolationAlt')"
  >
    <!-- The app window both the tabs and the pages live in. -->
    <rect x="8" y="8" width="504" height="364" rx="12" class="shell" />

    <!-- A strip of three tabs, so the reader recognises the shape before the
         idea arrives: this is a browser with three tabs, not three products. -->
    <g class="tabs">
      <rect x="24" y="22" width="146" height="30" rx="7" class="tab tab-a" />
      <rect x="180" y="22" width="146" height="30" rx="7" class="tab tab-b" />
      <rect x="336" y="22" width="146" height="30" rx="7" class="tab tab-c" />
      <circle cx="42" cy="37" r="5" class="dot-a" />
      <circle cx="198" cy="37" r="5" class="dot-b" />
      <circle cx="354" cy="37" r="5" class="dot-c" />
      <text x="54" y="41" class="label">{{ t("app.guideSceneIdentityA") }}</text>
      <text x="210" y="41" class="label">{{ t("app.guideSceneIdentityB") }}</text>
      <text x="366" y="41" class="label">{{ t("app.guideSceneIdentityC") }}</text>
    </g>

    <!-- Three pages, each fenced off. The fence is drawn in the identity's own
         colour, so the pairing is the message. -->
    <g class="page page-a">
      <rect x="24" y="70" width="146" height="150" rx="9" class="surface" />
      <rect x="24" y="70" width="146" height="150" rx="9" class="fence fence-a" />
      <rect x="38" y="86" width="70" height="8" rx="4" class="bar" />
      <rect x="38" y="104" width="118" height="6" rx="3" class="bar dim" />
      <rect x="38" y="118" width="96" height="6" rx="3" class="bar dim" />
      <rect x="38" y="146" width="52" height="20" rx="5" class="pill" />
    </g>
    <g class="page page-b">
      <rect x="187" y="70" width="146" height="150" rx="9" class="surface" />
      <rect x="187" y="70" width="146" height="150" rx="9" class="fence fence-b" />
      <rect x="201" y="86" width="70" height="8" rx="4" class="bar" />
      <rect x="201" y="104" width="118" height="6" rx="3" class="bar dim" />
      <rect x="201" y="118" width="96" height="6" rx="3" class="bar dim" />
      <rect x="201" y="146" width="52" height="20" rx="5" class="pill" />
    </g>
    <g class="page page-c">
      <rect x="350" y="70" width="146" height="150" rx="9" class="surface" />
      <rect x="350" y="70" width="146" height="150" rx="9" class="fence fence-c" />
      <rect x="364" y="86" width="70" height="8" rx="4" class="bar" />
      <rect x="364" y="104" width="118" height="6" rx="3" class="bar dim" />
      <rect x="364" y="118" width="96" height="6" rx="3" class="bar dim" />
      <rect x="364" y="146" width="52" height="20" rx="5" class="pill" />
    </g>

    <!-- The shared cookie jar nobody shares: a row per identity, each struck
         through by its own sealed boundary. The lock glyph is the one place the
         scene uses an icon instead of a shape. -->
    <g class="seals">
      <g class="seal seal-a">
        <rect x="24" y="240" width="146" height="44" rx="9" class="jar" />
        <path d="M46 254v-4a5 5 0 0 1 10 0v4" class="lock" />
        <rect x="43" y="254" width="16" height="12" rx="3" class="lock" />
        <rect x="68" y="256" width="62" height="6" rx="3" class="bar dim" />
        <rect x="68" y="268" width="44" height="5" rx="2.5" class="bar dim" />
      </g>
      <g class="seal seal-b">
        <rect x="187" y="240" width="146" height="44" rx="9" class="jar" />
        <path d="M209 254v-4a5 5 0 0 1 10 0v4" class="lock" />
        <rect x="206" y="254" width="16" height="12" rx="3" class="lock" />
        <rect x="231" y="256" width="62" height="6" rx="3" class="bar dim" />
        <rect x="231" y="268" width="44" height="5" rx="2.5" class="bar dim" />
      </g>
      <g class="seal seal-c">
        <rect x="350" y="240" width="146" height="44" rx="9" class="jar" />
        <path d="M372 254v-4a5 5 0 0 1 10 0v4" class="lock" />
        <rect x="369" y="254" width="16" height="12" rx="3" class="lock" />
        <rect x="394" y="256" width="62" height="6" rx="3" class="bar dim" />
        <rect x="394" y="268" width="44" height="5" rx="2.5" class="bar dim" />
      </g>
    </g>

    <!-- A caption that states the consequence, not the mechanism. -->
    <text x="260" y="330" text-anchor="middle" class="caption">
      {{ t("app.guideSceneIsolationCaption") }}
    </text>
  </svg>
</template>

<style scoped>
.scene {
  /* Sizing is owned by GuideDialog, which gives every scene the same stage height
     so the tour does not jump between pages of slightly different aspect. */
  display: block;
  overflow: visible;
}

.shell {
  fill: color-mix(in srgb, var(--surface-2) 45%, transparent);
  stroke: var(--line);
}

.tab {
  fill: var(--surface);
  stroke: var(--line);
}
.surface {
  fill: var(--surface);
  stroke: var(--line);
}
.jar {
  fill: var(--surface);
  stroke: var(--line-soft);
}
.bar {
  fill: var(--text-secondary);
  opacity: 0.5;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.34;
}
.pill {
  fill: color-mix(in srgb, var(--accent) 26%, transparent);
}
.label {
  fill: var(--text-secondary);
  font-size: 11px;
  font-family: var(--font-sans);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}
.lock {
  fill: none;
  stroke: var(--faint);
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.dot-a {
  fill: var(--role-amber);
}
.dot-b {
  fill: var(--role-teal);
}
.dot-c {
  fill: var(--role-violet);
}

/* The identity colours, each on its own element. */
.fence-a {
  stroke: var(--role-amber);
}
.fence-b {
  stroke: var(--role-teal);
}
.fence-c {
  stroke: var(--role-violet);
}

/*
 * The entrance plays once and stays put.
 *
 * An earlier revision looped the whole scene, which meant every 5.2s the frames
 * and fences dropped to opacity 0 and rebuilt themselves. On paper that is a
 * "living diagram"; on screen it is a strobe, and a reader who is still on the
 * page when it fires sees the illustration blank out. So the choreography is an
 * entrance, not a loop: tabs, pages, then each fence drawing around its page in
 * turn. The mount-per-page rule in GuideDialog means navigating back replays it,
 * which is the only replay anybody wants.
 *
 * `forwards` holds the final frame; `both` would too, but it also applies the
 * 0% frame during the delay, which stacks three invisible pages on top of each
 * other before the first one lands.
 */
.page,
.seal,
.fence {
  transform-box: fill-box;
  transform-origin: center;
}

.fence {
  fill: none;
  stroke-width: 1.6;
  stroke-dasharray: 700;
  stroke-dashoffset: 700;
  animation: draw-fence 1.2s ease-out forwards;
}

.tab {
  animation: tab-in 0.42s var(--ease-out) forwards;
}
.page-a,
.seal-a {
  animation: settle 0.5s ease-out 0.06s forwards;
}
.page-b,
.seal-b {
  animation: settle 0.5s ease-out 0.12s forwards;
}
.page-c,
.seal-c {
  animation: settle 0.5s ease-out 0.18s forwards;
}

/* The fence follows its own page in: A starts at 0.1s, B at 0.34s, C at 0.58s.
   Drawing all three at once would have said "three frames"; drawing them in turn
   says "three boundaries", and the boundary is the page's whole subject. */
.fence-a {
  animation-delay: 0.1s;
}
.fence-b {
  animation-delay: 0.34s;
}
.fence-c {
  animation-delay: 0.58s;
}

@keyframes tab-in {
  0% {
    opacity: 0;
    transform: translateY(-4px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes settle {
  0% {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes draw-fence {
  0% {
    stroke-dashoffset: 700;
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  100% {
    stroke-dashoffset: 0;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tab,
  .page,
  .seal {
    animation: none;
    opacity: 1;
  }
  .fence {
    animation: none;
    stroke-dashoffset: 0;
  }
}
</style>
