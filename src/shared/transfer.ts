import type { Site, Identity, LayoutPreset, View, SlotRect } from "./types";

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
  layoutPresets: LayoutPreset[];
  secrets?: SealedSecrets;
}

export interface ExportCounts {
  sites: number;
  identities: number;
  views: number;
  layoutPresets: number;
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
  return {
    id,
    name: text(raw["name"], "站点名称", 80),
    baseUrl: text(raw["baseUrl"], "站点地址", 500),
    loginPath: text(raw["loginPath"], "登录入口", 300),
    ...(optionalText(raw["authCheckPath"], 300)
      ? { authCheckPath: optionalText(raw["authCheckPath"], 300) }
      : {}),
    ...(optionalText(raw["defaultEngineId"], 120)
      ? { defaultEngineId: optionalText(raw["defaultEngineId"], 120) }
      : {}),
    autoSubmit: raw["autoSubmit"] === true,
    ...(Array.isArray(raw["extraFields"]) ? { extraFields: raw["extraFields"] as never } : {}),
    createdAt: optionalText(raw["createdAt"]) ?? new Date().toISOString(),
    updatedAt: optionalText(raw["updatedAt"]) ?? new Date().toISOString(),
  };
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
  const views = Array.isArray(input["views"]) ? input["views"].map(sanitizeView) : [];
  const layoutPresets = Array.isArray(input["layoutPresets"])
    ? input["layoutPresets"]
        .map(sanitizePreset)
        .filter((preset): preset is LayoutPreset => Boolean(preset))
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
    layoutPresets,
    ...(secrets && typeof secrets.payload === "string" ? { secrets } : {}),
  };
}

export function exportCounts(file: WorkspaceExportFile): ExportCounts {
  return {
    sites: file.sites.length,
    identities: file.identities.length,
    views: file.views.length,
    layoutPresets: file.layoutPresets.length,
  };
}
