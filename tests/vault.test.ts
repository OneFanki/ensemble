import { describe, expect, it } from "vitest";
import { CredentialVault, MemorySecretBox, resolvePassword } from "@core/credentials/vault";

describe("CredentialVault", () => {
  it("stores environment and identity credentials separately", () => {
    const vault = new CredentialVault(new MemorySecretBox(), () => {});
    vault.set({ kind: "environment", id: "env-1" }, "env-secret");
    vault.set({ kind: "identity", id: "id-1" }, "id-secret");

    expect(vault.get({ kind: "environment", id: "env-1" })).toBe("env-secret");
    expect(vault.get({ kind: "identity", id: "id-1" })).toBe("id-secret");
    expect(vault.get({ kind: "identity", id: "missing" })).toBeUndefined();
  });

  it("never exposes plaintext in the persisted payload", () => {
    let persisted: unknown;
    const vault = new CredentialVault(new MemorySecretBox(), (state) => {
      persisted = state;
    });
    vault.set({ kind: "identity", id: "id-1" }, "super-secret");
    expect(JSON.stringify(persisted)).not.toContain("super-secret");
  });

  it("clears a single credential without touching the other bucket", () => {
    const vault = new CredentialVault(new MemorySecretBox(), () => {});
    vault.set({ kind: "environment", id: "env" }, "a");
    vault.set({ kind: "identity", id: "id" }, "b");
    vault.clear({ kind: "identity", id: "id" });
    expect(vault.get({ kind: "identity", id: "id" })).toBeUndefined();
    expect(vault.get({ kind: "environment", id: "env" })).toBe("a");
  });

  it("reports presence without decrypting", () => {
    const vault = new CredentialVault(new MemorySecretBox(), () => {});
    vault.set({ kind: "environment", id: "env" }, "a");
    const presence = vault.presence();
    expect(presence.environment["env"]).toBe(true);
    expect(presence.identity["env"]).toBeUndefined();
  });

  it("resolves identity overrides over environment defaults", () => {
    const vault = new CredentialVault(new MemorySecretBox(), () => {});
    vault.set({ kind: "environment", id: "env" }, "env-pass");
    const inherited = resolvePassword(vault, { id: "id", passwordMode: "inherit" }, "env");
    expect(inherited).toEqual({ password: "env-pass", source: "environment" });

    vault.set({ kind: "identity", id: "id" }, "id-pass");
    const custom = resolvePassword(vault, { id: "id", passwordMode: "custom" }, "env");
    expect(custom).toEqual({ password: "id-pass", source: "identity" });

    const missing = resolvePassword(vault, { id: "other", passwordMode: "custom" }, "env");
    expect(missing).toEqual({ source: "missing" });
  });
});
