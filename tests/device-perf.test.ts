import type { PerfSample } from "@shared/embedded";
import {
  DEVICE_DPR_MAX,
  DEVICE_DPR_MIN,
  DEVICE_PRESETS,
  PERF_METRICS,
  PERF_HISTORY_MAX,
  PERF_SAMPLE_INTERVAL_DEFAULT_MS,
  PERF_SAMPLE_INTERVAL_MAX_MS,
  PERF_SAMPLE_INTERVAL_MIN_MS,
  PERF_WINDOW_DEFAULT_MS,
  PERF_WINDOW_MAX_MS,
  PERF_WINDOW_MIN_MS,
  normalizeDevice,
  normalizePerfSampleInterval,
  normalizePerfWindow,
  perfHistoryLimit,
  normalizeViewportSize,
  perfArea,
  perfAxisLabel,
  perfAxisMax,
  perfCamera,
  perfClock,
  perfPolyline,
  perfSparkPath,
  perfSparkPoints,
  perfSummarize,
} from "@shared/embedded";
import {
  deriveSample,
  peakOf,
  pushSample,
  seriesOf,
} from "@core/cdp/performance";
import { describe, expect, it } from "vitest";

/**
 * Device validation and the performance sampler's arithmetic.
 *
 * These are the parts a unit test can judge honestly: what a hand-typed device
 * is allowed to be, and whether the derived rates are computed from the right
 * interval. The CDP calls themselves are exercised in `e2e-devtools-panels`.
 */
describe("device emulation", () => {
  it("accepts a device with everything a phone needs", () => {
    const device = normalizeDevice({
      width: 390,
      height: 844,
      dpr: 3,
      touch: true,
      userAgent: "Mozilla/5.0 (iPhone)",
    });
    expect(device).toEqual({
      width: 390,
      height: 844,
      dpr: 3,
      touch: true,
      userAgent: "Mozilla/5.0 (iPhone)",
    });
  });

  it("rejects a size outside the supported range", () => {
    // Same floor and ceiling as a plain viewport: a device is a viewport with
    // more identity, not a different size space.
    expect(normalizeDevice({ width: 200, height: 844, dpr: 3, touch: true })).toBeUndefined();
    expect(normalizeDevice({ width: 390, height: 5000, dpr: 3, touch: true })).toBeUndefined();
    expect(normalizeViewportSize(200, 844)).toBeUndefined();
  });

  it("rejects a pixel ratio a browser would never report", () => {
    expect(normalizeDevice({ width: 390, height: 844, dpr: 0, touch: true })).toBeUndefined();
    expect(
      normalizeDevice({ width: 390, height: 844, dpr: DEVICE_DPR_MAX + 1, touch: true }),
    ).toBeUndefined();
    expect(
      normalizeDevice({ width: 390, height: 844, dpr: DEVICE_DPR_MIN, touch: true }),
    ).toMatchObject({ dpr: DEVICE_DPR_MIN });
  });

  it("drops a blank user agent instead of storing an empty string", () => {
    // A blank UA means "use the browser's own"; keeping `""` would be sent to
    // `setUserAgentOverride` and blank the header.
    expect(normalizeDevice({ width: 390, height: 844, dpr: 2, touch: true, userAgent: "  " })).toEqual({
      width: 390,
      height: 844,
      dpr: 2,
      touch: true,
    });
  });

  it("offers presets that are all valid devices", () => {
    for (const preset of DEVICE_PRESETS) {
      expect(normalizeDevice(preset)).toBeDefined();
      // Every preset is a device, not a viewport: touch is what makes a site
      // serve its mobile UI, and a preset without it would be a size shortcut
      // filed under the wrong heading.
      expect(preset.touch).toBe(true);
      expect(preset.userAgent).toBeTruthy();
    }
  });
});

