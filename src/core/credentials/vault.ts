import type { PasswordOwner } from "@shared/types";
import {
  createKdfParams,
  deriveKey,
  isSealedPayload,
  open,
  seal,
  timingSafeEqualText,
  type KdfParams,
} from "./crypto";

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
  readonly backend: string;
  readonly available: boolean;
  readonly kind?: "os" | "master";
}

export class MemorySecretBox implements SecretBox {
  readonly backend = "memory";
  readonly available = true;
  readonly kind = "os" as const;

  encrypt(plain: string): string {
    return `mem:${Buffer.from(plain, "utf8").toString("base64")}`;
  }

  decrypt(payload: string): string {
    if (!payload.startsWith("mem:")) throw new Error("Unsupported payload");
    return Buffer.from(payload.slice(4), "base64").toString("utf8");
  }
}

export interface VaultV1 {
  version: 1;
  site: Record<string, string>;
  identity: Record<string, string>;
}

export interface VaultV2 {
  version: 2;
  mode: "os" | "master";
  /** Present only in master mode. */
  kdf?: KdfParams;
  /** Encrypted canary used to verify the master password. */
  check?: string;
  site: Record<string, string>;
  identity: Record<string, string>;
}

export type VaultFile = VaultV1 | VaultV2;

const VAULT_CHECK = "ensemble:vault:v2";
const MIN_MASTER_LENGTH = 8;

export class VaultLockedError extends Error {
  constructor(message = "Vault is locked") {
    super(message);
    this.name = "VaultLockedError";
  }
}

export class VaultUnavailableError extends Error {
  constructor() {
    super("System credential storage is unavailable");
    this.name = "VaultUnavailableError";
  }
}

/** Encrypts with a scrypt-derived key that only exists while the app is unlocked. */
export class MasterPasswordBox implements SecretBox {
  readonly backend = "aes-256-gcm";
  readonly available = true;
  readonly kind = "master" as const;

  constructor(private readonly key: Buffer) {}

  static derive(password: string, params: KdfParams): MasterPasswordBox {
    return new MasterPasswordBox(deriveKey(password, params));
  }

  encrypt(plain: string): string {
    return seal(this.key, plain);
  }

  decrypt(payload: string): string {
    return open(this.key, payload);
  }
}

export interface VaultOptions {
  /** OS keychain adapter (safeStorage). Never falls back to plaintext. */
  osBox: SecretBox;
  persist: (file: VaultFile) => void;
  initial?: VaultFile;
}

export class CredentialVault {
  private file: VaultFile;
  private masterBox: MasterPasswordBox | null = null;

  constructor(private readonly options: VaultOptions) {
    this.file = normalize(options.initial);
  }

  get mode(): "os" | "master" {
    return this.file.version === 2 ? this.file.mode : "os";
  }

  get locked(): boolean {
    return this.mode === "master" && this.masterBox === null;
  }

  get backend(): string {
    return this.mode === "master" ? "aes-256-gcm" : this.options.osBox.backend;
  }

  get secure(): boolean {
    if (this.mode === "master") return true;
    if (!this.options.osBox.available) return false;
    if (this.options.osBox.backend === "basic_text") return false;
    return !this.containsLegacyPlaintext();
  }

  get hasLegacyPlaintext(): boolean {
    return this.containsLegacyPlaintext();
  }

  get hasMasterPassword(): boolean {
    return this.mode === "master";
  }

  private activeBox(): SecretBox {
    if (this.mode === "master") {
      if (!this.masterBox) throw new VaultLockedError();
      return this.masterBox;
    }
    if (!this.options.osBox.available) throw new VaultUnavailableError();
    return this.options.osBox;
  }

  private buckets(): Array<Record<string, string>> {
    return [this.file.site, this.file.identity];
  }

  private containsLegacyPlaintext(): boolean {
    return this.buckets().some((bucket) =>
      Object.values(bucket).some((payload) => payload.startsWith("plain:")),
    );
  }

  private bucket(owner: PasswordOwner): Record<string, string> {
    return owner.kind === "site" ? this.file.site : this.file.identity;
  }

  has(owner: PasswordOwner): boolean {
    return Boolean(this.bucket(owner)[owner.id]);
  }

  set(owner: PasswordOwner, password: string): void {
    if (!password) {
      this.clear(owner);
      return;
    }
    const box = this.activeBox();
    this.bucket(owner)[owner.id] = box.encrypt(password);
    this.persist();
  }

  get(owner: PasswordOwner): string | undefined {
    const payload = this.bucket(owner)[owner.id];
    if (!payload) return undefined;
    const box = this.activeBox();
    try {
      return box.decrypt(payload);
    } catch {
      return undefined;
    }
  }

  clear(owner: PasswordOwner): void {
    // Clearing never needs the key, so it must keep working while locked.
    delete this.bucket(owner)[owner.id];
    this.persist();
  }

  clearSite(siteId: string): void {
    delete this.file.site[siteId];
    this.persist();
  }

  presence(): {
    site: Record<string, boolean>;
    identity: Record<string, boolean>;
  } {
    const collect = (bucket: Record<string, string>) =>
      Object.fromEntries(Object.keys(bucket).map((key) => [key, Boolean(bucket[key])]));
    return {
      site: collect(this.file.site),
      identity: collect(this.file.identity),
    };
  }

  /**
   * Switches the vault to a master-password key. Every existing secret is
   * decrypted with the current key and re-encrypted with the new one, so the
   * operation is atomic: either the whole vault moves or nothing changes.
   */
  setMasterPassword(password: string): void {
    if (password.length < MIN_MASTER_LENGTH) {
      throw new Error(`Master password must be at least ${MIN_MASTER_LENGTH} characters`);
    }
    const source = this.activeBox();
    const params = createKdfParams();
    const target = MasterPasswordBox.derive(password, params);
    const reencrypted = this.reencryptAll(source, target);

    this.file = {
      version: 2,
      mode: "master",
      kdf: params,
      check: target.encrypt(VAULT_CHECK),
      ...reencrypted,
    };
    this.masterBox = target;
    this.persist();
  }

