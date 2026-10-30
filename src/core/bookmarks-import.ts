import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BookmarkSourceKind, Platform } from "@shared/types";

/**
 * Reads the bookmark files of installed browsers so Ensemble can import them.
 *
 * Only the big three are detected, because only they have files whose format is
 * stable enough to read blind: Chromium siblings (Edge, Chrome) keep a JSON
 * `Bookmarks` file per profile, Firefox keeps `places.sqlite`. Both formats
 * carry no credentials — a bookmark file is names and addresses — so reading it
 * touches nothing sensitive. The paths follow the OS convention, with per-
 * browser overrides that the tests use to plant fabricated files.
 */

export type { BookmarkSourceKind };

/** A browser profile on this machine whose bookmarks can be read. */
export interface BookmarkImportSource {
  kind: BookmarkSourceKind;
  /** Display name of the browser, as the user knows it. */
  browser: string;
  /** Display label of the profile inside that browser. */
  profile: string;
  /**
   * http(s) bookmark count in this profile, so the picker can be honest.
   * `-1` means "not counted": a Firefox database would have to be copied and
   * opened to count, which detection has no business doing for every profile.
   */
  count: number;
  /** Backing file. Main process keeps it; the renderer only ever sees the id. */
  file: string;
}

/** A parsed bookmark tree. Folders keep their nesting; urls carry no extras. */
export interface BookmarkImportNode {
  name: string;
  url?: string;
  children?: BookmarkImportNode[];
}

interface DetectorContext {
  /** Overrides for tests; real runs derive every root from the OS convention. */
  edgeDir?: string;
  chromeDir?: string;
  firefoxProfilesDir?: string;
}

const CHROMIUM_BROWSERS: Array<{
  kind: BookmarkSourceKind;
  browser: string;
  dirOf: (platform: Platform) => string;
}> = [
  {
    kind: "edge",
    browser: "Edge",
    dirOf: (platform) =>
      platform === "win32"
        ? join(process.env["LOCALAPPDATA"] ?? "", "Microsoft", "Edge", "User Data")
        : platform === "darwin"
          ? join(homedir(), "Library", "Application Support", "Microsoft Edge")
          : join(homedir(), ".config", "microsoft-edge"),
  },
  {
    kind: "chrome",
    browser: "Chrome",
    dirOf: (platform) =>
      platform === "win32"
        ? join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "User Data")
        : platform === "darwin"
          ? join(homedir(), "Library", "Application Support", "Google", "Chrome")
          : join(homedir(), ".config", "google-chrome"),
  },
];

function labelChromiumProfile(dirName: string): string {
  if (dirName === "Default") return "默认配置";
  const match = /^Profile (.+)$/.exec(dirName);
  return match ? `Profile ${match[1]}` : dirName;
}

