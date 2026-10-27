import type { Flow, FlowParam, FlowStep } from "./flows";
import type { Bookmark, Identity, LayoutPreset, LoginField, Site, SlotRect, View } from "./types";

/**
 * Portable workspace snapshot. IDs are preserved so re-importing an export on the
 * same machine updates in place; importing on another machine simply adds new
 * entries. Browser profiles and running instances are never part of an export.
 */
export const EXPORT_FORMAT = "ensemble.workspace";
export const EXPORT_VERSION = 1;

export interface SealedSecrets {
  /** scrypt parameters used to derive the key for `payload`. */
  kdf: { salt: string; n: number; r: number; p: number };
  /** AES-256-GCM payload (`gcm2:iv:tag:ciphertext`) of the secrets JSON. */
  payload: string;
}

export interface WorkspaceExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  sites: Site[];
  identities: Identity[];
  views: View[];
  /** Saved step sequences; they belong to a site and travel with it. */
  flows?: Flow[];
  layoutPresets: LayoutPreset[];
  /**
   * Plain bookmarks. Independent of sites and identities — that is the point of
   * the distinction — so they import even into a workspace with no sites at all.
   */
  bookmarks?: Bookmark[];
  secrets?: SealedSecrets;
}

export interface ExportCounts {
  sites: number;
  identities: number;
  views: number;
  flows: number;
  layoutPresets: number;
  bookmarks: number;
}

export interface ImportPreview extends ExportCounts {
  version: number;
  exportedAt?: string;
  /** True when the file carries an encrypted secrets blob. */
  hasSecrets: boolean;
}

