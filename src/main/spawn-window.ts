import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GUIDE_VERSION } from "@shared/guide";
import { isProcessAlive, readSingletonLock } from "./single-instance";

/**
 * Seeds a freshly spawned window's directory from this one's persisted state.
 *
 * Windows are not independent data. The persisted side — sites, accounts,
 * bookmarks, saved passwords, settings — is the same in every window, and the
 * only thing a window owns is its session: which identities are on its rail and
 * which tabs it has open. True sharing means one process owning several windows;
 * until that refactor, a spawned window is a sibling process with its own
 * directory, seeded from this one's persisted state at the moment it opens.
 * Sessions start empty there — that is the isolation — and the two libraries
 * diverge only through later edits.
 *
 * What is copied, and what is not:
 *
 * - `workspace.json` and `vault.json` verbatim. The vault is OS-protected for
 *   this user on this machine, which a sibling directory of the same app
 *   exactly is; saved passwords ride along because the accounts would be
 *   half-present without them.
 * - `settings.json` with one edit: `guideVersion` pinned to the current
 *   version. A window that opens after the fact has no reason to replay the
 *   first-run tour — the guide-read flag is shared persisted state, not a
 *   per-window one. An unreadable parent file degrades to that one line.
 * - `mcp.json` deliberately absent: the endpoint serves one workspace, and a
 *   duplicate listener would fight the parent for the port. The child starts
 *   with MCP off, like any fresh directory.
 *
 * The per-directory instance lock still applies within each directory, and no
 * file is ever written by two processes.
 */
export function seedSpawnedWindow(sourceDir: string, targetDir: string): void {
  mkdirSync(join(targetDir, "profiles"), { recursive: true });
  for (const name of ["workspace.json", "vault.json"]) {
    const source = join(sourceDir, name);
    if (existsSync(source)) copyFileSync(source, join(targetDir, name));
  }
  const settingsPath = join(sourceDir, "settings.json");
  let settings: Record<string, unknown> | null = null;
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      settings = null;
    }
  }
  const seeded = settings ?? {};
  seeded["guideVersion"] = GUIDE_VERSION;
  writeFileSync(join(targetDir, "settings.json"), `${JSON.stringify(seeded, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Options for {@link launchSpawnedWindow}; everything Electron-specific is
 * resolved by the caller so this module stays testable in plain Node. */
export interface SpawnWindowOptions {
  /** The spawning instance's own user-data directory; the library is seeded from it. */
  sourceUserData: string;
  /** `process.execPath`; a dev build needs `appPath` prepended, a packaged one does not. */
  execPath: string;
  /** The app's own path; empty for a packaged binary, which needs no argument. */
  appPath: string;
  /** Marks the child as a spawned window so it does not create its own tray. */
  extraArgs?: string[];
}

/**
 * Opens a second Ensemble window: seed a fresh directory from this one, then
 * launch a detached child against it. Used by the in-app menu entry and by the
 * duplicate-launch path — a second start of the app while one is running is
 * just another way of saying "new window".
 */
export function launchSpawnedWindow(options: SpawnWindowOptions): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Sibling of the source directory, so the whole family stays together no
  // matter where the primary's user-data directory actually lives.
  const dir = join(
    dirname(options.sourceUserData),
    `${basename(options.sourceUserData)}-windows`,
    `window-${stamp}`,
  );
  seedSpawnedWindow(options.sourceUserData, dir);
  const child = spawn(
    options.execPath,
    [...(options.appPath ? [options.appPath] : []), ...(options.extraArgs ?? []), `--user-data-dir=${dir}`],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/** One live spawned window, as the tray sees it. */
export interface SpawnedWindowEntry {
  /** The window's own user-data directory. */
  dir: string;
  /** The pid that holds the directory's instance lock — the window's process. */
  pid: number;
  /** Creation time parsed back out of the directory's `window-<ISO>` stamp. */
  createdAt: string;
}

/**
 * Lists the spawned windows that are still alive, for the tray's window list.
 *
 * Every spawned window holds a singleton lock inside its own directory, and the
 * lock records its pid — which is everything needed to enumerate them from the
 * outside: the directory name carries the creation time, the lockfile carries
 * the pid, and a pid that answers `kill(pid, 0)` is a window still running.
 * No registry file, no handshake: the filesystem is the registry, written by
 * exactly the process that owns each entry.
 */
export function listSpawnedWindows(
  windowsRoot: string,
  options?: { processAlive?: (pid: number) => boolean },
): SpawnedWindowEntry[] {
  const alive = options?.processAlive ?? isProcessAlive;
  let names: string[];
  try {
    names = readdirSync(windowsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("window-"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const entries: SpawnedWindowEntry[] = [];
  for (const name of names) {
    const dir = join(windowsRoot, name);
    const holder = readSingletonLock(join(dir, "lockfile"));
    if (!holder || !alive(holder.pid)) continue;
    // `window-2026-11-21T14-01-41-358Z` — the dashes in the time part are the
    // ones this module's own stamp put there; the reverse maps them back.
    const createdAt = name.startsWith("window-") ? name.slice("window-".length).replace(/-(\d\d)-(\d\d)-(\d\d\d)Z$/, ":$1:$2.$3Z") : "";
    entries.push({ dir, pid: holder.pid, createdAt });
  }
  return entries;
}