function countImportTree(nodes: BookmarkImportNode[]): number {
  let count = 0;
  const walk = (list: BookmarkImportNode[]) => {
    for (const node of list) {
      if (node.url) count += 1;
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return count;
}

/** Children of one Chromium profile's Bookmarks file, as an import tree. */
export function parseChromiumBookmarks(file: string): BookmarkImportNode[] {
  if (!existsSync(file)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("无法读取该浏览器的书签文件（可能已损坏）");
  }
  const roots = (data as Record<string, Record<string, unknown>> | null)?.["roots"];
  if (!roots || typeof roots !== "object") return [];
  // The three standard roots are folders in their own right — the file already
  // names them (书签栏 / 其他书签 / 移动设备书签 in the browser's own locale),
  // so they are walked directly instead of being wrapped in another label.
  const out: BookmarkImportNode[] = [];
  for (const key of ["bookmark_bar", "other", "synced"]) {
    const root = roots[key];
    if (!root || typeof root !== "object") continue;
    out.push(...walkChromium(root));
  }
  return out;
}

function walkChromium(node: unknown): BookmarkImportNode[] {
  const record = node as Record<string, unknown> | null;
  if (!record || typeof record !== "object") return [];
  const children = Array.isArray(record["children"]) ? record["children"] : [];
  const name = typeof record["name"] === "string" ? record["name"].trim().slice(0, 120) : "";
  if (record["type"] === "url") {
    const url = typeof record["url"] === "string" ? record["url"].trim() : "";
    // The rest of the app only stores http(s); a file:// or javascript: entry
    // from the browser would produce a bookmark the surface refuses to open.
    if (!/^https?:\/\//i.test(url) || !name) return [];
    return [{ name, url }];
  }
  const mapped = children.flatMap(walkChromium);
  if (!mapped.length) return [];
  return [{ name: name || "未命名文件夹", children: mapped }];
}

/** Chromium profile directories under one User Data root that hold bookmarks. */
function chromiumSources(
  userDataDir: string,
  kind: BookmarkSourceKind,
  browser: string,
): BookmarkImportSource[] {
  if (!existsSync(userDataDir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(userDataDir);
  } catch {
    return [];
  }
  const out: BookmarkImportSource[] = [];
  for (const entry of entries) {
    if (entry !== "Default" && !entry.startsWith("Profile ")) continue;
    const file = join(userDataDir, entry, "Bookmarks");
    if (!existsSync(file)) continue;
    try {
      const tree = parseChromiumBookmarks(file);
      if (tree.length === 0) continue;
      out.push({
        kind,
        browser,
        profile: labelChromiumProfile(entry),
        count: countImportTree(tree),
        file,
      });
    } catch {
      // An unreadable profile is skipped rather than failing detection: one
      // broken file must not hide the healthy sources beside it.
    }
  }
  return out;
}

const FIREFOX_ROOT_GUIDS: Array<{ guid: string; label: string }> = [
  { guid: "toolbar_____", label: "书签工具栏" },
  { guid: "menu________", label: "书签菜单" },
  { guid: "unfiled_____", label: "其他书签" },
];

interface PlacesRow {
  id: number;
  guid: string;
  parent: number;
  type: number;
  title: string | null;
  position: number;
  url: string | null;
}

/**
 * Children of one Firefox profile's places database, as an import tree.
 *
 * Firefox keeps the database open with a WAL, so the file is copied to a temp
 * dir (with its -wal/-shm sidecars, which hold the newest rows) and the copy is
 * opened read-only. Reading the original in place would either be locked or
 * torn mid-transaction.
 */
export async function parseFirefoxBookmarks(file: string): Promise<BookmarkImportNode[]> {
  if (!existsSync(file)) return [];
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error("当前运行时不支持读取 Firefox 的书签数据库");
  }
  const staging = join(tmpdir(), `ensemble-places-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const copy = join(staging, "places.sqlite");
  mkdirSync(staging, { recursive: true });
  try {
    copyFileSync(file, copy);
    for (const sidecar of ["-wal", "-shm"]) {
      if (existsSync(file + sidecar)) copyFileSync(file + sidecar, copy + sidecar);
    }
    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT b.id, b.guid, b.parent, b.type, b.title, b.position, p.url FROM moz_bookmarks b " +
            "LEFT JOIN moz_places p ON b.fk = p.id",
        )
        .all() as unknown as PlacesRow[];
      const childrenOf = new Map<number, PlacesRow[]>();
      for (const row of rows) {
        const list = childrenOf.get(row.parent) ?? [];
        list.push(row);
        childrenOf.set(row.parent, list);
      }
      // Sibling order is the stored position, not row order.
      for (const list of childrenOf.values()) list.sort((a, b) => a.position - b.position);

      const roots: BookmarkImportNode[] = [];
      for (const root of FIREFOX_ROOT_GUIDS) {
        const row = rows.find((item) => item.guid === root.guid);
        if (!row) continue;
        const children = walkFirefox(row.id, childrenOf);
        if (children.length) roots.push({ name: root.label, children });
      }
      return roots;
    } finally {
      db.close();
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("当前运行时")) throw cause;
    throw new Error("无法读取该 Firefox 配置的书签数据库");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function walkFirefox(parentId: number, childrenOf: Map<number, PlacesRow[]>): BookmarkImportNode[] {
  const out: BookmarkImportNode[] = [];
  for (const row of childrenOf.get(parentId) ?? []) {
    const name = (row.title ?? "").trim().slice(0, 120);
    if (row.type === 2) {
      const children = walkFirefox(row.id, childrenOf);
      if (children.length) out.push({ name: name || "未命名文件夹", children });
    } else if (row.type === 1 && row.url && /^https?:\/\//i.test(row.url)) {
      if (name) out.push({ name, url: row.url });
    }
  }
  return out;
}

/**
 * Firefox profile directories that hold a places database. `profiles.ini` is
 * deliberately not parsed: its format varies across versions, while any dir
 * with a places.sqlite is by definition a profile with bookmarks.
 */
function firefoxSources(profilesDir: string): BookmarkImportSource[] {
  if (!existsSync(profilesDir)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(profilesDir);
  } catch {
    return [];
  }
  const out: BookmarkImportSource[] = [];
  for (const entry of entries) {
    const file = join(profilesDir, entry, "places.sqlite");
    if (!existsSync(file)) continue;
    out.push({
      kind: "firefox",
      browser: "Firefox",
      profile: entry.replace(/\.default(-release)?$/i, "") || entry,
      count: -1,
      file,
    });
  }
  return out;
}

/** Every importable source on this machine. */
export function detectBookmarkSources(
  platform: Platform,
  context: DetectorContext = {},
): BookmarkImportSource[] {
  const out: BookmarkImportSource[] = [];
  for (const item of CHROMIUM_BROWSERS) {
    const dir =
      item.kind === "edge"
        ? (context.edgeDir ?? item.dirOf(platform))
        : (context.chromeDir ?? item.dirOf(platform));
    out.push(...chromiumSources(dir, item.kind, item.browser));
  }
  out.push(...firefoxSources(context.firefoxProfilesDir ?? firefoxProfilesRoot(platform)));
  return out;
}

function firefoxProfilesRoot(platform: Platform): string {
  if (platform === "win32") return join(process.env["APPDATA"] ?? "", "Mozilla", "Firefox", "Profiles");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Firefox", "Profiles");
  return join(homedir(), ".mozilla", "firefox");
}
