<script setup lang="ts">
import type { PerfMetric, PerfSample } from "@shared/embedded";
import {
  PERF_METRICS,
  PERF_SAMPLE_INTERVAL_DEFAULT_MS,
  PERF_WINDOW_DEFAULT_MS,
  perfArea,
  perfAxisLabel,
  perfAxisMax,
  perfPeak,
  perfPolyline,
  perfSparkPoints,
} from "@shared/embedded";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import SelectField from "./SelectField.vue";

/**
 * Performance monitor: the same numbers Chrome's own panel shows, as a live
 * series.
 *
 * Three things make a lane readable, and the first one is why this was rebuilt:
 *
 * - **A scale.** A line's height means nothing without one. Every lane carries
 *   a three-tick gutter (top / half / bottom) plus a dashed midline, so "flat
 *   near the bottom" can be read as "a few percent" instead of "somewhere".
 * - **An area fill.** A 1px line hugging the baseline is nearly invisible; the
 *   shaded region below it shows both the shape and the proportion.
 * - **A real time axis.** `t` is milliseconds since sampling started, not a
 *   sample index. A busy page delays the sampler, and evenly spaced points would
 *   hide exactly the gap that matters.
 *
 * Colour is per *category*, not per line: CPU is heat, the heap is memory, the
 * four DOM counts share one hue because they answer one question, and the two
 * per-second rates share another. Eight unrelated hues would be noise; four
 * groups tell you what kind of number you are looking at before you read it.
 *
 * Sampling runs in the main process at 5 Hz and only while this tab is showing
 * (see `showDevtoolsTab`). This component polls the history rather than waiting
 * for a state broadcast: pushing a full workspace state five times a second
 * would make the panel itself the load being measured.
 *
 * The window and the interval are configured here, not in Settings. Both are
 * questions about the chart in front of you — "this stutter is too short to see"
 * and "this climb needs a longer reach" — and answering them used to mean
 * leaving the page you were measuring, changing a value, and coming back. The
 * two controls sit in the panel's header, next to the numbers they change.
 */
const props = defineProps<{ tabId: string }>();

const { t } = useI18n();
const workspace = useWorkspaceStore();

/**
 * The two knobs, as fixed choices.
 *
 * Fixed rather than free-typed: both values multiply (window ÷ interval is how
 * many points get drawn and kept), so a hand-typed pair can ask for a thousand
 * points per series. These are the pairs that are actually useful — a stutter
 * hunt wants a fine interval in a narrow window, a slow leak wants the opposite.
 */
const WINDOW_OPTIONS = [
  { value: "10000", label: "10 s" },
  { value: "20000", label: "20 s" },
  { value: "60000", label: "1 min" },
  { value: "120000", label: "2 min" },
];

const INTERVAL_OPTIONS = [
  { value: "100", label: "100 ms" },
  { value: "200", label: "200 ms" },
  { value: "500", label: "500 ms" },
  { value: "1000", label: "1 s" },
];

function setWindow(value: string | undefined): void {
  void workspace.saveSettings({ perfWindowMs: Number(value ?? PERF_WINDOW_DEFAULT_MS) });
}

function applySampleInterval(value: string | undefined): void {
  void workspace.saveSettings({
    perfSampleIntervalMs: Number(value ?? PERF_SAMPLE_INTERVAL_DEFAULT_MS),
  });
}

/**
 * The chart's span, in milliseconds.
 *
 * Read from settings rather than a constant: the window is a choice between
 * resolution and reach, and the two readers want different answers — a stutter
 * wants a narrow window with pixels per second, a slow climb wants a minute of
 * shape. The main process samples with the same number, so the axis and the
 * history it draws can never disagree.
 */
const windowMs = computed(() => workspace.settings.perfWindowMs || PERF_WINDOW_DEFAULT_MS);

/** The interval the main process is actually sampling at, for the header. */
const intervalMs = computed(
  () => workspace.settings.perfSampleIntervalMs || PERF_SAMPLE_INTERVAL_DEFAULT_MS,
);

const history = ref<PerfSample[]>([]);
const hidden = ref<Set<PerfMetric>>(new Set());

let timer: ReturnType<typeof setInterval> | undefined;
let alive = true;

async function poll(): Promise<void> {
  try {
    const next = await window.ensemble.readEmbeddedPerf(props.tabId);
    if (alive) history.value = next;
  } catch {
    // The page went away; the next poll either recovers or the panel closes.
  }
}

onMounted(() => {
  void poll();
  timer = setInterval(() => void poll(), 250);
});
onBeforeUnmount(() => {
  alive = false;
  if (timer) clearInterval(timer);
});

/** Latest sample, which is what each row's number reads. */
const latest = computed(() => history.value[history.value.length - 1]);

