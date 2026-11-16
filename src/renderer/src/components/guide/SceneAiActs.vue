<script setup lang="ts">
/**
 * "What the AI does in the page" — three verbs that take turns.
 *
 * A three-panel carousel rather than three side-by-side cards: the point is that
 * these are different *kinds* of work (read, act, observe errors) happening on
 * one page, and showing them one at a time on the same page frame says that.
 * Side-by-side cards would have read as three features.
 *
 * The three are deliberately ordered from safest to most invasive — read, click,
 * console — because that is also the order a cautious user cares about.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene acts"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneActsAlt')"
  >
    <!-- One page frame, reused by all three beats. The frame is divided into
         three bands that never overlap: rows (read), a button (act), and a
         console strip (observe). The first version placed the console on top of
         the button, which was fine while only one beat was visible at a time and
         turned into a pile-up once all three became permanent. -->
    <rect x="98" y="22" width="324" height="268" rx="11" class="shell" />
    <rect x="110" y="34" width="120" height="10" rx="5" class="bar dim" />
    <rect x="110" y="54" width="300" height="1" class="rule" />

    <!-- Band 1: the rows the AI reads. -->
    <g class="body">
      <rect x="110" y="64" width="300" height="26" rx="6" class="row" />
      <rect x="110" y="96" width="300" height="26" rx="6" class="row" />
      <rect x="110" y="128" width="300" height="26" rx="6" class="row" />
    </g>

    <!-- Band 2: the button the AI clicks. -->
    <g class="body">
      <rect x="110" y="166" width="88" height="26" rx="6" class="button" />
      <text x="154" y="183" text-anchor="middle" class="button-label">
        {{ t("app.guideSceneActsButton") }}
      </text>
    </g>

    <!-- Beat 1: read. A wash that hugs the three rows (and stops before the
         button), a scan line inside it, and a tag naming what came back. -->
    <g class="beat beat-read">
      <rect x="106" y="60" width="308" height="98" rx="8" class="read-wash" />
      <line x1="110" y1="64" x2="410" y2="64" class="scan" />
      <g class="read-tag">
        <rect x="300" y="74" width="102" height="20" rx="10" class="tag" />
        <text x="351" y="88" text-anchor="middle" class="tag-label">role · name</text>
      </g>
    </g>

    <!-- Beat 2: act. A cursor arrives at the button and presses it. -->
    <g class="beat beat-act">
      <circle cx="154" cy="179" r="9" class="click-ring" />
      <g class="cursor">
        <path d="M0 0l0 14 4-4 3 7 3-1.4-3-7 5-0.6z" class="cursor-fill" />
      </g>
    </g>

    <!-- Beat 3: observe. A console strip on its own band, below the button. -->
    <g class="beat beat-console">
      <rect x="110" y="206" width="300" height="68" rx="8" class="console" />
      <circle cx="124" cy="224" r="3" class="err-dot" />
      <rect x="134" y="220" width="150" height="7" rx="3.5" class="bar dim" />
      <circle cx="124" cy="248" r="3" class="err-dot" />
      <rect x="134" y="244" width="196" height="7" rx="3.5" class="bar dim" />
      <text x="398" y="224" text-anchor="end" class="console-label">
        {{ t("app.guideSceneActsConsole") }}
      </text>
    </g>

    <text x="260" y="330" text-anchor="middle" class="caption">
      {{ t("app.guideSceneActsCaption") }}
    </text>
  </svg>
</template>

<style scoped>
.scene {
  /* Sizing is owned by GuideDialog, so every scene fills the same stage. */
  display: block;
  overflow: visible;
  /* This scene loops, so it owns its own cycle length rather than borrowing the
     tour's: 9s is long enough for each of the three beats to be read. */
  --acts-cycle: 9s;
}

.shell {
  fill: color-mix(in srgb, var(--surface-2) 45%, transparent);
  stroke: var(--line);
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.36;
}
.rule {
  fill: var(--line-soft);
}
.row {
  fill: var(--faint);
  opacity: 0.12;
}
.button {
  fill: color-mix(in srgb, var(--accent) 30%, transparent);
}
.button-label {
  fill: var(--text);
  font-size: 11px;
  font-family: var(--font-sans);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}
.console-label {
  fill: var(--faint);
  font-size: 9px;
  letter-spacing: 0.08em;
  font-family: var(--font-sans);
}

/* --- beat 1: read --- */
.read-wash {
  fill: color-mix(in srgb, var(--accent) 9%, transparent);
  stroke: color-mix(in srgb, var(--accent) 34%, transparent);
}
.scan {
  stroke: var(--accent);
  stroke-width: 1.4;
  opacity: 0;
}
.tag {
  fill: var(--surface);
  stroke: color-mix(in srgb, var(--accent) 40%, var(--line));
}
.tag-label {
  fill: var(--muted);
  font-size: 9.5px;
  font-family: var(--font-mono);
}