describe("performance sampler", () => {
  it("reports no rate for the first sample", () => {
    // The raw counters are cumulative since the document loaded. Reporting them
    // as a rate on the first tick would draw a spike that never happened.
    const sample = deriveSample(undefined, { Nodes: 100, LayoutCount: 50, TaskDuration: 2 }, 1000, 0);
    expect(sample.layouts).toBe(0);
    expect(sample.cpu).toBe(0);
    // Instantaneous counts are still real on the first sample.
    expect(sample.nodes).toBe(100);
  });

  it("turns cumulative counters into per-second rates", () => {
    const first = { LayoutCount: 10, RecalcStyleCount: 4, TaskDuration: 1 };
    const second = { LayoutCount: 30, RecalcStyleCount: 6, TaskDuration: 1.5 };
    const sample = deriveSample(first, second, 2000, 0);
    expect(sample.layouts).toBe(10);
    expect(sample.styleRecalcs).toBe(1);
    // Half of a 2-second window spent on tasks.
    expect(sample.cpu).toBe(25);
  });

  it("measures each sample over its own interval, not over the whole run", () => {
    // The bug that made the first version useless: passing the *total* elapsed
    // time into every sample averaged a 100ms burst over a minute of history,
    // and the chart drew a flat line through the busiest page. Two samples taken
    // 200ms after a spike must report the spike at full height.
    const first = { TaskDuration: 0, LayoutCount: 0 };
    const second = { TaskDuration: 0.1, LayoutCount: 5 };
    const sample = deriveSample(first, second, 200, 0);
    // 0.1s of task time in a 0.2s interval.
    expect(sample.cpu).toBe(50);
    // 5 layouts in 0.2s is 25/s, not 5/s stretched over a longer window.
    expect(sample.layouts).toBe(25);
  });

  it("timestamps the sample from the start of sampling", () => {
    // The rate interval and the chart's x coordinate are different numbers: the
    // rate uses the gap since the last reading, the timestamp is absolute.
    const now = Date.now();
    const sample = deriveSample({ TaskDuration: 0 }, { TaskDuration: 0.05 }, 200, now - 5_000);
    expect(sample.t).toBeGreaterThanOrEqual(5_000);
    expect(sample.t).toBeLessThan(7_000);
  });

  it("reports zero rather than a negative rate when the document was replaced", () => {
    // A navigation resets every counter. A negative delta means "this is a new
    // document", and the honest answer is that no rate is known yet.
    const sample = deriveSample({ LayoutCount: 100 }, { LayoutCount: 2 }, 1000, 0);
    expect(sample.layouts).toBe(0);
  });

  it("never reports more than 100% CPU", () => {
    // TaskDuration can exceed the wall interval on a multi-core renderer.
    const sample = deriveSample({ TaskDuration: 0 }, { TaskDuration: 9 }, 1000, 0);
    expect(sample.cpu).toBe(100);
  });

  it("keeps the newest samples when the cap is reached", () => {
    // Same timestamps, so only the count ceiling can trim: this is the backstop
    // for a page whose sampler fires far faster than the window would imply.
    const limit = perfHistoryLimit(PERF_WINDOW_DEFAULT_MS, PERF_SAMPLE_INTERVAL_DEFAULT_MS);
    let history = [] as ReturnType<typeof deriveSample>[];
    for (let index = 0; index < limit + 5; index += 1) {
      history = pushSample(history, deriveSample(undefined, { Nodes: index }, 0, 0));
    }
    expect(history).toHaveLength(limit);
    expect(history[history.length - 1]?.nodes).toBe(limit + 4);
  });

  it("drops samples that have left the window, not just those past the count", () => {
    // A delayed sampler produces fewer, wider-spaced samples. A count-only cap
    // would keep 100 of them spanning far more than the window the chart draws,
    // so the history would claim to be "one window" while holding ten seconds
    // more — invisible in the chart, but wrong the moment anything reads it.
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    let history = [
      { ...base, t: 0, nodes: 1 },
      { ...base, t: 5_000, nodes: 2 },
      { ...base, t: 10_000, nodes: 3 },
    ];
    history = pushSample(history, { ...base, t: 15_000, nodes: 4 });
    // A 20-second window ending at 15s reaches back to 0, so nothing is dropped
    // yet; one more sample moves the floor past 0.
    expect(history.map((sample) => sample.t)).toEqual([0, 5_000, 10_000, 15_000]);
    history = pushSample(history, { ...base, t: 20_000, nodes: 5 });
    // 20s window ending at 20s ⇒ everything before t=0 is out; t=0 itself is on
    // the edge and is kept, so only the assert on the oldest surviving value
    // matters here.
    expect(history[0]?.t).toBeGreaterThanOrEqual(0);
    history = pushSample(history, { ...base, t: 25_000, nodes: 6 });
    expect(history.map((sample) => sample.t)).toEqual([5_000, 10_000, 15_000, 20_000, 25_000]);
  });

  it("trims to whatever window the setting names, not to a fixed one", () => {
    // The window is a setting now. A short one has to forget quickly — a five
    // second chart holding a minute of samples would silently draw the oldest
    // ones clamped at the left edge, which reads as a flat past that never
    // existed.
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    let history: PerfSample[] = [];
    for (let t = 0; t <= 20_000; t += 1_000) {
      history = pushSample(
        history,
        { ...base, t, nodes: t / 1_000 },
        { windowMs: 5_000, intervalMs: 1_000 },
      );
    }
    expect(history.map((sample) => sample.t)).toEqual([16_000, 17_000, 18_000, 19_000, 20_000]);
  });

  it("clamps both settings into the range the sampler supports", () => {
    // A settings file can be edited by hand, and a zero interval would spin the
    // timer as fast as the event loop allows. Normalising at the write boundary
    // is what keeps that from ever reaching a running page.
    expect(normalizePerfSampleInterval(0)).toBe(PERF_SAMPLE_INTERVAL_MIN_MS);
    expect(normalizePerfSampleInterval(99_999)).toBe(PERF_SAMPLE_INTERVAL_MAX_MS);
    expect(normalizePerfSampleInterval("250")).toBe(250);
    expect(normalizePerfSampleInterval(undefined)).toBe(PERF_SAMPLE_INTERVAL_DEFAULT_MS);
    expect(normalizePerfWindow(1)).toBe(PERF_WINDOW_MIN_MS);
    expect(normalizePerfWindow(10 * 60_000)).toBe(PERF_WINDOW_MAX_MS);
    expect(normalizePerfWindow(null)).toBe(PERF_WINDOW_DEFAULT_MS);
  });

  it("keeps the sample count bounded when both settings are at their extremes", () => {
    // 2 minutes at 100ms is 1,200 readings per series across eight series; the
    // ceiling is what stops a lawful pair of settings from becoming the load it
    // is supposed to measure.
    expect(perfHistoryLimit(PERF_WINDOW_MAX_MS, PERF_SAMPLE_INTERVAL_MIN_MS)).toBeLessThanOrEqual(
      PERF_HISTORY_MAX,
    );
    // The defaults still cover exactly one window.
    expect(perfHistoryLimit(PERF_WINDOW_DEFAULT_MS, PERF_SAMPLE_INTERVAL_DEFAULT_MS)).toBe(100);
  });

  it("floors a peak so an all-zero series still has a scale", () => {
    const history = [deriveSample(undefined, {}, 0, 0), deriveSample(undefined, {}, 0, 0)];
    expect(peakOf(history, "cpu")).toBe(1);
    const points = seriesOf(history, "cpu", peakOf(history, "cpu"));
    expect(points.every((point) => point.y === 0)).toBe(true);
  });

  it("scales every metric to its own peak so one big number cannot flatten the rest", () => {
    const history = [
      deriveSample(undefined, { JSHeapUsedSize: 0, Nodes: 0 }, 0, 0),
      deriveSample(undefined, { JSHeapUsedSize: 100_000_000, Nodes: 10 }, 1000, 0),
    ];
    expect(peakOf(history, "heap")).toBe(100_000_000);
    expect(peakOf(history, "nodes")).toBe(10);
    // Normalised, both peaks reach the top of their own lane.
    expect(seriesOf(history, "heap", 100_000_000).at(-1)?.y).toBe(1);
    expect(seriesOf(history, "nodes", 10).at(-1)?.y).toBe(1);
  });

  it("publishes a metric list the panel can render", () => {
    // The sampler and the table both read this list; a metric that exists in
    // one and not the other is a column that never fills.
    expect(PERF_METRICS).toContain("cpu");
    expect(PERF_METRICS).toContain("heap");
    expect(new Set(PERF_METRICS).size).toBe(PERF_METRICS.length);
  });

  it("gives a steady series headroom so a flat line reads as flat", () => {
    // A chart whose axis top equals the highest sample pins a constant line to
    // the ceiling, which reads as "saturated" rather than "steady".
    expect(perfAxisMax(10)).toBeGreaterThan(10);
    expect(perfAxisMax(0)).toBeGreaterThanOrEqual(1);
  });

  it("never lets the axis top fall below the peak", () => {
    for (const peak of [0.3, 7, 42, 1_800, 2_400_000]) {
      expect(perfAxisMax(peak)).toBeGreaterThanOrEqual(peak);
    }
  });

  it("spaces chart points by time, not by index", () => {
    // A busy page delays the sampler. Evenly spaced points would hide that gap
    // and misreport when a spike happened, so the x coordinate comes from `t`.
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    const history = [
      { ...base, t: 0, nodes: 1 },
      { ...base, t: 100, nodes: 5 },
      { ...base, t: 1_000, nodes: 9 },
    ];
    // A one-second window ending at the last sample puts t=0 at the left edge;
    // the point of this test is the *spacing*, so the window is chosen to keep
    // the whole series on screen.
    const points = perfSparkPoints(history, "nodes", 100, 20, 10, 1_000);
    expect(points).toHaveLength(3);
    expect(points[0]?.x).toBeCloseTo(0, 1);
    // 100ms into a 1000ms window is a tenth of the width — a real gap, not an
    // even third, which is what index spacing would have produced.
    expect(points[1]?.x).toBeCloseTo(10, 1);
    expect(points[2]?.x).toBeCloseTo(100, 1);
  });

  it("holds the axis still while the window fills, instead of stretching the data", () => {
    // The bug this guards: the axis used to be fitted to "oldest sample →
    // newest", so two seconds of data were drawn across the whole chart and
    // then squeezed as more arrived. The chart looked like it was zooming on
    // its own. With a fixed window the newest sample is always at the right
    // edge and a young series occupies only its own sliver of it.
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    const young = [
      { ...base, t: 0, nodes: 1 },
      { ...base, t: 100, nodes: 5 },
      { ...base, t: 200, nodes: 9 },
    ];
    const points = perfSparkPoints(young, "nodes", 200, 20, 10, 2_000);
    // 200ms of a 2000ms window is the rightmost tenth: x runs 180 → 200, never
    // from 0. Anchoring to the first sample would put these at 0 → 200.
    expect(points[0]?.x).toBeCloseTo(180, 1);
    expect(points.at(-1)?.x).toBeCloseTo(200, 1);

    // A full window still uses the whole width, and the oldest sample sits at
    // the left edge — that is the sliding window once it is full.
    const full = [
      { ...base, t: 0, nodes: 1 },
      { ...base, t: 1_000, nodes: 5 },
      { ...base, t: 2_000, nodes: 9 },
    ];
    const spread = perfSparkPoints(full, "nodes", 200, 20, 10, 2_000);
    expect(spread[0]?.x).toBeCloseTo(0, 1);
    expect(spread.at(-1)?.x).toBeCloseTo(200, 1);
  });

  it("draws nothing for a single sample", () => {
    // One point is not a line; drawing it would put a dot at the left edge that
    // looks like a drop to zero.
    expect(perfSparkPath([deriveSample(undefined, { Nodes: 1 }, 0, 0)], "nodes", 100, 20, 10)).toBe(
      "",
    );
  });

  it("closes the area on the baseline at both ends", () => {
    // The fill is what makes a low series visible. It has to start and end on
    // the baseline, or the shaded region floats below/above the line it belongs
    // to and reads as a second series.
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    const history = [
      { ...base, t: 0, nodes: 2 },
      { ...base, t: 500, nodes: 8 },
      { ...base, t: 1_000, nodes: 4 },
    ];
    const area = perfArea(perfSparkPoints(history, "nodes", 100, 30, 10, 1_000), 30);
    const baseline = 29;
    // Starts by tracing the line, then drops to the baseline on both sides.
    expect(area.startsWith("M")).toBe(true);
    expect(area).toContain(`L100.0,${baseline}`);
    expect(area).toContain(`L0.0,${baseline}`);
    expect(area.endsWith("Z")).toBe(true);
  });

  it("labels axis ticks in each metric's own unit", () => {
    // The gutter is ~36px, so a label has to be short *and* say the unit.
    expect(perfAxisLabel("cpu", 100)).toBe("100%");
    expect(perfAxisLabel("cpu", 12.4)).toBe("12.4%");
    // One decimal below ten, none above: the gutter cannot show more, and the
    // extra digit would not change any decision.
    expect(perfAxisLabel("heap", 16.9 * 1024 * 1024)).toBe("17M");
    expect(perfAxisLabel("heap", 1.8 * 1024 * 1024)).toBe("1.8M");
    expect(perfAxisLabel("nodes", 3058)).toBe("3058");
    expect(perfAxisLabel("nodes", 12_500)).toBe("13k");
    expect(perfAxisLabel("nodes", 9_400)).toBe("9400");
    expect(perfAxisLabel("layouts", 1.5)).toBe("1.5");
    // Zero has to be a real label, not an empty string: it is the baseline tick.
    expect(perfAxisLabel("nodes", 0)).toBe("0");
    // A percentage scale whose zero drops the sign reads as two units mixed on
    // one axis (100% / 50% / 0).
    expect(perfAxisLabel("cpu", 0)).toBe("0%");
  });

  it("orders metrics the way Chrome's monitor does", () => {
    // cost → memory → structure → churn. Changing this silently would reorder
    // the panel without anyone deciding to.
    expect([...PERF_METRICS]).toEqual([
      "cpu",
      "heap",
      "nodes",
      "listeners",
      "documents",
      "frames",
      "layouts",
      "styleRecalcs",
    ]);
  });

  /*
   * The camera.
   *
   * The panel used to pin the plot's right edge to the newest sample, which
   * froze the chart between samples and snapped it one step when the next one
   * landed. These functions are what let it move every frame instead, so their
   * arithmetic is the whole fix — a wrong factor here scrolls at the wrong
   * speed or in the wrong direction, and no amount of rAF hides that.
   */
  it("draws an explicit origin without clamping to the plot", () => {
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    const history = [
      { ...base, t: 0, nodes: 1 },
      { ...base, t: 1_000, nodes: 2 },
      { ...base, t: 2_000, nodes: 3 },
    ];
    // Origin at t=1_000 over a 1s window: t=0 is a full window to the left and
    // has to stay there. Clamping it to 0 would pile the oldest sample onto the
    // left edge and draw a flat past that never happened.
    const points = perfSparkPoints(history, "nodes", 100, 20, 10, 1_000, { origin: 1_000 });
    expect(points.map((point) => Math.round(point.x))).toEqual([-100, 0, 100]);
  });

  it("keeps the static plot's clamping when no origin is given", () => {
    // The default path is the one `measure_performance` and older callers use;
    // it must keep behaving exactly as before.
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    const history = [
      { ...base, t: 0, nodes: 1 },
      { ...base, t: 500, nodes: 2 },
      { ...base, t: 2_000, nodes: 3 },
    ];
    const points = perfSparkPoints(history, "nodes", 100, 20, 10, 1_000);
    expect(points[0]?.x).toBe(0);
    expect(points.at(-1)?.x).toBe(100);
  });

  it("extends the last reading past the right edge when asked", () => {
    // Without this the curve stops at the newest sample and a gap opens as wide
    // as the time since it was taken — exactly the seam the camera would expose.
    const base = { at: "", cpu: 0, listeners: 0, documents: 0, frames: 0, heap: 0, layouts: 0, styleRecalcs: 0 };
    const history = [
      { ...base, t: 0, nodes: 4 },
      { ...base, t: 1_000, nodes: 9 },
    ];
    const plain = perfSparkPoints(history, "nodes", 100, 20, 10, 1_000, { origin: 0 });
    const extended = perfSparkPoints(history, "nodes", 100, 20, 10, 1_000, {
      origin: 0,
      extendRight: true,
    });
    expect(extended).toHaveLength(plain.length + 1);
    // Flat and one full plot-width further right: off-screen, clipped, and the
    // same height as the reading it continues.
    expect(extended.at(-1)).toEqual({ x: 200, y: plain.at(-1)!.y });
  });

  it("draws counts as a staircase and cpu as a slope", () => {
    // A DOM count did not climb from 3 to 4; it was 3 and then it was 4. A
    // slope invents a value nobody measured. CPU is a share of an interval, so
    // its slope is real.
    const points = [
      { x: 0, y: 10 },
      { x: 50, y: 4 },
      { x: 100, y: 7 },
    ];
    expect(perfPolyline(points)).toBe("M0.0,10.0 L50.0,4.0 L100.0,7.0");
    // Hold the old value until the new sample's own moment, then step.
    expect(perfPolyline(points, { step: true })).toBe("M0.0,10.0 H50.0 V4.0 H100.0 V7.0");
    // The fill follows the same shape, or it cuts corners under the line.
    expect(perfArea(points, 20, { step: true })).toContain("H50.0 V4.0");
  });

  it("advances the camera only once the window is full", () => {
    // While the series is still filling, the newest sample IS the right edge —
    // sliding then would drag a short curve off into an empty chart.
    const windowMs = 10_000;
    const width = 100;
    // A full window has been laid out: nothing to slide yet.
    expect(perfCamera(10_000, 0, windowMs, width)).toBe(0);
    // Half a window later the plot has moved half a plot-width.
    expect(perfCamera(15_000, 0, windowMs, width)).toBeCloseTo(50, 5);
    // Rewinding (a clock that went backwards) must not scroll the other way.
    expect(perfCamera(9_000, 0, windowMs, width)).toBe(0);
  });

  it("derives the current moment from the newest sample", () => {
    // Samples carry `t` relative to sampling start, not a wall clock, so "now"
    // has to be reconstructed from the moment the newest one was taken.
    const sample: PerfSample = {
      at: "2026-01-01T00:00:01.000Z",
      t: 1_000,
      cpu: 0,
      nodes: 0,
      listeners: 0,
      documents: 0,
      frames: 0,
      heap: 0,
      layouts: 0,
      styleRecalcs: 0,
    };
    const nowMs = Date.parse("2026-01-01T00:00:01.250Z");
    expect(perfClock(sample, nowMs)).toBe(1_250);
    // No samples yet, and a sample stamped in the future, both have to be safe:
    // the first is "nothing drawn", the second must not rewind the camera.
    expect(perfClock(undefined, nowMs)).toBe(0);
    expect(perfClock(sample, Date.parse("2026-01-01T00:00:00.000Z"))).toBe(1_000);
  });
});

