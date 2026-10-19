export type Platform = "win32" | "darwin" | "linux";

export type EngineFamily = "chromium" | "firefox" | "webkit";
export type EngineChannel = "stable" | "beta" | "dev" | "canary";
export type EngineSource = "registry" | "standard" | "path" | "flatpak" | "snap" | "manual";
export type EngineStatus = "ready" | "unverified" | "blocked";

export interface Engine {
  id: string;
  family: EngineFamily;
  brand: string;
  channel: EngineChannel;
  exePath: string;
  version?: string;
  source: EngineSource;
  cdp: boolean;
  status: EngineStatus;
  blockReason?: string;
  /** Extra arguments that must precede browser arguments, used by flatpak. */
  launchArgs?: string[];
  /** Overrides where profiles for this engine are stored (flatpak/snap confinement). */
  profileBase?: string;
}

/**
 * Free text by design. Teams label environments "local", "staging", "prod", but
 * equally "测试", "项目-联调" or anything else. Only production-like values get
 * the extra confirmation; see @shared/environments.
 */
export type EnvironmentKind = string;

/**
 * A login form input beyond username and password, such as a tenant code.
 * `label` is matched against the field's placeholder/name/label text on the page.
 */
export interface LoginField {
  label: string;
  value: string;
}

export interface Environment {
  id: string;
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  kind: EnvironmentKind;
  defaultEngineId?: string;
  autoSubmit: boolean;
  /** Login fields shared by every identity in this environment. */
  extraFields?: LoginField[];
  createdAt: string;
  updatedAt: string;
}

export type PasswordMode = "inherit" | "custom";
export type IdentityStatus = "unknown" | "signed-in" | "expired";
export type RoleColor = "amber" | "teal" | "violet" | "rose" | "blue" | "slate";

export interface Identity {
  id: string;
  environmentId: string;
  name: string;
  username: string;
  role: string;
  color: RoleColor;
  engineId?: string;
  startPath?: string;
  passwordMode: PasswordMode;
  status: IdentityStatus;
  lastCheckedAt?: string;
  /** Overrides environment fields with the same label; an empty value removes one. */
  extraFields?: LoginField[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** Layout key is columns x rows. */
export type LayoutKey = "1x1" | "2x1" | "2x2" | "3x1";

export interface Scene {
  id: string;
  environmentId: string;
  name: string;
  identityIds: string[];
  layout: LayoutKey;
  paths: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface RunningInstance {
  id: string;
  identityId?: string;
  label: string;
  environmentId: string;
  engineId: string;
  pid: number;
  profileDir: string;
  mode: "cdp" | "external";
  cdpPort?: number;
  targetId?: string;
  startedAt: string;
  clean?: boolean;
}

export interface AuthCheckResult {
  identityId: string;
  status: IdentityStatus;
  checkedAt: string;
  detail?: string;
}

export interface LaunchResult {
  instance: RunningInstance;
  identities: Identity[];
}

/** Emitted after a best-effort fill that follows a launch or scene start. */
export interface AutoFillReport {
  identityId: string;
  label: string;
  filled: boolean;
  submitted: boolean;
  /** Configured fields whose input could not be located on the page. */
  missingFields: string[];
  /** Visible inputs the page has that no configuration describes yet. */
  unmatchedFields: string[];
  skipped?: "no-password" | "not-login-page" | "cross-origin" | "external" | "failed";
}

export interface AppSettings {
  theme: "dark" | "light" | "system";
  locale: "zh" | "en";
  lastEnvironmentId?: string;
  lastView: "identities" | "scenes";
  layout: LayoutKey;
  /** Fill saved credentials as soon as a launched window reaches a login form. */
  autoFillOnLaunch: boolean;
}

export interface CredentialPresence {
  secure: boolean;
  backend: string;
  /** "os" uses the platform keychain; "master" uses an app master password. */
  mode: "os" | "master";
  locked: boolean;
  /** True when a master password can be set or changed right now. */
  canManageMaster: boolean;
  warning?: string;
  environment: Record<string, boolean>;
  identity: Record<string, boolean>;
}

export interface WorkspaceSnapshot {
  environments: Environment[];
  identities: Identity[];
  scenes: Scene[];
  engines: Engine[];
  /** False while the background engine scan is still running. */
  enginesReady: boolean;
  instances: RunningInstance[];
  settings: AppSettings;
  credentials: CredentialPresence;
  platform: Platform;
  appVersion: string;
  userDataDir: string;
}

export interface EnvironmentDraft {
  id?: string;
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  kind: EnvironmentKind;
  defaultEngineId?: string;
  autoSubmit: boolean;
  extraFields?: LoginField[];
}

export interface IdentityDraft {
  id?: string;
  environmentId: string;
  name: string;
  username: string;
  role: string;
  color: RoleColor;
  engineId?: string;
  startPath?: string;
  passwordMode: PasswordMode;
  /** Only sent when the user typed a new password. Never returned by the main process. */
  password?: string;
  extraFields?: LoginField[];
  note?: string;
}

export interface SceneDraft {
  id?: string;
  environmentId: string;
  name: string;
  identityIds: string[];
  layout: LayoutKey;
  paths: Record<string, string>;
}

export type SettingsPatch = Partial<
  Pick<
    AppSettings,
    "theme" | "locale" | "lastEnvironmentId" | "lastView" | "layout" | "autoFillOnLaunch"
  >
>;

export interface PasswordOwner {
  kind: "environment" | "identity";
  id: string;
}
