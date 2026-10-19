import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EngineChannel, EngineFamily } from "@shared/types";
import type { EngineCandidate } from "./shared";

const execFileAsync = promisify(execFile);

interface MacApp {
  name: string;
  brand: string;
  channel: EngineChannel;
  family: EngineFamily;
  cdp: boolean;
  status?: "blocked";
  blockReason?: string;
}

const APPS: MacApp[] = [
  { name: "Google Chrome", brand: "Google Chrome", channel: "stable", family: "chromium", cdp: true },
  {
    name: "Google Chrome Beta",
    brand: "Google Chrome Beta",
    channel: "beta",
    family: "chromium",
    cdp: true,
  },
  {
    name: "Microsoft Edge",
    brand: "Microsoft Edge",
    channel: "stable",
    family: "chromium",
    cdp: true,
  },
  { name: "Brave Browser", brand: "Brave", channel: "stable", family: "chromium", cdp: true },
  { name: "Vivaldi", brand: "Vivaldi", channel: "stable", family: "chromium", cdp: true },
  { name: "Chromium", brand: "Chromium", channel: "stable", family: "chromium", cdp: true },
  { name: "Firefox", brand: "Firefox", channel: "stable", family: "firefox", cdp: false },
  {
    name: "Safari",
    brand: "Safari",
    channel: "stable",
    family: "webkit",
    cdp: false,
    status: "blocked",
    blockReason: "Safari 没有独立的 profile 目录模型，无法多账号隔离",
  },
];

export function macAppExecutable(appDir: string, appName: string): string {
  return join(appDir, `${appName}.app`, "Contents", "MacOS", appName);
}

export async function readMacBundleVersion(executable: string): Promise<string | undefined> {
  const contents = join(executable, "..", "..", "..");
  const plist = join(contents, "Info.plist");
  if (!existsSync(plist)) return undefined;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist],
      { timeout: 2500 },
    );
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function scanMac(env: NodeJS.ProcessEnv = process.env): Promise<EngineCandidate[]> {
  const home = env.HOME ?? "";
  const appDirs = ["/Applications", ...(home ? [join(home, "Applications")] : [])];
  const found: Array<{ app: MacApp; exePath: string }> = [];

  for (const appDir of appDirs) {
    for (const app of APPS) {
      const exePath = macAppExecutable(appDir, app.name);
      if (existsSync(exePath)) found.push({ app, exePath });
    }
  }

  return Promise.all(
    found.map(async ({ app, exePath }) => ({
      family: app.family,
      brand: app.brand,
      channel: app.channel,
      exePath,
      source: "standard" as const,
      cdp: app.cdp,
      version: await readMacBundleVersion(exePath),
      ...(app.status ? { status: app.status, blockReason: app.blockReason } : {}),
    })),
  );
}
