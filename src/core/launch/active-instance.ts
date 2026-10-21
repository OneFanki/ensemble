import type { RunningInstance } from "@shared/types";

/**
 * Maps the OS foreground window to one of our running instances.
 *
 * Every instance owns one browser process, so the PID the OS reports is the only
 * reliable link between "the window the user is looking at" and "which account".
 * This is deliberately not built from click history: raising a window from the
 * taskbar or with Alt+Tab must move the highlight too.
 */
export function findInstanceByPid(
  instances: Iterable<RunningInstance>,
  pid: number,
): RunningInstance | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  for (const instance of instances) {
    if (instance.pid === pid) return instance;
  }
  return undefined;
}

export interface ActiveInstanceInput {
  /** PID owning the OS foreground window, if it could be read. */
  foregroundPid: number | undefined;
  /** PID of our own Electron process; clicking any of our windows reports it. */
  selfPid: number;
  instances: Iterable<RunningInstance>;
}

/**
 * Decides the next highlighted instance.
 *
 * Returns `undefined` to mean "leave the previous highlight alone". That case is
 * not cosmetic: clicking the switcher itself briefly hands the foreground to our
 * Electron process, and clearing the highlight every time would make the row
 * flicker exactly when the user is looking at it. The same applies when the
 * foreground cannot be read at all.
 */
export function nextActiveInstanceId(input: ActiveInstanceInput): string | null | undefined {
  const { foregroundPid, selfPid, instances } = input;
  if (foregroundPid === undefined) return undefined;
  if (foregroundPid === selfPid) return undefined;
  const match = findInstanceByPid(instances, foregroundPid);
  // The user switched to some other application; nothing of ours is in front.
  return match ? match.id : null;
}
