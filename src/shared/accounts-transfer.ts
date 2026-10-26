import type { Identity, Site } from "./types";

/**
 * A shareable bundle of accounts — not a workspace backup.
 *
 * The workspace export (`ensemble.workspace`) is a machine-migration format: it
 * carries every site, view and layout preset with their ids preserved. Handing
 * that to a colleague transfers the whole arrangement and is needlessly
 * confusing for "here are the three tenant logins I made".
 *
 * An account bundle carries only the chosen sites and accounts, plus their
 * passwords when a passphrase is given. It deliberately has no ids in the
 * matching path: the receiver's workspace has its own ids, so sites are matched
 * by base URL and accounts by username.
 */
export const ACCOUNTS_FORMAT = "ensemble.accounts";
export const ACCOUNTS_VERSION = 1;

export interface BundledLogin {
  label: string;
  value: string;
}

export interface BundledAccount {
  name: string;
  username: string;
  role: string;
  color: Identity["color"];
  startPath: string;
  note?: string;
  extraFields: BundledLogin[];
  /** True when the bundle carries this account's password (encrypted). */
  hasPassword: boolean;
}

export interface BundledSite {
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  /** Absent = the receiver keeps its own global default. */
  autoSubmit?: boolean;
  extraFields: BundledLogin[];
  /** Site default password, when the bundle was made with passwords included. */
  hasPassword: boolean;
  accounts: BundledAccount[];
}

/**
 * The password blob, keyed by what the receiver can re-derive.
 *
 * Ids cannot be used: the exporter and the importer assign their own. A site is
 * identified by its base URL and an account by `baseUrl` + lowercase username,
 * which is exactly the key the importer matches on.
 */
export interface BundleSecrets {
  site: Record<string, string>;
  identity: Record<string, string>;
}

/** Key for an account, stable across machines. */
export function accountSecretKey(baseUrl: string, username: string): string {
  return `${baseUrl}\u0000${username.trim().toLowerCase()}`;
}

export interface AccountBundleFile {
  format: typeof ACCOUNTS_FORMAT;
  version: number;
  exportedAt: string;
  /** Free-text hint for the receiver; never contains secrets. */
  note?: string;
  sites: BundledSite[];
  secrets?: { kdf: { salt: string; n: number; r: number; p: number }; payload: string };
}

export interface BundleCounts {
  sites: number;
  accounts: number;
  withPasswords: number;
}

/** What the receiver's workspace already has, for the pre-import preview. */
export interface BundlePreview extends BundleCounts {
  version: number;
  exportedAt?: string;
  hasSecrets: boolean;
  /** Accounts whose site already exists here, matched by base URL. */
  matchingSites: string[];
}

