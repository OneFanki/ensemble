import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  MemorySecretBox,
  resolvePassword,
  VaultLockedError,
  type VaultFile,
} from "@core/credentials/vault";
import { open, seal } from "@core/credentials/crypto";

function makeVault(options: { initial?: VaultFile; box?: MemorySecretBox } = {}) {
  let persisted: VaultFile | undefined;
  const vault = new CredentialVault({
    osBox: options.box ?? new MemorySecretBox(),
    persist: (file) => {
      persisted = file;
    },
    ...(options.initial ? { initial: options.initial } : {}),
  });
  return { vault, persisted: () => persisted };
}

describe("CredentialVault", () => {
  it("stores site and identity credentials separately", () => {
    const { vault } = makeVault();
    vault.set({ kind: "site", id: "env-1" }, "env-secret");
    vault.set({ kind: "identity", id: "id-1" }, "id-secret");

    expect(vault.get({ kind: "site", id: "env-1" })).toBe("env-secret");
    expect(vault.get({ kind: "identity", id: "id-1" })).toBe("id-secret");
    expect(vault.get({ kind: "identity", id: "missing" })).toBeUndefined();
  });

  it("never exposes plaintext in the persisted payload", () => {
    const { vault, persisted } = makeVault();
    vault.set({ kind: "identity", id: "id-1" }, "super-secret");
    expect(JSON.stringify(persisted())).not.toContain("super-secret");
  });

  it("clears a single credential without touching the other bucket", () => {
    const { vault } = makeVault();
    vault.set({ kind: "site", id: "env" }, "a");
    vault.set({ kind: "identity", id: "id" }, "b");
    vault.clear({ kind: "identity", id: "id" });
    expect(vault.get({ kind: "identity", id: "id" })).toBeUndefined();
    expect(vault.get({ kind: "site", id: "env" })).toBe("a");
  });

  it("reports presence without decrypting", () => {
    const { vault } = makeVault();
    vault.set({ kind: "site", id: "env" }, "a");
    const presence = vault.presence();
    expect(presence.site["env"]).toBe(true);
    expect(presence.identity["env"]).toBeUndefined();
  });

  it("resolves identity overrides over site defaults", () => {
    const { vault } = makeVault();
    vault.set({ kind: "site", id: "env" }, "env-pass");
    const inherited = resolvePassword(vault, { id: "id", passwordMode: "inherit" }, "env");
    expect(inherited).toEqual({ password: "env-pass", source: "site" });

    vault.set({ kind: "identity", id: "id" }, "id-pass");
    const custom = resolvePassword(vault, { id: "id", passwordMode: "custom" }, "env");
    expect(custom).toEqual({ password: "id-pass", source: "identity" });

    const missing = resolvePassword(vault, { id: "other", passwordMode: "custom" }, "env");
    expect(missing).toEqual({ source: "missing" });
  });
});

