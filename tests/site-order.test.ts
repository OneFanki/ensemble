import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Site order is one global list drawn inside tag groups: a site with two tags
 * appears in two groups, and both follow the same stored order. Reordering is
 * therefore an array splice, and moving a site between groups stays an edit of
 * its tags.
 */
let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-site-order-"));
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

async function addSite(name: string) {
  return await service.saveSite({
    name,
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    autoSubmit: false,
  });
}

describe("site ordering", async () => {
  it("keeps the order sites were created in", async () => {
    for (const name of ["甲", "乙", "丙"]) await addSite(name);
    expect(service.snapshot().sites.map((site) => site.name)).toEqual(["甲", "乙", "丙"]);
  });

  it("moves a site to the index it was dropped on", async () => {
    const a = await addSite("甲");
    await addSite("乙");
    await addSite("丙");
    service.moveSite(a.id, 2);
    expect(service.snapshot().sites.map((site) => site.name)).toEqual(["乙", "丙", "甲"]);
  });

  it("moves a site backwards as well as forwards", async () => {
    await addSite("甲");
    await addSite("乙");
    const c = await addSite("丙");
    service.moveSite(c.id, 0);
    expect(service.snapshot().sites.map((site) => site.name)).toEqual(["丙", "甲", "乙"]);
  });

  it("clamps an index past the end instead of throwing", async () => {
    await addSite("甲");
    const b = await addSite("乙");
    service.moveSite(b.id, 99);
    expect(service.snapshot().sites.map((site) => site.name)).toEqual(["甲", "乙"]);
  });

  it("refuses an id that is not there", () => {
    expect(() => service.moveSite("does-not-exist", 0)).toThrow();
  });

  it("keeps tag membership untouched", async () => {
    const tag = service.saveTag({ name: "后台系统", color: "teal" });
    const tagged = await service.saveSite({
      name: "甲",
      baseUrl: "http://localhost:3000",
      loginPath: "/login",
      autoSubmit: false,
      tagIds: [tag.id],
    });
    await addSite("乙");
    service.moveSite(tagged.id, 1);
    expect(service.snapshot().sites.find((site) => site.id === tagged.id)?.tagIds).toEqual([
      tag.id,
    ]);
  });
});
