import type { Engine, Platform } from "@shared/types";
import { scanLinux } from "./linux";
import { scanMac } from "./macos";
import {
  dedupeEngines,
  detectBrandFromPath,
  detectFamilyFromPath,
  type EngineCandidate,
  materializeEngine,
  sortEngines,
} from "./shared";
import { scanWindows } from "./windows";

export async function scanEngines(
  platform: Platform = process.platform as Platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Engine[]> {
  let candidates: EngineCandidate[] = [];
  if (platform === "win32") {
    candidates = await scanWindows(env);
  } else if (platform === "darwin") {
    candidates = await scanMac(env);
  } else {
    candidates = await scanLinux(env);
  }

  const engines = candidates.map((candidate) =>
    materializeEngine(candidate, {
      cdp: candidate.cdp ?? candidate.family === "chromium",
      version: candidate.version,
      status: candidate.status,
      blockReason: candidate.blockReason,
    }),
  );
  return sortEngines(dedupeEngines(engines));
}

export function candidateFromManualPath(exePath: string): EngineCandidate {
  const family = detectFamilyFromPath(exePath) ?? "chromium";
  return {
    family,
    brand: detectBrandFromPath(exePath),
    channel: "stable",
    exePath,
    source: "manual",
    cdp: family === "chromium",
  };
}

export function mergeManualEngines(engines: Engine[], manualPaths: string[]): Engine[] {
  const manual = manualPaths.map((exePath) =>
    materializeEngine(candidateFromManualPath(exePath), {
      cdp: detectFamilyFromPath(exePath) === "chromium",
    }),
  );
  const manualByPath = new Map(manual.map((engine) => [engine.exePath.toLowerCase(), engine]));
  const merged = engines.map((engine) => manualByPath.get(engine.exePath.toLowerCase()) ?? engine);
  const known = new Set(merged.map((engine) => engine.exePath.toLowerCase()));
  for (const engine of manual) {
    if (!known.has(engine.exePath.toLowerCase())) merged.push(engine);
  }
  return sortEngines(dedupeEngines(merged));
}