function isShown(metric: PerfMetric): boolean {
  return !hidden.value.has(metric);
}

function toggle(metric: PerfMetric): void {
  const next = new Set(hidden.value);
  if (next.has(metric)) next.delete(metric);
  else next.add(metric);
  hidden.value = next;
}

/** A metric's current value in its display unit. */
function valueOf(metric: PerfMetric, sample = latest.value): string {
  if (!sample) return "—";
  switch (metric) {
    case "cpu":
      return `${sample.cpu.toFixed(1)}%`;
    case "heap":
      return formatBytes(sample.heap);
    case "layouts":
    case "styleRecalcs":
      return sample[metric].toFixed(1);
    default:
      return String(sample[metric]);
  }
}

/** The highest reading in the window, in the same unit as the value. */
function peakOf(metric: PerfMetric): string {
  const peak = perfPeak(history.value, metric);
  if (metric === "heap") return formatBytes(peak);
  if (metric === "layouts" || metric === "styleRecalcs") return peak.toFixed(1);
  if (metric === "cpu") return `${peak.toFixed(1)}%`;
  return String(Math.round(peak));
}

const METRIC_LABELS: Record<PerfMetric, string> = {
  cpu: "app.perfCpu",
  nodes: "app.perfNodes",
  listeners: "app.perfListeners",
  documents: "app.perfDocuments",
  frames: "app.perfFrames",
  heap: "app.perfHeap",
  layouts: "app.perfLayouts",
  styleRecalcs: "app.perfStyleRecalcs",
};

/**
 * The hue for a metric's category.
 *
 * These are theme tokens, not hex: both themes define their own pair, and the
 * light theme needs deeper values to stay legible on white.
 */
const METRIC_COLORS: Record<PerfMetric, string> = {
  cpu: "var(--amber)",
  heap: "var(--violet)",
  nodes: "var(--blue)",
  listeners: "var(--blue)",
  documents: "var(--blue)",
  frames: "var(--blue)",
  layouts: "var(--rose)",
  styleRecalcs: "var(--rose)",
};

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

/**
 * The chart's vertical scale for one metric.
 *
 * CPU is the exception: it is a percentage with a known top, so the axis is
 * pinned to 100 instead of to the local peak. A page idling at 2% otherwise
 * draws a "full height" line and reads as saturated — the same misreading the
 * missing scale caused, just in the other direction.
 */
function axisFor(metric: PerfMetric): number {
  if (metric === "cpu") return 100;
  return perfAxisMax(perfPeak(history.value, metric));
}

const CHART_WIDTH = 100;
/*
 * Tall enough for three tick labels to sit apart.
 *
 * At 30px the gutter's "top / half / zero" were stacked with barely 4px between
 * baselines and read as one blur; 40px gives each label its own band, which is
 * the whole point of having a scale.
 */
const CHART_HEIGHT = 40;

/**
 * Everything one lane needs, computed once per poll.
 *
 * The template uses each lane's points twice (fill and line) and its ticks three
 * times; calling those helpers inline meant re-scanning the history a dozen
 * times per frame, at 4 frames a second, inside the panel that is supposed to be
 * measuring load.
 *
 * `perfSparkPoints` is given the fixed window, so a lane's x axis does not move
 * as samples accumulate: the newest sample is at the right edge and a young
 * series draws only the sliver of the window it has filled. Without that the
 * axis was derived from the data on every poll and the curve appeared to zoom.
 */
interface Lane {
  /** Top of the scale, the halfway point, then zero. All three label a
      gridline, so the reader can put a line's height against a number. */
  ticks: [string, string, string];
  line: string;
  area: string;
}

const lanes = computed<Record<PerfMetric, Lane>>(() => {
  const result = {} as Record<PerfMetric, Lane>;
  for (const metric of PERF_METRICS) {
    const top = axisFor(metric);
    const points = perfSparkPoints(
      history.value,
      metric,
      CHART_WIDTH,
      CHART_HEIGHT,
      top,
      windowMs.value,
    );
    result[metric] = {
      ticks: [
        perfAxisLabel(metric, top),
        perfAxisLabel(metric, top / 2),
        perfAxisLabel(metric, 0),
      ],
      line: perfPolyline(points),
      area: perfArea(points, CHART_HEIGHT),
    };
  }
  return result;
});
</script>

