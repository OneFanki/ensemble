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

/**
 * The one shape a key provider must have.
 *
 * Async since Electron 45: the OS-keychain adapter is `safeStorage`, whose
 * synchronous methods are deprecated there (removed in 46), so encrypting or
 * decrypting is a promise even when the implementation is pure `node:crypto`.
 * Callers throughout the service layer are `async` accordingly.
 */
export interface SecretBox {
  encrypt(plain: string): Promise<string>;
  decrypt(payload: string): Promise<string>;
  readonly backend: string;
  readonly available: boolean;
  readonly kind?: "os" | "master";
}

export class MemorySecretBox implements SecretBox {
  readonly backend = "memory";
  readonly available = true;
  readonly kind = "os" as const;

  encrypt(plain: string): Promise<string> {
    return Promise.resolve(`mem:${Buffer.from(plain, "utf8").toString("base64")}`);
  }

  decrypt(payload: string): Promise<string> {
    if (!payload.startsWith("mem:")) return Promise.reject(new Error("Unsupported payload"));
    return Promise.resolve(Buffer.from(payload.slice(4), "base64").toString("utf8"));
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

  encrypt(plain: string): Promise<string> {
    return Promise.resolve(seal(this.key, plain));
  }

  decrypt(payload: string): Promise<string> {
    return Promise.resolve(open(this.key, payload));
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

  async set(owner: PasswordOwner, password: string): Promise<void> {
    if (!password) {
      this.clear(owner);
      return;
    }
    const box = this.activeBox();
    this.bucket(owner)[owner.id] = await box.encrypt(password);
    this.persist();
  }

  async get(owner: PasswordOwner): Promise<string | undefined> {
    const payload = this.bucket(owner)[owner.id];
    if (!payload) return undefined;
    const box = this.activeBox();
    try {
      return await box.decrypt(payload);
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
  async setMasterPassword(password: string): Promise<void> {
    if (password.length < MIN_MASTER_LENGTH) {
      throw new Error(`Master password must be at least ${MIN_MASTER_LENGTH} characters`);
    }
    const source = this.activeBox();
    const params = createKdfParams();
    const target = MasterPasswordBox.derive(password, params);
    const reencrypted = await this.reencryptAll(source, target);

    this.file = {
      version: 2,
      mode: "master",
      kdf: params,
      check: await target.encrypt(VAULT_CHECK),
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
      // The raw crypto rather than MasterPasswordBox: this is the one check that
      // has to stay synchronous (unlock answers synchronously), and scrypt+AES
      // are synchronous anyway — the box's promise would only add a wrapper.
      return timingSafeEqualText(open(deriveKey(password, kdf), check), VAULT_CHECK);
    } catch {
      return false;
    }
  }

  lock(): void {
    if (this.mode === "master") this.masterBox = null;
  }

  async changeMasterPassword(current: string, next: string): Promise<boolean> {
    if (this.mode !== "master") return false;
    // Verify against the stored canary even while unlocked: holding an open app
    // must not be enough to rotate the password silently.
    if (!this.verifyMasterPassword(current)) return false;
    if (next.length < MIN_MASTER_LENGTH) {
      throw new Error(`Master password must be at least ${MIN_MASTER_LENGTH} characters`);
    }
    await this.setMasterPassword(next);
    return true;
  }

  /**
   * Drops the master password and returns to OS-keychain protection. Refuses when
   * the OS keychain is unavailable, because that would weaken the vault.
   */
  async removeMasterPassword(): Promise<void> {
    if (this.mode !== "master") return;
    if (!this.options.osBox.available) throw new VaultUnavailableError();
    const source = this.activeBox();
    const reencrypted = await this.reencryptAll(source, this.options.osBox);
    this.file = { version: 2, mode: "os", ...reencrypted };
    this.masterBox = null;
    this.persist();
  }

  /**
   * Rewrites legacy `plain:` payloads with the OS keychain. Called once at
   * startup; returns true when the file changed.
   */
  async migrateLegacyPlaintext(): Promise<boolean> {
    if (this.mode !== "os" || !this.options.osBox.available) return false;
    if (!this.containsLegacyPlaintext()) return false;

    for (const bucket of this.buckets()) {
      for (const [key, payload] of Object.entries(bucket)) {
        if (!payload.startsWith("plain:")) continue;
        const plain = Buffer.from(payload.slice(6), "base64").toString("utf8");
        bucket[key] = await this.options.osBox.encrypt(plain);
      }
    }
    this.persist();
    return true;
  }

  private async reencryptAll(
    source: SecretBox,
    target: SecretBox,
  ): Promise<{ site: Record<string, string>; identity: Record<string, string> }> {
    const move = async (bucket: Record<string, string>) => {
      const entries = await Promise.all(
        Object.entries(bucket).map(async ([key, payload]) => {
          const plain = await source.decrypt(payload);
          return [key, await target.encrypt(plain)] as const;
        }),
      );
      return Object.fromEntries(entries);
    };
    return {
      site: await move(this.file.site),
      identity: await move(this.file.identity),
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
 *
 * `siteId` may be absent: an account whose site reference was lost still exists,
 * and `inherit` then has no site default to fall back on. Resolving that as
 * missing is what keeps the fill path from reporting a login it never had.
 */
/**
 * Why a credential could not be resolved.
 *
 * "Missing" alone was not actionable: an account that inherits the site default
 * and a site that never got one produced the same message, and it said the
 * account had no password — which is true but points at the wrong place to fix
 * it. Whoever reads this cannot know which of the two dialogs to open.
 */
export type MissingCredentialReason =
  /** `custom`, but this account's own password was never saved. */
  | "identity-empty"
  /** `inherit`, and the site's default password was never saved. */
  | "site-empty"
  /** `inherit`, but the account has no site at all (the link was lost). */
  | "no-site"
  /** `reference`, but the source account is gone or is itself a reference. */
  | "reference-broken";

export async function resolvePassword(
  vault: CredentialVault,
  identity: {
    id: string;
    passwordMode: "inherit" | "custom" | "reference";
    credentialFrom?: string;
  },
  siteId: string | undefined,
  identities?: Array<{ id: string; passwordMode: "inherit" | "custom" | "reference" }>,
): Promise<{
  password?: string;
  source: "identity" | "site" | "missing";
  missing?: MissingCredentialReason;
}> {
  if (identity.passwordMode === "custom") {
    const password = await vault.get({ kind: "identity", id: identity.id });
    return password ? { password, source: "identity" } : { source: "missing", missing: "identity-empty" };
  }
  if (identity.passwordMode === "reference") {
    const sourceId = identity.credentialFrom;
    if (!sourceId) return { source: "missing", missing: "reference-broken" };
    const source = identities?.find((item) => item.id === sourceId);
    // A source that is itself a reference is invalid by construction; treat it as
    // missing instead of walking an arbitrary depth.
    if (!source || source.passwordMode === "reference") {
      return { source: "missing", missing: "reference-broken" };
    }
    const password = await vault.get({ kind: "identity", id: sourceId });
    return password ? { password, source: "identity" } : { source: "missing", missing: "identity-empty" };
  }
  if (!siteId) return { source: "missing", missing: "no-site" };
  const password = await vault.get({ kind: "site", id: siteId });
  return password ? { password, source: "site" } : { source: "missing", missing: "site-empty" };
}