export interface ImportResult extends ExportCounts {
  updated: number;
  added: number;
  importedSecrets: number;
  /** Identities whose site is missing from both file and workspace. */
  skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max = 400): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} 不能为空`);
  if (trimmed.length > max) throw new Error(`${field} 过长`);
  return trimmed;
}

function optionalText(value: unknown, max = 400): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function sanitizeSite(raw: unknown): Site {
  if (!isRecord(raw)) throw new Error("站点条目格式错误");
  const id = text(raw["id"], "站点 id", 80);
  /*
   * `extraFields` was a site-level feature; it belongs to accounts now. An export
   * written before that change still carries the values, so they are read here and
   * tagged onto the file's identities by `parseExportFile` rather than dropped.
   * The site object itself never keeps them — a `Site` has no such field, and any
   * stray key would survive into storage until the next load pruned it.
   */
  return {
    id,
    name: text(raw["name"], "站点名称", 80),
    baseUrl: text(raw["baseUrl"], "站点地址", 500),
    loginPath: text(raw["loginPath"], "登录入口", 300),
    ...(optionalText(raw["authCheckPath"], 300)
      ? { authCheckPath: optionalText(raw["authCheckPath"], 300) }
      : {}),
    autoSubmit: raw["autoSubmit"] === true,
    createdAt: optionalText(raw["createdAt"]) ?? new Date().toISOString(),
    updatedAt: optionalText(raw["updatedAt"]) ?? new Date().toISOString(),
  };
}

/** Legacy site-level login fields, keyed by site id, from an older export. */
function legacySiteFields(raw: unknown): Map<string, LoginField[]> {
  const out = new Map<string, LoginField[]>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item["id"] === "string" ? item["id"] : "";
    const fields = Array.isArray(item["extraFields"]) ? item["extraFields"] : [];
    const cleaned = fields.flatMap((field): LoginField[] => {
      if (!isRecord(field)) return [];
      const label = typeof field["label"] === "string" ? field["label"].trim() : "";
      const value = typeof field["value"] === "string" ? field["value"].trim() : "";
      return label ? [{ label, value }] : [];
    });
    if (id && cleaned.length > 0) out.set(id, cleaned);
  }
  return out;
}

function sanitizeIdentity(raw: unknown): Identity {
  if (!isRecord(raw)) throw new Error("身份条目格式错误");
  const color = ["amber", "teal", "violet", "rose", "blue", "slate"].includes(String(raw["color"]))
    ? (raw["color"] as Identity["color"])
    : "slate";
  return {
    id: text(raw["id"], "身份 id", 80),
    siteId: text(raw["siteId"], "身份所属站点", 80),
    name: text(raw["name"], "身份名称", 80),
    username: text(raw["username"], "账号", 200),
    role: optionalText(raw["role"], 60) ?? "member",
    color,
    ...(optionalText(raw["engineId"], 120) ? { engineId: optionalText(raw["engineId"], 120) } : {}),
    ...(optionalText(raw["startPath"], 300)
      ? { startPath: optionalText(raw["startPath"], 300) }
      : {}),
    passwordMode: raw["passwordMode"] === "custom" ? "custom" : "inherit",
    // Imported identities always start unchecked: their session lives in a
    // profile that is not part of the export.
    status: "unknown",
    ...(Array.isArray(raw["extraFields"]) ? { extraFields: raw["extraFields"] as never } : {}),
    ...(optionalText(raw["note"], 1000) ? { note: optionalText(raw["note"], 1000) } : {}),
    createdAt: optionalText(raw["createdAt"]) ?? new Date().toISOString(),
    updatedAt: optionalText(raw["updatedAt"]) ?? new Date().toISOString(),
  };
}

function sanitizeView(raw: unknown): View {
  if (!isRecord(raw)) throw new Error("视图条目格式错误");
  const identityIds = Array.isArray(raw["identityIds"])
    ? raw["identityIds"].filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const assignments = isRecord(raw["slotAssignments"]) ? raw["slotAssignments"] : {};
  return {
    id: text(raw["id"], "视图 id", 80),
    siteId: text(raw["siteId"], "视图所属站点", 80),
    name: text(raw["name"], "视图名称", 80),
    identityIds,
    layoutId: optionalText(raw["layoutId"], 64) ?? "2x2",
    slotAssignments: Object.fromEntries(
      Object.entries(assignments).filter(
        ([key, value]) =>
          typeof key === "string" && Number.isInteger(value) && (value as number) >= 0,
      ),
    ) as Record<string, number>,
    paths: isRecord(raw["paths"]) ? (raw["paths"] as Record<string, string>) : {},
    createdAt: optionalText(raw["createdAt"]) ?? new Date().toISOString(),
    updatedAt: optionalText(raw["updatedAt"]) ?? new Date().toISOString(),
  };
}

/**
 * Validates one imported flow.
 *
 * Steps are copied field by field rather than spread: an export is a file a
 * person can edit, and an unknown key surviving into the workspace would be
 * carried around forever. Structural problems drop the step; a flow with no
 * steps left is dropped entirely.
 */
function sanitizeFlow(raw: unknown): Flow | undefined {
  if (!isRecord(raw)) return undefined;
  const id = optionalText(raw["id"], 80);
  const siteId = optionalText(raw["siteId"], 80);
  const name = optionalText(raw["name"], 80);
  if (!id || !siteId || !name) return undefined;
  const steps: FlowStep[] = Array.isArray(raw["steps"])
    ? raw["steps"].flatMap((item): FlowStep[] => {
        if (!isRecord(item)) return [];
        const action = optionalText(item["action"], 20) as FlowStep["action"] | undefined;
        if (!action) return [];
        const step: FlowStep = { action };
        const writable = step as unknown as Record<string, unknown>;
        for (const key of [
          "selector",
          "label",
          "text",
          "role",
          "note",
          "value",
          "url",
          "option",
          "key",
          "expect",
          "as",
          "condition",
        ] as const) {
          const value = optionalText(item[key], 4000);
          if (value) writable[key] = value;
        }
        if (item["exact"] === true) step.exact = true;
        if (item["optional"] === true) step.optional = true;
        if (typeof item["timeoutMs"] === "number" && Number.isFinite(item["timeoutMs"])) {
          step.timeoutMs = item["timeoutMs"];
        }
        return [step];
      })
    : [];
  if (steps.length === 0) return undefined;
  const params: FlowParam[] = Array.isArray(raw["params"])
    ? raw["params"].flatMap((item): FlowParam[] => {
        if (!isRecord(item)) return [];
        const paramName = optionalText(item["name"], 60);
        const label = optionalText(item["label"], 80);
        if (!paramName || !label) return [];
        return [
          {
            name: paramName,
            label,
            ...(item["required"] === true ? { required: true } : {}),
            ...(item["secret"] === true ? { secret: true } : {}),
            ...(optionalText(item["default"], 2000)
              ? { default: optionalText(item["default"], 2000) }
              : {}),
            ...(optionalText(item["description"], 300)
              ? { description: optionalText(item["description"], 300) }
              : {}),
          },
        ];
      })
    : [];
  return {
    id,
    siteId,
    name,
    description: optionalText(raw["description"], 1000) ?? "",
    params,
    steps,
    createdAt: optionalText(raw["createdAt"]) ?? new Date().toISOString(),
    updatedAt: optionalText(raw["updatedAt"]) ?? new Date().toISOString(),
  };
}

function sanitizePreset(raw: unknown): LayoutPreset | undefined {
  if (!isRecord(raw)) return undefined;
  const name = optionalText(raw["name"], 60);
  const id = optionalText(raw["id"], 80);
  if (!name || !id || !Array.isArray(raw["slots"])) return undefined;
  const slots: SlotRect[] = [];
  for (const slot of raw["slots"]) {
    if (!isRecord(slot)) continue;
    const { x, y, width, height } = slot;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      slots.push({ x, y, width, height });
    }
  }
  if (slots.length === 0) return undefined;
  return { id, name, slots, builtin: false };
}

/**
 * Validates one imported bookmark.
 *
 * The rules match `sanitizeBookmarks` in the store — an export is a hand-editable
 * file, so the same "no bookmark the app cannot open" rule has to hold here.
 * Ordered after the import so appends land at the end of the grid in file order.
 */
function sanitizeBookmark(raw: unknown, index: number): Bookmark | undefined {
  if (!isRecord(raw)) return undefined;
  const url = optionalText(raw["url"], 2000);
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  const id = optionalText(raw["id"], 80) ?? `bookmark-import-${index}`;
  const favicon = optionalText(raw["favicon"], 400_000);
  return {
    id,
    name: optionalText(raw["name"], 120) ?? new URL(url).host,
    url,
    ...(favicon?.startsWith("data:image/") ? { favicon } : {}),
    order: typeof raw["order"] === "number" && Number.isFinite(raw["order"]) ? raw["order"] : index,
    createdAt: optionalText(raw["createdAt"]) ?? new Date().toISOString(),
    updatedAt: optionalText(raw["updatedAt"]) ?? new Date().toISOString(),
  };
}

/**
 * Validates a user-picked file. Anything malformed is rejected with a readable
 * message instead of partially importing a half-broken workspace.
 */
export function parseExportFile(input: unknown): WorkspaceExportFile {
  if (!isRecord(input)) throw new Error("文件内容不是有效的配置导出");
  if (input["format"] !== EXPORT_FORMAT) throw new Error("不是 Ensemble 的配置导出文件");
  if (typeof input["version"] !== "number" || input["version"] > EXPORT_VERSION) {
    throw new Error("配置版本过新，请升级 Ensemble 后再导入");
  }
  if (!Array.isArray(input["sites"])) throw new Error("缺少 sites");

  const sites = input["sites"].map(sanitizeSite);
  const identities = Array.isArray(input["identities"])
    ? input["identities"].map(sanitizeIdentity)
    : [];
  // An export from before sites stopped owning login fields carries them on the
  // site. Copy each onto its accounts unless the account already sets that label,
  // which is exactly what the old merge produced at fill time.
  const inherited = legacySiteFields(input["sites"]);
  for (const identity of identities) {
    const fields = identity.siteId ? inherited.get(identity.siteId) : undefined;
    if (!fields) continue;
    const own = identity.extraFields ?? [];
    const labels = new Set(own.map((field) => field.label.trim().toLowerCase()));
    identity.extraFields = [
      ...own,
      ...fields.filter((field) => !labels.has(field.label.trim().toLowerCase())),
    ];
  }
  const views = Array.isArray(input["views"]) ? input["views"].map(sanitizeView) : [];
  const flows = Array.isArray(input["flows"])
    ? input["flows"].map(sanitizeFlow).filter((flow): flow is Flow => Boolean(flow))
    : [];
  const layoutPresets = Array.isArray(input["layoutPresets"])
    ? input["layoutPresets"]
        .map(sanitizePreset)
        .filter((preset): preset is LayoutPreset => Boolean(preset))
    : [];
  const bookmarks = Array.isArray(input["bookmarks"])
    ? input["bookmarks"]
        .map(sanitizeBookmark)
        .filter((bookmark): bookmark is Bookmark => Boolean(bookmark))
    : [];

  const secrets = isRecord(input["secrets"])
    ? (input["secrets"] as unknown as SealedSecrets)
    : undefined;
  return {
    format: EXPORT_FORMAT,
    version: input["version"],
    exportedAt: optionalText(input["exportedAt"]) ?? new Date().toISOString(),
    sites,
    identities,
    views,
    flows,
    layoutPresets,
    bookmarks,
    ...(secrets && typeof secrets.payload === "string" ? { secrets } : {}),
  };
}

export function exportCounts(file: WorkspaceExportFile): ExportCounts {
  return {
    sites: file.sites.length,
    identities: file.identities.length,
    views: file.views.length,
    flows: file.flows?.length ?? 0,
    layoutPresets: file.layoutPresets.length,
    bookmarks: file.bookmarks?.length ?? 0,
  };
}
