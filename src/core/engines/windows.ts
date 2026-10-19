import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { EngineChannel } from "@shared/types";
import {
  compareVersions,
  parseVersionOutput,
  type EngineCandidate,
  versionFromExecutablePath,
} from "./shared";

const execFileAsync = promisify(execFile);

/**
 * Chromium vendors keep every installed version as a sibling folder and launch the
 * newest one. Reading folder names is far cheaper than probing the binary, and
 * `msedge.exe --version` writes nothing on Windows.
 */
export function versionFromSiblingFolders(exePath: string): string | undefined {
  const parent = dirname(exePath);
  if (!existsSync(parent)) return undefined;
  try {
    const versions = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^\d+\.\d+\.\d+(\.\d+)?$/.test(name));
    if (versions.length === 0) return undefined;
    return versions.reduce((newest, candidate) =>
      compareVersions(candidate, newest) > 0 ? candidate : newest,
    );
  } catch {
    return undefined;
  }
}

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

  // Registry lookups spawn a process each; run them together.
  const registryHits = await Promise.all(
    REGISTRY_EXES.map(async (entry) => ({ entry, exePath: await queryAppPath(entry.exe) })),
  );

  for (const { entry, exePath } of registryHits) {
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

  // Edge and Chrome on Windows keep the executable at a fixed path, with installed
  // versions as sibling folders. The newest folder is what the launcher starts.
  // Firefox writes no output for `--version` here either, so fall back to the
  // Windows file metadata via one batched PowerShell call.
  const unresolved: EngineCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.version) continue;
    candidate.version = versionFromSiblingFolders(candidate.exePath);
    if (!candidate.version) unresolved.push(candidate);
  }

  if (unresolved.length > 0) {
    const versions = await probeFileVersions(unresolved.map((candidate) => candidate.exePath));
    for (const candidate of unresolved) {
      const version = versions.get(candidate.exePath.toLowerCase());
      if (version) candidate.version = version;
    }
  }

  return candidates;
}

/** Reads Windows PE file versions for several executables in one PowerShell call. */
export async function probeFileVersions(paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (paths.length === 0) return result;

  const list = paths.map((path) => `'${path.replace(/'/g, "''")}'`).join(",");
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-Item ${list} -ErrorAction SilentlyContinue | Select-Object FullName,@{n='V';e={$_.VersionInfo.ProductVersion}} | ConvertTo-Json -Compress`,
      ],
      { timeout: 8_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return result;
    const parsed = JSON.parse(trimmed) as
      | { FullName?: string; V?: string }
      | Array<{ FullName?: string; V?: string }>;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (!row.FullName || !row.V) continue;
      const version = parseVersionOutput(row.V);
      if (version) result.set(row.FullName.toLowerCase(), version);
    }
  } catch {
    // Version display is cosmetic; a failed probe must not break scanning.
  }
  return result;
}
