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

/**
 * Built-in ids are stable strings such as "2x2" or "free". Custom presets use a
 * generated id, so scenes only ever reference a preset by id.
 */
export type LayoutId = string;

/** A window rectangle in fractions of the work area (0–1). */
export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A named window arrangement. `slots` positions windows edge to edge across the
 * whole work area; an empty slot list means "no layout": every window opens at
 * full work-area size and windows overlap instead of shrinking.
 */
export interface LayoutPreset {
  id: LayoutId;
  name: string;
  slots: SlotRect[];
  builtin: boolean;
}

export interface Scene {
  id: string;
  environmentId: string;
  name: string;
  identityIds: string[];
  layoutId: LayoutId;
  /** identityId -> slot index. Missing entries fall back to launch order. */
  slotAssignments: Record<string, number>;
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
  /** Preset and slot the window was placed with, so later retiles keep it put. */
  layoutId?: LayoutId;
  slotIndex?: number;
  startedAt: string;
  clean?: boolean;
}

/**
 * Content of the short-lived label shown over a browser window right after it
 * is raised. Separate pages look identical, so the label is the only thing that
 * tells the user which account that window belongs to.
 */
export interface FocusLabelPayload {
  label: string;
  role?: string;
  color: RoleColor;
  /** Only set when several environments are running at once. */
  environment?: string;
  /** Bumped by the sender so the renderer can restart the fade animation. */
  seq: number;
}

export interface AuthCheckResult {
  identityId: string;
  status: IdentityStatus;
  checkedAt: string;
  detail?: string;
}

export interface AuthBatchTotals {
  signedIn: number;
  expired: number;
  unknown: number;
}

export interface AuthBatchResult {
  environmentId?: string;
  checkedAt: string;
  totals: AuthBatchTotals;
  results: AuthCheckResult[];
}

export interface ReloginResult {
  identityId: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ReloginBatchResult {
  attempted: number;
  succeeded: number;
  results: ReloginResult[];
}

export interface SceneRestoreOutcome {
  restored: boolean;
  sceneId?: string;
  sceneName?: string;
  reason?: string;
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
  lastView: "environments" | "identities" | "scenes";
  /**
   * Scene launched most recently. Only used when {@link restoreLastScene} is on;
   * it is not the "selected scene in the UI" and may point at another environment.
   */
  lastSceneId?: string;
  /** Reopen {@link lastSceneId} once the app finishes starting. */
  restoreLastScene: boolean;
  /** Show the always-on-top switcher that lists running instances. */
  overlayEnabled: boolean;
  /**
   * User agent a headless session check presents to the site.
   *
   * "desktop" (default) sends the normal desktop UA, which is what a user's own
   * browser sends; "headless" sends Chromium's honest headless UA. Overriding the
   * UA is a basic browser feature (devtools can do it), not fingerprint
   * spoofing, and it keeps a background check from looking like a crawler to the
   * site under test.
   */
  headlessCheckUa: "desktop" | "headless";
  /**
   * After switching windows, briefly show the account name over the window that
   * was just raised. Identical pages otherwise make it impossible to tell which
   * account a window belongs to.
   */
  focusLabelEnabled: boolean;
  /**
   * Delay between two windows of the same scene, in milliseconds. 0 by default:
   * launchers are cheap, and the old 350ms made an eight-member scene feel slow.
   * Users on a constrained machine can raise it.
   */
  launchIntervalMs: number;
  /** Preset used when identities are launched outside a scene. */
  layout: LayoutId;
  /** Fill saved credentials as soon as a launched window reaches a login form. */
  autoFillOnLaunch: boolean;
  /**
   * Keep running in the tray when the window is closed. On by default: the local
   * MCP endpoint dies with the process, so an accidental close would disconnect
   * every AI client mid-task.
   */
  closeToTray: boolean;
  /** Version of the onboarding tour the user has already seen. */
  onboardingVersion: number;
  /**
   * Check GitHub for a newer release shortly after launch and every few hours.
   * On by default: finding out about updates should not depend on remembering to
   * press a button. Only the check is automatic — downloading and installing
   * always start from an explicit click.
   */
  autoCheckUpdates: boolean;
  /**
   * Version the user chose to postpone. Suppresses the update prompt for that
   * exact version until a newer one is published, so "later" is not asked again
   * on every launch.
   */
  dismissedUpdateVersion?: string;
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
  /** User-defined layout presets; built-ins live in @shared/layouts. */
  layoutPresets: LayoutPreset[];
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
  layoutId: LayoutId;
  slotAssignments: Record<string, number>;
  paths: Record<string, string>;
}

export interface LayoutPresetDraft {
  id?: string;
  name: string;
  slots: SlotRect[];
}

export type SettingsPatch = Partial<
  Pick<
    AppSettings,
    | "theme"
    | "locale"
    | "lastEnvironmentId"
    | "lastView"
    | "lastSceneId"
    | "restoreLastScene"
    | "overlayEnabled"
    | "headlessCheckUa"
    | "focusLabelEnabled"
    | "launchIntervalMs"
    | "layout"
    | "autoFillOnLaunch"
    | "closeToTray"
    | "onboardingVersion"
    | "autoCheckUpdates"
    | "dismissedUpdateVersion"
  >
>;

export interface PasswordOwner {
  kind: "environment" | "identity";
  id: string;
}

/** Settings for the local MCP endpoint AI clients connect to. */
export interface McpSettings {
  enabled: boolean;
  /** Loopback port; clients are configured against it once. */
  port: number;
  /** Bearer token. Never part of the workspace snapshot. */
  token: string;
  allowWrite: boolean;
  allowRun: boolean;
  allowDelete: boolean;
}

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  /** Ready-to-paste URL, e.g. http://127.0.0.1:47821/mcp */
  url: string;
  token: string;
  allowWrite: boolean;
  allowRun: boolean;
  allowDelete: boolean;
  toolCount: number;
  /** Last bind error, if the port could not be used. */
  error?: string;
}

export interface McpPatch {
  enabled?: boolean;
  port?: number;
  allowWrite?: boolean;
  allowRun?: boolean;
  allowDelete?: boolean;
  /** Replaces the bearer token; every client must update its config. */
  rotateToken?: boolean;
}
