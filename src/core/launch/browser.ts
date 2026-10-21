import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Engine, RunningInstance } from "@shared/types";
import { CdpClient } from "../cdp/client";
import {
  readBrowserVersion,
  setWindowBounds,
  waitForDevToolsActivePort,
  waitForPageTarget,
} from "../cdp/browser";
import type { Rect } from "../layout/grid";
import { buildChromiumArgs, buildFirefoxArgs, safeProfileSegment } from "./args";

export interface LaunchRequest {
  environmentId: string;
  profileRoot: string;
  engine: Engine;
  profileKey: string;
  startUrl: string;
  windowBounds?: Rect;
  label: string;
  identityId?: string;
  clean?: boolean;
  instanceId: string;
}

export interface LaunchOutcome {
  instance: RunningInstance;
  child: ChildProcess;
  pageCdp?: CdpClient;
  browserCdp?: CdpClient;
  targetId?: string;
  /**
   * Resolves when the browser goes away on its own — the user closed the last
   * window, or the process crashed. The caller uses it to drop the instance from
   * the UI instead of showing a window that no longer exists.
   */
  exited: Promise<void>;
}

interface CdpEntry {
  page: CdpClient;
  browser: CdpClient;
}

class CdpRegistry {
  private readonly byInstance = new Map<string, CdpEntry>();

  set(instanceId: string, entry: CdpEntry): void {
    this.byInstance.set(instanceId, entry);
  }

  get(instanceId: string): CdpEntry | undefined {
    return this.byInstance.get(instanceId);
  }

  delete(instanceId: string): void {
    this.byInstance.delete(instanceId);
  }
}

export const cdpRegistry = new CdpRegistry();

export function instanceProfileDir(
  profileRoot: string,
  environmentId: string,
  key: string,
): string {
  return join(profileRoot, safeProfileSegment(environmentId), safeProfileSegment(key));
}

export function resolveProfileRoot(engine: Engine, profileRoot: string): string {
  return engine.profileBase ?? profileRoot;
}

function spawnBrowser(engine: Engine, args: string[]): ChildProcess {
  const finalArgs = engine.launchArgs ? [...engine.launchArgs, ...args] : args;
  const child = spawn(engine.exePath, finalArgs, {
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });
  if (!child.pid) {
    throw new Error(`Failed to start ${engine.brand}`);
  }
  child.unref();
  return child;
}

/**
 * Launches in progress, keyed by profile directory. A double click, a scene
 * start racing a manual launch, or an AI call landing at the same moment would
 * otherwise spawn a second process for the same profile: Chromium then forwards
 * its URL to the running instance as an extra tab and the second launch fails
 * after the DevTools timeout.
 */
const inFlightLaunches = new Map<string, Promise<LaunchOutcome>>();

export function launchBrowser(request: LaunchRequest): Promise<LaunchOutcome> {
  const { engine } = request;
  const profileRoot = resolveProfileRoot(engine, request.profileRoot);
  const profileDir = instanceProfileDir(profileRoot, request.environmentId, request.profileKey);

  const pending = inFlightLaunches.get(profileDir);
  if (pending) return pending;

  const job = launchBrowserNow(request, profileDir);
  inFlightLaunches.set(profileDir, job);
  void job
    .finally(() => {
      if (inFlightLaunches.get(profileDir) === job) inFlightLaunches.delete(profileDir);
    })
    // The caller owns the rejection; this only keeps the cleanup chain quiet.
    .catch(() => {});
  return job;
}

