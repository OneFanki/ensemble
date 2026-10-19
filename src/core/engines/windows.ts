import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { EngineChannel } from "@shared/types";
import { parseVersionOutput, type EngineCandidate, versionFromExecutablePath } from "./shared";

const execFileAsync = promisify(execFile);

interface WindowsApp {
  relPath: string;
  brand: string;
  channel: EngineChannel;
  family: "chromium" | "firefox";
}

const APPS: WindowsApp[] = [
  {
    relPath: "Microsoft\\Edge\\Application\\msedge.exe",
    brand: "Microsoft Edge",
    channel: "stable",
    family: "chromium",
  },
  {
    relPath: "Microsoft\\Edge Beta\\Application\\msedge.exe",
    brand: "Microsoft Edge Beta",
    channel: "beta",
    family: "chromium",
  },
  {
    relPath: "Microsoft\\Edge Dev\\Application\\msedge.exe",
    brand: "Microsoft Edge Dev",
    channel: "dev",
    family: "chromium",
  },
  {
    relPath: "Google\\Chrome\\Application\\chrome.exe",
    brand: "Google Chrome",
    channel: "stable",
    family: "chromium",
  },
  {
    relPath: "Google\\Chrome Beta\\Application\\chrome.exe",
    brand: "Google Chrome Beta",
    channel: "beta",
    family: "chromium",
  },
  {
    relPath: "Google\\Chrome Dev\\Application\\chrome.exe",
    brand: "Google Chrome Dev",
    channel: "dev",
    family: "chromium",
  },
  {
    relPath: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    brand: "Brave",
    channel: "stable",
    family: "chromium",
  },
  {
    relPath: "Vivaldi\\Application\\vivaldi.exe",
    brand: "Vivaldi",
    channel: "stable",
    family: "chromium",
  },
  {
    relPath: "Chromium\\Application\\chrome.exe",
    brand: "Chromium",
    channel: "stable",
    family: "chromium",
  },
  {
    relPath: "Mozilla Firefox\\firefox.exe",
    brand: "Firefox",
    channel: "stable",
    family: "firefox",
  },
];

const REGISTRY_EXES: Array<{ exe: string; brand: string; family: "chromium" | "firefox" }> = [
  { exe: "msedge.exe", brand: "Microsoft Edge", family: "chromium" },
  { exe: "chrome.exe", brand: "Google Chrome", family: "chromium" },
  { exe: "brave.exe", brand: "Brave", family: "chromium" },
  { exe: "vivaldi.exe", brand: "Vivaldi", family: "chromium" },
  { exe: "firefox.exe", brand: "Firefox", family: "firefox" },
];

export function parseRegQueryValue(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/REG_SZ\s+(.+?)\s*$/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function queryAppPath(exe: string): Promise<string | undefined> {
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync("reg", ["query", key, "/ve"], {
        timeout: 2500,
        windowsHide: true,
      });
      const value = parseRegQueryValue(stdout);
      if (value && existsSync(value)) return value;
    } catch {
      // Key missing is the normal case for most browsers.
    }
  }
  return undefined;
}

export async function scanWindows(env: NodeJS.ProcessEnv = process.env): Promise<EngineCandidate[]> {
  const roots = [
    env["PROGRAMFILES"],
    env["PROGRAMFILES(X86)"],
    env["LOCALAPPDATA"],
    env["LOCALAPPDATA"] ? `${env["LOCALAPPDATA"]}\\Programs` : undefined,
  ].filter((root): root is string => Boolean(root));

  const candidates: EngineCandidate[] = [];
  for (const root of roots) {
    for (const app of APPS) {
      const exePath = `${root}\\${app.relPath}`;
      if (!existsSync(exePath)) continue;
      candidates.push({
        family: app.family,
        brand: app.brand,
        channel: app.channel,
        exePath,
        source: "standard",
        version: versionFromExecutablePath(exePath),
        cdp: app.family === "chromium",
      });
    }
  }

  for (const entry of REGISTRY_EXES) {
    const exePath = await queryAppPath(entry.exe);
    if (!exePath) continue;
    if (candidates.some((candidate) => candidate.exePath.toLowerCase() === exePath.toLowerCase())) {
      continue;
    }
    candidates.push({
      family: entry.family,
      brand: entry.brand,
      channel: "stable",
      exePath,
      source: "registry",
      version: versionFromExecutablePath(exePath),
      cdp: entry.family === "chromium",
    });
  }

  return candidates;
}

/** Fallback version probe for engines whose install path does not contain a version. */
export async function probeWindowsVersion(exePath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(exePath, ["--version"], {
      timeout: 4000,
      windowsHide: true,
    });
    return parseVersionOutput(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}
