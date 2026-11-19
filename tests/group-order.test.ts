import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Group order is the order of the site sections on the account page. Like views,
 * the stored array order *is* the order, so the tests check the array, not a
 * field.
 */
let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-group-order-"));
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

function addGroup(name: string) {
  return service.saveSiteGroup({ name, color: "teal" });
}

describe("group ordering", () => {
  it("keeps the order groups were created in", () => {
    for (const name of ["甲", "乙", "丙"]) addGroup(name);
    expect(service.snapshot().siteGroups.map((group) => group.name)).toEqual(["甲", "乙", "丙"]);
  });

  it("moves a group to the index it was dropped on", () => {
    const a = addGroup("甲");
    addGroup("乙");
    addGroup("丙");
    service.moveSiteGroup(a.id, 2);
    expect(service.snapshot().siteGroups.map((group) => group.name)).toEqual(["乙", "丙", "甲"]);
  });

  it("moves a group backwards as well as forwards", () => {
    addGroup("甲");
    addGroup("乙");
    const c = addGroup("丙");
    service.moveSiteGroup(c.id, 0);
    expect(service.snapshot().siteGroups.map((group) => group.name)).toEqual(["丙", "甲", "乙"]);
  });

  it("clamps an index past the end instead of throwing", () => {
    addGroup("甲");
    const b = addGroup("乙");
    service.moveSiteGroup(b.id, 99);
    expect(service.snapshot().siteGroups.map((group) => group.name)).toEqual(["甲", "乙"]);
  });

  it("refuses an id that is not there", () => {
    expect(() => service.moveSiteGroup("does-not-exist", 0)).toThrow();
  });

  it("persists the new order to disk", async () => {
    const a = addGroup("甲");
    addGroup("乙");
    service.moveSiteGroup(a.id, 1);

    // A second service reading the same directory is what proves the order was
    // written, not just held in memory.
    const reopened = new WorkspaceService({
      userDataDir: dir,
      profileRoot: join(dir, "profiles"),
      platform: "win32",
      secretBox: new MemorySecretBox(),
      appVersion: "test",
    });
    await reopened.initialize();
    expect(reopened.snapshot().siteGroups.map((group) => group.name)).toEqual(["乙", "甲"]);
  });
});