async function launchBrowserNow(
  request: LaunchRequest,
  profileDir: string,
): Promise<LaunchOutcome> {
  const { engine } = request;
  await mkdir(profileDir, { recursive: true });

  if (engine.family === "webkit") {
    throw new Error(engine.blockReason ?? "WebKit engines are not supported");
  }
  if (!existsSync(engine.exePath)) {
    throw new Error(`${engine.brand} 的可执行文件已不存在，请重新扫描引擎`);
  }

  if (engine.family === "firefox") {
    const child = spawnBrowser(
      engine,
      buildFirefoxArgs({ profileDir, startUrl: request.startUrl }),
    );
    return {
      child,
      instance: buildInstance(request, engine, profileDir, child.pid as number, "external"),
      exited: waitForChildExit(child),
    };
  }

  return launchChromium(request, profileDir);
}

/**
 * Chromium remembers "Continue where you left off" in the profile. When that is
 * on, a launch with a URL restores the old session *and* opens the URL, which
 * shows up as two identical tabs. These profiles are managed entirely by
 * Ensemble, so the startup mode is pinned to "new tab page": the only page that
 * opens is the URL passed on this launch.
 */
export async function pinStartupMode(profileDir: string): Promise<void> {
  const defaultDir = join(profileDir, "Default");
  const file = join(defaultDir, "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      prefs = parsed as Record<string, unknown>;
    }
  } catch {
    // A missing or half-written Preferences file is normal on a fresh profile.
  }
  const session =
    prefs["session"] && typeof prefs["session"] === "object"
      ? (prefs["session"] as Record<string, unknown>)
      : {};
  if (session["restore_on_startup"] === 5) return;
  await mkdir(defaultDir, { recursive: true });
  prefs["session"] = { ...session, restore_on_startup: 5 };
  await writeFile(file, JSON.stringify(prefs), { mode: 0o600 });
}

async function launchChromium(request: LaunchRequest, profileDir: string): Promise<LaunchOutcome> {
  const { engine } = request;
  // A previous run may have left a stale DevToolsActivePort behind; reading it would
  // point us at a dead port and make the launch fail with "fetch failed".
  await rm(join(profileDir, "DevToolsActivePort"), { force: true });
  // Must happen before the browser starts: Chromium rewrites Preferences on exit.
  await pinStartupMode(profileDir).catch(() => {
    // An unreadable profile only risks an extra restored tab, never a dead launch.
  });
  const child = spawnBrowser(
    engine,
    buildChromiumArgs({
      profileDir,
      startUrl: request.startUrl,
      windowBounds: request.windowBounds,
    }),
  );

  try {
    const { port } = await waitForDevToolsActivePort(profileDir);
    const version = await readBrowserVersion(port);
    const browser = await CdpClient.connect(version.webSocketDebuggerUrl);

    // Prefer the real page over the initial about:blank target. A clean session
    // that deliberately opens a blank tab would never satisfy that predicate, so
    // skip the wait in that case instead of stalling for the full timeout.
    const blankStart = /^about:blank$/i.test(request.startUrl);
    const target = blankStart
      ? await waitForPageTarget(port)
      : await waitForPageTarget(port, 15_000, (item) => item.url !== "about:blank").catch(() =>
          waitForPageTarget(port),
        );

    const page = await CdpClient.connect(target.webSocketDebuggerUrl as string);
    if (request.windowBounds) {
      await setWindowBounds(browser, target.id, request.windowBounds).catch(() => {
        // Wayland ignores absolute positioning; the window still opens.
      });
    }

    cdpRegistry.set(request.instanceId, { page, browser });
    const pid = await resolveBrowserPid(browser, child.pid as number);
    const instance = buildInstance(request, engine, profileDir, pid, "cdp");
    instance.cdpPort = port;
    instance.targetId = target.id;
    return {
      child,
      pageCdp: page,
      browserCdp: browser,
      targetId: target.id,
      instance,
      // The browser-level socket outlives individual pages, so it is the best
      // signal that the whole browser is gone.
      exited: waitForBrowserExit(browser, page),
    };
  } catch (error) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    throw new Error(
      `启动 ${engine.brand} 失败：${(error as Error).message}。若浏览器被企业策略禁用远程调试，请改用外部模式。`,
    );
  }
}

