import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { ACCOUNTS_FORMAT, accountSecretKey, parseAccountBundle } from "@shared/accounts-transfer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-accounts-"));
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

function seed() {
  const alpha = service.saveSite({
    name: "Alpha",
    baseUrl: "http://alpha.test",
    loginPath: "/login",
    autoSubmit: false,
  });
  const beta = service.saveSite({
    name: "Beta",
    baseUrl: "http://beta.test",
    loginPath: "/login",
    autoSubmit: false,
  });
  const admin = service.saveIdentity(
    {
      siteId: alpha.id,
      name: "Alpha 管理员",
      username: "admin@alpha.test",
      role: "admin",
      color: "amber",
      passwordMode: "custom",
      extraFields: [{ label: "租户名", value: "Alpha 租户" }],
    },
    "alpha-secret",
  );
  const member = service.saveIdentity(
    {
      siteId: alpha.id,
      name: "Alpha 成员",
      username: "member@alpha.test",
      role: "member",
      color: "teal",
      passwordMode: "custom",
    },
    "member-secret",
  );
  const other = service.saveIdentity(
    {
      siteId: beta.id,
      name: "Beta 管理员",
      username: "admin@beta.test",
      role: "admin",
      color: "violet",
      passwordMode: "custom",
    },
    "beta-secret",
  );
  return { alpha, beta, admin, member, other };
}

describe("account bundles", () => {
  it("carries only the chosen accounts and pulls in their site", () => {
    const { alpha, admin } = seed();
    const { file, counts } = service.exportAccounts({
      siteIds: [],
      identityIds: [admin.id],
    });
    // Selecting one account brings its site so the receiver has somewhere to
    // attach it — without also exporting the other accounts on that site.
    expect(file.sites).toHaveLength(1);
    expect(file.sites[0]?.baseUrl).toBe(alpha.baseUrl);
    expect(file.sites[0]?.accounts.map((account) => account.username)).toEqual([
      "admin@alpha.test",
    ]);
    expect(counts.accounts).toBe(1);
    expect(file.format).toBe(ACCOUNTS_FORMAT);
  });

  it("exports every account of a chosen site when no account is named", () => {
    const { alpha } = seed();
    const { file } = service.exportAccounts({ siteIds: [alpha.id], identityIds: [] });
    expect(file.sites[0]?.accounts).toHaveLength(2);
  });

  it("never writes a plaintext password into the file", () => {
    const { admin } = seed();
    const { file } = service.exportAccounts({
      siteIds: [],
      identityIds: [admin.id],
      passphrase: "share-passphrase",
    });
    expect(file.secrets).toBeTruthy();
    expect(JSON.stringify(file)).not.toContain("alpha-secret");
    expect(file.sites[0]?.accounts[0]?.hasPassword).toBe(true);
  });

  it("round-trips accounts and passwords into another workspace", async () => {
    const { admin } = seed();
    const { file } = service.exportAccounts({
      siteIds: [],
      identityIds: [admin.id],
      passphrase: "share-passphrase",
    });

    // A second, empty workspace — the colleague's machine.
    const otherDir = mkdtempSync(join(tmpdir(), "ensemble-accounts-b-"));
    const receiver = new WorkspaceService({
      userDataDir: otherDir,
      profileRoot: join(otherDir, "profiles"),
      platform: "win32",
      secretBox: new MemorySecretBox(),
      appVersion: "test",
    });
    await receiver.initialize();
    try {
      const result = receiver.importAccountBundle(file, "share-passphrase");
      expect(result.sitesAdded).toBe(1);
      expect(result.accountsAdded).toBe(1);
      expect(result.passwordsWritten).toBe(1);

      const identity = receiver.snapshot().identities[0];
      expect(identity?.username).toBe("admin@alpha.test");
      // The password followed the account, even though the ids differ.
      expect(receiver.resolvedPassword(identity!.id)).toBe("alpha-secret");
      // Extra login fields come along too: they are part of the account.
      expect(identity?.extraFields?.[0]).toEqual({ label: "租户名", value: "Alpha 租户" });
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("matches an existing site by URL and updates the account in place", async () => {
    const { admin } = seed();
    const { file } = service.exportAccounts({
      siteIds: [],
      identityIds: [admin.id],
      passphrase: "share-passphrase",
    });

    const otherDir = mkdtempSync(join(tmpdir(), "ensemble-accounts-c-"));
    const receiver = new WorkspaceService({
      userDataDir: otherDir,
      profileRoot: join(otherDir, "profiles"),
      platform: "win32",
      secretBox: new MemorySecretBox(),
      appVersion: "test",
    });
    await receiver.initialize();
    try {
      // Same URL, different id and name — the case a shared bundle hits.
      const localSite = receiver.saveSite({
        name: "我自己的叫法",
        baseUrl: "http://alpha.test",
        loginPath: "/login",
        autoSubmit: false,
      });
      receiver.saveIdentity(
        {
          siteId: localSite.id,
          name: "旧名字",
          username: "admin@alpha.test",
          role: "member",
          color: "slate",
          passwordMode: "custom",
        },
        "old-secret",
      );

      const result = receiver.importAccountBundle(file, "share-passphrase");
      expect(result.sitesAdded).toBe(0);
      expect(result.accountsUpdated).toBe(1);
      const identities = receiver.snapshot().identities;
      expect(identities).toHaveLength(1);
      expect(identities[0]?.name).toBe("Alpha 管理员");
      // The imported password replaces the local one.
      expect(receiver.resolvedPassword(identities[0]!.id)).toBe("alpha-secret");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("refuses a wrong passphrase without touching the workspace", () => {
    const { admin } = seed();
    const { file } = service.exportAccounts({
      siteIds: [],
      identityIds: [admin.id],
      passphrase: "share-passphrase",
    });
    expect(() => service.importAccountBundle(file, "wrong-passphrase")).toThrow();
    // The merge must not have happened: no new site was created.
    expect(service.snapshot().sites).toHaveLength(2);
  });

  it("rejects a file that is not an account bundle", () => {
    expect(() => parseAccountBundle({ format: "ensemble.workspace", version: 1 })).toThrow();
    expect(() => parseAccountBundle(null)).toThrow();
  });

  it("keys a password by what the receiver can re-derive", () => {
    // Ids differ between machines; URL + username is the join key.
    expect(accountSecretKey("http://alpha.test", "Admin@Alpha.test")).toBe(
      accountSecretKey("http://alpha.test", "admin@alpha.test"),
    );
    expect(accountSecretKey("http://alpha.test", "admin")).not.toBe(
      accountSecretKey("http://beta.test", "admin"),
    );
  });
});
