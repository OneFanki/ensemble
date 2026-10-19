import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Engine, EngineChannel, EngineFamily, EngineSource } from "@shared/types";

export interface EngineCandidate {
  family: EngineFamily;
  brand: string;
  channel: EngineChannel;
  exePath: string;
  source: EngineSource;
  launchArgs?: string[];
  profileBase?: string;
  version?: string;
  cdp?: boolean;
  status?: Engine["status"];
  blockReason?: string;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function makeEngineId(candidate: EngineCandidate): string {
  return `${candidate.family}:${slugify(candidate.brand)}:${candidate.channel}`;
}

export function parseVersionOutput(output: string): string | undefined {
  const match = output.match(/(\d+\.\d+(?:\.\d+){0,2})/);
  return match?.[1];
}

export function versionFromExecutablePath(exePath: string): string | undefined {
  const parent = basename(dirname(exePath));
  return /^\d+\.\d+(?:\.\d+){0,2}$/.test(parent) ? parent : undefined;
}

export function detectFamilyFromPath(exePath: string): EngineFamily | undefined {
  const name = basename(exePath).toLowerCase();
  if (name.includes("firefox")) return "firefox";
  if (
    name.includes("chrome") ||
    name.includes("msedge") ||
    name.includes("brave") ||
    name.includes("vivaldi") ||
    name.includes("chromium")
  ) {
    return "chromium";
  }
  return undefined;
}

export function detectBrandFromPath(exePath: string): string {
  const name = basename(exePath).toLowerCase();
  if (name.includes("msedge")) return "Microsoft Edge";
  if (name.includes("chrome-beta")) return "Google Chrome Beta";
  if (name.includes("chrome-dev")) return "Google Chrome Dev";
  if (name.includes("chrome")) return "Google Chrome";
  if (name.includes("brave")) return "Brave";
  if (name.includes("vivaldi")) return "Vivaldi";
  if (name.includes("chromium")) return "Chromium";
  if (name.includes("firefox")) return "Firefox";
  return basename(exePath);
}

export function dedupeEngines(engines: Engine[]): Engine[] {
  const seen = new Map<string, Engine>();
  for (const engine of engines) {
    const key = engine.exePath.toLowerCase();
    const existing = seen.get(key);
    if (!existing || existing.source !== "manual") {
      seen.set(key, engine);
    }
  }
  return [...seen.values()];
}

const BRAND_ORDER = [
  "microsoft edge",
  "google chrome",
  "brave",
  "chromium",
  "vivaldi",
  "firefox",
  "safari",
];

const CHANNEL_ORDER: Record<EngineChannel, number> = {
  stable: 0,
  beta: 1,
  dev: 2,
  canary: 3,
};

export function sortEngines(engines: Engine[]): Engine[] {
  return [...engines].sort((a, b) => {
    const familyRank = (family: EngineFamily) => (family === "chromium" ? 0 : family === "firefox" ? 1 : 2);
    const familyDiff = familyRank(a.family) - familyRank(b.family);
    if (familyDiff !== 0) return familyDiff;
    const brandA = BRAND_ORDER.findIndex((prefix) => a.brand.toLowerCase().startsWith(prefix));
    const brandB = BRAND_ORDER.findIndex((prefix) => b.brand.toLowerCase().startsWith(prefix));
    if (brandA !== brandB) return (brandA < 0 ? 99 : brandA) - (brandB < 0 ? 99 : brandB);
    return CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel];
  });
}

export function materializeEngine(
  candidate: EngineCandidate,
  options: { version?: string; cdp: boolean; status?: Engine["status"]; blockReason?: string } = {
    cdp: candidate.cdp ?? candidate.family === "chromium",
  },
): Engine {
  return {
    id: makeEngineId(candidate),
    family: candidate.family,
    brand: candidate.brand,
    channel: candidate.channel,
    exePath: candidate.exePath,
    version: options.version ?? candidate.version ?? versionFromExecutablePath(candidate.exePath),
    source: candidate.source,
    cdp: options.cdp,
    status:
      options.status ??
      candidate.status ??
      (candidate.family === "webkit" ? "blocked" : "ready"),
    ...(options.blockReason ?? candidate.blockReason
      ? { blockReason: options.blockReason ?? candidate.blockReason }
      : {}),
    ...(candidate.launchArgs ? { launchArgs: candidate.launchArgs } : {}),
    ...(candidate.profileBase ? { profileBase: candidate.profileBase } : {}),
  };
}

export function executableExists(path: string): boolean {
  return existsSync(path);
}
