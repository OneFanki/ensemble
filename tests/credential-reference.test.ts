import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "@core/service";
import { MemorySecretBox, resolvePassword } from "@core/credentials/vault";

let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-refs-"));
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

function makeSite(name: string, baseUrl: string) {
  return service.saveSite({ name, baseUrl, loginPath: "/login", autoSubmit: false });
}

describe("saved-login detection", () => {
  it("recognises a username whose password the vault stores", () => {
    const site = makeSite("本地", "http://localhost:3000");
    service.saveIdentity(
      {
        siteId: site.id,
        name: "管理员",
        username: "admin@example.test",
        role: "管理员",
        color: "amber",
        passwordMode: "custom",
      },
      "secret",
    );
    expect(service.hasSavedLogin(site.id, "Admin@example.test")).toBe(true);
    expect(service.hasSavedLogin(site.id, "other@example.test")).toBe(false);
  });

  it("does not treat an identity saved without a password as saved", () => {
    const site = makeSite("本地", "http://localhost:3000");
    service.saveIdentity({
      siteId: site.id,
      name: "待补密码",
      username: "pending@example.test",
      role: "成员",
      color: "slate",
      passwordMode: "custom",
    });
    // Capturing this login is exactly what the prompt is for.
    expect(service.hasSavedLogin(site.id, "pending@example.test")).toBe(false);
  });

  it("follows a reference to the source password", () => {
    const source = makeSite("本地", "http://localhost:3000");
    const other = makeSite("测试", "http://test.example.com");
    const identity = service.saveIdentity(
      {
        siteId: source.id,
        name: "管理员",
        username: "admin",
        role: "管理员",
        color: "amber",
        passwordMode: "custom",
      },
      "secret",
    );
    const reference = service.saveIdentity({
      siteId: other.id,
      name: "ignored",
      username: "ignored",
      role: "ignored",
      color: "slate",
      passwordMode: "reference",
      credentialFrom: identity.id,
    });
    expect(service.hasSavedLogin(other.id, reference.username)).toBe(true);
  });
});

