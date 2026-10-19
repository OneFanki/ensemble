import type { PasswordOwner } from "@shared/types";

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
  readonly backend: string;
  readonly available: boolean;
}

export class MemorySecretBox implements SecretBox {
  readonly backend = "memory";
  readonly available = true;

  encrypt(plain: string): string {
    return `mem:${Buffer.from(plain, "utf8").toString("base64")}`;
  }

  decrypt(payload: string): string {
    if (!payload.startsWith("mem:")) throw new Error("Unsupported payload");
    return Buffer.from(payload.slice(4), "base64").toString("utf8");
  }
}

export type VaultSchema = {
  version: 1;
  environment: Record<string, string>;
  identity: Record<string, string>;
};

export class CredentialVault {
  private state: VaultSchema = { version: 1, environment: {}, identity: {} };

  constructor(
    private readonly box: SecretBox,
    private readonly persist: (state: VaultSchema) => void,
    initial?: VaultSchema,
  ) {
    if (initial && initial.version === 1) {
      this.state = initial;
    }
  }

  get secure(): boolean {
    return this.box.available && this.box.backend !== "basic_text";
  }

  get backend(): string {
    return this.box.backend;
  }

  private bucket(owner: PasswordOwner): Record<string, string> {
    return owner.kind === "environment" ? this.state.environment : this.state.identity;
  }

  has(owner: PasswordOwner): boolean {
    return Boolean(this.bucket(owner)[owner.id]);
  }

  set(owner: PasswordOwner, password: string): void {
    if (!password) {
      this.clear(owner);
      return;
    }
    this.bucket(owner)[owner.id] = this.box.encrypt(password);
    this.persist(this.state);
  }

  get(owner: PasswordOwner): string | undefined {
    const payload = this.bucket(owner)[owner.id];
    if (!payload) return undefined;
    try {
      return this.box.decrypt(payload);
    } catch {
      return undefined;
    }
  }

  clear(owner: PasswordOwner): void {
    delete this.bucket(owner)[owner.id];
    this.persist(this.state);
  }

  clearEnvironment(environmentId: string): void {
    delete this.state.environment[environmentId];
    this.persist(this.state);
  }

  presence(): {
    environment: Record<string, boolean>;
    identity: Record<string, boolean>;
  } {
    const collect = (bucket: Record<string, string>) =>
      Object.fromEntries(Object.keys(bucket).map((key) => [key, Boolean(bucket[key])]));
    return {
      environment: collect(this.state.environment),
      identity: collect(this.state.identity),
    };
  }
}

/**
 * Resolves the effective password for an identity.
 * Custom identity passwords win; otherwise the environment default applies.
 */
export function resolvePassword(
  vault: CredentialVault,
  identity: { id: string; passwordMode: "inherit" | "custom" },
  environmentId: string,
): { password?: string; source: "identity" | "environment" | "missing" } {
  if (identity.passwordMode === "custom") {
    const password = vault.get({ kind: "identity", id: identity.id });
    return password ? { password, source: "identity" } : { source: "missing" };
  }
  const password = vault.get({ kind: "environment", id: environmentId });
  return password ? { password, source: "environment" } : { source: "missing" };
}
