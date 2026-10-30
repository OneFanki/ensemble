import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import {
  detectBookmarkSources,
  parseChromiumBookmarks,
  type BookmarkImportNode,
} from "@core/bookmarks-import";

let dir: string;
let service: WorkspaceService;

function makeService(): WorkspaceService {
  return new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-bookmark-import-"));
  service = makeService();
  await service.initialize();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Flattens the tree the way assertions want to read it: "path → url". */
function flatten(nodes: BookmarkImportNode[], prefix = ""): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.url) out.push(`${prefix}${node.name} → ${node.url}`);
    if (node.children) out.push(...flatten(node.children, `${prefix}${node.name}/`));
  }
  return out;
}

describe("chromium bookmark source", () => {
  function plantChromium(userDataDir: string, roots: unknown): string {
    mkdirSync(join(userDataDir, "Default"), { recursive: true });
    writeFileSync(join(userDataDir, "Default", "Bookmarks"), JSON.stringify({ roots }));
    return join(userDataDir, "Default", "Bookmarks");
  }

  it("parses the standard roots and keeps only http(s) entries", () => {
    const file = plantChromium(join(dir, "ud"), {
      bookmark_bar: {
        type: "folder",
        name: "书签栏",
        children: [
          { type: "url", name: "后台", url: "https://admin.example.com" },
          { type: "url", name: "脚本", url: "javascript:alert(1)" },
          { type: "url", name: "本机", url: "file:///C:/Windows" },
          {
            type: "folder",
            name: "深层",
            children: [{ type: "url", name: "文档", url: "http://docs.example.com/a" }],
          },
          { type: "folder", name: "空夹", children: [] },
        ],
      },
      other: { type: "folder", name: "其他书签", children: [] },
    });
    const tree = parseChromiumBookmarks(file);
    // Empty branches never make it out of the parser: the import would only
    // have to prune them, and the count shown in the picker stays honest.
    expect(flatten(tree)).toEqual([
      "书签栏/后台 → https://admin.example.com",
      "书签栏/深层/文档 → http://docs.example.com/a",
    ]);
  });

  it("detects profiles that hold bookmarks and skips the rest", () => {
    const userDataDir = join(dir, "ud2");
    plantChromium(userDataDir, {
      bookmark_bar: { type: "folder", name: "书签栏", children: [
        { type: "url", name: "一", url: "https://a.example.com" },
      ] },
    });
    // A profile dir without a Bookmarks file, the way a fresh install looks.
    mkdirSync(join(userDataDir, "Profile 1"), { recursive: true });
    const sources = detectBookmarkSources("win32", { edgeDir: userDataDir, chromeDir: join(dir, "absent-chrome"), firefoxProfilesDir: join(dir, "absent-ff") });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("edge");
    expect(sources[0]?.profile).toBe("默认配置");
    expect(sources[0]?.count).toBe(1);
  });

  it("imports under a browser folder with structure intact", async () => {
    const userDataDir = join(dir, "ud3");
    const file = plantChromium(userDataDir, {
      bookmark_bar: {
        type: "folder",
        name: "书签栏",
        children: [
          { type: "url", name: "后台", url: "https://admin.example.com" },
          {
            type: "folder",
            name: "深层",
            children: [{ type: "url", name: "文档", url: "https://docs.example.com/a" }],
          },
        ],
      },
      other: { type: "folder", name: "其他书签", children: [] },
    });
    const outcome = await service.importBookmarksFromSource({
      kind: "edge",
      browser: "Edge",
      profile: "默认配置",
      file,
    });
    expect(outcome).toEqual({ bookmarks: 2, folders: 2, skipped: 0 });
    const folders = service.snapshot().bookmarkFolders;
    const root = folders.find((folder) => folder.name === "Edge 书签");
    expect(root?.parentId).toBeUndefined();
    const bar = folders.find((folder) => folder.name === "书签栏");
    expect(bar?.parentId).toBe(root?.id);
    const deep = folders.find((folder) => folder.name === "深层");
    expect(deep?.parentId).toBe(bar?.id);
    const bookmarks = service.snapshot().bookmarks;
    expect(bookmarks.find((item) => item.name === "后台")?.folderId).toBe(bar?.id);
    expect(bookmarks.find((item) => item.name === "文档")?.folderId).toBe(deep?.id);
    // The empty 其他书签 group was pruned on the way in.
    expect(folders.find((folder) => folder.name === "其他书签")).toBeUndefined();
  });

  it("skips urls the workspace already has, and prunes what that empties", async () => {
    service.saveBookmark({ name: "后台", url: "https://admin.example.com" });
    const userDataDir = join(dir, "ud4");
    const file = plantChromium(userDataDir, {
      bookmark_bar: {
        type: "folder",
        name: "书签栏",
        children: [
          { type: "url", name: "后台", url: "https://admin.example.com" },
          { type: "url", name: "新页", url: "https://fresh.example.com" },
        ],
      },
    });
    const outcome = await service.importBookmarksFromSource({
      kind: "edge",
      browser: "Edge",
      profile: "默认配置",
      file,
    });
    expect(outcome).toEqual({ bookmarks: 1, folders: 1, skipped: 1 });
    expect(service.snapshot().bookmarks.map((item) => item.name).sort()).toEqual(["后台", "新页"]);
  });

  it("is idempotent: importing the same profile twice imports nothing twice", async () => {
    const userDataDir = join(dir, "ud5");
    const file = plantChromium(userDataDir, {
      bookmark_bar: {
        type: "folder",
        name: "书签栏",
        children: [{ type: "url", name: "一", url: "https://a.example.com" }],
      },
    });
    const source = { kind: "edge" as const, browser: "Edge", profile: "默认配置", file };
    const first = await service.importBookmarksFromSource(source);
    expect(first.bookmarks).toBe(1);
    const before = service.snapshot();
    const second = await service.importBookmarksFromSource(source);
    expect(second).toEqual({ bookmarks: 0, folders: 0, skipped: 1 });
    // The tree is byte-for-byte the same shape: no stacked "书签栏 (2)".
    expect(service.snapshot().bookmarkFolders.map((folder) => folder.name)).toEqual(
      before.bookmarkFolders.map((folder) => folder.name),
    );
    expect(service.snapshot().bookmarks).toHaveLength(before.bookmarks.length);
  });
});

