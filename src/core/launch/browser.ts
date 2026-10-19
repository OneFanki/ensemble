import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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

export async function launchBrowser(request: LaunchRequest): Promise<LaunchOutcome> {
  const { engine } = request;
  const profileRoot = resolveProfileRoot(engine, request.profileRoot);
  const profileDir = instanceProfileDir(profileRoot, request.environmentId, request.profileKey);
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

async function launchChromium(request: LaunchRequest, profileDir: string): Promise<LaunchOutcome> {
  const { engine } = request;
  // A previous run may have left a stale DevToolsActivePort behind; reading it would
  // point us at a dead port and make the launch fail with "fetch failed".
  await rm(join(profileDir, "DevToolsActivePort"), { force: true });
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
async function resolveBrowserPid(browser: CdpClient, fallback: number): Promise<number> {
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
      if (entry) {
        try {
          await entry.browser.send("Browser.close", {}, { timeoutMs });
        } catch {
          // Fall through to a PID based kill.
        }
        entry.page.close();
        entry.browser.close();
        cdpRegistry.delete(instance.id);
      }
      await killIfAlive(instance.pid, timeoutMs);
    }),
  );
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
