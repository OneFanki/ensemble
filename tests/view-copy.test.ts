import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";

let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-view-copy-"));
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

function site(name: string, baseUrl: string) {
  return service.saveSite({ name, baseUrl, loginPath: "/login", autoSubmit: false });
}

function identity(siteId: string, username: string, password?: string) {
  return service.saveIdentity(
    {
      siteId,
      name: username,
      username,
      role: "member",
      color: "slate",
      passwordMode: "custom",
    },
    password,
  );
}

describe("copying a view to another site", () => {
  it("creates reference identities on the target and links the view to them", () => {
    const local = site("本地", "http://localhost:3000");
    const test = site("测试", "http://test.example.com");
    const a = identity(local.id, "admin", "admin-pass");
    const b = identity(local.id, "member", "member-pass");
    const view = service.saveView({
      siteId: local.id,
      name: "权限检查",
      identityIds: [a.id, b.id],
      layoutId: "2x1",
      slotAssignments: {},
      paths: {},
    });

    const result = service.copyViewToSite(view.id, test.id);

    expect(result.view.siteId).toBe(test.id);
    expect(result.view.name).toBe("权限检查");
    expect(result.view.layoutId).toBe("2x1");
    expect(result.createdReferences).toEqual(["admin", "member"]);
    expect(result.reused).toEqual([]);
    expect(result.view.identityIds).toHaveLength(2);

    // Every member on the target is a reference back to the source account.
    for (const identityId of result.view.identityIds) {
      const created = service.snapshot().identities.find((item) => item.id === identityId);
      expect(created?.siteId).toBe(test.id);
      expect(created?.passwordMode).toBe("reference");
      expect([a.id, b.id]).toContain(created?.credentialFrom);
    }
  });

  it("records where the copy came from", () => {
    const local = site("本地", "http://localhost:3000");
    const test = site("测试", "http://test.example.com");
    const a = identity(local.id, "admin", "p");
    const view = service.saveView({
      siteId: local.id,
      name: "检查",
      identityIds: [a.id],
      layoutId: "1x1",
      slotAssignments: {},
      paths: {},
    });

    const result = service.copyViewToSite(view.id, test.id);
    expect(result.view.copiedFrom).toEqual({ siteId: local.id, viewId: view.id });
  });

  it("reuses an existing account on the target instead of duplicating it", () => {
    const local = site("本地", "http://localhost:3000");
    const test = site("测试", "http://test.example.com");
    const a = identity(local.id, "admin", "p");
    // The target already has this person; a second identity would split their
    // login state for no reason.
    const existing = identity(test.id, "admin", "test-pass");
    const view = service.saveView({
      siteId: local.id,
      name: "检查",
      identityIds: [a.id],
      layoutId: "1x1",
      slotAssignments: {},
      paths: {},
    });

    const result = service.copyViewToSite(view.id, test.id);
    expect(result.reused).toEqual(["admin"]);
    expect(result.createdReferences).toEqual([]);
    expect(result.view.identityIds).toEqual([existing.id]);
  });

  it("mixes reuse and creation in one copy", () => {
    const local = site("本地", "http://localhost:3000");
    const test = site("测试", "http://test.example.com");
    const a = identity(local.id, "admin", "p");
    const b = identity(local.id, "member", "p");
    identity(test.id, "admin", "q");
    const view = service.saveView({
      siteId: local.id,
      name: "检查",
      identityIds: [a.id, b.id],
      layoutId: "2x1",
      slotAssignments: {},
      paths: {},
    });

    const result = service.copyViewToSite(view.id, test.id);
    expect(result.reused).toEqual(["admin"]);
    expect(result.createdReferences).toEqual(["member"]);
  });

  it("skips a source member that is itself a reference", () => {
    const a = site("A", "http://a.example.com");
    const b = site("B", "http://b.example.com");
    const c = site("C", "http://c.example.com");
    const source = identity(a.id, "admin", "p");
    // A reference has no credentials of its own, so there is nothing to pass on.
    const reference = service.saveIdentity({
      siteId: b.id,
      name: "admin",
      username: "admin",
      role: "member",
      color: "slate",
      passwordMode: "reference",
      credentialFrom: source.id,
    });
    const view = service.saveView({
      siteId: b.id,
      name: "检查",
      identityIds: [reference.id],
      layoutId: "1x1",
      slotAssignments: {},
      paths: {},
    });

    expect(() => service.copyViewToSite(view.id, c.id)).toThrow();
  });

  it("refuses to copy a view onto its own site", () => {
    const local = site("本地", "http://localhost:3000");
    const a = identity(local.id, "admin", "p");
    const view = service.saveView({
      siteId: local.id,
      name: "检查",
      identityIds: [a.id],
      layoutId: "1x1",
      slotAssignments: {},
      paths: {},
    });
    expect(() => service.copyViewToSite(view.id, local.id)).toThrow();
  });

  it("the copy is independent: later edits to the source do not change it", () => {
    const local = site("本地", "http://localhost:3000");
    const test = site("测试", "http://test.example.com");
    const a = identity(local.id, "admin", "p");
    const view = service.saveView({
      siteId: local.id,
      name: "检查",
      identityIds: [a.id],
      layoutId: "1x1",
      slotAssignments: {},
      paths: {},
    });
    const copied = service.copyViewToSite(view.id, test.id);

    service.saveView({
      id: view.id,
      siteId: local.id,
      name: "改了名字",
      identityIds: [a.id],
      layoutId: "2x2",
      slotAssignments: {},
      paths: {},
    });

    const after = service.snapshot().views.find((item) => item.id === copied.view.id);
    expect(after?.name).toBe("检查");
    expect(after?.layoutId).toBe("1x1");
  });
});

describe("cross-site views", () => {
  it("accepts members from several sites", () => {
    const local = site("本地", "http://localhost:3000");
    const staging = site("测试", "http://test.example.com");
    const a = identity(local.id, "admin");
    const b = identity(staging.id, "member");

    const view = service.saveView({
      siteId: local.id,
      name: "跨部署",
      identityIds: [a.id, b.id],
      layoutId: "2x1",
      slotAssignments: {},
      paths: {},
    });

    // A view is one screen, not one deployment: both members must survive.
    expect(view.identityIds).toEqual([a.id, b.id]);
    expect(service.snapshot().views.find((item) => item.id === view.id)?.identityIds).toHaveLength(2);
  });

  it("still rejects ids that belong to no identity", () => {
    const local = site("本地", "http://localhost:3000");
    const a = identity(local.id, "admin");
    const view = service.saveView({
      siteId: local.id,
      name: "混合",
      identityIds: [a.id, "missing-id"],
      layoutId: "1x1",
      slotAssignments: {},
      paths: {},
    });
    expect(view.identityIds).toEqual([a.id]);
  });

  it("refuses to launch a cross-site view as external windows", async () => {
    const local = site("本地", "http://localhost:3000");
    const staging = site("测试", "http://test.example.com");
    const a = identity(local.id, "admin");
    const b = identity(staging.id, "member");
    const view = service.saveView({
      siteId: local.id,
      name: "跨部署",
      identityIds: [a.id, b.id],
      layoutId: "2x1",
      slotAssignments: {},
      paths: {},
    });

    // External windows are one launch per site; the built-in surface is the
    // documented way to show a cross-site view. Failing loudly beats launching
    // half of it.
    await expect(service.launchView(view.id)).rejects.toThrow();
  });
});