<template>
  <div class="perf-panel" data-perf-panel>
    <div class="perf-inner">
      <!--
        Header: title, the two knobs, then the peak caption over the column the
        peak numbers occupy — so the sides read as a table rather than as loose
        text.

        The knobs live here rather than in Settings because they are questions
        about the chart in front of you: a 30ms stutter is invisible in a 200ms
        series, and a slow leak needs a minute of reach. Changing either used to
        mean leaving the page being measured, finding a settings row, and coming
        back — with the sampler restarted from scratch on return.
      -->
      <div class="perf-head">
        <span class="perf-title">{{ t("app.perfTitle") }}</span>
        <span class="perf-controls">
          <span class="perf-knob" :title="t('app.perfWindowSetting')">
            <SelectField
              compact
              :model-value="String(windowMs)"
              :options="WINDOW_OPTIONS"
              :aria-label="t('app.perfWindowSetting')"
              data-perf-window
              @update:model-value="setWindow"
            />
          </span>
          <span class="perf-knob" :title="t('app.perfIntervalSetting')">
            <SelectField
              compact
              :model-value="String(intervalMs)"
              :options="INTERVAL_OPTIONS"
              :aria-label="t('app.perfIntervalSetting')"
              data-perf-interval
              @update:model-value="applySampleInterval"
            />
          </span>
        </span>
        <span class="perf-peak-head">{{ t("app.perfPeak") }}</span>
      </div>

      <div class="perf-rows">
        <!--
          One row per metric, two lines each: the name and the numbers on top,
          the chart underneath at full row width.

          The row is also the toggle: a real checkbox would add a second tab stop
          for the same action, and the tick already says whether the line is on.
        -->
        <button
          v-for="metric in PERF_METRICS"
          :key="metric"
          type="button"
          class="metric-row"
          :class="{ off: !isShown(metric) }"
          :data-perf-metric="metric"
          :style="{ '--spark': METRIC_COLORS[metric] }"
          @click="toggle(metric)"
        >
          <span class="metric-head">
            <span class="metric-check" :class="{ on: isShown(metric) }"></span>
            <span class="metric-name">{{ t(METRIC_LABELS[metric]) }}</span>
            <span class="metric-value mono" :data-perf-value="metric">{{ valueOf(metric) }}</span>
            <span class="metric-peak mono" :data-perf-peak="metric">{{ peakOf(metric) }}</span>
          </span>

          <!--
            The chart gets the whole row.

            Every arrangement that put the scale in its own column spent 80–130px
            of a panel that is often only ~380px wide, so the curve — the thing
            the panel exists for — was the narrowest element in it. The scale now
            floats over the plot's left edge instead: the numbers cost no
            horizontal space, and the plot is as wide as the panel allows.

            Ticks are HTML, not SVG text, because the chart is stretched with
            `preserveAspectRatio="none"` and would distort any glyph inside it.
          -->
          <span class="metric-chart">
            <svg
              v-if="isShown(metric)"
              class="metric-spark"
              :viewBox="`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <!-- Three reference levels, matching the three ticks: the top of
                   the scale, the halfway line, and zero. -->
              <line x1="0" y1="1" :x2="CHART_WIDTH" y2="1" class="spark-grid" />
              <line
                x1="0"
                :y1="CHART_HEIGHT / 2"
                :x2="CHART_WIDTH"
                :y2="CHART_HEIGHT / 2"
                class="spark-grid dashed"
              />
              <line
                x1="0"
                :y1="CHART_HEIGHT - 1"
                :x2="CHART_WIDTH"
                :y2="CHART_HEIGHT - 1"
                class="spark-base"
              />
              <path :d="lanes[metric].area" class="spark-area" />
              <path :d="lanes[metric].line" class="spark-line" />
            </svg>
            <span
              v-for="(tick, index) in lanes[metric].ticks"
              :key="index"
              class="chart-tick mono"
              :class="[`at-${index}`, { dim: !isShown(metric) }]"
            >{{ tick }}</span>
          </span>
        </button>

        <p v-if="history.length < 2" class="perf-hint">{{ t("app.perfCollecting") }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perf-panel {
  height: 100%;
  min-height: 0;
  background: var(--surface);
  /* The panel's width depends on the view's layout, not the window, so it
     measures itself. The container must be this outer element: a container
     query resolves against an ancestor. */
  container-type: inline-size;
}

.perf-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 10px 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.perf-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 0 6px 8px;
  border-bottom: 1px solid var(--line-soft);
}

.perf-title {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text);
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The two knobs sit together and take the slack, so the peak caption stays over
   the peak column whether or not a page has started producing samples. */
.perf-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1 1 auto;
  justify-content: flex-end;
  min-width: 0;
}

.perf-knob {
  flex: 0 0 auto;
}

.perf-peak-head {
  /* Same 34px as the peak numbers below it, so the caption sits over its own
     column instead of a guessed offset. */
  flex: 0 0 auto;
  min-width: 34px;
  font-size: 9.5px;
  color: var(--faint);
  text-align: right;
}

.perf-rows {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-height: 0;
  padding-top: 4px;
  overflow: auto;
}

.metric-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: none;
  padding: 4px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

