import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clampSlot } from "@shared/layouts";
import type { Environment, Engine, Identity, LayoutPreset, Scene, SlotRect } from "@shared/types";

export interface StoredInstance {
  id: string;
  identityId?: string;
  environmentId: string;
  engineId: string;
  pid: number;
  profileDir: string;
  startedAt: string;
}

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

export function parseWindowsProcessList(stdout: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { ProcessId?: number; CommandLine?: string };
      if (typeof parsed.ProcessId === "number" && typeof parsed.CommandLine === "string") {
        result.push({ pid: parsed.ProcessId, commandLine: parsed.CommandLine });
      }
    } catch {
      // Skip malformed rows.
    }
  }
  return result;
}

export function profileDirFromCommandLine(commandLine: string): string | undefined {
  const match = commandLine.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i);
  return match?.[1] ?? match?.[2];
}

export function normalizeForCompare(path: string): string {
  return path
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/**
 * Ownership check used before killing anything: a profile directory counts as ours
 * only when it is exactly the root or lives beneath it. This prevents both prefix
 * collisions (profiles-copy) and accidental matches against a user's own browser.
 */
export function isOwnedProfile(profileDir: string, profileRoot: string): boolean {
  const dir = normalizeForCompare(profileDir);
  const root = normalizeForCompare(profileRoot);
  if (!root) return false;
  return dir === root || dir.startsWith(`${root}/`);
}

/**
 * Lists processes launched with a --user-data-dir pointing inside the given roots.
 * Only processes whose profile directory is under our own profile root are adopted,
 * so a normal user browser is never touched.
 */
export async function findOwnedBrowserProcesses(profileRoot: string): Promise<ProcessInfo[]> {
  const processes = await listProcesses();
  return processes.filter((entry) => {
    const profileDir = profileDirFromCommandLine(entry.commandLine);
    if (!profileDir) return false;
    return isOwnedProfile(profileDir, profileRoot);
  });
}

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve([]);
            return;
          }
          const text = stdout.trim();
          if (!text) {
            resolve([]);
            return;
          }
          try {
            const parsed = JSON.parse(text) as Array<{ ProcessId?: number; CommandLine?: string }>;
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            resolve(
              rows
                .filter(
                  (row): row is { ProcessId: number; CommandLine: string } =>
                    typeof row.ProcessId === "number" && typeof row.CommandLine === "string",
                )
                .map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine })),
            );
          } catch {
            resolve(parseWindowsProcessList(text));
          }
        },
      );
    });
  }

  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pid=,args="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const rows = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const space = line.indexOf(" ");
          if (space < 0) return undefined;
          const pid = Number.parseInt(line.slice(0, space), 10);
          if (!Number.isInteger(pid)) return undefined;
          return { pid, commandLine: line.slice(space + 1) };
        })
        .filter((row): row is ProcessInfo => Boolean(row));
      resolve(rows);
    });
  });
}

export function profileExists(profileDir: string): boolean {
  return existsSync(join(profileDir));
}

export interface WorkspaceData {
  version: 1;
  environments: Environment[];
  identities: Identity[];
  scenes: Scene[];
  instances: StoredInstance[];
  manualEngines: string[];
  layoutPresets: LayoutPreset[];
}

export interface EngineCache {
  version: 1;
  scannedAt: string;
  engines: Engine[];
}

export function emptyWorkspace(): WorkspaceData {
  return {
    version: 1,
    environments: [],
    identities: [],
    scenes: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  };
}

/** Older files stored a fixed layout key (`1x1`, `2x2`, …) on each scene. */
type LegacyScene = Partial<Scene> & { layout?: string };

function sanitizeScenes(input: unknown): Scene[] {
  if (!Array.isArray(input)) return [];
  return (input as LegacyScene[])
    .filter(
      (scene): scene is LegacyScene & { id: string; environmentId: string } =>
        typeof scene?.id === "string" && typeof scene.environmentId === "string",
    )
    .map((scene) => {
      const assignments =
        scene.slotAssignments && typeof scene.slotAssignments === "object"
          ? Object.fromEntries(
              Object.entries(scene.slotAssignments).filter(
                ([key, value]) => typeof key === "string" && Number.isInteger(value) && value >= 0,
              ),
            )
          : {};
      return {
        id: scene.id,
        environmentId: scene.environmentId,
        name: typeof scene.name === "string" ? scene.name : "",
        identityIds: Array.isArray(scene.identityIds) ? scene.identityIds : [],
        layoutId:
          typeof scene.layoutId === "string" && scene.layoutId
            ? scene.layoutId
            : typeof scene.layout === "string" && scene.layout
              ? scene.layout
              : "2x2",
        slotAssignments: assignments,
        paths: scene.paths && typeof scene.paths === "object" ? scene.paths : {},
        createdAt: scene.createdAt ?? new Date().toISOString(),
        updatedAt: scene.updatedAt ?? new Date().toISOString(),
      };
    });
}

function sanitizeLayoutPresets(input: unknown): LayoutPreset[] {
  if (!Array.isArray(input)) return [];
  const presets: LayoutPreset[] = [];
  for (const raw of input as LayoutPreset[]) {
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") continue;
    if (!Array.isArray(raw.slots) || raw.slots.length === 0) continue;
    const slots: SlotRect[] = [];
    for (const slot of raw.slots) {
      if (
        typeof slot?.x === "number" &&
        typeof slot.y === "number" &&
        typeof slot.width === "number" &&
        typeof slot.height === "number"
      ) {
        slots.push(clampSlot(slot));
      }
    }
    if (slots.length > 0) {
      presets.push({ id: raw.id, name: raw.name, slots, builtin: false });
    }
  }
  return presets;
}

/** Strips fields from older schema versions so they cannot leak back into storage. */
function sanitizeEnvironments(input: unknown): Environment[] {
  if (!Array.isArray(input)) return [];
  return (input as Array<Environment & { kind?: string }>).map((environment) => {
    const { kind: _kind, ...rest } = environment;
    return rest;
  });
}

export function sanitizeWorkspace(input: Partial<WorkspaceData>): WorkspaceData {
  const base = emptyWorkspace();
  return {
    version: 1,
    environments: sanitizeEnvironments(input.environments),
    identities: Array.isArray(input.identities) ? input.identities : base.identities,
    scenes: sanitizeScenes(input.scenes),
    instances: Array.isArray(input.instances) ? input.instances : base.instances,
    manualEngines: Array.isArray(input.manualEngines) ? input.manualEngines : base.manualEngines,
    layoutPresets: sanitizeLayoutPresets(input.layoutPresets),
  };
}
