import { describe, expect, it } from "vitest";
// 单测环境只有 @core/@shared 别名，main 侧走相对路径。
import { GuestCdp, type GuestCdpTarget } from "../src/main/embedded/guest-cdp";

/**
 * The sleep sweep's `busy` fact, as GuestCdp reports it.
 *
 * Only an AI-facing command may hold a page awake past its grace — a freeze
 * would turn it into a timeout. Observer traffic (`sendQuiet`, `lifecycle`) is
 * different: the performance sampler's 5 Hz heartbeat rides it, and counting it
 * let a page under continuous observation chain one in-flight sample into the
 * next at sweep time, never sleeping at all.
 */

/** A controllable target: commands park until the test releases them. */
function targetWith(gate: { open: () => void; openOne: () => void }): GuestCdpTarget & {
  sends: string[];
} {
  const sends: string[] = [];
  const waiters: Array<() => void> = [];
  gate.open = () => {
    for (const release of waiters.splice(0)) release();
  };
  gate.openOne = () => waiters.shift()?.();
  const park = <T,>(label: string): Promise<T> => {
    sends.push(label);
    return new Promise<T>((resolve) => {
      waiters.push(() => resolve(undefined as T));
    });
  };
  return {
    sends,
    guestId: () => "guest-1",
    has: () => true,
    busy: () => false,
    waitLaidOut: () => Promise.resolve(),
    contents: () => undefined,
    send: <T,>(guestId: string, method: string): Promise<T> => {
      void guestId;
      return park<T>(method);
    },
    evaluate: <T,>(guestId: string): Promise<T> => {
      void guestId;
      return park<T>("evaluate");
    },
  };
}

function executor(target: GuestCdpTarget): GuestCdp {
  return new GuestCdp(target, "tab-1", undefined, () => undefined);
}

describe("GuestCdp busy", () => {
  it("is true only while an AI-facing command waits for its reply", async () => {
    const gate = { open: () => undefined, openOne: () => undefined };
    const target = targetWith(gate);
    const cdp = executor(target);
    expect(cdp.busy()).toBe(false);
    const pending = cdp.send("Runtime.evaluate");
    // Let the command's own microtasks (the activity hook) settle so it has
    // reached the target and parked.
    await Promise.resolve();
    await Promise.resolve();
    expect(cdp.busy()).toBe(true);
    gate.open();
    await pending;
    expect(cdp.busy()).toBe(false);
  });

  it("stays true across concurrent AI commands until the last one settles", async () => {
    const gate = { open: () => undefined, openOne: () => undefined };
    const target = targetWith(gate);
    const cdp = executor(target);
    const first = cdp.send("Runtime.evaluate");
    const second = cdp.evaluate("1");
    await Promise.resolve();
    await Promise.resolve();
    gate.openOne();
    await first;
    expect(cdp.busy()).toBe(true);
    gate.openOne();
    await second;
    expect(cdp.busy()).toBe(false);
  });

  it("does not count observer traffic, so a sampled page can sleep", async () => {
    const gate = { open: () => undefined, openOne: () => undefined };
    const target = targetWith(gate);
    const cdp = executor(target);
    const pending = cdp.sendQuiet("Performance.getMetrics");
    expect(cdp.busy()).toBe(false);
    gate.open();
    await pending;
    const lifecycle = cdp.lifecycle("frozen");
    expect(cdp.busy()).toBe(false);
    gate.open();
    await lifecycle;
  });

  it("counts the renderer screenshot path, which sends no CDP command", async () => {
    const gate = { open: () => undefined, openOne: () => undefined };
    const target = targetWith(gate);
    const cdp = executor(target);
    const pending = cdp.screenshot({ preferRenderer: true });
    expect(cdp.busy()).toBe(true);
    gate.open();
    await pending.catch(() => undefined);
    expect(cdp.busy()).toBe(false);
  });
});
