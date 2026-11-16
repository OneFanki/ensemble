<script setup lang="ts">
/**
 * "The AI connects over MCP and drives these pages."
 *
 * The wire is drawn between two ends and then packets travel along it, forever.
 * That is the one thing a still diagram cannot say: a connection is not a
 * setting you have, it is something continuously happening. The app is on the
 * left with its pages; the client is on the right.
 *
 * The endpoint address is deliberately not printed here — it changes per port
 * and belongs in Settings, where it can be copied. Printing a placeholder like
 * "127.0.0.1:<port>" would invite someone to type it.
 */
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <svg
    class="scene mcp"
    viewBox="0 0 520 380"
    role="img"
    :aria-label="t('app.guideSceneMcpAlt')"
  >
    <!-- Left: the app, with a couple of isolated pages inside.
         The two ends are the same height and share a centre line; the gap between
         them is wide enough for the wire to be its own element rather than a
         hairline joining two cards. -->
    <g class="end app-end">
      <rect x="18" y="50" width="164" height="216" rx="12" class="shell" />
      <rect x="30" y="64" width="140" height="22" rx="5" class="title-bar" />
      <rect x="30" y="98" width="64" height="72" rx="6" class="page" />
      <rect x="104" y="98" width="66" height="72" rx="6" class="page" />
      <rect x="30" y="180" width="140" height="72" rx="6" class="page dim" />
    </g>

    <!-- The wire runs between the facing edges at the boxes' vertical centre, so
         it reads as a connection between two peers rather than a line drawn
         across both. It is drawn *before* the client box: anything that
         overshoots is painted over by the box rather than landing on top of its
         contents. -->
    <path d="M182 158h156" pathLength="100" class="wire" />
    <g class="packets">
      <circle cx="196" cy="158" r="3.6" class="packet" />
      <circle cx="196" cy="158" r="3.6" class="packet p2" />
      <circle cx="196" cy="158" r="3.6" class="packet p3" />
    </g>

    <!-- The label on the wire says what travels, not what the protocol is. -->
    <text x="260" y="143" text-anchor="middle" class="wire-label">MCP</text>

    <!-- Right: the AI client. Same height as the app, so the two ends read as a
         pair; the app's variety comes from the pages inside it, not from being
         a taller rectangle. -->
    <g class="end client-end">
      <rect x="338" y="50" width="164" height="216" rx="12" class="shell" />
      <g class="spark">
        <path d="M420 84l6 16 16 6-16 6-6 16-6-16-16-6 16-6z" class="spark-fill" />
      </g>
      <rect x="354" y="164" width="102" height="8" rx="4" class="bar dim" />
      <rect x="354" y="184" width="78" height="8" rx="4" class="bar dim" />
      <rect x="354" y="204" width="58" height="8" rx="4" class="bar dim" />
      <rect x="354" y="228" width="88" height="8" rx="4" class="bar dim" />
    </g>

    <text x="100" y="296" text-anchor="middle" class="end-label">
      {{ t("app.guideSceneMcpApp") }}
    </text>
    <text x="420" y="296" text-anchor="middle" class="end-label">
      {{ t("app.guideSceneMcpClient") }}
    </text>

    <text x="260" y="352" text-anchor="middle" class="caption">
      {{ t("app.guideSceneMcpCaption") }}
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
.title-bar {
  fill: var(--faint);
  opacity: 0.16;
}
.page {
  fill: var(--surface);
  stroke: var(--line-soft);
}
.page.dim {
  fill: var(--surface);
  stroke: var(--line-soft);
  opacity: 0.55;
}
.bar.dim {
  fill: var(--faint);
  opacity: 0.36;
}
.end-label {
  fill: var(--text);
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-sans);
}
.wire-label {
  fill: var(--faint);
  font-size: 10px;
  letter-spacing: 0.1em;
  font-family: var(--font-mono);
}
.caption {
  fill: var(--faint);
  font-size: 11.5px;
  font-family: var(--font-sans);
}
.spark-fill {
  fill: var(--accent);
}

/* The connection establishes once: the two ends arrive facing each other, then
   the wire draws between them. Traffic, unlike the connection, does not stop — so
   only the packets and the spark loop, and they loop on their own clocks. */
.end {
  transform-box: fill-box;
  transform-origin: center;
}
.app-end {
  animation: end-in 0.5s ease-out forwards;
}
.client-end {
  animation: end-in 0.5s ease-out 0.16s forwards;
}

.wire {
  fill: none;
  stroke: var(--line);
  stroke-width: 1.6;
  stroke-dasharray: 100;
  stroke-dashoffset: 100;
  animation: draw-wire 0.6s ease-out 0.5s forwards;
}

/* Packets ride a translate rather than the dash offset: the wire's own dash
   belongs to the draw-on animation, and sharing it would make every packet tug
   the line back. 142px is the gap from the first packet's start (x=196) to the
   client's edge (x=338), so a packet arrives exactly as the box begins and is
   clipped by it rather than drawn over it. */
/* Even thirds of the cycle: a stream, not a burst. The stagger puts three
   packets in flight at once; the first waits for the wire to finish drawing. */
.packet {
  fill: var(--accent);
  opacity: 0;
  animation: packet 2.4s linear 1.1s infinite both;
}
.p2 {
  animation-delay: 1.9s;
}
.p3 {
  animation-delay: 2.7s;
}

/* The spark pulses on a faster beat than the wire: it is the client thinking,
   not the connection being established. */
.spark {
  transform-box: fill-box;
  transform-origin: center;
  animation: spark-pulse 1.6s ease-in-out 0.4s infinite both;
}

@keyframes end-in {
  0% {
    opacity: 0;
    transform: translateY(8px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes draw-wire {
  0% {
    stroke-dashoffset: 100;
  }
  100% {
    stroke-dashoffset: 0;
  }
}

@keyframes packet {
  0% {
    opacity: 0;
    transform: translateX(0);
  }
  10% {
    opacity: 1;
  }
  62% {
    opacity: 1;
    transform: translateX(142px);
  }
  74%,
  100% {
    opacity: 0;
    transform: translateX(142px);
  }
}

@keyframes spark-pulse {
  0%,
  100% {
    opacity: 0.6;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1.06);
  }
}

@media (prefers-reduced-motion: reduce) {
  .end,
  .spark {
    animation: none;
    opacity: 1;
  }
  .wire {
    animation: none;
    stroke-dashoffset: 0;
  }
  .packet {
    animation: none;
    opacity: 0.7;
  }
}
</style>
