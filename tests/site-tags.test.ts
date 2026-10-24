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

describe("tags", () => {
  it("creates a tag and attaches it to a site", () => {
    const tag = service.saveTag({ name: "后台系统", color: "teal" });
    const site = makeSite([tag.id]);
    expect(site.tagIds).toEqual([tag.id]);
    expect(service.snapshot().tags).toHaveLength(1);
  });

  it("rejects a duplicate name regardless of case", () => {
    service.saveTag({ name: "后台系统", color: "teal" });
    expect(() => service.saveTag({ name: "后台系统", color: "rose" })).toThrow();
  });

  it("allows renaming a tag without tripping its own duplicate check", () => {
    const tag = service.saveTag({ name: "后台", color: "teal" });
    const renamed = service.saveTag({ id: tag.id, name: "后台系统", color: "amber" });
    expect(renamed.name).toBe("后台系统");
    expect(renamed.color).toBe("amber");
  });

  it("ignores tag ids that do not exist", () => {
    const site = makeSite(["missing-tag"]);
    // An unknown id would make the site vanish from every group, so it is dropped.
    expect(site.tagIds).toBeUndefined();
  });

  it("keeps only known tags when a site has a mix", () => {
    const real = service.saveTag({ name: "前台", color: "blue" });
    const site = makeSite([real.id, "ghost"]);
    expect(site.tagIds).toEqual([real.id]);
  });

  it("deleting a tag unlinks it but keeps the site", () => {
    const tag = service.saveTag({ name: "后台系统", color: "teal" });
    const site = makeSite([tag.id]);

    service.deleteTag(tag.id);

    const snapshot = service.snapshot();
    expect(snapshot.tags).toHaveLength(0);
    const survivor = snapshot.sites.find((item) => item.id === site.id);
    expect(survivor).toBeDefined();
    expect(survivor?.tagIds).toBeUndefined();
  });

  it("removing a site does not touch its tags", () => {
    const tag = service.saveTag({ name: "后台系统", color: "teal" });
    const site = makeSite([tag.id]);
    service.deleteSite(site.id);
    expect(service.snapshot().tags).toHaveLength(1);
  });

  it("a site can carry several tags", () => {
    const a = service.saveTag({ name: "后台", color: "teal" });
    const b = service.saveTag({ name: "测试", color: "rose" });
    const site = makeSite([a.id, b.id]);
    expect(site.tagIds).toEqual([a.id, b.id]);
  });

  it("deduplicates tag ids on save", () => {
    const tag = service.saveTag({ name: "后台", color: "teal" });
    const site = makeSite([tag.id, tag.id]);
    expect(site.tagIds).toEqual([tag.id]);
  });

  it("tags identities with the same namespace as sites", () => {
    const tag = service.saveTag({ name: "生产", color: "rose" });
    const site = makeSite();
    const identity = service.saveIdentity({
      siteId: site.id,
      name: "管理员 · 主账号",
      username: "admin@example.test",
      role: "admin",
      color: "amber",
      passwordMode: "inherit",
      tagIds: [tag.id],
    });
    expect(identity.tagIds).toEqual([tag.id]);
    expect(service.snapshot().tags.map((item) => item.name)).toEqual(["生产"]);
  });

  it("tags views with the same namespace", () => {
    const tag = service.saveTag({ name: "回归", color: "violet" });
    const site = makeSite();
    const first = service.saveIdentity({
      siteId: site.id,
      name: "成员",
      username: "member@example.test",
      role: "member",
      color: "teal",
      passwordMode: "inherit",
    });
    const view = service.saveView({
      siteId: site.id,
      name: "跨站点视图",
      identityIds: [first.id],
      layoutId: "2x1",
      slotAssignments: {},
      paths: {},
      tagIds: [tag.id],
    });
    expect(view.tagIds).toEqual([tag.id]);
  });

  it("deleting a tag unlinks it from identities and views too", () => {
    const tag = service.saveTag({ name: "测试", color: "blue" });
    const site = makeSite([tag.id]);
    const identity = service.saveIdentity({
      siteId: site.id,
      name: "访客",
      username: "guest@example.test",
      role: "guest",
      color: "violet",
      passwordMode: "inherit",
      tagIds: [tag.id],
    });
    const view = service.saveView({
      siteId: site.id,
      name: "视图",
      identityIds: [identity.id],
      layoutId: "2x1",
      slotAssignments: {},
      paths: {},
      tagIds: [tag.id],
    });

    service.deleteTag(tag.id);

    const snapshot = service.snapshot();
    expect(snapshot.tags).toHaveLength(0);
    expect(snapshot.sites[0]?.tagIds).toBeUndefined();
    expect(snapshot.identities.find((item) => item.id === identity.id)?.tagIds).toBeUndefined();
    expect(snapshot.views.find((item) => item.id === view.id)?.tagIds).toBeUndefined();
  });
});

describe("tag storage hygiene", () => {
  it("drops malformed tags instead of failing the workspace", () => {
    const result = sanitizeWorkspace({
      tags: [
        { id: "ok", name: "有效", color: "teal", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "no-name", name: "   ", color: "teal" },
        { id: "bad-color", name: "颜色错误", color: "chartreuse" },
        { name: "缺 id", color: "teal" },
      ] as never,
      sites: [],
    });
    expect(result.tags.map((tag) => tag.id)).toEqual(["ok", "bad-color"]);
    // An unknown colour falls back rather than dropping the tag.
    expect(result.tags[1]?.color).toBe("slate");
  });

  it("prunes tag references that point at tags which no longer exist", () => {
    const result = sanitizeWorkspace({
      tags: [{ id: "t1", name: "保留", color: "teal", createdAt: "2026-01-01T00:00:00.000Z" }],
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
      identities: [
        {
          id: "i1",
          siteId: "s1",
          name: "账号",
          username: "user@example.test",
          role: "member",
          color: "teal",
          passwordMode: "inherit",
          status: "unknown",
          tagIds: ["t1", "ghost"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      views: [
        {
          id: "v1",
          siteId: "s1",
          name: "视图",
          identityIds: ["i1"],
          layoutId: "2x1",
          slotAssignments: {},
          paths: {},
          tagIds: ["ghost", "t1"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    expect(result.sites[0]?.tagIds).toEqual(["t1"]);
    expect(result.identities[0]?.tagIds).toEqual(["t1"]);
    expect(result.views[0]?.tagIds).toEqual(["t1"]);
    expect(result.tags).toHaveLength(1);
  });

  it("reads a workspace written when tags were site-only", () => {
    const result = sanitizeWorkspace({
      siteTags: [{ id: "t1", name: "旧标签", color: "teal", createdAt: "2026-01-01T00:00:00.000Z" }],
      sites: [
        {
          id: "s1",
          name: "站点",
          baseUrl: "http://localhost:3000",
          loginPath: "/login",
          autoSubmit: false,
          tagIds: ["t1"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    expect(result.tags.map((tag) => tag.id)).toEqual(["t1"]);
    expect(result.sites[0]?.tagIds).toEqual(["t1"]);
  });

  it("a fresh workspace starts with no tags", () => {
    expect(emptyWorkspace().tags).toEqual([]);
  });
});
