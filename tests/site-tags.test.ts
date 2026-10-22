import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";
import { emptyWorkspace, sanitizeWorkspace } from "@core/processes/registry";

let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-tags-"));
  service = new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
  });
  await service.initialize();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSite(tagIds?: string[]) {
  return service.saveSite({
    name: "订单服务-测试站点",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    autoSubmit: false,
    ...(tagIds ? { tagIds } : {}),
  });
}

describe("site tags", () => {
  it("creates a tag and attaches it to a site", () => {
    const tag = service.saveSiteTag({ name: "后台系统", color: "teal" });
    const site = makeSite([tag.id]);
    expect(site.tagIds).toEqual([tag.id]);
    expect(service.snapshot().siteTags).toHaveLength(1);
  });

  it("rejects a duplicate name regardless of case", () => {
    service.saveSiteTag({ name: "后台系统", color: "teal" });
    expect(() => service.saveSiteTag({ name: "后台系统", color: "rose" })).toThrow();
  });

  it("allows renaming a tag without tripping its own duplicate check", () => {
    const tag = service.saveSiteTag({ name: "后台", color: "teal" });
    const renamed = service.saveSiteTag({ id: tag.id, name: "后台系统", color: "amber" });
    expect(renamed.name).toBe("后台系统");
    expect(renamed.color).toBe("amber");
  });

  it("ignores tag ids that do not exist", () => {
    const site = makeSite(["missing-tag"]);
    // An unknown id would make the site vanish from every group, so it is dropped.
    expect(site.tagIds).toBeUndefined();
  });

  it("keeps only known tags when a site has a mix", () => {
    const real = service.saveSiteTag({ name: "前台", color: "blue" });
    const site = makeSite([real.id, "ghost"]);
    expect(site.tagIds).toEqual([real.id]);
  });

  it("deleting a tag unlinks it but keeps the site", () => {
    const tag = service.saveSiteTag({ name: "后台系统", color: "teal" });
    const site = makeSite([tag.id]);

    service.deleteSiteTag(tag.id);

    const snapshot = service.snapshot();
    expect(snapshot.siteTags).toHaveLength(0);
    const survivor = snapshot.sites.find((item) => item.id === site.id);
    expect(survivor).toBeDefined();
    expect(survivor?.tagIds).toBeUndefined();
  });

  it("removing a site does not touch its tags", () => {
    const tag = service.saveSiteTag({ name: "后台系统", color: "teal" });
    const site = makeSite([tag.id]);
    service.deleteSite(site.id);
    expect(service.snapshot().siteTags).toHaveLength(1);
  });

  it("a site can carry several tags", () => {
    const a = service.saveSiteTag({ name: "后台", color: "teal" });
    const b = service.saveSiteTag({ name: "测试", color: "rose" });
    const site = makeSite([a.id, b.id]);
    expect(site.tagIds).toEqual([a.id, b.id]);
  });

  it("deduplicates tag ids on save", () => {
    const tag = service.saveSiteTag({ name: "后台", color: "teal" });
    const site = makeSite([tag.id, tag.id]);
    expect(site.tagIds).toEqual([tag.id]);
  });
});

describe("tag storage hygiene", () => {
  it("drops malformed tags instead of failing the workspace", () => {
    const result = sanitizeWorkspace({
      siteTags: [
        { id: "ok", name: "有效", color: "teal", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "no-name", name: "   ", color: "teal" },
        { id: "bad-color", name: "颜色错误", color: "chartreuse" },
        { name: "缺 id", color: "teal" },
      ] as never,
      sites: [],
    });
    expect(result.siteTags.map((tag) => tag.id)).toEqual(["ok", "bad-color"]);
    // An unknown colour falls back rather than dropping the tag.
    expect(result.siteTags[1]?.color).toBe("slate");
  });

  it("prunes tag references that point at tags which no longer exist", () => {
    const result = sanitizeWorkspace({
      siteTags: [{ id: "t1", name: "保留", color: "teal", createdAt: "2026-01-01T00:00:00.000Z" }],
      sites: [
        {
          id: "s1",
          name: "站点",
          baseUrl: "http://localhost:3000",
          loginPath: "/login",
          autoSubmit: false,
          tagIds: ["t1", "t2"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    expect(result.sites[0]?.tagIds).toEqual(["t1"]);
    expect(result.siteTags).toHaveLength(1);
  });

  it("a fresh workspace starts with no tags", () => {
    expect(emptyWorkspace().siteTags).toEqual([]);
  });
});
