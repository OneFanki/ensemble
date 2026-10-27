import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  FLOW_ACTIONS,
  type Flow,
  type FlowAction,
  type FlowParam,
  type FlowStep,
  WAIT_CONDITIONS,
  type WaitCondition,
} from "@shared/flows";
import { clampSlot } from "@shared/layouts";
import type {
  Bookmark,
  Engine,
  Identity,
  LayoutPreset,
  LoginField,
  Site,
  SlotRect,
  Tag,
  View,
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
  tags: Tag[];
  identities: Identity[];
  views: View[];
  flows: Flow[];
  instances: StoredInstance[];
  manualEngines: string[];
  layoutPresets: LayoutPreset[];
  /** Plain bookmarks; see {@link Bookmark}. Absent in files from before 0.5. */
  bookmarks: Bookmark[];
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
    tags: [],
    identities: [],
    views: [],
    flows: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
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
        // Dangling ids are pruned later, once the tag list is known.
        ...(Array.isArray(view.tagIds) ? { tagIds: view.tagIds } : {}),
        ...(view.copiedFrom ? { copiedFrom: view.copiedFrom } : {}),
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

/**
 * Strips fields from older schema versions so they cannot leak back into storage.
 *
 * `extraFields` is deliberately still read here: {@link inheritSiteFields} needs
 * it to move those values onto the accounts that were relying on them. It is
 * removed again once that has run.
 */
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

/** Drops site-level login fields; they live on accounts only. */
function withoutSiteFields(sites: Site[]): Site[] {
  return sites.map((site) => {
    const { extraFields: _fields, ...rest } = site as Site & { extraFields?: LoginField[] };
    return rest;
  });
}

function sanitizeTags(input: unknown): Tag[] {
  if (!Array.isArray(input)) return [];
  const colors = new Set(["amber", "teal", "violet", "rose", "blue", "slate"]);
  const tags: Tag[] = [];
  const seen = new Set<string>();
  for (const raw of input as Tag[]) {
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
 * Keeps only tag ids that still exist.
 *
 * A dangling reference would make the entity vanish from every filter group
 * while looking fine on its own page, so it is dropped instead of stored.
 */
function tagIdsOf(value: unknown, known: Set<string>): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept = [
    ...new Set(
      value.filter((id): id is string => typeof id === "string" && id.length > 0 && known.has(id)),
    ),
  ];
  return kept.length > 0 ? kept : undefined;
}

function withTagIds<T extends { tagIds?: string[] }>(item: T, tagIds: string[] | undefined): T {
  return { ...item, ...(tagIds ? { tagIds } : { tagIds: undefined }) };
}

function pruneDanglingTags(
  sites: Site[],
  identities: Identity[],
  views: View[],
  tags: Tag[],
): { sites: Site[]; identities: Identity[]; views: View[] } {
  const known = new Set(tags.map((tag) => tag.id));
  return {
    sites: sites.map((site) => withTagIds(site, tagIdsOf(site.tagIds, known))),
    identities: identities.map((identity) =>
      withTagIds(identity, tagIdsOf(identity.tagIds, known)),
    ),
    views: views.map((view) => withTagIds(view, tagIdsOf(view.tagIds, known))),
  };
}

/**
 * Reads a workspace file written by the previous 0.x schema.
 *
 * The v1 file used `environments` / `scenes` and `environmentId` on every
 * identity and scene. Nothing else changed, so the upgrade is a key rename: ids,
 * credentials and profile directories all keep working. This exists so an
 * existing workspace opens instead of appearing empty — not as a long-term
 * compatibility layer, which the project does not carry before 1.0.
 *
 * A file can carry **both** keys: one build wrote `sites: []` next to the still
 * populated `environments`. Sites are therefore merged instead of read from one
 * key, and an identity keeps a `siteId` it already has while falling back to
 * `environmentId`. Reading it the other way round is not recoverable — a single
 * empty `sites` array made the migration look unnecessary, and every account
 * came back with no site while the site list came back empty.
 */
function upgradeV1(raw: Record<string, unknown>): Partial<WorkspaceData> {
  const rename = (list: unknown, key: string): unknown => {
    if (!Array.isArray(list)) return list;
    return list.map((item) => {
      if (!item || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      const { environmentId, ...rest } = record;
      const current = record[key];
      const value = typeof current === "string" && current ? current : environmentId;
      return { ...rest, [key]: value };
    });
  };
  const sites: Site[] = [];
  const seen = new Set<string>();
  for (const list of [raw["sites"], raw["environments"]]) {
    if (!Array.isArray(list)) continue;
    for (const item of list as Site[]) {
      if (!item || typeof item.id !== "string" || seen.has(item.id)) continue;
      seen.add(item.id);
      sites.push(item);
    }
  }
  return {
    sites,
    identities: rename(raw["identities"], "siteId") as Identity[] | undefined,
    views: rename(raw["scenes"], "siteId") as View[] | undefined,
    instances: raw["instances"] as StoredInstance[] | undefined,
    manualEngines: raw["manualEngines"] as string[] | undefined,
    layoutPresets: raw["layoutPresets"] as LayoutPreset[] | undefined,
  };
}

/**
 * Reads flows from disk without trusting them.
 *
 * A workspace file can be hand-edited or come from an older build, and a flow is
 * a list of instructions that will be executed against a live page. Anything that
 * does not parse is dropped rather than repaired: a half-understood step is more
 * dangerous than a missing one. Flows whose site no longer exists are dropped
 * too — they have nowhere to run.
 */
function sanitizeFlows(input: unknown, siteIds: Set<string>): Flow[] {
  if (!Array.isArray(input)) return [];
  const flows: Flow[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const siteId = typeof record.siteId === "string" ? record.siteId : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!id || !name || !siteIds.has(siteId)) continue;

    const params: FlowParam[] = Array.isArray(record.params)
      ? record.params
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => ({
            name: String(item.name ?? "").trim(),
            label: String(item.label ?? "").trim(),
            ...(item.required === true ? { required: true } : {}),
            ...(item.secret === true ? { secret: true } : {}),
            ...(typeof item.default === "string" ? { default: item.default } : {}),
            ...(typeof item.description === "string" ? { description: item.description } : {}),
          }))
          .filter((param) => param.name && param.label)
      : [];

    const steps: FlowStep[] = Array.isArray(record.steps)
      ? record.steps
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => {
            const action = String(item.action ?? "") as FlowAction;
            const step: FlowStep = { action };
            for (const key of ["selector", "label", "text", "role", "note", "value", "url", "option", "key", "expect", "as"] as const) {
              const value = item[key];
              if (typeof value === "string" && value.trim()) step[key] = value;
            }
            if (item.exact === true) step.exact = true;
            if (item.optional === true) step.optional = true;
            if (typeof item.timeoutMs === "number" && Number.isFinite(item.timeoutMs)) {
              step.timeoutMs = Math.min(Math.max(Math.trunc(item.timeoutMs), 100), 120_000);
            }
            if (typeof item.condition === "string" && WAIT_CONDITIONS.includes(item.condition as WaitCondition)) {
              step.condition = item.condition as WaitCondition;
            }
            return step;
          })
          .filter((step) => FLOW_ACTIONS.includes(step.action))
      : [];
    if (steps.length === 0) continue;

    flows.push({
      id,
      siteId,
      name: name.slice(0, 80),
      description: typeof record.description === "string" ? record.description.slice(0, 1000) : "",
      params,
      steps,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
    });
  }
  return flows;
}

