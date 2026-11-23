import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSpawnedWindows, seedSpawnedWindow } from "../src/main/spawn-window";
import { GUIDE_VERSION } from "../src/shared/guide";

/**
 * A spawned window inherits the library, never the tour.
 *
 * Windows are not independent data: the persisted side — sites, accounts,
 * bookmarks, saved passwords, settings — is the same behind every window, and
 * only the session (running identities, open tabs) belongs to one window. The
 * spawn therefore seeds the child from the parent's files, with exactly two
 * deviations: the guide-read flag counts as read, and `mcp.json` stays behind —
 * a second listener would fight the parent for the port.
 *
 * These tests pin the file-level contract because it is easy to drift one file
 * into "copied" and only notice when a spawned window pops the guide over the
 * screen, or refuses to start its MCP listener.
 */
describe("seedSpawnedWindow", () => {
  const dirs: string[] = [];

  function makeDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "ensemble-seed-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("copies the workspace and the vault, and seeds settings as guide-read", () => {
    const parent = makeDir({
      "workspace.json": '{"version":2,"sites":[],"identities":[]}',
      "vault.json": '{"version":2,"mode":"os","site":{},"identity":{}}',
      "settings.json": '{"theme":"dark","guideVersion":0}',
      // Present but never allowed to travel: the endpoint serves one workspace.
      "mcp.json": '{"enabled":true,"port":47821}',
    });
    const child = join(parent, "..", "ensemble-seed-child");
    dirs.push(child);
    seedSpawnedWindow(parent, child);

    expect(readFileSync(join(child, "workspace.json"), "utf8")).toBe(
      '{"version":2,"sites":[],"identities":[]}',
    );
    expect(readFileSync(join(child, "vault.json"), "utf8")).toContain('"mode":"os"');
    const settings = JSON.parse(readFileSync(join(child, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings["theme"]).toBe("dark");
    // A window opened after the fact never replays the first-run tour.
    expect(settings["guideVersion"]).toBe(GUIDE_VERSION);
    expect(existsSync(join(child, "mcp.json"))).toBe(false);
    // The child's browser profiles live under its own root, so process
    // ownership still resolves to this directory alone.
    expect(existsSync(join(child, "profiles"))).toBe(true);
  });

  it("tolerates a parent directory that is missing files entirely", () => {
    const parent = mkdtempSync(join(tmpdir(), "ensemble-seed-empty-"));
    dirs.push(parent);
    const child = join(parent, "child");
    dirs.push(child);
    seedSpawnedWindow(parent, child);

    // No workspace, no vault — but settings still exist, carrying the one line
    // that matters: the tour does not replay.
    expect(existsSync(join(child, "workspace.json"))).toBe(false);
    expect(existsSync(join(child, "vault.json"))).toBe(false);
    const settings = JSON.parse(readFileSync(join(child, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings["guideVersion"]).toBe(GUIDE_VERSION);
  });

  it("survives an unreadable settings file without giving up the other seeds", () => {
    const parent = makeDir({
      "workspace.json": '{"version":2}',
      "settings.json": "{not json",
    });
    const child = join(parent, "child");
    dirs.push(child);
    expect(() => seedSpawnedWindow(parent, child)).not.toThrow();

    expect(readFileSync(join(child, "workspace.json"), "utf8")).toBe('{"version":2}');
    const settings = JSON.parse(readFileSync(join(child, "settings.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings["guideVersion"]).toBe(GUIDE_VERSION);
  });

  it("creates the profiles root even when nothing else exists to copy", () => {
    const parent = mkdtempSync(join(tmpdir(), "ensemble-seed-bare-"));
    dirs.push(parent);
    const child = join(parent, "child");
    dirs.push(child);
    seedSpawnedWindow(parent, child);
    // The child's own profiles root exists from the start, but it is empty:
    // the parent's browser profiles are not the seed, so the child's sessions
    // genuinely start empty.
    expect(existsSync(join(child, "profiles"))).toBe(true);
    expect(existsSync(join(child, "profiles", "anything"))).toBe(false);
    expect(readFileSync(join(child, "settings.json"), "utf8")).toContain('"guideVersion"');
  });
});

describe("listSpawnedWindows", () => {
  const owned: string[] = [];

  afterEach(() => {
    for (const dir of owned.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function windowDir(root: string, stamp: string, pid: number | null): void {
    const dir = join(root, `window-${stamp}`);
    mkdirSync(dir, { recursive: true });
    if (pid !== null) {
      writeFileSync(join(dir, "lockfile"), JSON.stringify({ pid }), "utf8");
    }
  }

  it("lists only directories whose lock names a live pid", () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-windows-"));
    owned.push(root);
    windowDir(root, "2026-11-21T10-00-00-000Z", 101);
    windowDir(root, "2026-11-21T11-00-00-000Z", 202);
    windowDir(root, "2026-11-21T12-00-00-000Z", 303);
    // Dead holder, unparseable lock, and a directory that is not a window.
    windowDir(root, "2026-11-21T13-00-00-000Z", 404);
    writeFileSync(join(root, "window-2026-11-21T13-00-00-000Z", "lockfile"), "{not json", "utf8");
    mkdirSync(join(root, "profiles"), { recursive: true });

    const list = listSpawnedWindows(root, { processAlive: (pid) => pid === 101 || pid === 303 });
    expect(list.map((entry) => entry.pid)).toEqual([101, 303]);
    // Creation times come back out of the directory stamp as parseable UTC.
    expect(list[0]!.createdAt).toBe("2026-11-21T10:00:00.000Z");
  });

  it("answers an empty list for a root that does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-windows-empty-"));
    owned.push(root);
    expect(listSpawnedWindows(join(root, "missing"), { processAlive: () => true })).toEqual([]);
  });
});