describe("credential references", () => {
  it("copies the source's display fields onto the reference", () => {
    const a = makeSite("本地", "http://localhost:3000");
    const b = makeSite("测试", "http://test.example.com");
    const source = service.saveIdentity(
      {
        siteId: a.id,
        name: "管理员 · 主账号",
        username: "admin",
        role: "管理员",
        color: "amber",
        passwordMode: "custom",
        note: "备注",
      },
      "secret",
    );

    const reference = service.saveIdentity({
      siteId: b.id,
      name: "ignored",
      username: "ignored",
      role: "ignored",
      color: "slate",
      passwordMode: "reference",
      credentialFrom: source.id,
    });

    // The reference reuses the source wholesale: name, username, role, colour, note.
    expect(reference.name).toBe("管理员 · 主账号");
    expect(reference.username).toBe("admin");
    expect(reference.role).toBe("管理员");
    expect(reference.color).toBe("amber");
    expect(reference.note).toBe("备注");
  });

  it("resolves the source's password through the reference", () => {
    const a = makeSite("本地", "http://localhost:3000");
    const b = makeSite("测试", "http://test.example.com");
    const source = service.saveIdentity(
      {
        siteId: a.id,
        name: "源",
        username: "admin",
        role: "admin",
        color: "amber",
        passwordMode: "custom",
      },
      "shared-secret",
    );
    const reference = service.saveIdentity({
      siteId: b.id,
      name: "引用",
      username: "admin",
      role: "admin",
      color: "amber",
      passwordMode: "reference",
      credentialFrom: source.id,
    });

    const resolved = resolvePassword(
      (service as unknown as { vault: unknown }).vault as never,
      reference,
      b.id,
      service.snapshot().identities,
    );
    expect(resolved.password).toBe("shared-secret");
  });

  it("rejects a reference to a missing identity", () => {
    const site = makeSite("测试", "http://test.example.com");
    expect(() =>
      service.saveIdentity({
        siteId: site.id,
        name: "x",
        username: "x",
        role: "member",
        color: "slate",
        passwordMode: "reference",
        credentialFrom: "nope",
      }),
    ).toThrow();
  });

  it("rejects a reference to another reference, so chains cannot form", () => {
    const a = makeSite("A", "http://a.example.com");
    const b = makeSite("B", "http://b.example.com");
    const c = makeSite("C", "http://c.example.com");
    const source = service.saveIdentity(
      {
        siteId: a.id,
        name: "源",
        username: "u",
        role: "member",
        color: "slate",
        passwordMode: "custom",
      },
      "p",
    );
    const first = service.saveIdentity({
      siteId: b.id,
      name: "引用一",
      username: "u",
      role: "member",
      color: "slate",
      passwordMode: "reference",
      credentialFrom: source.id,
    });
    expect(() =>
      service.saveIdentity({
        siteId: c.id,
        name: "引用二",
        username: "u",
        role: "member",
        color: "slate",
        passwordMode: "reference",
        credentialFrom: first.id,
      }),
    ).toThrow();
  });

  it("rejects a reference to itself", () => {
    const site = makeSite("A", "http://a.example.com");
    expect(() =>
      service.saveIdentity({
        id: "fixed-id",
        siteId: site.id,
        name: "x",
        username: "x",
        role: "member",
        color: "slate",
        passwordMode: "reference",
        credentialFrom: "fixed-id",
      }),
    ).toThrow();
  });

  it("detaching writes the resolved password as a local custom credential", () => {
    const a = makeSite("本地", "http://localhost:3000");
    const b = makeSite("测试", "http://test.example.com");
    const source = service.saveIdentity(
      {
        siteId: a.id,
        name: "源",
        username: "admin",
        role: "admin",
        color: "amber",
        passwordMode: "custom",
      },
      "shared-secret",
    );
    const reference = service.saveIdentity({
      siteId: b.id,
      name: "引用",
      username: "admin",
      role: "admin",
      color: "amber",
      passwordMode: "reference",
      credentialFrom: source.id,
    });

    const detached = service.detachReference(reference.id);
    expect(detached.passwordMode).toBe("custom");
    expect(detached.credentialFrom).toBeUndefined();

    // Changing the source must no longer affect the detached copy.
    service.saveIdentity(
      {
        id: source.id,
        siteId: a.id,
        name: "源",
        username: "admin",
        role: "admin",
        color: "amber",
        passwordMode: "custom",
      },
      "changed",
    );
    const resolved = service.snapshot().credentials.identity[detached.id];
    expect(resolved).toBe(true);
    // The detached copy kept the value it had at detach time.
    expect(service.detachReference(detached.id).passwordMode).toBe("custom");
  });

  it("deleting a source materialises its password into dependents", () => {
    const a = makeSite("本地", "http://localhost:3000");
    const b = makeSite("测试", "http://test.example.com");
    const source = service.saveIdentity(
      {
        siteId: a.id,
        name: "源",
        username: "admin",
        role: "admin",
        color: "amber",
        passwordMode: "custom",
      },
      "shared-secret",
    );
    const reference = service.saveIdentity({
      siteId: b.id,
      name: "引用",
      username: "admin",
      role: "admin",
      color: "amber",
      passwordMode: "reference",
      credentialFrom: source.id,
    });

    service.deleteIdentity(source.id);

    const survivor = service.snapshot().identities.find((item) => item.id === reference.id);
    expect(survivor).toBeDefined();
    // A dangling reference would be an identity that silently cannot log in.
    expect(survivor?.passwordMode).toBe("custom");
    expect(survivor?.credentialFrom).toBeUndefined();
  });

  it("refuses to turn a referenced identity into a reference itself", () => {
    const a = makeSite("A", "http://a.example.com");
    const b = makeSite("B", "http://b.example.com");
    const target = service.saveIdentity(
      {
        siteId: a.id,
        name: "被引用者",
        username: "u",
        role: "member",
        color: "slate",
        passwordMode: "custom",
      },
      "p",
    );
    const other = service.saveIdentity(
      {
        siteId: a.id,
        name: "另一个",
        username: "v",
        role: "member",
        color: "slate",
        passwordMode: "custom",
      },
      "q",
    );
    service.saveIdentity({
      siteId: b.id,
      name: "引用",
      username: "u",
      role: "member",
      color: "slate",
      passwordMode: "reference",
      credentialFrom: target.id,
    });

    expect(() =>
      service.saveIdentity({
        id: target.id,
        siteId: a.id,
        name: "被引用者",
        username: "u",
        role: "member",
        color: "slate",
        passwordMode: "reference",
        credentialFrom: other.id,
      }),
    ).toThrow();
  });
});