export function sanitizeWorkspace(input: Partial<WorkspaceData>): WorkspaceData {
  const base = emptyWorkspace();
  const raw = input as Partial<WorkspaceData> & Record<string, unknown>;
  /*
   * A v1 file has no `sites` key and does have `environments`. The check is on
   * `environments` alone rather than "no sites yet": one build wrote an empty
   * `sites` array next to the populated `environments`, and reading that as
   * current is what emptied the site list and unlinked every account.
   */
  const source = Array.isArray(raw.environments) ? upgradeV1(raw) : raw;
  // The tag namespace used to be site-only (`siteTags`). Same ids and colours,
  // so the rename is a straight read; identities and views simply start with no
  // tags of their own.
  const tags = sanitizeTags(source.tags ?? raw["siteTags"]);
  const sites = sanitizeSites(source.sites);
  const identities = Array.isArray(source.identities) ? source.identities : base.identities;
  const pruned = pruneDanglingTags(
    withoutSiteFields(sites),
    inheritSiteFields(sites, identities),
    sanitizeViews(source.views),
    tags,
  );
  return {
    version: 2,
    sites: pruned.sites,
    tags,
    identities: pruned.identities,
    views: pruned.views,
    flows: sanitizeFlows(source.flows, new Set(pruned.sites.map((site) => site.id))),
    instances: Array.isArray(source.instances) ? source.instances : base.instances,
    manualEngines: Array.isArray(source.manualEngines) ? source.manualEngines : base.manualEngines,
    layoutPresets: sanitizeLayoutPresets(source.layoutPresets),
    bookmarks: sanitizeBookmarks(source.bookmarks),
  };
}