  /** Returns false when the password is wrong; the vault stays locked. */
  unlock(password: string): boolean {
    if (this.mode !== "master") return true;
    if (!this.verifyMasterPassword(password)) return false;
    const kdf = this.file.version === 2 ? this.file.kdf : undefined;
    if (!kdf) return false;
    this.masterBox = MasterPasswordBox.derive(password, kdf);
    return true;
  }

  /** Checks a password against the stored canary without changing lock state. */
  private verifyMasterPassword(password: string): boolean {
    if (this.file.version !== 2) return false;
    const { kdf, check } = this.file;
    if (!kdf || !check) return false;
    try {
      return timingSafeEqualText(MasterPasswordBox.derive(password, kdf).decrypt(check), VAULT_CHECK);
    } catch {
      return false;
    }
  }

  lock(): void {
    if (this.mode === "master") this.masterBox = null;
  }

  changeMasterPassword(current: string, next: string): boolean {
    if (this.mode !== "master") return false;
    // Verify against the stored canary even while unlocked: holding an open app
    // must not be enough to rotate the password silently.
    if (!this.verifyMasterPassword(current)) return false;
    if (next.length < MIN_MASTER_LENGTH) {
      throw new Error(`Master password must be at least ${MIN_MASTER_LENGTH} characters`);
    }
    this.setMasterPassword(next);
    return true;
  }

  /**
   * Drops the master password and returns to OS-keychain protection. Refuses when
   * the OS keychain is unavailable, because that would weaken the vault.
   */
  removeMasterPassword(): void {
    if (this.mode !== "master") return;
    if (!this.options.osBox.available) throw new VaultUnavailableError();
    const source = this.activeBox();
    const reencrypted = this.reencryptAll(source, this.options.osBox);
    this.file = { version: 2, mode: "os", ...reencrypted };
    this.masterBox = null;
    this.persist();
  }

  /**
   * Rewrites legacy `plain:` payloads with the OS keychain. Called once at
   * startup; returns true when the file changed.
   */
  migrateLegacyPlaintext(): boolean {
    if (this.mode !== "os" || !this.options.osBox.available) return false;
    if (!this.containsLegacyPlaintext()) return false;

    for (const bucket of this.buckets()) {
      for (const [key, payload] of Object.entries(bucket)) {
        if (!payload.startsWith("plain:")) continue;
        const plain = Buffer.from(payload.slice(6), "base64").toString("utf8");
        bucket[key] = this.options.osBox.encrypt(plain);
      }
    }
    this.persist();
    return true;
  }

  private reencryptAll(
    source: SecretBox,
    target: SecretBox,
  ): { site: Record<string, string>; identity: Record<string, string> } {
    const move = (bucket: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(bucket).map(([key, payload]) => [key, target.encrypt(source.decrypt(payload))]),
      );
    return {
      site: move(this.file.site),
      identity: move(this.file.identity),
    };
  }

  private persist(): void {
    this.options.persist(this.file);
  }
}

function normalize(initial?: VaultFile): VaultFile {
  if (!initial) {
    return { version: 2, mode: "os", site: {}, identity: {} };
  }
  if (initial.version === 2) {
    return {
      version: 2,
      mode: initial.mode === "master" ? "master" : "os",
      ...(initial.kdf ? { kdf: initial.kdf } : {}),
      ...(initial.check ? { check: initial.check } : {}),
      site: initial.site ?? {},
      identity: initial.identity ?? {},
    };
  }
  return {
    version: 2,
    mode: "os",
    site: initial.site ?? {},
    identity: initial.identity ?? {},
  };
}

/** True when the payload uses the master-password ciphertext format. */
export function isMasterPayload(payload: string): boolean {
  return isSealedPayload(payload);
}

/**
 * Resolves the password an identity logs in with.
 *
 * Three modes, in order of specificity:
 *
 * - `custom` — this identity stores its own password;
 * - `reference` — this identity reuses another identity's password, so changing
 *   the source changes every site that references it. References are one level
 *   deep: the source may not itself be a reference, which keeps the chain acyclic;
 * - `inherit` — fall back to the site default.
 *
 * `identities` is only needed to follow a reference. Omitting it makes a
 * reference resolve as missing rather than silently falling back to the site
 * default, which would log in with the wrong credentials.
 */
export function resolvePassword(
  vault: CredentialVault,
  identity: {
    id: string;
    passwordMode: "inherit" | "custom" | "reference";
    credentialFrom?: string;
  },
  siteId: string,
  identities?: Array<{ id: string; passwordMode: "inherit" | "custom" | "reference" }>,
): { password?: string; source: "identity" | "site" | "missing" } {
  if (identity.passwordMode === "custom") {
    const password = vault.get({ kind: "identity", id: identity.id });
    return password ? { password, source: "identity" } : { source: "missing" };
  }
  if (identity.passwordMode === "reference") {
    const sourceId = identity.credentialFrom;
    if (!sourceId) return { source: "missing" };
    const source = identities?.find((item) => item.id === sourceId);
    // A source that is itself a reference is invalid by construction; treat it as
    // missing instead of walking an arbitrary depth.
    if (!source || source.passwordMode === "reference") return { source: "missing" };
    const password = vault.get({ kind: "identity", id: sourceId });
    return password ? { password, source: "identity" } : { source: "missing" };
  }
  const password = vault.get({ kind: "site", id: siteId });
  return password ? { password, source: "site" } : { source: "missing" };
}