describe("master password mode", () => {
  it("re-encrypts everything and locks on restart", () => {
    const { vault, persisted } = makeVault();
    vault.set({ kind: "site", id: "env" }, "env-pass");
    vault.set({ kind: "identity", id: "id" }, "id-pass");
    vault.setMasterPassword("correct horse battery");

    expect(vault.mode).toBe("master");
    expect(vault.hasMasterPassword).toBe(true);
    expect(vault.locked).toBe(false);
    expect(vault.get({ kind: "site", id: "env" })).toBe("env-pass");

    const stored = persisted() as VaultFile;
    expect(stored.version).toBe(2);
    expect(JSON.stringify(stored)).not.toContain("env-pass");
    expect(JSON.stringify(stored)).not.toContain("id-pass");

    // A fresh process reads the file but has no key until unlocked.
    const restarted = makeVault({ initial: stored });
    expect(restarted.vault.locked).toBe(true);
    expect(() => restarted.vault.get({ kind: "site", id: "env" })).toThrow(
      VaultLockedError,
    );
    expect(restarted.vault.unlock("wrong password")).toBe(false);
    expect(restarted.vault.locked).toBe(true);
    expect(restarted.vault.unlock("correct horse battery")).toBe(true);
    expect(restarted.vault.get({ kind: "site", id: "env" })).toBe("env-pass");
  });

  it("refuses to save credentials while locked", () => {
    const { vault } = makeVault();
    vault.setMasterPassword("correct horse battery");
    const stored = JSON.parse(JSON.stringify(vault["file"])) as VaultFile;

    const restarted = makeVault({ initial: stored });
    expect(() => restarted.vault.set({ kind: "identity", id: "x" }, "pw")).toThrow(
      VaultLockedError,
    );
    // Clearing must stay possible so the user can remove entries while locked.
    expect(() => restarted.vault.clear({ kind: "identity", id: "x" })).not.toThrow();
  });

  it("rejects short master passwords", () => {
    const { vault } = makeVault();
    expect(() => vault.setMasterPassword("short")).toThrow(/at least 8/i);
  });

  it("changes the master password only with the current one", () => {
    const { vault, persisted } = makeVault();
    vault.set({ kind: "site", id: "env" }, "env-pass");
    vault.setMasterPassword("first password");

    expect(vault.changeMasterPassword("nope", "second password")).toBe(false);

    const stored = JSON.parse(JSON.stringify(vault["file"])) as VaultFile;
    const restarted = makeVault({ initial: stored });
    expect(restarted.vault.unlock("first password")).toBe(true);
    expect(restarted.vault.changeMasterPassword("first password", "second password")).toBe(true);

    const changed = JSON.parse(JSON.stringify(restarted.vault["file"])) as VaultFile;
    const afterChange = makeVault({ initial: changed });
    expect(afterChange.vault.unlock("first password")).toBe(false);
    expect(afterChange.vault.unlock("second password")).toBe(true);
    expect(afterChange.vault.get({ kind: "site", id: "env" })).toBe("env-pass");
    expect(persisted()).toBeDefined();
  });

  it("falls back to the OS keychain when the master password is removed", () => {
    const { vault } = makeVault();
    vault.set({ kind: "site", id: "env" }, "env-pass");
    vault.setMasterPassword("first password");
    vault.removeMasterPassword();

    expect(vault.mode).toBe("os");
    expect(vault.locked).toBe(false);
    expect(vault.get({ kind: "site", id: "env" })).toBe("env-pass");
  });
});

describe("legacy data", () => {
  it("migrates v1 plaintext payloads to the OS keychain", () => {
    const plain = `plain:${Buffer.from("legacy-secret", "utf8").toString("base64")}`;
    const { vault, persisted } = makeVault({
      initial: { version: 1, site: { env: plain }, identity: {} },
    });

    expect(vault.hasLegacyPlaintext).toBe(true);
    expect(vault.migrateLegacyPlaintext()).toBe(true);
    expect(vault.hasLegacyPlaintext).toBe(false);
    expect(vault.get({ kind: "site", id: "env" })).toBe("legacy-secret");
    expect(JSON.stringify(persisted())).not.toContain("plain:");
  });

  it("reports insecure when the OS keychain is missing", () => {
    const unavailable = {
      ...new MemorySecretBox(),
      available: false,
    };
    const { vault } = makeVault({ box: unavailable as MemorySecretBox });
    expect(vault.secure).toBe(false);
    expect(() => vault.set({ kind: "identity", id: "x" }, "pw")).toThrow();
  });
});

describe("crypto primitives", () => {
  it("round-trips and detects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const payload = seal(key, "hello world");
    expect(open(key, payload)).toBe("hello world");

    const parts = payload.split(":");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("evil").toString("base64")].join(":");
    expect(() => open(key, tampered)).toThrow();
  });

  it("uses a distinct IV for every value", () => {
    const key = Buffer.alloc(32, 1);
    expect(seal(key, "same")).not.toBe(seal(key, "same"));
  });
});
