import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Reordering, and the two things that make it more than an array splice.
 *
 * 1. The stored array order *is* the list order. A separate `order` field would
 *    be a second source of truth, and the two would drift the first time anything
 *    wrote a view without knowing about it.
 * 2. A drop index arrives from a filtered list. Translating "drop onto the third
 *    visible row" into a position in the full array is the part that goes wrong
 *    quietly, so it is checked against a real service rather than a mock.
 */
const dirs: string[] = [];
const services: WorkspaceService[] = [];

async function makeService(): Promise<WorkspaceService> {
  const userDataDir = await mkdtemp(join(tmpdir(), "ensemble-view-order-"));
  dirs.push(userDataDir);
  const service = new WorkspaceService({
    userDataDir,
    profileRoot: join(userDataDir, "profiles"),
    platform: process.platform as "win32" | "darwin" | "linux",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
    workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  });
  services.push(service);
  await service.initialize();
  return service;
}

afterAll(async () => {
  await Promise.all(services.map((service) => service.stopAll().catch(() => {})));
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })),
  );
});

/** A site plus one account, so a view has a legal member to point at. */
function seed(service: WorkspaceService): { siteId: string; identityId: string } {
  const site = service.saveSite({
    name: "排序检查",
    baseUrl: "http://127.0.0.1:1",
    loginPath: "/login",
  });
  const identity = service.saveIdentity({
    siteId: site.id,
    name: "排序账号",
    username: "order@example.test",
    role: "member",
    color: "amber",
    passwordMode: "inherit",
    startPath: "/",
  });
  return { siteId: site.id, identityId: identity.id };
}

function addView(service: WorkspaceService, siteId: string, identityId: string, name: string) {
  return service.saveView({
    siteId,
    name,
    identityIds: [identityId],
    layoutId: "1x1",
    slotAssignments: {},
    paths: {},
  });
}

describe("view ordering", () => {
  it("keeps the order views were created in", async () => {
    const service = await makeService();
    const { siteId, identityId } = seed(service);
    for (const name of ["甲", "乙", "丙"]) addView(service, siteId, identityId, name);
    expect(service.snapshot().views.map((view) => view.name)).toEqual(["甲", "乙", "丙"]);
  });

  it("moves a view to the index it was dropped on", async () => {
    const service = await makeService();
    const { siteId, identityId } = seed(service);
    const a = addView(service, siteId, identityId, "甲");
    addView(service, siteId, identityId, "乙");
    addView(service, siteId, identityId, "丙");

    // Drag the first view onto the third row.
    service.moveView(a.id, 2);
    expect(service.snapshot().views.map((view) => view.name)).toEqual(["乙", "丙", "甲"]);
  });

  it("moves a view backwards as well as forwards", async () => {
    const service = await makeService();
    const { siteId, identityId } = seed(service);
    addView(service, siteId, identityId, "甲");
    addView(service, siteId, identityId, "乙");
    const c = addView(service, siteId, identityId, "丙");

    service.moveView(c.id, 0);
    expect(service.snapshot().views.map((view) => view.name)).toEqual(["丙", "甲", "乙"]);
  });

  it("clamps an index from a filtered list instead of throwing", async () => {
    const service = await makeService();
    const { siteId, identityId } = seed(service);
    addView(service, siteId, identityId, "甲");
    const b = addView(service, siteId, identityId, "乙");

    // A filtered list can report an index past the end of the full array.
    service.moveView(b.id, 99);
    expect(service.snapshot().views.map((view) => view.name)).toEqual(["甲", "乙"]);
  });

  it("persists the new order to disk", async () => {
    const service = await makeService();
    const { siteId, identityId } = seed(service);
    const a = addView(service, siteId, identityId, "甲");
    addView(service, siteId, identityId, "乙");

    service.moveView(a.id, 1);
    // A second service reading the same directory is what proves the order was
    // written, not just held in memory.
    const reopened = new WorkspaceService({
      userDataDir: dirs[dirs.length - 1]!,
      profileRoot: join(dirs[dirs.length - 1]!, "profiles"),
      platform: process.platform as "win32" | "darwin" | "linux",
      secretBox: new MemorySecretBox(),
      appVersion: "test",
      workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    });
    services.push(reopened);
    await reopened.initialize();
    expect(reopened.snapshot().views.map((view) => view.name)).toEqual(["乙", "甲"]);
  });

  it("refuses an id that is not there", async () => {
    const service = await makeService();
    expect(() => service.moveView("does-not-exist", 0)).toThrow();
  });
});
