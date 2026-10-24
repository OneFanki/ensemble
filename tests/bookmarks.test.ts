import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { sanitizeBookmarks } from "@core/processes/registry";
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
    const kept = sanitizeBookmarks([
      { id: "a", name: "好的", url: "https://example.com" },
      { id: "b", name: "坏的", url: "javascript:alert(1)" },
      { id: "c", name: "空的", url: "   " },
      null,
      42,
    ]);
    expect(kept.map((item) => item.id)).toEqual(["a"]);
  });

  it("drops duplicate ids and renames the unnamed", () => {
    const kept = sanitizeBookmarks([
      { id: "a", url: "https://first.example.com" },
      { id: "a", url: "https://second.example.com" },
      { url: "https://third.example.com" },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[1]?.id).toBe("bookmark-2");
    expect(kept[1]?.name).toBe("third.example.com");
  });

  it("sorts by the stored order", () => {
    const kept = sanitizeBookmarks([
      { id: "b", url: "https://b.example.com", order: 2 },
      { id: "a", url: "https://a.example.com", order: 1 },
    ]);
    expect(kept.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("keeps a data: icon and drops anything else", () => {
    const kept = sanitizeBookmarks([
      { id: "a", url: "https://a.example.com", favicon: "data:image/png;base64,AAAA" },
      { id: "b", url: "https://b.example.com", favicon: "https://b.example.com/i.png" },
    ]);
    expect(kept[0]?.favicon).toBe("data:image/png;base64,AAAA");
    expect(kept[1]?.favicon).toBeUndefined();
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
});
