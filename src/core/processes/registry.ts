import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clampSlot } from "@shared/layouts";
import type {
  Site,
  SiteTag,
  Engine,
  Identity,
  LayoutPreset,
  View,
  SlotRect,
} from "@shared/types";

export interface StoredInstance {
  id: string;
  identityId?: string;
  siteId: string;
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
  version: 2;
  sites: Site[];
  siteTags: SiteTag[];
  identities: Identity[];
  views: View[];
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
    version: 2,
    sites: [],
    siteTags: [],
    identities: [],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  };
}

/** Older files stored a fixed layout key (`1x1`, `2x2`, …) on each view. */
type LegacyView = Partial<View> & { layout?: string };

function sanitizeViews(input: unknown): View[] {
  if (!Array.isArray(input)) return [];
  return (input as LegacyView[])
    .filter(
      (view): view is LegacyView & { id: string; siteId: string } =>
        typeof view?.id === "string" && typeof view.siteId === "string",
    )
    .map((view) => {
      const assignments =
        view.slotAssignments && typeof view.slotAssignments === "object"
          ? Object.fromEntries(
              Object.entries(view.slotAssignments).filter(
                ([key, value]) => typeof key === "string" && Number.isInteger(value) && value >= 0,
              ),
            )
          : {};
      return {
        id: view.id,
        siteId: view.siteId,
        name: typeof view.name === "string" ? view.name : "",
        identityIds: Array.isArray(view.identityIds) ? view.identityIds : [],
        layoutId:
          typeof view.layoutId === "string" && view.layoutId
            ? view.layoutId
            : typeof view.layout === "string" && view.layout
              ? view.layout
              : "2x2",
        slotAssignments: assignments,
        paths: view.paths && typeof view.paths === "object" ? view.paths : {},
        createdAt: view.createdAt ?? new Date().toISOString(),
        updatedAt: view.updatedAt ?? new Date().toISOString(),
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
function sanitizeSites(input: unknown): Site[] {
  if (!Array.isArray(input)) return [];
  return (input as Array<Site & { kind?: string }>).map((site) => {
    const { kind: _kind, ...rest } = site;
    // Tag references are display-only; anything malformed is dropped rather than
    // failing the whole workspace.
    const tagIds = Array.isArray(rest.tagIds)
      ? rest.tagIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : undefined;
    return { ...rest, ...(tagIds && tagIds.length > 0 ? { tagIds } : { tagIds: undefined }) };
  });
}

function sanitizeSiteTags(input: unknown): SiteTag[] {
  if (!Array.isArray(input)) return [];
  const colors = new Set(["amber", "teal", "violet", "rose", "blue", "slate"]);
  const tags: SiteTag[] = [];
  const seen = new Set<string>();
  for (const raw of input as SiteTag[]) {
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") continue;
    if (!raw.name.trim() || seen.has(raw.id)) continue;
    seen.add(raw.id);
    tags.push({
      id: raw.id,
      name: raw.name.trim(),
      color: colors.has(raw.color) ? raw.color : "slate",
      createdAt: raw.createdAt ?? new Date().toISOString(),
    });
  }
  return tags;
}

/**
 * Drops tag references that no longer have a tag, so a deleted tag cannot leave
 * sites pointing at nothing.
 */
function pruneDanglingTags(sites: Site[], tags: SiteTag[]): Site[] {
  const known = new Set(tags.map((tag) => tag.id));
  return sites.map((site) => {
    if (!site.tagIds) return site;
    const kept = site.tagIds.filter((id) => known.has(id));
    return { ...site, tagIds: kept.length > 0 ? kept : undefined };
  });
}

/**
 * Reads a workspace file written by the previous 0.x schema.
 *
 * The v1 file used `environments` / `scenes` and `environmentId` on every
 * identity and scene. Nothing else changed, so the upgrade is a key rename: ids,
 * credentials and profile directories all keep working. This exists so an
 * existing workspace opens instead of appearing empty — not as a long-term
 * compatibility layer, which the project does not carry before 1.0.
 */
function upgradeV1(raw: Record<string, unknown>): Partial<WorkspaceData> {
  const rename = (list: unknown, key: string): unknown => {
    if (!Array.isArray(list)) return list;
    return list.map((item) => {
      if (!item || typeof item !== "object") return item;
      const { environmentId, ...rest } = item as Record<string, unknown>;
      return { ...rest, [key]: environmentId };
    });
  };
  return {
    sites: raw["environments"] as Site[] | undefined,
    identities: rename(raw["identities"], "siteId") as Identity[] | undefined,
    views: rename(raw["scenes"], "siteId") as View[] | undefined,
    instances: raw["instances"] as StoredInstance[] | undefined,
    manualEngines: raw["manualEngines"] as string[] | undefined,
    layoutPresets: raw["layoutPresets"] as LayoutPreset[] | undefined,
  };
}

export function sanitizeWorkspace(input: Partial<WorkspaceData>): WorkspaceData {
  const base = emptyWorkspace();
  const raw = input as Partial<WorkspaceData> & Record<string, unknown>;
  // A v1 file has no `sites` key but does have `environments`; treat anything
  // without the current shape as the previous schema.
  const source =
    Array.isArray(raw.sites) || !("environments" in raw) ? raw : upgradeV1(raw);
  const siteTags = sanitizeSiteTags(source.siteTags);
  return {
    version: 2,
    sites: pruneDanglingTags(sanitizeSites(source.sites), siteTags),
    siteTags,
    identities: Array.isArray(source.identities) ? source.identities : base.identities,
    views: sanitizeViews(source.views),
    instances: Array.isArray(source.instances) ? source.instances : base.instances,
    manualEngines: Array.isArray(source.manualEngines) ? source.manualEngines : base.manualEngines,
    layoutPresets: sanitizeLayoutPresets(source.layoutPresets),
  };
}
