import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { EngineChannel, EngineFamily } from "@shared/types";
import { parseVersionOutput, type EngineCandidate } from "./shared";

const execFileAsync = promisify(execFile);

interface LinuxBinary {
  name: string;
  brand: string;
  channel: EngineChannel;
  family: EngineFamily;
}

const BINARIES: LinuxBinary[] = [
  { name: "google-chrome-stable", brand: "Google Chrome", channel: "stable", family: "chromium" },
  { name: "google-chrome-beta", brand: "Google Chrome Beta", channel: "beta", family: "chromium" },
  { name: "google-chrome-unstable", brand: "Google Chrome Dev", channel: "dev", family: "chromium" },
  { name: "chromium", brand: "Chromium", channel: "stable", family: "chromium" },
  { name: "chromium-browser", brand: "Chromium", channel: "stable", family: "chromium" },
  { name: "microsoft-edge-stable", brand: "Microsoft Edge", channel: "stable", family: "chromium" },
  { name: "microsoft-edge-beta", brand: "Microsoft Edge Beta", channel: "beta", family: "chromium" },
  { name: "brave-browser", brand: "Brave", channel: "stable", family: "chromium" },
  { name: "vivaldi-stable", brand: "Vivaldi", channel: "stable", family: "chromium" },
  { name: "firefox", brand: "Firefox", channel: "stable", family: "firefox" },
  { name: "firefox-esr", brand: "Firefox ESR", channel: "stable", family: "firefox" },
];

const FLATPAK_APPS: Record<
  string,
  { brand: string; family: EngineFamily; channel: EngineChannel }
> = {
  "com.google.Chrome": { brand: "Google Chrome", family: "chromium", channel: "stable" },
  "com.google.ChromeBeta": { brand: "Google Chrome Beta", family: "chromium", channel: "beta" },
  "com.microsoft.Edge": { brand: "Microsoft Edge", family: "chromium", channel: "stable" },
  "com.brave.Browser": { brand: "Brave", family: "chromium", channel: "stable" },
  "org.chromium.Chromium": { brand: "Chromium", family: "chromium", channel: "stable" },
  "com.vivaldi.Vivaldi": { brand: "Vivaldi", family: "chromium", channel: "stable" },
  "org.mozilla.firefox": { brand: "Firefox", family: "firefox", channel: "stable" },
};

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutableInPath(
  name: string,
  pathValue: string | undefined,
  isExecutable: (path: string) => boolean = isExecutableFile,
): string | undefined {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function probeLinuxVersion(
  exePath: string,
  launchArgs: string[] = [],
): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(exePath, [...launchArgs, "--version"], {
      timeout: 4000,
    });
    return parseVersionOutput(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

async function scanFlatpak(home: string): Promise<EngineCandidate[]> {
  let stdout: string;
  try {
    const result = await execFileAsync("flatpak", ["list", "--app", "--columns=application"], {
      timeout: 5000,
    });
    stdout = result.stdout;
  } catch {
    return [];
  }

  const flatpakBin = existsSync("/usr/bin/flatpak") ? "/usr/bin/flatpak" : "flatpak";
  const candidates: EngineCandidate[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const appId = line.trim();
    const app = FLATPAK_APPS[appId];
    if (!appId || !app) continue;
    candidates.push({
      family: app.family,
      brand: app.brand,
      channel: app.channel,
      exePath: flatpakBin,
      source: "flatpak",
      launchArgs: ["run", appId],
      profileBase: join(home, ".var", "app", appId, "ensemble"),
      cdp: app.family === "chromium",
    });
  }
  return candidates;
}

export async function scanLinux(env: NodeJS.ProcessEnv = process.env): Promise<EngineCandidate[]> {
  const pathValue = env.PATH;
  const home = env.HOME ?? homedir();
  const candidates: EngineCandidate[] = [];
  const seen = new Set<string>();

  for (const binary of BINARIES) {
    const exePath = findExecutableInPath(binary.name, pathValue);
    if (!exePath || seen.has(exePath)) continue;
    seen.add(exePath);
    const version = await probeLinuxVersion(exePath);
    candidates.push({
      family: binary.family,
      brand: binary.brand,
      channel: binary.channel,
      exePath,
      source: "path",
      version,
      cdp: binary.family === "chromium",
    });
  }

  const snapChromium = "/snap/bin/chromium";
  if (isExecutableFile(snapChromium) && !seen.has(snapChromium)) {
    seen.add(snapChromium);
    candidates.push({
      family: "chromium",
      brand: "Chromium (Snap)",
      channel: "stable",
      exePath: snapChromium,
      source: "snap",
      profileBase: join(home, "snap", "chromium", "common", "ensemble"),
      cdp: true,
      version: await probeLinuxVersion(snapChromium),
    });
  }

  const snapFirefox = "/snap/bin/firefox";
  if (isExecutableFile(snapFirefox) && !seen.has(snapFirefox)) {
    seen.add(snapFirefox);
    candidates.push({
      family: "firefox",
      brand: "Firefox (Snap)",
      channel: "stable",
      exePath: snapFirefox,
      source: "snap",
      profileBase: join(home, "snap", "firefox", "common", "ensemble"),
      cdp: false,
      version: await probeLinuxVersion(snapFirefox),
    });
  }

  candidates.push(...(await scanFlatpak(home)));
  return candidates;
}