/*
 * The summary an agent gets instead of the curve.
 *
 * These exist because the tool's whole value is that a model does not have to do
 * the arithmetic: if `avg` were computed over the wrong set, or `maxAt` pointed
 * at a sample that is not the max, every conclusion drawn from it would be
 * plausible and wrong.
 */
describe("performance summary", () => {
  const sample = (t: number, cpu: number): PerfSample => ({
    t,
    at: "",
    cpu,
    nodes: 0,
    listeners: 0,
    documents: 0,
    frames: 0,
    heap: 0,
    layouts: 0,
    styleRecalcs: 0,
  });

  it("reports the mean, the peak and when the peak happened", () => {
    const history = [sample(0, 2), sample(200, 40), sample(400, 6)];
    const summary = perfSummarize(history, "cpu");
    expect(summary?.avg).toBe(16);
    expect(summary?.max).toBe(40);
    // The middle sample: this is the number that gets matched against a console
    // line's timestamp, so an off-by-one here produces a confidently wrong story.
    expect(summary?.maxAt).toBe(200);
    expect(summary?.last).toBe(6);
    expect(summary?.samples).toBe(3);
  });

  it("leaves the warmup reading out of a rate's mean", () => {
    // The first reading of a session has no previous counter, so its rate is
    // unknown — not zero. Averaging that zero in reported a busy page as half as
    // busy: a two-sample window's mean was exactly half the real CPU.
    const warm = { ...sample(0, 0), warmup: true as const };
    const history = [warm, sample(200, 40), sample(400, 60)];
    const summary = perfSummarize(history, "cpu");
    expect(summary?.samples).toBe(2);
    expect(summary?.avg).toBe(50);
    expect(summary?.max).toBe(60);
    expect(summary?.maxAt).toBe(400);
  });

  it("keeps a count's first reading, which needs no predecessor", () => {
    // A DOM node count is valid the moment it is read; dropping it would throw
    // away a real fact and, on a short window, leave nothing at all.
    const history = [{ ...sample(0, 0), nodes: 42 }, sample(200, 0)];
    expect(perfSummarize(history, "nodes")?.samples).toBe(2);
    expect(perfSummarize(history, "nodes")?.max).toBe(42);
  });

  it("does not draw the warmup zero into a rate's line", () => {
    // A visible drop to the baseline at the start of every session, which never
    // happened. Counts keep their first point.
    const warm = { ...sample(0, 0), warmup: true as const };
    const ratePoints = perfSparkPoints([warm, sample(200, 40), sample(400, 60)], "cpu", 100, 20, 100);
    expect(ratePoints).toHaveLength(2);
    const countPoints = perfSparkPoints(
      [{ ...sample(0, 0), nodes: 42 }, sample(200, 0), sample(400, 0)],
      "nodes",
      100,
      20,
      100,
    );
    expect(countPoints).toHaveLength(3);
  });

  it("says nothing at all for an empty window", () => {
    // The caller substitutes zeros; returning a zero-filled summary from here
    // would claim "the page was idle" for a window that was never measured.
    expect(perfSummarize([], "cpu")).toBeUndefined();
  });

  it("keeps sub-unit precision instead of rounding to whole numbers", () => {
    // A page idling at 0.4% and one at 0.6% are both "0" if this rounds early,
    // and the panel's headline number would disagree with the tool's.
    const summary = perfSummarize([sample(0, 0.4), sample(200, 0.6)], "cpu");
    expect(summary?.avg).toBe(0.5);
    expect(summary?.max).toBe(0.6);
  });
});