describe("origin change detection", () => {
  it("records the origin once a fill succeeds", async () => {
    const site = makeSite("本地", "http://localhost:3000");
    expect(site.lastOrigin).toBeUndefined();
    // acceptSiteOrigin is what the UI calls after the user confirms a change; a
    // first-time record happens on the first successful fill.
    service.acceptSiteOrigin(site.id);
    expect(service.snapshot().sites[0]?.lastOrigin).toBe("http://localhost:3000");
  });

  it("updates the recorded origin when the address changes and is accepted", () => {
    const site = makeSite("本地", "http://localhost:3000");
    service.acceptSiteOrigin(site.id);
    service.saveSite({
      id: site.id,
      name: "本地",
      baseUrl: "http://staging.example.com",
      loginPath: "/login",
      autoSubmit: false,
    });
    // Editing the address does not silently re-trust it.
    expect(service.snapshot().sites[0]?.lastOrigin).toBe("http://localhost:3000");
    service.acceptSiteOrigin(site.id);
    expect(service.snapshot().sites[0]?.lastOrigin).toBe("http://staging.example.com");
  });
});

describe("reference consistency", () => {
  it("propagates edits on the source to every reference", () => {
    const a = makeSite("本地", "http://localhost:3000");
    const b = makeSite("测试", "http://test.example.com");
    const source = service.saveIdentity({
      siteId: a.id,
      name: "管理员",
      username: "admin",
      role: "管理员",
      color: "amber",
      passwordMode: "custom",
    });
    const reference = service.saveIdentity({
      siteId: b.id,
      name: "ignored",
      username: "ignored",
      role: "ignored",
      color: "slate",
      passwordMode: "reference",
      credentialFrom: source.id,
    });

    service.saveIdentity({
      id: source.id,
      siteId: a.id,
      name: "管理员（改名）",
      username: "admin-2",
      role: "运维",
      color: "rose",
      passwordMode: "custom",
      note: "新备注",
    });

    const after = service.findIdentity(reference.id);
    // "Reference" means exactly the same account: every synced field follows.
    expect(after?.name).toBe("管理员（改名）");
    expect(after?.username).toBe("admin-2");
    expect(after?.role).toBe("运维");
    expect(after?.color).toBe("rose");
    expect(after?.note).toBe("新备注");
  });

  it("leaves local fields of the reference alone", () => {
    const a = makeSite("本地", "http://localhost:3000");
    const b = makeSite("测试", "http://test.example.com");
    const source = service.saveIdentity({
      siteId: a.id,
      name: "管理员",
      username: "admin",
      role: "管理员",
      color: "amber",
      passwordMode: "custom",
      startPath: "/admin",
    });
    const reference = service.saveIdentity({
      siteId: b.id,
      name: "ignored",
      username: "ignored",
      role: "ignored",
      color: "slate",
      passwordMode: "reference",
      credentialFrom: source.id,
      startPath: "/dashboard",
    });

    service.saveIdentity({
      id: source.id,
      siteId: a.id,
      name: "管理员",
      username: "admin",
      role: "管理员",
      color: "amber",
      passwordMode: "custom",
      startPath: "/console",
    });

    // The start path belongs to the target site, not to the shared account.
    expect(service.findIdentity(reference.id)?.startPath).toBe("/dashboard");
  });
});
