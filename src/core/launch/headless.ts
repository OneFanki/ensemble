import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings, Engine } from "@shared/types";
import { CdpClient } from "../cdp/client";
import { readBrowserVersion, waitForDevToolsActivePort, waitForPageTarget } from "../cdp/browser";
import { buildChromiumArgs, safeProfileSegment } from "./args";
import { resolveBrowserPid, waitForProcessExit } from "./browser";

/**
 * A short-lived, windowless browser session over an existing profile.
 *
 * Session checks need the profile's cookies, and only one process can own a
 * Chromium profile at a time. So this path serves exactly the case where no
 * window is open for that identity: launch headless against its profile, read the
 * answer, shut down. Nothing is registered as a running instance — no overlay
 * row, no view slot, no window the user has to close.
 *
 * Measured on Windows: ~380ms against ~2s for a visible window, and the login
 * state comes from the same cookies a real visit uses. One honest limitation:
 * Chromium deletes cookies without an expiry when the browser exits (measured
 * against the real engine), and this app deliberately disables session restore,
 * so a site that only uses session cookies reads as expired once the window is
 * closed. That is not a false negative — reopening the window would show the
 * same logged-out state.
 */
export interface HeadlessSessionRequest {
  engine: Engine;
  profileRoot: string;
  siteId: string;
  profileKey: string;
  /** UA the page should report; see AppSettings.headlessCheckUa. */
  userAgent: AppSettings["headlessCheckUa"];
  /** Hard ceiling for the whole session, launch included. */
  timeoutMs?: number;
}

export interface HeadlessSession {
  page: CdpClient;
  browser: CdpClient;
  /** Closes the browser and waits for its process to go away. */
  close(): Promise<void>;
}

/** Browsers that cannot be driven over CDP cannot be checked this way. */
export function supportsHeadlessSession(engine: Engine): boolean {
  return engine.family === "chromium" && engine.cdp === true && engine.status !== "blocked";
}

/**
 * Turns Chromium's headless UA into the one its visible build reports.
 *
 * The only difference is the product token: `HeadlessChrome/155.0` becomes
 * `Chrome/155.0`, with the engine's own brand suffix (`Edg/…` or `OPR/…`)
 * untouched. Nothing else in the string is rewritten, so the result is exactly
 * what the user's own browser sends.
 */
export function desktopUserAgent(headlessUa: string): string {
  return headlessUa.replace("HeadlessChrome/", "Chrome/");
}

export async function openHeadlessSession(
  request: HeadlessSessionRequest,
): Promise<HeadlessSession> {
  const { engine } = request;
  if (!supportsHeadlessSession(engine)) {
    throw new Error(`${engine.brand} 无法用于后台检测`);
  }
  if (!existsSync(engine.exePath)) {
    throw new Error(`${engine.brand} 的可执行文件已不存在，请重新扫描引擎`);
  }

  const profileRoot = engine.profileBase ?? request.profileRoot;
  const profileDir = join(
    profileRoot,
    safeProfileSegment(request.siteId),
    safeProfileSegment(request.profileKey),
  );
  await mkdir(profileDir, { recursive: true });
  // A stale port file from an earlier run would point at a dead socket.
  await rm(join(profileDir, "DevToolsActivePort"), { force: true });

  const child = spawn(
    engine.exePath,
    [
      ...(engine.launchArgs ?? []),
      ...buildChromiumArgs({
        profileDir,
        // Start on about:blank: the UA override has to be in place before the
        // first request that reaches the site under test.
        startUrl: "about:blank",
        headless: true,
      }),
    ],
    { detached: false, stdio: "ignore", windowsHide: true },
  );
  if (!child.pid) throw new Error(`Failed to start ${engine.brand}`);

  const timeoutMs = request.timeoutMs ?? 25_000;
  const deadline = Date.now() + timeoutMs;
  let browser: CdpClient | undefined;
  let page: CdpClient | undefined;
  // Edge and Chrome relaunch themselves through a compat layer, so the spawned
  // pid can be a launcher that is already gone. CDP knows the real one, and that
  // is what the shutdown below has to wait for.
  let browserPid = child.pid;

  const close = async () => {
    try {
      await browser?.send("Browser.close", {}, { timeoutMs: 2_000 });
    } catch {
      // Force-killed below.
    }
    page?.close();
    browser?.close();
    await stopProcessTree(browserPid, 2_500);
  };

  try {
    const { port } = await waitForDevToolsActivePort(profileDir, Math.min(15_000, timeoutMs));
    const target = await waitForPageTarget(port, Math.max(3_000, deadline - Date.now()));
    const version = await readBrowserVersion(port);
    browser = await CdpClient.connect(version.webSocketDebuggerUrl);
    page = await CdpClient.connect(target.webSocketDebuggerUrl as string);
    browserPid = await resolveBrowserPid(browser, child.pid);

    if (request.userAgent === "desktop") {
      // Browser.getVersion reports the UA this build would send; strip the
      // headless product token and hand it back through the same override a
      // user sets in devtools.
      const identity = await browser.send<{ userAgent?: string }>("Browser.getVersion", {});
      const desktop = desktopUserAgent(identity.userAgent ?? "");
      if (desktop) {
        await page
          .send("Emulation.setUserAgentOverride", { userAgent: desktop })
          .catch(() => {
            // A browser that refuses the override still gets checked; the site
            // only sees a different UA string.
          });
      }
    }

    return { page, browser, close };
  } catch (error) {
    await close();
    throw new Error(`后台检测启动 ${engine.brand} 失败：${(error as Error).message}`);
  }
}

function stopProcessTree(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    void (async () => {
      // Browser.close was already sent. Give the process time to finish writing
      // its profile — the check may have refreshed a cookie, and a kill in the
      // middle of that write is how a profile loses its login state.
      if (await waitForProcessExit(pid, timeoutMs)) return resolve();
      // Chromium's helper processes outlive a plain kill on Windows.
      try {
        spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      } catch {
        // Best effort; the tree is already detached from us.
      }
      resolve();
    })();
  });
}
