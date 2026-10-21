import { findInstanceByPid, nextActiveInstanceId } from "@core/launch/active-instance";
import type { RunningInstance } from "@shared/types";
import { describe, expect, it } from "vitest";

function instance(id: string, pid: number): RunningInstance {
  return {
    id,
    label: id,
    environmentId: "env",
    engineId: "engine",
    pid,
    profileDir: `/profiles/${id}`,
    mode: "cdp",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

const instances = [instance("a", 100), instance("b", 200), instance("c", 300)];

describe("mapping the foreground window to an instance", () => {
  it("finds the instance that owns the process", () => {
    expect(findInstanceByPid(instances, 200)?.id).toBe("b");
  });

  it("does not guess for processes that are not ours", () => {
    expect(findInstanceByPid(instances, 999)).toBeUndefined();
    expect(findInstanceByPid(instances, 0)).toBeUndefined();
    expect(findInstanceByPid(instances, Number.NaN)).toBeUndefined();
  });

  it("highlights whichever browser window is in front", () => {
    expect(nextActiveInstanceId({ foregroundPid: 300, selfPid: 1, instances })).toBe("c");
    expect(nextActiveInstanceId({ foregroundPid: 100, selfPid: 1, instances })).toBe("a");
  });

  it("clears the highlight when another application is in front", () => {
    expect(nextActiveInstanceId({ foregroundPid: 999, selfPid: 1, instances })).toBeNull();
  });

  /*
   * Clicking the switcher hands the foreground to our own process for a moment.
   * Clearing the highlight then would make exactly the row the user just clicked
   * flicker, which reads as "the switch did not take".
   */
  it("keeps the previous highlight while our own window is in front", () => {
    expect(nextActiveInstanceId({ foregroundPid: 1, selfPid: 1, instances })).toBeUndefined();
  });

  it("keeps the previous highlight when the foreground cannot be read", () => {
    expect(
      nextActiveInstanceId({ foregroundPid: undefined, selfPid: 1, instances }),
    ).toBeUndefined();
  });
});