describe("firefox bookmark source", () => {
  function plantFirefox(profilesDir: string): string {
    const profileDir = join(profilesDir, "abc123.default-release");
    mkdirSync(profileDir, { recursive: true });
    const db = new DatabaseSync(join(profileDir, "places.sqlite"));
    db.exec(`
      CREATE TABLE moz_bookmarks (
        id INTEGER PRIMARY KEY, guid TEXT, parent INTEGER, type INTEGER,
        title TEXT, position INTEGER, fk INTEGER
      );
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT);
    `);
    db.prepare("INSERT INTO moz_places (id, url) VALUES (1, ?)").run("https://one.example.com");
    db.prepare("INSERT INTO moz_places (id, url) VALUES (2, ?)").run("https://two.example.com/deep");
    const bookmark = db.prepare(
      "INSERT INTO moz_bookmarks (id, guid, parent, type, title, position, fk) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    // The three fixed roots, then content: a bookmark directly on the toolbar
    // and one nested inside a folder of its own.
    bookmark.run(10, "toolbar_____", 1, 2, "toolbar", 0, null);
    bookmark.run(11, "menu________", 1, 2, "menu", 1, null);
    bookmark.run(12, "bm-one", 10, 1, "一", 0, 1);
    bookmark.run(13, "folder-f", 10, 2, "子夹", 1, null);
    bookmark.run(14, "bm-two", 13, 1, "二", 0, 2);
    bookmark.run(15, "bm-bad", 10, 1, "脚本", 2, null);
    db.prepare("INSERT INTO moz_places (id, url) VALUES (3, ?)").run("javascript:alert(1)");
    bookmark.run(16, "bm-bad2", 10, 1, "脚本", 2, 3);
    db.close();
    return profileDir;
  }

  it("detects profiles with a places database, count deferred", () => {
    const profilesDir = join(dir, "ff-profiles");
    plantFirefox(profilesDir);
    const sources = detectBookmarkSources("win32", { edgeDir: join(dir, "absent-edge"), chromeDir: join(dir, "absent-chrome"), firefoxProfilesDir: profilesDir });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe("firefox");
    expect(sources[0]?.profile).toBe("abc123");
    expect(sources[0]?.count).toBe(-1);
  });

  it("imports the fixed roots as folders with positions kept", async () => {
    const profilesDir = join(dir, "ff-profiles2");
    const profileDir = plantFirefox(profilesDir);
    const outcome = await service.importBookmarksFromSource({
      kind: "firefox",
      browser: "Firefox",
      profile: "abc123",
      file: join(profileDir, "places.sqlite"),
    });
    // 一 and 二 import; the javascript: row is filtered, not imported.
    expect(outcome).toEqual({ bookmarks: 2, folders: 2, skipped: 0 });
    const folders = service.snapshot().bookmarkFolders;
    const root = folders.find((folder) => folder.name === "Firefox 书签");
    const toolbar = folders.find((folder) => folder.name === "书签工具栏");
    const nested = folders.find((folder) => folder.name === "子夹");
    expect(toolbar?.parentId).toBe(root?.id);
    expect(nested?.parentId).toBe(toolbar?.id);
    // 书签菜单 holds nothing valid, so it never lands.
    expect(folders.find((folder) => folder.name === "书签菜单")).toBeUndefined();
    const bookmarks = service.snapshot().bookmarks;
    expect(bookmarks.find((item) => item.name === "一")?.folderId).toBe(toolbar?.id);
    expect(bookmarks.find((item) => item.name === "二")?.folderId).toBe(nested?.id);
  });
});
