import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Rect } from "../layout/grid";
import { CdpClient } from "./client";

export interface DevToolsActivePort {
  port: number;
  browserPath: string;
}

export interface PageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserVersionInfo {
  Browser: string;
  webSocketDebuggerUrl: string;
}

export function parseDevToolsActivePort(content: string): DevToolsActivePort | undefined {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const port = Number.parseInt(lines[0] ?? "", 10);
  const browserPath = lines[1] ?? "";
  if (!Number.isInteger(port) || port <= 0 || !browserPath) return undefined;
  return { port, browserPath };
}

export async function waitForDevToolsActivePort(
  profileDir: string,
  timeoutMs = 20_000,
): Promise<DevToolsActivePort> {
  const file = join(profileDir, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const parsed = parseDevToolsActivePort(await readFile(file, "utf8"));
      if (parsed && (await portResponds(parsed.port))) return parsed;
    } catch {
      // The file appears once the browser is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(
    "Browser did not open a DevTools port. It may be blocked by enterprise policy or another process.",
  );
}

async function portResponds(port: number): Promise<boolean> {
  try {
    await fetchJson(browserVersionUrl(port), 1_500);
    return true;
  } catch {
    return false;
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 5_000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

export function browserVersionUrl(port: number): string {
  return `http://127.0.0.1:${port}/json/version`;
}

export function pageTargetsUrl(port: number): string {
  return `http://127.0.0.1:${port}/json/list`;
}

export async function readBrowserVersion(port: number): Promise<BrowserVersionInfo> {
  return fetchJson<BrowserVersionInfo>(browserVersionUrl(port));
}

export async function listPageTargets(port: number): Promise<PageTarget[]> {
  const targets = await fetchJson<PageTarget[]>(pageTargetsUrl(port));
  return targets.filter((target) => target.type === "page");
}

export async function waitForPageTarget(
  port: number,
  timeoutMs = 15_000,
  predicate: (target: PageTarget) => boolean = () => true,
): Promise<PageTarget> {
  const startedAt = Date.now();
  let lastTargets: PageTarget[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await listPageTargets(port);
      lastTargets = targets;
      const target = targets.find((item) => item.webSocketDebuggerUrl && predicate(item));
      if (target) return target;
    } catch {
      // The HTTP endpoint may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const fallback = lastTargets.find((item) => item.webSocketDebuggerUrl);
  if (fallback) return fallback;
  throw new Error("Browser did not expose a page target");
}

export async function evaluate<T>(
  client: CdpClient,
  expression: string,
  options: { awaitPromise?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const response = await client.send<{
    result: { value?: T; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? false,
    },
    { timeoutMs: options.timeoutMs ?? 20_000 },
  );

  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      "Page evaluation failed";
    throw new Error(description);
  }
  return response.result.value as T;
}

export async function navigateAndWait(
  client: CdpClient,
  url: string,
  timeoutMs = 20_000,
): Promise<void> {
  await client.send("Page.enable");
  await client.send("Page.navigate", { url });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const state = await evaluate<string>(client, "document.readyState", { timeoutMs: 3_000 });
      if (state === "complete" || state === "interactive") return;
    } catch {
      // Navigation may destroy the execution context momentarily.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Page did not become ready within ${timeoutMs}ms`);
}

export async function setWindowBounds(
  browserClient: CdpClient,
  targetId: string,
  bounds: Rect,
): Promise<void> {
  const { windowId } = await browserClient.send<{ windowId: number }>(
    "Browser.getWindowForTarget",
    { targetId },
  );
  await browserClient.send("Browser.setWindowBounds", {
    windowId,
    bounds: {
      left: Math.round(bounds.x),
      top: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      windowState: "normal",
    },
  });
}

export async function closeBrowser(browserClient: CdpClient): Promise<void> {
  try {
    await browserClient.send("Browser.close", {}, { timeoutMs: 5_000 });
  } catch {
    // The browser may close the socket before replying.
  }
}