/*
 * No hover fill on the row.
 *
 * The row is two lines tall — a name and a 40px chart — so tinting the whole box
 * lit up the chart as well, and a curve that dims or brightens under the pointer
 * reads as the data changing. The hover hint belongs to the part that is
 * actually a control (the tick and the name), so it is scoped to that line.
 */
.metric-row:hover .metric-head {
  color: var(--text);
}

.metric-row.off {
  opacity: 0.45;
}

/* The name line: tick, name, then the two numbers pushed to the right end. It
   is the row's *label*, so it stays one line at any width — the name ellipsises
   rather than wrapping, and the numbers never move. */
.metric-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* A tick, not a checkbox: the row is the control. Filled with the metric's own
   hue so the row and its line are visibly the same series. */
.metric-check {
  width: 9px;
  height: 9px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 2px;
}

.metric-check.on {
  border-color: var(--spark);
  background: var(--spark);
}

/* `min-width: 0` is load-bearing: a flex item defaults to `min-width: auto`,
   which refuses to shrink below its content and lets a long name wrap instead
   of ellipsising — "JS 堆大小" broke into two lines and pushed its chart down. */
.metric-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The plot owns the row's full width, with a 34px gutter on the left for the
   scale. The gutter is the smallest that fits `100%` at 9px, and it is carved
   out of the row rather than out of a separate flex column: the chart still
   measures as "row width minus a number", not "whatever four columns left
   over". */
.metric-chart {
  position: relative;
  display: block;
  width: 100%;
  height: 40px;
  min-width: 34px;
  padding-left: 34px;
}

.metric-spark {
  display: block;
  width: 100%;
  height: 40px;
  overflow: visible;
}

/* The scale, in the gutter.
 *
 * In its own column it cost 80–130px of a panel that is often ~380px wide, and
 * the curve — the reason the panel exists — ended up the narrowest element in
 * the row. Drawn over the plot instead, the numbers cost only the gutter.
 *
 * The three positions are the top gridline, the midline and the baseline,
 * offset by half a line height so each number is centred on its line.
 */
.chart-tick {
  position: absolute;
  left: 0;
  width: 28px;
  font-size: 9px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--faint);
  pointer-events: none;
}

/* The first and last labels are not centred on their lines: half a line height
   above the top gridline or below the baseline falls outside the row, where the
   next row clips it. Sitting flush against the edge costs ~3px of alignment and
   keeps every number fully drawn. */
.chart-tick.at-0 {
  top: 0;
}

.chart-tick.at-1 {
  top: 50%;
  transform: translateY(-50%);
}

.chart-tick.at-2 {
  bottom: 0;
}

.chart-tick.dim {
  opacity: 0.5;
}

/* Top edge and midline. Very faint on purpose: they are references, not data,
   and at this height they would otherwise compete with the line. */
.spark-grid {
  stroke: var(--line-soft);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  opacity: 0.5;
}

.spark-grid.dashed {
  stroke-dasharray: 2 3;
}

.spark-base {
  stroke: var(--line);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
  opacity: 0.6;
}

/* The fill is the readable part of a low series; the line gives it an edge.
   Both take the row's category hue via `--spark`.

   Low opacity is deliberate: a steady metric fills the whole lane, and at a
   heavier tint eight filled lanes turn the panel into a wall of colour blocks
   with the lines lost inside them. This reads as "area shaded, value on top". */
.spark-area {
  fill: var(--spark);
  stroke: none;
  opacity: 0.1;
}

.spark-line {
  fill: none;
  stroke: var(--spark);
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

/* The two numeric columns size to their content instead of to a guessed width:
   `14.0 MB` needs more room than `0.0`, and a fixed column either clipped the
   former or wasted 20px on the latter. They sit at the end of the name line, so
   their width no longer comes out of the chart's. */
.metric-value {
  flex: 0 0 auto;
  font-size: 10.5px;
  color: var(--text);
  text-align: right;
}

/* The peak column is secondary: it answers "how bad did it get", not "what is
   it now", so it stays quieter than the live value. */
.metric-peak {
  flex: 0 0 auto;
  min-width: 34px;
  font-size: 9.5px;
  color: var(--faint);
  text-align: right;
}

.perf-hint {
  margin: 8px 6px 0;
  font-size: 10.5px;
  color: var(--faint);
}

/* A narrow docked panel (the 2×2 quadrant is the common case) still cannot show
   name, value and peak on one line without the name losing its meaning. The peak
   goes first (the current value says more), and the zero tick goes with it — the
   fill already sits on the baseline, so that number is the one a reader can
   infer. The chart keeps the full width either way; that is what turns into a
   shape you can actually see. */
@container (max-width: 380px) {
  .metric-peak,
  .perf-peak-head,
  .chart-tick.at-2 {
    display: none;
  }
}
</style>
