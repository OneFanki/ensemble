import type { Flow } from "./flows";
import type { LocaleSetting } from "./locale";
import type { SearchEngine } from "./search";

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
 * A user-created label, shared by sites, identities and views.
 *
 * One namespace on purpose: a tag answers "how do I find this again", and the
 * same words ("生产", "测试", "客户A") apply to a deployment, an account and an
 * arrangement. Tags carry no behaviour — deleting one only unlinks it.
 */
export interface Tag {
  id: string;
  name: string;
  color: RoleColor;
  createdAt: string;
}

/**
 * A plain bookmark: a name and an address, nothing else.
 *
 * Deliberately not a {@link Site}. A site is a login recipe — it knows a login
 * path, an auth check, default passwords and the accounts that belong to it, and
 * opening one lands on the login form with a session of its own. A bookmark only
 * says "this page, in the daily profile". Conflating the two was the reason the
 * default surface had no way to keep a page without inventing an identity for
 * it: opening a bookmark must reuse the login already in the daily profile, not
 * start a fresh session and ask for a password.
 *
 * The difference the user sees is the outcome: a bookmark opens the address
 * directly, a site opens its login page and fills it.
 */
export interface Bookmark {
  id: string;
  name: string;
  url: string;
  /** Site icon, inlined by the main process exactly like a tab's. */
  favicon?: string;
  /** Sort key; lower first. New bookmarks append. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkDraft {
  id?: string;
  name: string;
  url: string;
}

export interface Site {
  id: string;
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  /**
   * Whether to press the login button after filling.
   *
   * Absent means "follow `settings.autoSubmitLogin`", which is the shape a
   * per-site override should have: a site only stores a value when someone made
   * a decision about *this* site.
   *
   * A stored boolean is honoured as-is, `false` included. Older builds wrote
   * `false` on every new site, so some of those values mean "nobody chose
   * anything" rather than "keep this one manual" — but the two are
   * indistinguishable in the data, and silently starting to submit a login form
   * someone may have deliberately kept manual is the worse mistake. The dialog
   * shows the resolved value, so a stale `false` is one click from correction.
   */
  autoSubmit?: boolean;
  /** Tag ids; finding and grouping only. */
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
  /**
   * Site this account belongs to, or `undefined` for an account whose site is
   * gone.
   *
   * Optional on purpose: the v2 rename dropped this key from every account it
   * migrated, and those files are out in the wild. The account page shows them
   * under {@link identityOrphanSite} and offers a bulk re-link, which is why the
   * field must stay readable as absent instead of being coerced to `""`.
   */
  siteId?: string;
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
  /** Extra login fields, per account — the only place they exist. */
  extraFields?: LoginField[];
  /** Tag ids; the site's own tags are matched when filtering, not copied here. */
  tagIds?: string[];
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
   * Tag ids for finding a view. Filters also match tags of the member accounts
   * and their sites, so "everything touching 生产" works without tagging twice.
   */
  tagIds?: string[];
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
  /**
   * True when the launch pipeline confirmed a signed-in session — either it was
   * already there, or the auto-login routine just established one.
   */
  loggedIn?: boolean;
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
    | "failed"
    | "login-failed";
}

export interface AppSettings {
  theme: "dark" | "light" | "system";
  /** UI language; `"system"` follows the OS. See {@link LocaleSetting}. */
  locale: LocaleSetting;
  lastSiteId?: string;
  lastView: "browser" | "sites" | "identities" | "views" | "flows" | "tags";
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
  /**
   * Where "launch" sends a view or identity.
   *
   * One switch in the title bar decides it: launching never asks twice, and the
   * management pages do not each need their own pair of buttons. "embedded" is
   * the default because that surface is the reason the app exists; "external"
   * is the fidelity check against the real browser.
   */
  launchTarget: "embedded" | "external";
  /**
   * Browser used for external launches, by engine id.
   *
   * Global on purpose. It used to live on each site, which meant the same
   * "launch externally" action routed differently depending on which site the
   * account belonged to — while the title bar showed one browser. A single
   * setting matches what that switch claims to do; an identity can still
   * override it when one account genuinely needs another browser.
   *
   * Unset means "pick one": the first engine that supports CDP, else the first
   * engine found. That keeps a fresh install working with no configuration.
   */
  defaultEngineId?: string;
  /** Fill saved credentials as soon as a launched window reaches a login form. */
  autoFillOnLaunch: boolean;
  /**
   * Press the login button right after a fill, unless a site says otherwise.
   *
   * Filling without submitting leaves every account parked on a filled form, one
   * click short of signed in — which for a view of six accounts is six clicks.
   * The default is on because that is what "open this account" is supposed to
   * mean. A site can override it (`Site.autoSubmit`), which is the escape hatch
   * for a console that hates being submitted by a robot, or one with a captcha
   * that would be burned by a wasted attempt.
   */
  autoSubmitLogin: boolean;
  /**
   * Default zoom for pages in the built-in browser, in percent.
   *
   * Applied to new pages and to pages the user has not adjusted by hand. Ctrl +
   * plus/minus adjusts one page only; Ctrl+0 returns it to this value. There is
   * deliberately no per-site zoom: a site is one login recipe shared by several
   * accounts, so a site-level factor would silently apply to identities that
   * only happen to share it, and the extra dimension is hard to explain.
   */
  browserZoom: number;
  /**
   * Engine a blank tab searches with, and the one the address bar falls back to
   * for text that is not an address.
   *
   * A blank tab is a search box in this app because the surface is meant to
   * replace the user's own browser while developing: opening a new page to look
   * something up must not require leaving the app.
   */
  searchEngineId: string;
  /** Engines the user added; built-ins live in code and are always available. */
  customSearchEngines: SearchEngine[];
  /**
   * Backdrop of the new-tab surface, by preset id (see `shared/newtab.ts`).
   *
   * A preset rather than a file path: the surface must paint before any network
   * or disk read, and a user-supplied image would need its own storage and its
   * own cleanup path. Presets are a closed set that can grow later.
   */
  newTabBackground: string;
  /**
   * Show the bookmark grid on the new-tab surface.
   *
   * On by default. A user who wants the search box alone can turn it off, and
   * the page then looks exactly like a plain browser start page.
   */
  newTabBookmarks: boolean;
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
  /**
   * How the app reaches the network: update checks, update downloads, and the
   * pages in the built-in browser.
   *
   * "system" is the default and means "whatever the OS says", which is what a
   * real browser does and what a Clash/TUN setup expects — the user turns on a
   * proxy once, at the system level, and every app that follows it works.
   * "off" forces a direct connection for users whose system proxy would break
   * local test addresses. "manual" is for proxies that never reach the OS
   * settings (a container, a remote proxy, or a rule set the user keeps apart).
   */
  proxyMode: ProxyMode;
  /**
   * `http://host:port` or `socks5://host:port`; only read when
   * {@link proxyMode} is "manual".
   */
  proxyUrl?: string;
  /**
   * Hosts that skip the proxy, comma-separated (Chromium's `proxyBypassRules`
   * syntax). Localhost is always bypassed: every test environment this app
   * exists to drive lives there.
   */
  proxyBypass?: string;
}

