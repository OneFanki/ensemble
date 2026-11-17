import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireSingletonLock,
  readSingletonLock,
} from "../src/main/single-instance";

/**
 * The single-instance lock has to survive the exact thing that broke it
 * before: a force-killed run leaves `lockfile` behind, and the next start must
 * take the lock instead of quitting in silence. The holder's pid in the file,
 * not the file's existence, is what decides.
 */
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-lock-test-"));
  created.push(dir);
  return dir;
}

const neverAlive = () => false;
const alwaysAlive = () => true;

describe("single instance lock", () => {
  it("records the holder's pid in an exclusively created file", () => {
    const lockPath = join(scratch(), "lockfile");
    const lock = acquireSingletonLock(lockPath, 4242, { processAlive: alwaysAlive });
    expect(lock.acquired).toBe(true);
    expect(readSingletonLock(lockPath)?.pid).toBe(4242);
    if (lock.acquired) lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("heals a leftover file from a dead process and takes the lock", () => {
    const lockPath = join(scratch(), "lockfile");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999 }));
    const lock = acquireSingletonLock(lockPath, 5000, { processAlive: neverAlive });
    expect(lock.acquired).toBe(true);
    expect(readSingletonLock(lockPath)?.pid).toBe(5000);
    if (lock.acquired) lock.release();
  });

  it("heals a file it cannot even read as a lock", () => {
    const lockPath = join(scratch(), "lockfile");
    writeFileSync(lockPath, "leftover garbage, not JSON");
    const lock = acquireSingletonLock(lockPath, 5000, { processAlive: alwaysAlive });
    // No usable holder pid inside, so no live instance can be behind it.
    expect(lock.acquired).toBe(true);
    expect(readSingletonLock(lockPath)?.pid).toBe(5000);
    if (lock.acquired) lock.release();
  });

  it("refuses with the holder's pid while a live instance holds it", () => {
    const lockPath = join(scratch(), "lockfile");
    writeFileSync(lockPath, JSON.stringify({ pid: 1234 }));
    const lock = acquireSingletonLock(lockPath, 5000, { processAlive: alwaysAlive });
    expect(lock.acquired).toBe(false);
    if (!lock.acquired) {
      expect(lock.reason).toBe("held");
      expect(lock.holderPid).toBe(1234);
    }
    // The refusal must not have destroyed the holder's file.
    expect(readSingletonLock(lockPath)?.pid).toBe(1234);
  });

  it("keeps a real holder's pid alive against the real process check", () => {
    const lockPath = join(scratch(), "lockfile");
    // The test process itself is the one pid we can be sure is running.
    const lock = acquireSingletonLock(lockPath, process.pid);
    expect(lock.acquired).toBe(true);
    const second = acquireSingletonLock(lockPath, process.pid + 1);
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.holderPid).toBe(process.pid);
    if (lock.acquired) lock.release();
    expect(acquireSingletonLock(lockPath, process.pid).acquired).toBe(true);
  });

  it("does not delete a successor's lock on a late release", () => {
    const lockPath = join(scratch(), "lockfile");
    const first = acquireSingletonLock(lockPath, 1111, { processAlive: neverAlive });
    // The first holder crashed; a new instance took over the file.
    const second = acquireSingletonLock(lockPath, 2222, { processAlive: neverAlive });
    expect(second.acquired).toBe(true);
    if (first.acquired) first.release();
    expect(readSingletonLock(lockPath)?.pid).toBe(2222);
    if (second.acquired) second.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("round-trips the lock file content through its own reader", () => {
    const lockPath = join(scratch(), "lockfile");
    writeFileSync(lockPath, JSON.stringify({ pid: 7 }));
    expect(readSingletonLock(lockPath)).toEqual({ pid: 7 });
    writeFileSync(lockPath, JSON.stringify({ pid: "not-a-number" }));
    expect(readSingletonLock(lockPath)).toBeUndefined();
    writeFileSync(lockPath, JSON.stringify({ pid: 0 }));
    expect(readSingletonLock(lockPath)).toBeUndefined();
    expect(readFileSync(lockPath, "utf8")).toContain("0");
  });
});