export interface BundleImportResult extends BundleCounts {
  /** Sites created because no site with that base URL existed. */
  sitesAdded: number;
  /** Accounts created; an existing username on the same site is updated. */
  accountsAdded: number;
  accountsUpdated: number;
  /** Accounts skipped because the receiver already has that username. */
  skipped: number;
  passwordsWritten: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, max = 400): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} 不能为空`);
  if (trimmed.length > max) throw new Error(`${field} 过长`);
  return trimmed;
}

function optionalText(value: unknown, field: string, max = 2000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function loginFields(value: unknown): BundledLogin[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("extraFields 必须是数组");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`extraFields[${index}] 格式不对`);
    return { label: text(item["label"], "label", 80), value: text(item["value"], "value", 400) };
  });
}

const COLORS = ["amber", "teal", "violet", "rose", "blue", "slate"];

/**
 * Validates a bundle read from disk.
 *
 * Strict on purpose: an account bundle is something people send each other, so
 * a malformed file must be rejected as a whole rather than importing half of it
 * into someone else's workspace.
 */
export function parseAccountBundle(raw: unknown): AccountBundleFile {
  if (!isRecord(raw)) throw new Error("文件内容不是对象");
  if (raw["format"] !== ACCOUNTS_FORMAT) throw new Error("不是账号导出文件");
  const version = Number(raw["version"]);
  if (!Number.isInteger(version) || version < 1) throw new Error("版本号不正确");
  if (version > ACCOUNTS_VERSION) throw new Error("这个文件来自更新的版本，请升级后再导入");
  if (!Array.isArray(raw["sites"])) throw new Error("sites 必须是数组");

  const sites = raw["sites"].map((item, siteIndex) => {
    if (!isRecord(item)) throw new Error(`sites[${siteIndex}] 格式不对`);
    const accounts = Array.isArray(item["accounts"]) ? item["accounts"] : [];
    return {
      name: text(item["name"], "站点名称", 120),
      baseUrl: text(item["baseUrl"], "站点地址", 500),
      loginPath:
        typeof item["loginPath"] === "string" && item["loginPath"] ? item["loginPath"] : "/login",
      ...(optionalText(item["authCheckPath"], "登录检测地址", 500)
        ? { authCheckPath: optionalText(item["authCheckPath"], "登录检测地址", 500) }
        : {}),
      // Only a bundle that states a choice carries one; a bundle written before
      // the field became an override has no value at all, and turning that into
      // `false` would pin the receiver's site to manual forever.
      ...(typeof item["autoSubmit"] === "boolean" ? { autoSubmit: item["autoSubmit"] } : {}),
      extraFields: loginFields(item["extraFields"]),
      hasPassword: item["hasPassword"] === true,
      accounts: accounts.map((account, accountIndex) => {
        if (!isRecord(account))
          throw new Error(`账号格式不对（sites[${siteIndex}].accounts[${accountIndex}]）`);
        const color =
          typeof account["color"] === "string" && COLORS.includes(account["color"])
            ? (account["color"] as Identity["color"])
            : "slate";
        return {
          name: text(account["name"], "账号名称", 120),
          username: text(account["username"], "用户名", 200),
          role: typeof account["role"] === "string" && account["role"] ? account["role"] : "member",
          color,
          startPath:
            typeof account["startPath"] === "string" && account["startPath"]
              ? account["startPath"]
              : "/",
          ...(optionalText(account["note"], "备注", 2000)
            ? { note: optionalText(account["note"], "备注", 2000) }
            : {}),
          extraFields: loginFields(account["extraFields"]),
          hasPassword: account["hasPassword"] === true,
        } satisfies BundledAccount;
      }),
    } satisfies BundledSite;
  });

  let secrets: AccountBundleFile["secrets"];
  if (raw["secrets"] !== undefined) {
    const sealed = raw["secrets"];
    if (!isRecord(sealed)) throw new Error("secrets 格式不对");
    const kdf = sealed["kdf"];
    if (!isRecord(kdf)) throw new Error("secrets.kdf 格式不对");
    secrets = {
      kdf: {
        salt: text(kdf["salt"], "salt", 200),
        n: Number(kdf["n"]),
        r: Number(kdf["r"]),
        p: Number(kdf["p"]),
      },
      payload: text(sealed["payload"], "payload", 200000),
    };
  }

  return {
    format: ACCOUNTS_FORMAT,
    version,
    exportedAt:
      typeof raw["exportedAt"] === "string" ? raw["exportedAt"] : new Date().toISOString(),
    ...(optionalText(raw["note"], "备注", 500)
      ? { note: optionalText(raw["note"], "备注", 500) }
      : {}),
    sites,
    ...(secrets ? { secrets } : {}),
  };
}

export function accountBundleCounts(file: AccountBundleFile): BundleCounts {
  let accounts = 0;
  let withPasswords = 0;
  for (const site of file.sites) {
    accounts += site.accounts.length;
    withPasswords += site.accounts.filter((account) => account.hasPassword).length;
  }
  if (file.secrets) {
    // The encrypted blob is opaque; hasPassword per entry is what the UI shows.
  }
  return { sites: file.sites.length, accounts, withPasswords };
}

/** Builds a bundle from workspace objects and, optionally, their passwords. */
export function buildAccountBundle(input: {
  sites: Site[];
  identities: Identity[];
  /**
   * Plaintext passwords keyed by what the receiver can re-derive
   * (`baseUrl`, and `accountSecretKey(baseUrl, username)`). Never written to the
   * bundle: the caller seals it and stores only the ciphertext.
   */
  passwords?: BundleSecrets;
  note?: string;
}): AccountBundleFile {
  const secrets = input.passwords;
  const sites: BundledSite[] = input.sites.map((site) => {
    const accounts = input.identities.filter((identity) => identity.siteId === site.id);
    return {
      name: site.name,
      baseUrl: site.baseUrl,
      loginPath: site.loginPath,
      ...(site.authCheckPath ? { authCheckPath: site.authCheckPath } : {}),
      ...(site.autoSubmit === undefined ? {} : { autoSubmit: site.autoSubmit }),
      extraFields: (site.extraFields ?? []).map((field) => ({ ...field })),
      hasPassword: Boolean(secrets?.site[site.baseUrl]),
      accounts: accounts.map((identity) => ({
        name: identity.name,
        username: identity.username,
        role: identity.role,
        color: identity.color,
        startPath: identity.startPath ?? "/",
        ...(identity.note ? { note: identity.note } : {}),
        extraFields: (identity.extraFields ?? []).map((field) => ({ ...field })),
        hasPassword: Boolean(secrets?.identity[accountSecretKey(site.baseUrl, identity.username)]),
      })),
    };
  });

  return {
    format: ACCOUNTS_FORMAT,
    version: ACCOUNTS_VERSION,
    exportedAt: new Date().toISOString(),
    ...(input.note ? { note: input.note } : {}),
    sites,
  };
}