/** See {@link AppSettings.proxyMode}. */
export type ProxyMode = "system" | "off" | "manual";

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
  tags: Tag[];
  /** Plain bookmarks on the new-tab surface; no credentials, no site. */
  bookmarks: Bookmark[];
  identities: Identity[];
  views: View[];
  /** Reusable step sequences, one per repeatable job on a site. */
  flows: Flow[];
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
  /**
   * The OS language tag, e.g. "zh-CN".
   *
   * Sent so the renderer can resolve `settings.locale === "system"` itself —
   * `navigator.language` inside Electron follows `--lang`, which this app sets,
   * so asking the browser would answer with the app's own choice rather than the
   * user's OS setting.
   */
  systemLocale: string;
}

export interface SiteDraft {
  id?: string;
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  /** Absent = follow the global default. */
  autoSubmit?: boolean;
  tagIds?: string[];
}

export interface TagDraft {
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
  /**
   * Token from a captured login. The main process holds the password; sending
   * the token is how the form saves it without the secret ever being here.
   */
  captureToken?: string;
  extraFields?: LoginField[];
  /** Tag ids; the site's tags are matched too when filtering. */
  tagIds?: string[];
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
  /** Tag ids for finding the view; member tags are matched as well. */
  tagIds?: string[];
}

/**
 * A login form submission seen on the built-in surface.
 *
 * Carries no password: the secret stays in the main process until the user
 * accepts the save, and the renderer only ever holds this token.
 */
export interface LoginCaptureNotice {
  token: string;
  username: string;
  origin: string;
  path: string;
  tabId: string;
  /** Site matched by origin, when one exists; new sites are created instead. */
  siteId?: string;
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
    | "launchTarget"
    | "defaultEngineId"
    | "autoFillOnLaunch"
    | "autoSubmitLogin"
    | "browserZoom"
    | "searchEngineId"
    | "customSearchEngines"
    | "newTabBackground"
    | "newTabBookmarks"
    | "closeToTray"
    | "onboardingVersion"
    | "autoCheckUpdates"
    | "dismissedUpdateVersion"
    | "proxyMode"
    | "proxyUrl"
    | "proxyBypass"
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
  /**
   * Origins where the AI may type and click inside the **daily profile**.
   *
   * Empty by default, and that default is the point: a page in the daily profile
   * is the user's own signed-in browsing, so an AI gets read access there and
   * nothing more until the user names the origin. Identity and clean-session
   * pages are unaffected — those exist to be driven.
   */
  aiOrigins: string[];
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
  aiOrigins: string[];
  toolCount: number;
  /** Last bind error, if the port could not be used. */
  error?: string;
}

/**
 * One AI action aimed at a page.
 *
 * Carries the origin because that is the unit the permission is granted in, and
 * the count so the dock can show a running total per site for this session.
 */
export interface AiPageAction {
  origin: string;
  tabId: string;
  tool: string;
  ok: boolean;
  /** False when the action was refused by the daily-profile gate. */
  originAuthorized: boolean;
  /** Actions on this origin since the app started. */
  count: number;
}

export interface McpPatch {
  enabled?: boolean;
  port?: number;
  allowWrite?: boolean;
  allowRun?: boolean;
  allowDelete?: boolean;
  /** Grants or revokes AI input permission for one origin in the daily profile. */
  aiOrigin?: { origin: string; allowed: boolean };
  /** Replaces the bearer token; every client must update its config. */
  rotateToken?: boolean;
}
