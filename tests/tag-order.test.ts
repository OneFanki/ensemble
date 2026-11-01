import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Tag order is a display order with side effects: the sites page draws one
 * group per tag in this order, and every tag filter follows it. Like views, the
 * stored array order *is* the order, so the tests check the array, not a field.
 */
let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-tag-order-"));
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

function addTag(name: string) {
  return service.saveTag({ name, color: "teal" });
}

describe("tag ordering", () => {
  it("keeps the order tags were created in", () => {
    for (const name of ["甲", "乙", "丙"]) addTag(name);
    expect(service.snapshot().tags.map((tag) => tag.name)).toEqual(["甲", "乙", "丙"]);
  });

  it("moves a tag to the index it was dropped on", () => {
    const a = addTag("甲");
    addTag("乙");
    addTag("丙");
    service.moveTag(a.id, 2);
    expect(service.snapshot().tags.map((tag) => tag.name)).toEqual(["乙", "丙", "甲"]);
  });

  it("moves a tag backwards as well as forwards", () => {
    addTag("甲");
    addTag("乙");
    const c = addTag("丙");
    service.moveTag(c.id, 0);
    expect(service.snapshot().tags.map((tag) => tag.name)).toEqual(["丙", "甲", "乙"]);
  });

  it("clamps an index past the end instead of throwing", () => {
    addTag("甲");
    const b = addTag("乙");
    service.moveTag(b.id, 99);
    expect(service.snapshot().tags.map((tag) => tag.name)).toEqual(["甲", "乙"]);
  });

  it("refuses an id that is not there", () => {
    expect(() => service.moveTag("does-not-exist", 0)).toThrow();
  });

  it("persists the new order to disk", async () => {
    const a = addTag("甲");
    addTag("乙");
    service.moveTag(a.id, 1);

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
    expect(reopened.snapshot().tags.map((tag) => tag.name)).toEqual(["乙", "甲"]);
  });
});