/* --- beat 2: act --- */
.click-ring {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.6;
  opacity: 0;
}
.cursor {
  transform-box: fill-box;
  transform-origin: top left;
}
.cursor-fill {
  fill: var(--text);
  stroke: var(--surface);
  stroke-width: 1;
}

/* --- beat 3: observe --- */
.console {
  fill: var(--surface);
  stroke: var(--line);
}
.err-dot {
  fill: var(--red);
}

/*
 * All three marks are on screen at once; the cycle only decides which one is lit.
 *
 * The first version had each beat fade fully in and fully out, which meant a
 * reader looking up between beats saw a bare page frame — the exact opposite of
 * the page's claim. Three things that take turns being invisible read as one
 * thing happening occasionally, not as three capabilities.
 *
 * So the resting state is all three at low emphasis, and one steps up to full for
 * its third of the cycle. Whatever instant the eye arrives, the page shows read,
 * click and observe together, with a moving highlight saying which one is now.
 */
.beat {
  opacity: 0.28;
  animation: beat-focus var(--acts-cycle) ease-in-out infinite;
}
.beat-read {
  animation-delay: 0s;
}
.beat-act {
  animation-delay: calc(var(--acts-cycle) / 3);
}
.beat-console {
  animation-delay: calc(var(--acts-cycle) / 3 * 2);
}

/* Each motion sweeps once inside its own third and then parks, in step with its
   beat's focus. They stay mounted so the marks never vanish.
   The act beat runs in the second third, so its two marks carry the same delay as
   the beat itself — without it the cursor would cross the page while the read
   band was lit and be invisible again by the time its own band came on. */
.scan {
  animation: scan-down var(--acts-cycle) ease-in-out infinite both;
}
.read-tag {
  animation: tag-in var(--acts-cycle) ease-out infinite both;
}
.cursor {
  animation: cursor-path var(--acts-cycle) ease-in-out infinite both;
}
.click-ring {
  animation: ring-pop var(--acts-cycle) ease-out infinite both;
}
/* After the shorthands, not before: `animation:` resets the delay, so a delay
   set above would be wiped out. */
.cursor,
.click-ring {
  animation-delay: calc(var(--acts-cycle) / 3);
}

/* A third of 9s is 3s. The ramp up and down is a fifth of that, so each mark
   spends most of its turn at full emphasis and the hand-off is a soft dip. */
@keyframes beat-focus {
  0% {
    opacity: 0.28;
  }
  10%,
  26% {
    opacity: 1;
  }
  38%,
  100% {
    opacity: 0.28;
  }
}

@keyframes scan-down {
  0% {
    transform: translateY(0);
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  26% {
    transform: translateY(90px);
    opacity: 1;
  }
  38%,
  100% {
    opacity: 0;
    transform: translateY(90px);
  }
}

@keyframes tag-in {
  0%,
  8% {
    opacity: 0;
    transform: translateX(6px);
  }
  20%,
  30% {
    opacity: 1;
    transform: translateX(0);
  }
  40%,
  100% {
    opacity: 0;
    transform: translateX(0);
  }
}

/* The cursor starts to the right of the button and travels to its centre
   (154, 179 — the button spans 110..198 × 166..192). */
@keyframes cursor-path {
  0%,
  33% {
    opacity: 0;
    transform: translate(300px, 140px);
  }
  42% {
    opacity: 1;
    transform: translate(240px, 158px);
  }
  58% {
    opacity: 1;
    transform: translate(154px, 179px);
  }
  70%,
  100% {
    opacity: 0;
    transform: translate(154px, 179px);
  }
}

/* The ring fires inside the act beat's own third (the cursor arrives at ~58%),
   so it is timed to that rather than to the beat's own 33–66% window. It is a
   child of .beat-act, so the beat's opacity already governs whether it is lit. */
@keyframes ring-pop {
  0%,
  50% {
    opacity: 0;
    transform: scale(0.4);
    transform-box: fill-box;
    transform-origin: center;
  }
  58% {
    opacity: 1;
    transform: scale(1);
  }
  66%,
  100% {
    opacity: 0;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  /* No cycle at all, and all three marks visible: the point of the page is that
     these three things happen, and a reduced-motion reader still needs to see
     them. Only the "which one is now" emphasis is lost, which is fine — it is a
     description of motion they have opted out of. */
  .beat {
    animation: none;
    opacity: 0.8;
  }
  .scan,
  .read-tag,
  .cursor,
  .click-ring {
    animation: none;
  }
  .scan {
    opacity: 1;
    transform: translateY(52px);
  }
  .cursor {
    opacity: 1;
    transform: translate(154px, 179px);
  }
}
</style>
