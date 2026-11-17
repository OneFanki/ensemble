import { openSync, readFileSync, closeSync, unlinkSync, writeSync } from "node:fs";

/**
 * The single-instance lock, owned by this file instead of by whatever happens
 * to be lying around in the user data directory.
 *
 * The lock file records the holder's pid and stays exclusively created: the
 * winner is whoever manages to create it first (`wx` fails if it exists). A
 * crash or a `taskkill /F` leaves the file behind, so existence alone proves
 * nothing — the next start reads the recorded pid and checks whether that
 * process is still alive. Dead (or unreadable) means the file is a leftover:
 * it is removed and the lock is taken. Alive means a real instance is running:
 * the start reports which pid holds the lock and exits, loudly, instead of
 * disappearing behind three unrelated GPU warnings.
 *
 * `processAlive` is injectable so tests can pin the verdict without spawning
 * real processes.
 */
export interface SingletonLockHolder {
  pid: number;
}

export type SingletonLockOutcome =
  | { acquired: true; release: () => void }
  | { acquired: false; holderPid?: number; reason: "held" | "unusable" };

/** Reads the pid out of a lock file; anything unparseable counts as leftover. */
export function readSingletonLock(lockPath: string): SingletonLockHolder | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? { pid: parsed.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when a live process answers for this pid; EPERM also means alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createLockFile(lockPath: string, pid: number): () => void {
  // `wx` is the whole trick: exactly one caller on the machine can create the
  // file, and the handle stays open for the process's life.
  const handle = openSync(lockPath, "wx");
  try {
    writeSync(handle, JSON.stringify({ pid }));
  } finally {
    closeSync(handle);
  }
  return () => {
    // Only remove a lock that still names us: an overlap where a new instance
    // took over (we crashed) must not see our exit delete their lock.
    try {
      const holder = readSingletonLock(lockPath);
      if (holder?.pid === pid) unlinkSync(lockPath);
    } catch {
      // A lock we cannot remove is someone else's problem, not a crash.
    }
  };
}

export function acquireSingletonLock(
  lockPath: string,
  pid: number,
  options?: { processAlive?: (pid: number) => boolean },
): SingletonLockOutcome {
  const alive = options?.processAlive ?? isProcessAlive;
  try {
    return { acquired: true, release: createLockFile(lockPath, pid) };
  } catch {
    // The file exists: either a live instance holds it or a dead one left it.
  }
  const holder = readSingletonLock(lockPath);
  if (holder && alive(holder.pid)) {
    return { acquired: false, holderPid: holder.pid, reason: "held" };
  }
  // A leftover from a crash — or a file nothing can identify. Either way no
  // live process owns it, and removal is what "self-healing" means here.
  try {
    unlinkSync(lockPath);
  } catch {
    // Unremovable is fine: the exclusive create below decides who wins.
  }
  try {
    return { acquired: true, release: createLockFile(lockPath, pid) };
  } catch {
    // Someone recreated it between our unlink and our create: a live race we
    // lose on purpose rather than fight.
    return { acquired: false, holderPid: readSingletonLock(lockPath)?.pid, reason: "held" };
  }
}
