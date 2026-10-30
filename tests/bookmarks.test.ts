import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { sanitizeBookmarksSection } from "@core/processes/registry";
import { EXPORT_FORMAT, exportCounts, parseExportFile } from "@shared/transfer";

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
  dir = mkdtempSync(join(tmpdir(), "ensemble-bookmarks-"));
  service = makeService();
  await service.initialize();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bookmark store", () => {
  it("stores a name and an address, nothing else", () => {
    const saved = service.saveBookmark({ name: "后台", url: "https://admin.example.com/home" });
    expect(saved.id).toBeTruthy();
    expect(saved.name).toBe("后台");
    expect(saved.url).toBe("https://admin.example.com/home");
    // The absence of these is the whole point: a bookmark is not a site.
    expect(saved).not.toHaveProperty("siteId");
    expect(saved).not.toHaveProperty("loginPath");
  });

  it("falls back to the host when no name is given", () => {
    const saved = service.saveBookmark({ name: "   ", url: "https://example.com/a/b" });
    expect(saved.name).toBe("example.com");
  });

  it("assumes https for a bare host", () => {
    const saved = service.saveBookmark({ name: "", url: "example.com/docs" });
    expect(saved.url).toBe("https://example.com/docs");
  });

  it("refuses a scheme the surface cannot open", () => {
    expect(() => service.saveBookmark({ name: "x", url: "javascript:alert(1)" })).toThrow();
    expect(() => service.saveBookmark({ name: "x", url: "file:///C:/Windows" })).toThrow();
    expect(() => service.saveBookmark({ name: "x", url: "" })).toThrow();
  });

  it("appends new bookmarks in order", () => {
    service.saveBookmark({ name: "一", url: "https://a.example.com" });
    service.saveBookmark({ name: "二", url: "https://b.example.com" });
    expect(service.snapshot().bookmarks.map((item) => item.name)).toEqual(["一", "二"]);
  });

  it("renames without moving the bookmark", () => {
    const first = service.saveBookmark({ name: "一", url: "https://a.example.com" });
    service.saveBookmark({ name: "二", url: "https://b.example.com" });
    const renamed = service.saveBookmark({ id: first.id, name: "改名后", url: first.url });
    expect(renamed.name).toBe("改名后");
    expect(service.snapshot().bookmarks.map((item) => item.name)).toEqual(["改名后", "二"]);
  });

  it("rejects an update to a bookmark that is not there", () => {
    expect(() =>
      service.saveBookmark({ id: "missing", name: "x", url: "https://example.com" }),
    ).toThrow();
  });

  it("moves a bookmark to an explicit index and renumbers", () => {
    const a = service.saveBookmark({ name: "一", url: "https://a.example.com" });
    service.saveBookmark({ name: "二", url: "https://b.example.com" });
    service.saveBookmark({ name: "三", url: "https://c.example.com" });
    service.moveBookmark(a.id, 2);
    expect(service.snapshot().bookmarks.map((item) => item.name)).toEqual(["二", "三", "一"]);
    expect(service.snapshot().bookmarks.map((item) => item.order)).toEqual([0, 1, 2]);
  });

  it("stores only an inlined image as an icon", () => {
    const saved = service.saveBookmark({ name: "一", url: "https://a.example.com" });
    expect(service.setBookmarkFavicon(saved.id, "data:image/png;base64,AAAA").favicon).toBe(
      "data:image/png;base64,AAAA",
    );
    // A remote URL here would make the grid fetch the icon itself, which the
    // renderer's CSP forbids — so it is dropped rather than stored.
    expect(service.setBookmarkFavicon(saved.id, "https://a.example.com/favicon.ico").favicon)
      .toBeUndefined();
  });

  it("deletes one bookmark and keeps the rest", () => {
    const a = service.saveBookmark({ name: "一", url: "https://a.example.com" });
    service.saveBookmark({ name: "二", url: "https://b.example.com" });
    service.deleteBookmark(a.id);
    expect(service.snapshot().bookmarks.map((item) => item.name)).toEqual(["二"]);
    expect(() => service.deleteBookmark(a.id)).toThrow();
  });

  it("survives a restart", async () => {
    service.saveBookmark({ name: "留在磁盘上", url: "https://keep.example.com" });
    service = makeService();
    await service.initialize();
    expect(service.snapshot().bookmarks.map((item) => item.name)).toEqual(["留在磁盘上"]);
  });
});

