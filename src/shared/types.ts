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

/**
 * A user-created label for grouping sites.
 *
 * Tags carry no behaviour: they only decide how the site list and the title-bar
 * switcher are organised. A site may have many, and deleting a tag merely
 * unlinks it — sites and identities are never touched.
 */
export interface SiteTag {
  id: string;
  name: string;
  color: RoleColor;
  createdAt: string;
}

export interface Site {
  id: string;
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  defaultEngineId?: string;
  autoSubmit: boolean;
  /** Login fields shared by every identity in this site. */
  extraFields?: LoginField[];
  /** Site tag ids; display grouping only. */
  tagIds?: string[];
  /**
   * Origin credentials were last used against.
   *
   * Changing `baseUrl` is a normal edit, but it also redirects where the password
   * gets typed. When the current origin differs from this one, filling asks for
   * confirmation first — the same idea as SSH's `known_hosts`.
   */
  lastOrigin?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How an identity gets its password.
 *
 * `reference` reuses another identity's credentials wholesale: username, password,
 * display name, role, colour, note and extra fields all follow the source. Anything
 * that needs to differ must be detached into its own copy first.
 */
export type PasswordMode = "inherit" | "custom" | "reference";
export type IdentityStatus = "unknown" | "signed-in" | "expired";
export type RoleColor = "amber" | "teal" | "violet" | "rose" | "blue" | "slate";

export interface Identity {
  id: string;
  siteId: string;
  name: string;
  username: string;
  role: string;
  color: RoleColor;
  engineId?: string;
  startPath?: string;
  passwordMode: PasswordMode;
  /**
   * Identity whose credentials this one reuses, used when `passwordMode` is
   * `"reference"`. The source must not itself be a reference.
   */
  credentialFrom?: string;
  status: IdentityStatus;
  lastCheckedAt?: string;
  /** Overrides site fields with the same label; an empty value removes one. */
  extraFields?: LoginField[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Built-in ids are stable strings such as "2x2" or "free". Custom presets use a
 * generated id, so views only ever reference a preset by id.
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

export interface View {
  id: string;
  siteId: string;
  name: string;
  identityIds: string[];
  layoutId: LayoutId;
  /** identityId -> slot index. Missing entries fall back to launch order. */
  slotAssignments: Record<string, number>;
  paths: Record<string, string>;
  /**
   * Set when this view was copied from another site. It records provenance only:
   * the copy is independent, and "sync from source" is a manual action.
   */
  copiedFrom?: { siteId: string; viewId: string };
  createdAt: string;
  updatedAt: string;
}

/** Outcome of copying a view to another site. */
export interface ViewCopyResult {
  view: View;
  /** Identities created on the target site as references to the source ones. */
  createdReferences: string[];
  /** Source members that already had a matching account on the target site. */
  reused: string[];
  /** Source members that could not be matched and were skipped. */
  skipped: string[];
}

export interface RunningInstance {
  id: string;
  identityId?: string;
  label: string;
  siteId: string;
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
  /** Only set when several sites are running at once. */
  site?: string;
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
  siteId?: string;
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

export interface ViewRestoreOutcome {
  restored: boolean;
  viewId?: string;
  viewName?: string;
  reason?: string;
}

export interface LaunchResult {
  instance: RunningInstance;
  identities: Identity[];
}

/** Emitted after a best-effort fill that follows a launch or view start. */
export interface AutoFillReport {
  identityId: string;
  label: string;
  filled: boolean;
  submitted: boolean;
  /** Configured fields whose input could not be located on the page. */
  missingFields: string[];
  /** Visible inputs the page has that no configuration describes yet. */
  unmatchedFields: string[];
  skipped?:
    | "no-password"
    | "not-login-page"
    | "cross-origin"
    | "origin-changed"
    | "external"
    | "failed";
}

export interface AppSettings {
  theme: "dark" | "light" | "system";
  locale: "zh" | "en";
  lastSiteId?: string;
  lastView: "browser" | "sites" | "identities" | "views";
  /**
   * View launched most recently. Only used when {@link restoreLastView} is on;
   * it is not the "selected view in the UI" and may point at another site.
   */
  lastViewId?: string;
  /** Reopen {@link lastViewId} once the app finishes starting. */
  restoreLastView: boolean;
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
   * Delay between two windows of the same view, in milliseconds. 0 by default:
   * launchers are cheap, and the old 350ms made an eight-member view feel slow.
   * Users on a constrained machine can raise it.
   */
  launchIntervalMs: number;
  /** Preset used when identities are launched outside a view. */
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
  site: Record<string, boolean>;
  identity: Record<string, boolean>;
}

export interface WorkspaceSnapshot {
  sites: Site[];
  /** User-created site tags; ordering here is the display order. */
  siteTags: SiteTag[];
  identities: Identity[];
  views: View[];
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

export interface SiteDraft {
  id?: string;
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  defaultEngineId?: string;
  autoSubmit: boolean;
  extraFields?: LoginField[];
  tagIds?: string[];
}

export interface SiteTagDraft {
  id?: string;
  name: string;
  color: RoleColor;
}

/**
 * Raised when a fill targets a site whose address changed since the password was
 * last used there. The UI must show the two origins and ask before proceeding.
 */
export interface OriginChangedNotice {
  identityId: string;
  siteId: string;
  siteName: string;
  expectedOrigin: string;
  currentOrigin: string;
}

export interface IdentityDraft {
  id?: string;
  siteId: string;
  name: string;
  username: string;
  role: string;
  color: RoleColor;
  engineId?: string;
  startPath?: string;
  passwordMode: PasswordMode;
  /** Source identity when `passwordMode` is `"reference"`. */
  credentialFrom?: string;
  /** Only sent when the user typed a new password. Never returned by the main process. */
  password?: string;
  extraFields?: LoginField[];
  note?: string;
}

export interface ViewDraft {
  id?: string;
  siteId: string;
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
    | "lastSiteId"
    | "lastView"
    | "lastViewId"
    | "restoreLastView"
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
  kind: "site" | "identity";
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