/**
 * The process we spawned is not always the browser: Edge and Chrome relaunch
 * themselves through a compat layer and let the launcher exit immediately, so
 * `child.pid` can be dead before the window appears. CDP knows the real browser
 * process, which is what a forced kill needs.
 */
export async function resolveBrowserPid(browser: CdpClient, fallback: number): Promise<number> {
  try {
    const result = await browser.send<{ processInfo?: Array<{ type: string; id: number }> }>(
      "SystemInfo.getProcessInfo",
      {},
      { timeoutMs: 3_000 },
    );
    return result.processInfo?.find((item) => item.type === "browser")?.id ?? fallback;
  } catch {
    return fallback;
  }
}

function buildInstance(
  request: LaunchRequest,
  engine: Engine,
  profileDir: string,
  pid: number,
  mode: RunningInstance["mode"],
): RunningInstance {
  return {
    id: request.instanceId,
    identityId: request.identityId,
    label: request.label,
    environmentId: request.environmentId,
    engineId: engine.id,
    pid,
    profileDir,
    mode,
    startedAt: new Date().toISOString(),
    clean: request.clean,
  };
}

/**
 * Resolves once the spawned process exits. Firefox keeps the launched process
 * alive for the whole session, so its exit is a trustworthy signal.
 */
function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

/**
 * Detects a Chromium browser that went away on its own.
 *
 * The spawned process is useless as a signal on Windows: when the browser is
 * already running with another profile, the launcher exits immediately after
 * handing the URL over. The CDP sockets stay open for exactly as long as the
 * browser lives, so they are the reliable signal — browser level first, page
 * level as a fallback.
 */
function waitForBrowserExit(browser: CdpClient, page: CdpClient): Promise<void> {
  let settled = false;
  let unsubscribeBrowser = () => {};
  let unsubscribePage = () => {};

  return new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribeBrowser();
      unsubscribePage();
      resolve();
    };

    if (browser.isClosed || page.isClosed) {
      resolve();
      return;
    }
    unsubscribeBrowser = browser.onClose(finish);
    unsubscribePage = page.onClose(finish);
  });
}

export async function stopInstances(
  instances: RunningInstance[],
  timeoutMs = 3_000,
): Promise<void> {
  await Promise.all(
    instances.map(async (instance) => {
      const entry = cdpRegistry.get(instance.id);
      let graceful = false;
      if (entry) {
        try {
          await entry.browser.send("Browser.close", {}, { timeoutMs });
          graceful = true;
        } catch {
          // Fall through to a PID based kill.
        }
        entry.page.close();
        entry.browser.close();
        cdpRegistry.delete(instance.id);
      }
      // Browser.close is a graceful request; the process still has to flush the
      // profile on its way out — cookies written into the cookie DB, preferences,
      // local storage. Killing it immediately skips that flush, and on Windows a
      // SIGTERM is in fact an immediate termination, so a profile stopped this way
      // silently loses the login state a background check would need later.
      if (graceful) await waitForProcessExit(instance.pid, EXIT_GRACE_MS);
      await killIfAlive(instance.pid, timeoutMs);
    }),
  );
}

/** How long a browser may take to finish exiting on its own after Browser.close. */
const EXIT_GRACE_MS = 2_500;

/** Waits for the process to disappear, returning false when the deadline passes. */
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return false;
}

export async function closeInstanceCdp(instanceId: string): Promise<void> {
  const entry = cdpRegistry.get(instanceId);
  if (!entry) return;
  try {
    await entry.browser.send("Browser.close", {});
  } catch {
    // ignore
  }
  entry.page.close();
  entry.browser.close();
  cdpRegistry.delete(instanceId);
}

async function killIfAlive(pid: number, timeoutMs: number): Promise<void> {
  if (!pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  try {
    if (process.platform === "win32") {
      const { execFile } = await import("node:child_process");
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {});
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // ignore
  }
}
