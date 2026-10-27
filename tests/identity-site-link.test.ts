import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  dir = mkdtempSync(join(tmpdir(), "ensemble-link-"));
  service = makeService();
  await service.initialize();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const site = service.saveSite({
    name: "订单服务",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
  });
  const other = service.saveSite({
    name: "另一个站点",
    baseUrl: "http://localhost:4000",
    loginPath: "/login",
  });
  const identity = service.saveIdentity({
    siteId: site.id,
    name: "管理员",
    username: "admin",
    role: "admin",
    color: "amber",
    passwordMode: "custom",
    startPath: "/",
  });
  return { site, other, identity };
}

describe("editing an existing account", () => {
  it("moves the account when the form changes its site", () => {
    // The dialog has always had a site picker. It did nothing: every other field
    // was written, the save reported success, and the account stayed put — which
    // reads exactly like "linking is broken".
    const { other, identity } = seed();
    service.saveIdentity({
      id: identity.id,
      siteId: other.id,
      name: identity.name,
      username: identity.username,
      role: identity.role,
      color: identity.color,
      passwordMode: identity.passwordMode,
      startPath: identity.startPath,
    });
    expect(service.findIdentity(identity.id)?.siteId).toBe(other.id);
  });

  it("refuses to save an account onto a site that does not exist", () => {
    const { identity } = seed();
    expect(() =>
      service.saveIdentity({
        id: identity.id,
        siteId: "gone",
        name: identity.name,
        username: identity.username,
        role: identity.role,
        color: identity.color,
        passwordMode: identity.passwordMode,
      }),
    ).toThrow();
  });
});

describe("linking accounts to a site in bulk", () => {
  it("attaches every account in the batch", () => {
    const { other, identity } = seed();
    const second = service.saveIdentity({
      siteId: identity.siteId as string,
      name: "审核员",
      username: "reviewer",
      role: "member",
      color: "teal",
      passwordMode: "inherit",
    });

    const { linked } = service.linkIdentitiesToSite([identity.id, second.id], other.id);

    expect(linked).toBe(2);
    expect(service.findIdentity(identity.id)?.siteId).toBe(other.id);
    expect(service.findIdentity(second.id)?.siteId).toBe(other.id);
  });

  it("leaves accounts that are already on the target site alone", () => {
    const { site, identity } = seed();
    const before = service.findIdentity(identity.id)?.updatedAt;
    const { linked } = service.linkIdentitiesToSite([identity.id], site.id);
    expect(linked).toBe(0);
    expect(service.findIdentity(identity.id)?.updatedAt).toBe(before);
  });

  it("does not touch credentials, extra fields or tags", () => {
    const { other, identity } = seed();
    service.setPassword({ kind: "identity", id: identity.id }, "secret");
    service.saveIdentity({
      id: identity.id,
      siteId: identity.siteId as string,
      name: identity.name,
      username: identity.username,
      role: identity.role,
      color: identity.color,
      passwordMode: "custom",
      extraFields: [{ label: "租户名", value: "acme" }],
    });

    service.linkIdentitiesToSite([identity.id], other.id);

    const moved = service.findIdentity(identity.id);
    expect(moved?.extraFields).toEqual([{ label: "租户名", value: "acme" }]);
    expect(service.resolvedPassword(identity.id)).toBe("secret");
  });

  it("rejects an unknown site instead of silently linking nowhere", () => {
    const { identity } = seed();
    expect(() => service.linkIdentitiesToSite([identity.id], "missing")).toThrow();
  });
});

describe("an account whose site reference was lost", () => {
  it("reads back from disk with no site and still saves once a site is picked", async () => {
    // Exactly the shape left behind by the broken migration: the account exists,
    // the site list is empty, and `siteId` is not on the record at all.
    const stamp = "2026-01-01T00:00:00.000Z";
    writeFileSync(
      join(dir, "workspace.json"),
      JSON.stringify(
        {
          version: 2,
          sites: [],
          identities: [
            {
              id: "orphan",
              name: "admin",
              username: "admin",
              role: "admin",
              color: "amber",
              passwordMode: "custom",
              status: "unknown",
              createdAt: stamp,
              updatedAt: stamp,
            },
          ],
          views: [],
          flows: [],
          instances: [],
          manualEngines: [],
          layoutPresets: [],
          bookmarks: [],
        },
        null,
        2,
      ),
    );

    const reopened = makeService();
    await reopened.initialize();
    expect(reopened.findIdentity("orphan")?.siteId).toBeUndefined();
    expect(reopened.profileDirFor("orphan")).toBeUndefined();

    const site = reopened.saveSite({
      name: "新站点",
      baseUrl: "http://localhost:5000",
      loginPath: "/login",
    });
    expect(() =>
      reopened.saveIdentity({
        id: "orphan",
        siteId: site.id,
        name: "admin",
        username: "admin",
        role: "admin",
        color: "amber",
        passwordMode: "custom",
      }),
    ).not.toThrow();
    expect(reopened.findIdentity("orphan")?.siteId).toBe(site.id);
    expect(reopened.profileDirFor("orphan")).toContain(site.id);
  });
});
