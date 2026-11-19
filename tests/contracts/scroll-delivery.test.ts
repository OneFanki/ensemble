import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 滚动必须等本轮滚轮真正送达页面，再读位移。
 *
 * 这条契约守的是一个被实测过的时序缺陷，不是某个实现细节：
 *
 * 1. `Input.dispatchMouseEvent` 返回只代表事件进了 Chromium 的输入队列。
 *    页面的 `wheel` 监听器要到下一个合成帧才跑。
 * 2. 页面被节流时（后台标签页，或被别的窗口盖住的窗口）那一帧约 1 秒一次。
 *    实测：rAF 帧间隔 1007ms，派发到页面 wheel 监听器 3068ms，而滚动本身
 *    在事件到达后 0ms 就应用了。
 * 3. 于是「派发后马上读位置」读到的是滚动前的位置，把真实滚动报成
 *    `moved: false`；而那颗迟到的滚动落进下一次调用的基准，让下一次报出
 *    不属于自己的位移（实测 880 = 1080 − 200）。
 *
 * 修法是在派发前装一支一次性监听（和位置探针同一条命令，保证早于派发），
 * 派发后等它就位再读。**等的是「输入到达」这个事实，不是猜一个时长**——
 * 所以这里既要求等待存在，也要求它不是靠 sleep 蒙的。
 */
const BROWSER = readFileSync(
  join(process.cwd(), "src", "main", "embedded", "browser.ts"),
  "utf8",
);

/** The `scrollAt`-driving method's body, from its signature to the closing brace. */
function scrollMethodBody(): string {
  // 方法名可能是 scroll 或 scrollAt，取第一个包含 scroll 探针的那段。
  const start = BROWSER.indexOf("const collectProbe = (px: number, py: number) =>");
  expect(start, "滚动探针必须存在").toBeGreaterThan(-1);
  // 从探针往前找方法签名起点，往后找到方法结束（下一个同类缩进的 private/async）。
  const bodyStart = BROWSER.lastIndexOf("async scroll", start);
  expect(bodyStart, "必须能定位到滚动方法").toBeGreaterThan(-1);
  const tail = BROWSER.indexOf("\n  private async waitForScrollToSettle", start);
  expect(tail, "滚动方法之后应紧跟 waitForScrollToSettle").toBeGreaterThan(start);
  return BROWSER.slice(bodyStart, tail);
}

describe("滚轮送达的时序", () => {
  const body = scrollMethodBody();

  it("派发前就装好送达探针，而不是派发后再补", () => {
    // 探针必须和位置快照在同一条命令里：它要早于滚轮派发，且必须落在同一
    // 个执行上下文——单开一条命令会多一次往返，也挡不住中间插进来的滚动。
    const probeIndex = body.indexOf("__ensembleWheelProbe");
    expect(probeIndex, "送达探针必须存在").toBeGreaterThan(-1);
    const dispatchIndex = body.indexOf("scrollAt(");
    expect(dispatchIndex, "滚轮派发必须存在").toBeGreaterThan(-1);
    expect(probeIndex, "探针必须装得比派发早").toBeLessThan(dispatchIndex);
  });

  it("派发之后等本轮送达，再读位移", () => {
    const dispatchIndex = body.indexOf("scrollAt(");
    const awaitIndex = body.indexOf("__ensembleWheelProbe.promise");
    const readIndex = body.indexOf("waitForScrollToSettle");
    expect(awaitIndex, "必须等待送达信号").toBeGreaterThan(dispatchIndex);
    expect(readIndex, "位移必须在送达之后才读").toBeGreaterThan(awaitIndex);
  });

  it("等的是页面里的信号，不是固定 sleep", () => {
    // 一个 `setTimeout(...)` 的等待会随节流程度失效：写死 500ms 在 1fps 页面
    // 上照样太早，写死 3s 又会让不节流的页面白等。信号才两头都对。
    const awaitIndex = body.indexOf("__ensembleWheelProbe.promise");
    expect(awaitIndex).toBeGreaterThan(-1);
    const afterDispatch = body.slice(body.indexOf("scrollAt("), awaitIndex);
    expect(afterDispatch).not.toMatch(/setTimeout\s*\(/);
  });

  it("超时上限高于实测的节流延迟", () => {
    const match = BROWSER.match(/const WHEEL_DELIVERY_TIMEOUT_MS = ([\d_]+);/);
    expect(match, "送达超时必须是具名常量").not.toBeNull();
    const value = Number((match as RegExpMatchArray)[1]?.replace(/_/g, ""));
    // 实测 3068ms 才送达；上限必须留出余量，否则节流页面永远走超时分支。
    expect(value).toBeGreaterThan(4_000);
  });
});

/**
 * `measure_browser_performance` 的 `metrics` 必须真的只覆盖本次调用区间。
 *
 * 原来的过滤只写了下界（`t >= windowStartT`），上界靠「读的时候还没到」
 * 侥幸成立——采样器在整个等待期间照常写入，等待结束后到读 `history` 之间
 * 落进的样本一样会被算进来。于是 `maxAt` 可以超过调用方要的 `durationMs`，
 * 「本次观测区间」这个说法就不成立。
 *
 * 实测那次 e2e 失败正是它：`durationMs: 1600` 下 `maxAt` 报出 1394 / 1202，
 * 而断言要求 <= 1200。CPU 在 89–95%，页面确实是忙的——错的是区间。
 */
describe("性能测量的观测区间", () => {
  it("上下界都截断，区间才等于调用方要的那一段", () => {
    const start = BROWSER.indexOf("const windowStartT = ");
    expect(start, "必须能定位到观测区间起点").toBeGreaterThan(-1);
    const end = BROWSER.indexOf("const all = live.history;", start);
    expect(end, "必须能定位到区间过滤之后").toBeGreaterThan(start);
    const slice = BROWSER.slice(start, end);

    // 下界：不能丢，否则更早的样本会稀释本次读数。
    expect(slice).toMatch(/sample\.t >= windowStartT/);
    // 上界：不能丢，否则等待之后落进的样本会混进「本次区间」。
    expect(slice).toMatch(/sample\.t <= windowEndT/);
  });
});