describe("bookmark storage sanitising", () => {
  it("drops anything the surface cannot open", () => {
    const { bookmarks: kept } = sanitizeBookmarksSection([
      { id: "a", name: "好的", url: "https://example.com" },
      { id: "b", name: "坏的", url: "javascript:alert(1)" },
      { id: "c", name: "空的", url: "   " },
      null,
      42,
    ], []);
    expect(kept.map((item) => item.id)).toEqual(["a"]);
  });

  it("drops duplicate ids and renames the unnamed", () => {
    const { bookmarks: kept } = sanitizeBookmarksSection([
      { id: "a", url: "https://first.example.com" },
      { id: "a", url: "https://second.example.com" },
      { url: "https://third.example.com" },
    ], []);
    expect(kept).toHaveLength(2);
    expect(kept[1]?.id).toBe("bookmark-2");
    expect(kept[1]?.name).toBe("third.example.com");
  });

  it("sorts by the stored order", () => {
    const { bookmarks: kept } = sanitizeBookmarksSection([
      { id: "b", url: "https://b.example.com", order: 2 },
      { id: "a", url: "https://a.example.com", order: 1 },
    ], []);
    expect(kept.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("keeps a data: icon and drops anything else", () => {
    const { bookmarks: kept } = sanitizeBookmarksSection([
      { id: "a", url: "https://a.example.com", favicon: "data:image/png;base64,AAAA" },
      { id: "b", url: "https://b.example.com", favicon: "https://b.example.com/i.png" },
    ], []);
    expect(kept[0]?.favicon).toBe("data:image/png;base64,AAAA");
    expect(kept[1]?.favicon).toBeUndefined();
  });

  /**
   * A field that is not rebuilt here does not survive a restart.
   *
   * `sanitizeBookmarks` constructs every record field by field instead of
   * spreading the raw object — correct for validation, but it means a new field
   * is silently dropped on the next launch unless it is added here too. The
   * folder strip vanished from the new-tab page exactly this way: saving worked,
   * and the folder was gone after a reload.
   */
  it("keeps a folderId that names a carried folder, drops a dangling one", () => {
    const { bookmarkFolders: folders, bookmarks: kept } = sanitizeBookmarksSection(
      [
        { id: "a", url: "https://a.example.com", folderId: "f1" },
        { id: "b", url: "https://b.example.com", folderId: "f2" },
        { id: "c", url: "https://c.example.com" },
      ],
      [{ id: "f1", name: "工作", order: 0 }],
    );
    expect(folders.map((folder) => folder.id)).toEqual(["f1"]);
    expect(kept[0]?.folderId).toBe("f1");
    // The folder is not in the file, so the pointer would strand the bookmark
    // in a place nothing renders; it falls back to unfiled instead.
    expect(kept[1]?.folderId).toBeUndefined();
    expect(kept[2]?.folderId).toBeUndefined();
  });

  /**
   * Files from before folders were records kept the grouping as a name label on
   * each bookmark. The migration materialises each distinct label as a real
   * top-level folder, so an upgrade keeps every grouping the user had.
   */
  it("migrates the legacy name label into a real top-level folder", () => {
    const { bookmarkFolders: folders, bookmarks: kept } = sanitizeBookmarksSection(
      [
        { id: "a", url: "https://a.example.com", folder: "工作" },
        { id: "b", url: "https://b.example.com", folder: "工作" },
        { id: "c", url: "https://c.example.com", folder: "   " },
      ],
      [],
    );
    expect(folders).toHaveLength(1);
    expect(folders[0]?.name).toBe("工作");
    expect(folders[0]?.parentId).toBeUndefined();
    expect(kept.map((bookmark) => bookmark.folderId)).toEqual([
      folders[0]?.id,
      folders[0]?.id,
      undefined,
    ]);
    // The old field must not survive: only the id points anywhere.
    expect(kept[0]).not.toHaveProperty("folder");
  });

  it("repairs a parent cycle by dropping the closing link", () => {
    const { bookmarkFolders: folders } = sanitizeBookmarksSection(
      [],
      [
        { id: "f1", name: "一", parentId: "f2", order: 0 },
        { id: "f2", name: "二", parentId: "f1", order: 1 },
        { id: "f3", name: "三", order: 2 },
      ],
    );
    // Both folders survive; one of the two links goes so the tree has a root.
    const rooted = folders.filter((folder) => !folder.parentId);
    expect(rooted).toHaveLength(2);
    expect(folders.map((folder) => folder.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("survives a save-and-reload cycle with its folder tree intact", async () => {
    // The end-to-end shape of the sanitiser bug above: through the service,
    // written to disk, read back by a fresh instance. Anything the sanitiser
    // forgets is gone here even though every in-memory assertion still passes.
    const folder = service.saveBookmarkFolder({ name: "项目" });
    const child = service.saveBookmarkFolder({ name: "后台", parentId: folder.id });
    service.saveBookmark({ name: "带文件夹", url: "https://keep.example.com", folderId: child.id });
    const reloaded = makeService();
    await reloaded.initialize();
    expect(reloaded.snapshot().bookmarkFolders.map((item) => item.name)).toEqual(["项目", "后台"]);
    expect(reloaded.snapshot().bookmarkFolders[1]?.parentId).toBe(folder.id);
    expect(reloaded.snapshot().bookmarks[0]?.folderId).toBe(child.id);
  });
});

describe("bookmarks in a workspace export", () => {
  it("travels with the workspace and counts itself", () => {
    service.saveBookmark({ name: "带上我", url: "https://carry.example.com" });
    const { file, counts } = service.exportWorkspace();
    expect(file.bookmarks).toHaveLength(1);
    expect(counts.bookmarks).toBe(1);
    const parsed = parseExportFile(JSON.parse(JSON.stringify(file)));
    expect(parsed.bookmarks?.[0]?.name).toBe("带上我");
  });

  it("imports into a workspace with no sites at all", async () => {
    service.saveBookmark({ name: "不带站点", url: "https://lonely.example.com" });
    const file = JSON.parse(JSON.stringify(service.exportWorkspace().file));

    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "ensemble-bookmarks-target-"));
    service = makeService();
    await service.initialize();

    const result = service.importWorkspace(parseExportFile(file));
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
    expect(service.snapshot().bookmarks.map((item) => item.name)).toEqual(["不带站点"]);
  });

  /*
   * Order is reassigned on import rather than taken from the file. Two machines
   * both number their own bookmarks from 0; trusting the incoming numbers would
   * interleave the two sets instead of appending one after the other.
   */
  it("appends imported bookmarks after the ones already here", async () => {
    service.saveBookmark({ name: "本地", url: "https://local.example.com" });
    const file = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      sites: [],
      identities: [],
      views: [],
      layoutPresets: [],
      bookmarks: [
        {
          id: "remote-a",
          name: "外来一",
          url: "https://remote-a.example.com",
          order: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "remote-b",
          name: "外来二",
          url: "https://remote-b.example.com",
          order: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    };
    service.importWorkspace(parseExportFile(file));
    expect(service.snapshot().bookmarks.map((item) => item.name)).toEqual([
      "本地",
      "外来一",
      "外来二",
    ]);
  });

  it("drops a malformed bookmark instead of failing the whole import", () => {
    const file = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      sites: [],
      identities: [],
      views: [],
      layoutPresets: [],
      bookmarks: [
        { id: "bad", name: "坏的", url: "javascript:alert(1)" },
        { id: "good", name: "好的", url: "https://good.example.com" },
      ],
    };
    const parsed = parseExportFile(file);
    expect(parsed.bookmarks?.map((item) => item.id)).toEqual(["good"]);
    expect(exportCounts(parsed).bookmarks).toBe(1);
  });

  it("writes the bookmark into the workspace file on disk", () => {
    service.saveBookmark({ name: "落盘", url: "https://disk.example.com" });
    const raw = readFileSync(join(dir, "workspace.json"), "utf8");
    expect(raw).toContain("disk.example.com");
  });

  it("carries the folder tree and keeps bookmarks filed after import", async () => {
    const folder = service.saveBookmarkFolder({ name: "工作" });
    service.saveBookmark({ name: "带上我", url: "https://carry.example.com", folderId: folder.id });
    const file = JSON.parse(JSON.stringify(service.exportWorkspace().file));

    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "ensemble-bookmarks-tree-"));
    service = makeService();
    await service.initialize();

    service.importWorkspace(parseExportFile(file));
    const importedFolder = service.snapshot().bookmarkFolders[0];
    expect(importedFolder?.name).toBe("工作");
    expect(service.snapshot().bookmarks[0]?.folderId).toBe(importedFolder?.id);
  });

  it("unfiles an imported bookmark whose folder is not in the file", () => {
    const now = new Date().toISOString();
    const file = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: now,
      sites: [],
      identities: [],
      views: [],
      layoutPresets: [],
      bookmarks: [
        {
          id: "x",
          name: "孤儿",
          url: "https://x.example.com",
          folderId: "ghost",
          order: 0,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const parsed = parseExportFile(file);
    // Importing half of a tree must not strand the bookmark in a folder that
    // nobody has; the pointer is dropped at parse time, before any merge.
    expect(parsed.bookmarks?.[0]?.folderId).toBeUndefined();
  });
});

/**
 * Folders are records because they nest.
 *
 * The tree owns names and parents, so a rename is one write that never touches
 * the bookmarks inside, and a delete is a re-parent rather than a cascade.
 * These tests pin the rules the tree lives by.
 */
describe("bookmark folder tree", () => {
  it("creates a folder and files a bookmark into it", () => {
    expect(service.snapshot().bookmarkFolders).toEqual([]);
    const folder = service.saveBookmarkFolder({ name: "工作" });
    expect(folder.parentId).toBeUndefined();
    const bookmark = service.saveBookmark({
      name: "a",
      url: "https://a.example.com",
      folderId: folder.id,
    });
    expect(bookmark.folderId).toBe(folder.id);
  });

  it("rejects a bookmark whose folder does not exist", () => {
    expect(() =>
      service.saveBookmark({ name: "a", url: "https://a.example.com", folderId: "missing" }),
    ).toThrow("文件夹不存在");
  });

  it("nests folders and appends among siblings", () => {
    const parent = service.saveBookmarkFolder({ name: "工作" });
    const child = service.saveBookmarkFolder({ name: "后台", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    const second = service.saveBookmarkFolder({ name: "前台", parentId: parent.id });
    expect(second.order).toBeGreaterThan(child.order);
  });

  it("renames a folder without touching its bookmarks", () => {
    const folder = service.saveBookmarkFolder({ name: "工作" });
    const bookmark = service.saveBookmark({
      name: "a",
      url: "https://a.example.com",
      folderId: folder.id,
    });
    const renamed = service.saveBookmarkFolder({ id: folder.id, name: "项目" });
    expect(renamed.id).toBe(folder.id);
    expect(renamed.name).toBe("项目");
    // The id is stable, so the bookmark's pointer needed no rewrite at all.
    expect(service.snapshot().bookmarks[0]?.folderId).toBe(bookmark.folderId);
  });

  it("refuses to move a folder under itself or its own descendant", () => {
    const parent = service.saveBookmarkFolder({ name: "工作" });
    const child = service.saveBookmarkFolder({ name: "后台", parentId: parent.id });
    expect(() =>
      service.saveBookmarkFolder({ id: parent.id, name: "工作", parentId: child.id }),
    ).toThrow("子文件夹");
    expect(() =>
      service.saveBookmarkFolder({ id: parent.id, name: "工作", parentId: parent.id }),
    ).toThrow();
  });

  it("deletes a folder by re-parenting its contents one level up", () => {
    const parent = service.saveBookmarkFolder({ name: "工作" });
    const child = service.saveBookmarkFolder({ name: "后台", parentId: parent.id });
    const inner = service.saveBookmarkFolder({ name: "报表", parentId: child.id });
    service.saveBookmark({ name: "a", url: "https://a.example.com", folderId: child.id });
    const result = service.deleteBookmarkFolder(child.id);
    expect(result).toEqual({ folders: 1, bookmarks: 1 });
    const survivors = service.snapshot().bookmarkFolders;
    expect(survivors.find((item) => item.id === child.id)).toBeUndefined();
    // The subfolder and the bookmark both moved up together, to the same parent.
    expect(survivors.find((item) => item.id === inner.id)?.parentId).toBe(parent.id);
    expect(service.snapshot().bookmarks[0]?.folderId).toBe(parent.id);
  });

  it("unfiles the contents of a deleted top-level folder", () => {
    const folder = service.saveBookmarkFolder({ name: "工作" });
    service.saveBookmark({ name: "a", url: "https://a.example.com", folderId: folder.id });
    service.deleteBookmarkFolder(folder.id);
    expect(service.snapshot().bookmarkFolders).toEqual([]);
    expect(service.snapshot().bookmarks[0]?.folderId).toBeUndefined();
  });

  it("moves a subtree with one parentId change", () => {
    const root = service.saveBookmarkFolder({ name: "工作" });
    const other = service.saveBookmarkFolder({ name: "个人" });
    const child = service.saveBookmarkFolder({ name: "后台", parentId: root.id });
    service.saveBookmarkFolder({ id: child.id, name: "后台", parentId: other.id });
    expect(
      service.snapshot().bookmarkFolders.find((item) => item.id === child.id)?.parentId,
    ).toBe(other.id);
  });

  it("refuses to delete or update a folder that is not there", () => {
    expect(() => service.deleteBookmarkFolder("missing")).toThrow("文件夹不存在");
    expect(() => service.saveBookmarkFolder({ id: "missing", name: "x" })).toThrow("文件夹不存在");
    expect(() => service.saveBookmarkFolder({ name: "   " })).toThrow();
  });
});