/**
 * Moves site-level login fields onto the accounts that inherited them.
 *
 * Sites used to own "extra login fields" and hand them to every account. That
 * made a site look like it carried credentials, and it was the only reason the
 * site form had a field list at all — a site has no account of its own, so the
 * values always belonged to whoever signed in. The feature is gone; this keeps
 * the data: each field is copied into every account of that site that does not
 * already set the same label, which is exactly what the old merge produced.
 *
 * A site field also had the power to be removed per account by clearing the
 * value; that case is already stored as an empty account row and is left alone.
 */
function inheritSiteFields(sites: Site[], identities: Identity[]): Identity[] {
  const fieldsOf = new Map<string, LoginField[]>();
  for (const site of sites as Array<Site & { extraFields?: LoginField[] }>) {
    if (Array.isArray(site.extraFields) && site.extraFields.length > 0) {
      fieldsOf.set(site.id, site.extraFields);
    }
  }
  if (fieldsOf.size === 0) return identities;
  return identities.map((identity) => {
    const inherited = identity.siteId ? fieldsOf.get(identity.siteId) : undefined;
    if (!inherited) return identity;
    const own = identity.extraFields ?? [];
    const labels = new Set(own.map((field) => field.label.trim().toLowerCase()));
    const merged = [
      ...own,
      ...inherited.filter((field) => !labels.has(field.label.trim().toLowerCase())),
    ];
    return { ...identity, extraFields: merged };
  });
}

/**
 * Reads stored bookmarks, dropping anything that cannot be opened.
 *
 * A bookmark whose URL is not http(s) is not a bookmark the app can honour — the
 * embedded surface refuses every other scheme, so keeping the record would only
 * produce a row that fails when clicked. Unknown fields are ignored rather than
 * rejected: a file written by a newer build must still open here.
 */
export function sanitizeBookmarks(input: unknown): Bookmark[] {
  if (!Array.isArray(input)) return [];
  const out: Bookmark[] = [];
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const url = typeof raw["url"] === "string" ? raw["url"].trim() : "";
    if (!/^https?:\/\//i.test(url)) continue;
    const id = typeof raw["id"] === "string" && raw["id"] ? raw["id"] : `bookmark-${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof raw["name"] === "string" ? raw["name"].trim().slice(0, 120) : "";
    const now = new Date().toISOString();
    const favicon = typeof raw["favicon"] === "string" ? raw["favicon"] : "";
    out.push({
      id,
      // An unnamed bookmark is still usable: the host is the only thing the user
      // would have typed, so it is the honest fallback label.
      name: name || hostOf(url) || url,
      url,
      ...(favicon.startsWith("data:image/") ? { favicon } : {}),
      order: typeof raw["order"] === "number" && Number.isFinite(raw["order"]) ? raw["order"] : index,
      createdAt: typeof raw["createdAt"] === "string" ? raw["createdAt"] : now,
      updatedAt: typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : now,
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
