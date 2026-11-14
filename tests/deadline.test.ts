import { describe, expect, it, vi } from "vitest";
import { DeadlineError, isDeadlineError, withDeadline } from "../src/shared/async";

/**
 * Deadlines, and what a caller is allowed to conclude from one.
 *
 * The distinction this file guards is the whole point of `DeadlineError`: a
 * timeout says "we stopped waiting", not "the work failed". The MCP layer turns
 * a timed-out `evaluate` into a normal result carrying `stillRunning`, which is
 * only honest if the underlying error is recognisable as a deadline rather than
 * as a failure.
 */
describe("withDeadline", () => {
  it("rejects with a recognisable deadline error", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const pending = withDeadline(never, 1_000, "CDP Runtime.evaluate 没有响应");
    const settled = expect(pending).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    vi.useRealTimers();
  });

  it("keeps the message the old bare Error carried", async () => {
    // Callers (and one e2e) match on this text. Turning the timeout into a new
    // type must not also change what it says.
    vi.useFakeTimers();
    const pending = withDeadline(new Promise<void>(() => {}), 500, "截图");
    const assertion = expect(pending).rejects.toThrow("截图（超过 500ms）");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    vi.useRealTimers();
  });

  it("resolves with the value when it arrives in time", async () => {
    await expect(withDeadline(Promise.resolve(42), 1_000, "读取")).resolves.toBe(42);
  });

  it("passes a real rejection through untouched", async () => {
    // A page that threw is not a page that took too long. Reporting one as the
    // other would make "retry" look like the wrong advice.
    const failure = new Error("页面脚本执行失败");
    await expect(withDeadline(Promise.reject(failure), 1_000, "读取")).rejects.toBe(failure);
  });

  it("ignores a value that arrives after the deadline", async () => {
    // The original promise is not cancelled — it cannot be — so a late resolve
    // has to be harmless rather than a double settle.
    vi.useFakeTimers();
    let release!: (value: string) => void;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = withDeadline(slow, 100, "慢查询");
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineError);
    await vi.advanceTimersByTimeAsync(100);
    release("too late");
    await assertion;
    // Settling twice would throw "already settled" out of the executor.
    await Promise.resolve();
    vi.useRealTimers();
  });
});

describe("isDeadlineError", () => {
  it("accepts a DeadlineError", () => {
    expect(isDeadlineError(new DeadlineError("等待", 10))).toBe(true);
  });

  it("accepts the shape across module instances", () => {
    // The shared layer is bundled into both graphs, so the class identity is not
    // guaranteed. Callers switch on the marker, and this is that contract.
    expect(isDeadlineError({ timedOut: true, what: "等待", message: "等待（超过 10ms）" })).toBe(
      true,
    );
  });

  it("rejects everything else", () => {
    expect(isDeadlineError(new Error("超时"))).toBe(false);
    expect(isDeadlineError({ timedOut: true })).toBe(false);
    expect(isDeadlineError(null)).toBe(false);
    expect(isDeadlineError("timeout")).toBe(false);
  });
});
