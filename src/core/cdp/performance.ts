/**
 * Performance sampling for one page.
 *
 * The numbers come from CDP's `Performance.getMetrics`, which is the same
 * source Chrome's own performance monitor reads — so the fields and their units
 * match what a developer already knows: bytes, counts, seconds.
 *
 * ## Why this is not just a list of numbers
 *
 * A devtools metric table is a *time series*: the interesting question is never
 * "how many DOM nodes are there" but "did the node count climb while I clicked".
 * So each sample carries a timestamp and the history is kept, which is only
 * possible if something polls. That polling is why this module exists as a
 * scheduler rather than a one-shot read.
 *
 * ## Bounded, and only while watched
 *
 * A page that is being profiled is a page whose CDP session cannot idle-release,
 * and idle release exists so pages cannot detect the debugger. Sampling
 * therefore only runs while the performance tab is actually open, and the
 * history is capped — leaving the tab open overnight must not grow the app's
 * memory without limit.
 *
 * Deltas are computed here rather than in the renderer because the raw counters
 * (`LayoutCount`, `RecalcStyleCount`, `TaskDuration`) are cumulative since the
 * document loaded: a chart of the raw value would only ever trend upward, which
 * says nothing about where the cost happened. The derived series is what a
 * performance monitor is for.
 */

/** How many samples are kept before the oldest is dropped. */
export { PERF_HISTORY_LIMIT, PERF_WINDOW_MS } from "@shared/embedded";

import type { PerfMetric, PerfSample } from "@shared/embedded";
import {
  PERF_HISTORY_LIMIT,
  PERF_WINDOW_MS,
  perfPeak,
  perfSparkPath,
} from "@shared/embedded";
export type { PerfMetric, PerfSample } from "@shared/embedded";

/**
 * The subset of `Performance.getMetrics` this module reads.
 *
 * Kept as a plain record rather than generating a type from CDP: the fields are
 * a stable, documented set, and a wrong key reads as `undefined` (handled) while
 * a generated type would only restate the same names.
 */
export interface RawMetrics {
  Timestamp?: number;
  Nodes?: number;
  JSEventListeners?: number;
  Documents?: number;
  Frames?: number;
  JSHeapUsedSize?: number;
  LayoutCount?: number;
  RecalcStyleCount?: number;
  TaskDuration?: number;
}

/**
 * Turns two raw readings into one display sample.
 *
 * `elapsedMs` is the gap since the *previous* reading, not the time since
 * sampling began. Using the total duration made every spike average itself into
 * the whole run: CPU read as a slowly drifting number and the rates looked like
 * flat lines even while the page was visibly struggling. Each sample describes
 * its own interval.
 *
 * The sample's `t` is still absolute — milliseconds since `startedAt` — because
 * that is what the chart's x axis needs. The two are deliberately separate.
 *
 * The first reading has no predecessor, so every rate is zero: reporting the
 * cumulative totals as if they were a rate would draw a spike that never
 * happened. Counts are instantaneous and reported as-is from the first sample.
 *
 * `cpu` is the share of the interval the renderer spent on tasks. It uses
 * `TaskDuration` rather than `ScriptDuration` because layout and style work is
 * usually the reason a page feels slow, and script time alone would miss it.
 */
export function deriveSample(
  previous: RawMetrics | undefined,
  current: RawMetrics,
  elapsedMs: number,
  startedAt: number,
): PerfSample {
  const count = (value: number | undefined): number => (Number.isFinite(value) ? Number(value) : 0);
  const nodes = count(current.Nodes);
  const listeners = count(current.JSEventListeners);
  const documents = count(current.Documents);
  const frames = count(current.Frames);
  const heap = count(current.JSHeapUsedSize);

  const interval = elapsedMs > 0 ? elapsedMs / 1000 : 0;
  const rate = (now: number | undefined, before: number | undefined): number => {
    if (!previous || !interval) return 0;
    const delta = count(now) - count(before);
    // A counter that went backwards means the document was replaced; the
    // honest answer is "no rate yet", not a negative one.
    if (delta < 0) return 0;
    return Math.round((delta / interval) * 10) / 10;
  };
  const busySeconds = (now: number | undefined, before: number | undefined): number => {
    if (!previous) return 0;
    const delta = count(now) - count(before);
    return delta < 0 ? 0 : delta;
  };

  return {
    t: Math.max(0, Math.round(Date.now() - startedAt)),
    at: new Date().toISOString(),
    cpu: interval
      ? Math.min(100, Math.round((busySeconds(current.TaskDuration, previous?.TaskDuration) / interval) * 1000) / 10)
      : 0,
    nodes,
    listeners,
    documents,
    frames,
    heap,
    layouts: rate(current.LayoutCount, previous?.LayoutCount),
    styleRecalcs: rate(current.RecalcStyleCount, previous?.RecalcStyleCount),
  };
}

/**
 * Appends a sample and trims the history back to the chart's window.
 *
 * Trimming is by **time**, with the count cap only as a backstop. A busy page
 * delays the sampler, so a count-only cap would keep a hundred samples spanning
 * more than the window the chart draws — those extra samples are invisible
 * anyway (they would be clamped to the left edge), and the "we hold one window
 * of data" claim would quietly stop being true.
 */
export function pushSample(history: PerfSample[], sample: PerfSample): PerfSample[] {
  const left = sample.t - PERF_WINDOW_MS;
  const next = [...history.filter((item) => item.t >= left), sample];
  return next.length > PERF_HISTORY_LIMIT ? next.slice(next.length - PERF_HISTORY_LIMIT) : next;
}

/**
 * The largest value a metric reached, floored so a chart has a usable scale.
 *
 * A series that is all zeros would otherwise divide by zero, and a series with a
 * single spike would flatline everything else against the top of the axis.
 */
export function peakOf(history: PerfSample[], metric: PerfMetric, floor = 1): number {
  let peak = 0;
  for (const sample of history) {
    const value = sample[metric];
    if (value > peak) peak = value;
  }
  return Math.max(floor, peak);
}

/** A sample reduced to what a chart line needs. */
export function seriesOf(
  history: PerfSample[],
  metric: PerfMetric,
  peak: number,
): Array<{ x: number; y: number }> {
  const span = history.length > 1 ? history[history.length - 1]!.t - history[0]!.t : 1;
  return history.map((sample) => {
    const x = span > 0 ? (sample.t - history[0]!.t) / span : 0;
    return { x, y: peak > 0 ? Math.min(1, sample[metric] / peak) : 0 };
  });
}

/** Re-exported so `e2e` and tests read the same charting rules as the panel. */
export {
  perfArea,
  perfAxisLabel,
  perfAxisMax,
  perfPeak,
  perfPolyline,
  perfSparkPath,
  perfSparkPoints,
} from "@shared/embedded";
