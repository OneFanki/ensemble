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
  dir = mkdtempSync(join(tmpdir(), "ensemble-groups-"));
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

async function makeSite(tagIds?: string[]) {
  return await service.saveSite({
    name: "订单服务-测试站点",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    autoSubmit: false,
    ...(tagIds ? { tagIds } : {}),
  });
}

describe("site groups", () => {
  it("creates a group and attaches it to a site", async () => {
    const group = service.saveSiteGroup({ name: "后台系统", color: "teal" });
    const site = await makeSite([group.id]);
    expect(site.tagIds).toEqual([group.id]);
    expect(service.snapshot().siteGroups).toHaveLength(1);
  });

  it("rejects a duplicate name regardless of case", () => {
    service.saveSiteGroup({ name: "后台系统", color: "teal" });
    expect(() => service.saveSiteGroup({ name: "后台系统", color: "rose" })).toThrow();
  });

  it("allows renaming a group without tripping its own duplicate check", () => {
    const group = service.saveSiteGroup({ name: "后台", color: "teal" });
    const renamed = service.saveSiteGroup({ id: group.id, name: "后台系统", color: "amber" });
    expect(renamed.name).toBe("后台系统");
    expect(renamed.color).toBe("amber");
  });

  it("ignores group ids that do not exist", async () => {
    const site = await makeSite(["missing-group"]);
    // An unknown id would make the site vanish from every group, so it is dropped.
    expect(site.tagIds).toBeUndefined();
  });

  it("keeps only known groups when a site has a mix", async () => {
    const real = service.saveSiteGroup({ name: "前台", color: "blue" });
    const site = await makeSite([real.id, "ghost"]);
    expect(site.tagIds).toEqual([real.id]);
  });

  it("deleting a group unlinks it but keeps the site and its accounts", async () => {
    const group = service.saveSiteGroup({ name: "后台系统", color: "teal" });
    const site = await makeSite([group.id]);
    const account = await service.saveIdentity({
      siteId: site.id,
      name: "管理员 · 主账号",
      username: "admin@example.test",
      role: "admin",
      color: "amber",
      passwordMode: "inherit",
    });

    service.deleteSiteGroup(group.id);

    const snapshot = service.snapshot();
    expect(snapshot.siteGroups).toHaveLength(0);
    const survivor = snapshot.sites.find((item) => item.id === site.id);
    expect(survivor).toBeDefined();
    expect(survivor?.tagIds).toBeUndefined();
    expect(snapshot.identities.find((item) => item.id === account.id)).toBeDefined();
  });

  it("removing a site does not touch its groups", async () => {
    const group = service.saveSiteGroup({ name: "后台系统", color: "teal" });
    const site = await makeSite([group.id]);
    service.deleteSite(site.id);
    expect(service.snapshot().siteGroups).toHaveLength(1);
  });

  it("a site can carry several groups", async () => {
    const a = service.saveSiteGroup({ name: "后台", color: "teal" });
    const b = service.saveSiteGroup({ name: "测试", color: "rose" });
    const site = await makeSite([a.id, b.id]);
    expect(site.tagIds).toEqual([a.id, b.id]);
  });

  it("deduplicates group ids on save", async () => {
    const group = service.saveSiteGroup({ name: "后台", color: "teal" });
    const site = await makeSite([group.id, group.id]);
    expect(site.tagIds).toEqual([group.id]);
  });

  it("an account's groups are its site's, not its own", async () => {
    const group = service.saveSiteGroup({ name: "生产", color: "rose" });
    const site = await makeSite([group.id]);
    const identity = await service.saveIdentity({
      siteId: site.id,
      name: "管理员 · 主账号",
      username: "admin@example.test",
      role: "admin",
      color: "amber",
      passwordMode: "inherit",
    });
    // Nothing to copy onto the account: the site is the grouping.
    expect(identity).not.toHaveProperty("tagIds");
    expect(service.snapshot().sites.find((item) => item.id === site.id)?.tagIds).toEqual([
      group.id,
    ]);
    expect(service.snapshot().siteGroups.map((item) => item.name)).toEqual(["生产"]);
  });
});

describe("site group storage hygiene", () => {
  it("drops malformed groups instead of failing the workspace", () => {
    const result = sanitizeWorkspace({
      siteGroups: [
        { id: "ok", name: "有效", color: "teal", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "no-name", name: "   ", color: "teal" },
        { id: "bad-color", name: "颜色错误", color: "chartreuse" },
        { name: "缺 id", color: "teal" },
      ] as never,
      sites: [],
    });
    expect(result.siteGroups.map((group) => group.id)).toEqual(["ok", "bad-color"]);
    // An unknown colour falls back rather than dropping the group.
    expect(result.siteGroups[1]?.color).toBe("slate");
  });

  it("prunes group references that point at groups which no longer exist", () => {
    const result = sanitizeWorkspace({
      siteGroups: [{ id: "t1", name: "保留", color: "teal", createdAt: "2026-01-01T00:00:00.000Z" }],
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
    expect(result.siteGroups).toHaveLength(1);
  });

  it("reads the list from the older `siteTags` key", () => {
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
    expect(result.siteGroups.map((group) => group.id)).toEqual(["t1"]);
    expect(result.sites[0]?.tagIds).toEqual(["t1"]);
  });

  it("reads the list from the `tags` key a released build wrote", () => {
    const result = sanitizeWorkspace({
      tags: [{ id: "t1", name: "生产环境", color: "rose" }],
      sites: [],
    } as never);
    expect(result.siteGroups).toHaveLength(1);
    expect(result.siteGroups[0]?.name).toBe("生产环境");
  });

  it("keeps every account and site while dropping the old account labels", () => {    const result = sanitizeWorkspace({
      tags: [{ id: "t1", name: "生产", color: "rose" }],
      sites: [
        {
          id: "s1",
          name: "站点",
          baseUrl: "http://localhost:3000",
          loginPath: "/login",
          tagIds: ["t1"],
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
          tagIds: ["t1"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as never);
    expect(result.sites[0]?.tagIds).toEqual(["t1"]);
    // The account and the view survive whole; only their own labels are gone.
    const account = result.identities[0];
    expect(account?.id).toBe("i1");
    expect(account?.username).toBe("user@example.test");
    expect(account).not.toHaveProperty("tagIds");
    expect(result.views[0]?.id).toBe("v1");
    expect(result.views[0]).not.toHaveProperty("tagIds");
    expect(result.siteGroups).toHaveLength(1);
  });

  it("a fresh workspace starts with no groups", () => {
    expect(emptyWorkspace().siteGroups).toEqual([]);
  });
});
