import type { EmbeddedViewport } from "./embedded";
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
  /**
   * Folder this bookmark sits in; absent means unfiled (the top level).
   *
   * Folders are real records ({@link BookmarkFolder}) because they nest: a
   * single-level label can live on the bookmark itself, but once a folder can
   * have children, renaming or moving a middle node must not rewrite every
   * descendant — the tree owns the names, the bookmarks only point at a leaf.
   * Deleting a folder keeps its contents by re-parenting them one level up.
   */
  folderId?: string;
  /** Sort key; lower first. New bookmarks append. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A folder in the bookmark tree. Nesting is the reason this is a record rather
 * than a label on the bookmark (see {@link Bookmark.folderId}); ids keep
 * renames and subtree moves O(1) writes instead of rewrites of every path.
 */
export interface BookmarkFolder {
  id: string;
  name: string;
  /** Parent folder id; absent means the top level. */
  parentId?: string;
  /** Sort key among siblings; lower first. New folders append. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkDraft {
  id?: string;
  name: string;
  url: string;
  /** Absent or empty moves the bookmark to unfiled. */
  folderId?: string;
}

export interface BookmarkFolderDraft {
  id?: string;
  name: string;
  /** Absent or empty puts the folder at the top level; also how a folder moves. */
  parentId?: string;
}

export type BookmarkSourceKind = "edge" | "chrome" | "firefox";

/**
 * A detected browser profile whose bookmarks can be imported, without its local
 * path: the renderer addresses sources by opaque id, and the main process is
 * the only side that knows where the files live.
 */
export interface BookmarkImportSourceInfo {
  id: string;
  kind: BookmarkSourceKind;
  browser: string;
  profile: string;
  /** http(s) bookmarks in the profile; `-1` means not counted (Firefox). */
  count: number;
}

export interface BookmarkImportOutcome {
  bookmarks: number;
  folders: number;
  skipped: number;
}

export interface Site {
  id: string;
  name: string;
  baseUrl: string;
  loginPath: string;
  authCheckPath?: string;
  /**
   * Body marker that means "signed out" even when the check endpoint answers
   * 200.
   *
   * Some backends wrap every answer in a 200 envelope (`{"status":2014,...}`),
   * so a plain HTTP-status probe reads a signed-out session as signed in and
   * never fills. When set, the probe also matches this string against the
   * response body (first 4 KiB) and treats a hit as signed out.
   */
  authCheckSignedOut?: string;
  /**
   * localStorage key that holds the site's session token, for header-token
   * sites.
   *
   * Some backends authenticate a private header (`token`) read from the page's
   * localStorage instead of a cookie, so a cookie-only probe reads every
   * session — including a live one — as signed out. When set, the check probe
   * reads this key at check time and sends the value along.
   */
  authTokenKey?: string;
  /**
   * Header name the token is sent as. Defaults to "token" when a key is set;
   * only meaningful together with {@link Site.authTokenKey}.
   */
  authTokenHeader?: string;
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
  /**
   * Profile a profile-window was opened in, when there is one.
   *
   * Only external launches by profile set this. It exists so the run dock can
   * say which jar a window belongs to — two profile windows of the same browser
   * are otherwise indistinguishable rows.
   */
  profileId?: string;
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
  /**
   * When `skipped` is "no-password", which credential was absent.
   *
   * The launch path used to stay silent here and the manual fill button said
   * "this account has no password" either way — wrong half the time, because an
   * inheriting account is only as good as its site's default. Naming the reason
   * lets the toast point at the dialog that actually fixes it.
   */
  missingCredential?: "identity-empty" | "site-empty" | "no-site" | "reference-broken";
  /**
   * True when the launch actively navigated to the site's login page and then
   * found no form there.
   *
   * "No login form" is ordinary on a landing page and a defect on `/login`; the
   * flag is what lets the history keep the second case and drop the first.
   */
  navigatedToLogin?: boolean;
}

/**
 * A browsing profile: one environment with its own login state.
 *
 * Accounts and everyday browsing look like different features, but they are the
 * same thing underneath: a partition that keeps cookies under its own name.
 * {@link Identity} stays a richer object — it also carries credentials, a site
 * and login checks — while a profile is just the partition and how long it
 * lives. Treating them as one concept in the interface is what lets "new
 * browser" offer both without explaining the difference twice.
 *
 * `retention` is the only real difference between the built-ins:
 *
 * - `persist` writes to disk, so a sign-in survives a restart. That is what
 *   everyday browsing means.
 * - `ephemeral` lives in memory and is keyed per running browser, so it dies
 *   with the process. "Clean session" is not a separate feature — it is a
 *   profile with this retention.
 */
export interface BrowserProfile {
  id: string;
  /** Shown in the chooser and in the profile page; the built-in one is renamed. */
  name: string;
  retention: BrowserProfileRetention;
  /**
   * Set on the two rows the app ships with. A built-in profile can be renamed
   * but not deleted, and its partition name is stable so old logins keep
   * working.
   */
  builtin?: boolean;
}

export type BrowserProfileRetention = "persist" | "ephemeral";

export interface AppSettings {
  theme: "dark" | "light" | "system";
  /** UI language; `"system"` follows the OS. See {@link LocaleSetting}. */
  locale: LocaleSetting;
  /**
   * Profiles available for everyday pages, in the order the chooser lists them.
   *
   * The two built-ins (`default`, `clean`) are always present; the loader
   * re-inserts them if a file predates this field or lost them in an edit. A
   * user-created profile is a third row with the same shape.
   */
  profiles: BrowserProfile[];
  /**
   * Profile a page with no account opens in when the caller does not name one —
   * a bookmark, a typed address, the toolbar's "+".
   */
  defaultProfileId: string;
  lastSiteId?: string;
  lastView:
    | "browser"
    | "messages"
    | "ai"
    | "sites"
    | "identities"
    | "views"
    | "flows"
    | "tags"
    | "bookmarks"
    | "profiles";
  /**
   * Which shell the window opens in.
   *
   * "browse" is the browser surface alone — tab strip, toolbar, page — and is
   * what a single-cell layout means. "bench" adds the run dock and the cells of
   * a multi-cell layout. The layout drives it automatically; this value is the
   * last state, remembered so a restart lands where the work was.
   */
  shellMode?: "browse" | "bench";
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
  /**
   * Default layout for a new view and for a batch launch.
   *
   * `"free"` (no layout) out of the box: both entry points start with a single
   * page, and a grid default put that page in a quarter of the stage beside
   * empty cells nobody asked for.
   */
  layout: LayoutId;
  /**
   * Whether {@link AppSettings.layout} was chosen by the user.
   *
   * Read only while loading: while it is false the stored `layout` is replaced
   * with the factory default, so an install created under an older factory
   * default picks up the new one instead of keeping a value nobody chose. Picking
   * a layout in Settings sets it to true.
   */
  layoutExplicit: boolean;
  /**
   * Browser used when an external launch does not name one.
   *
   * Global on purpose. It used to live on each site, which meant the same
   * "launch externally" action routed differently depending on which site the
   * account belonged to. An identity can still override it when one account
   * genuinely needs another browser.
   *
   * Unset means "pick one": the first engine that supports CDP, else the first
   * engine found. That keeps a fresh install working with no configuration.
   *
   * This is only a *default*. Every launch point offers its own browser list, so
   * the choice is made at the moment of launching rather than by flipping a mode
   * first — see `surface` on the launch calls.
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
   * Default fixed CSS viewport for pages in the built-in browser.
   *
   * The workspace-wide answer to "what size should pages render at?". A page
   * follows it until the user pins its own size from that tab's context menu,
   * and can be sent back to following it from the same menu. `null` means
   * adaptive: every page fills its cell.
   *
   * Separate axis from {@link browserZoom}: zoom scales a page at its own layout
   * size, a fixed viewport changes the layout size itself.
   */
  browserViewport: EmbeddedViewport | null;
  /**
   * How far back the performance monitor's chart reaches, in milliseconds.
   *
   * The window is a trade-off between resolution and reach: a narrower one puts
   * more pixels between seconds, which is what makes a stutter visible, and a
   * wider one shows a slow climb. Range-checked on write by
   * `normalizePerfWindow`, so a stored value is always one the chart can draw.
   */
  perfWindowMs: number;
  /**
   * How often the performance monitor samples, in milliseconds.
   *
   * Lower is finer and slightly more expensive: each reading is a synchronous
   * CDP call on the page's main thread. The floor is the point where Chromium
   * has nothing new to report rather than an arbitrary round number.
   */
  perfSampleIntervalMs: number;
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
  /**
   * Version of the in-app guide the user has already read.
   *
   * One counter for one introduction: the guide is both the first-run screen and
   * the handbook the title-bar dot and Settings open later. A file written by an
   * older build may still carry `onboardingVersion` from the retired spotlight
   * tour; it is ignored on load and dropped on the next save.
   */
  guideVersion: number;
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
  /** Folders of the bookmark tree; bookmarks reference these by id. */
  bookmarkFolders: BookmarkFolder[];
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
  /** Body marker that reads as "signed out" on a 200 response; see {@link Site}. */
  authCheckSignedOut?: string;
  /** localStorage key that holds the session token; see {@link Site.authTokenKey}. */
  authTokenKey?: string;
  /** Header name the token is sent as; see {@link Site.authTokenHeader}. */
  authTokenHeader?: string;
  /** Absent = follow the global default. */
  autoSubmit?: boolean;
  tagIds?: string[];
  /**
   * Set or replace the site's default password as part of saving.
   *
   * Carried on the draft rather than written through `setPassword` afterwards
   * because a new site has no id until it has been saved: the dialog would have
   * to save twice and thread the id back. One write, one place.
   *
   * Never read back — the renderer only learns whether a password exists, via
   * `credentials.site[siteId]`. An empty string means "leave it alone"; use
   * {@link clearSitePassword} to remove one.
   */
  password?: string;
  /** Removes the site's default password while saving (no value round-trip). */
  clearSitePassword?: boolean;
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
  /**
   * Tenant, organization or whatever else the form asked for beside the
   * username. Part of the account's identity on a multi-tenant site.
   */
  extraFields?: { label: string; value: string }[];
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
    | "shellMode"
    | "lastViewId"
    | "restoreLastView"
    | "overlayEnabled"
    | "headlessCheckUa"
    | "focusLabelEnabled"
    | "launchIntervalMs"
    | "layout"
    | "defaultEngineId"
    | "autoFillOnLaunch"
    | "autoSubmitLogin"
    | "browserZoom"
    | "browserViewport"
    | "perfWindowMs"
    | "perfSampleIntervalMs"
    | "searchEngineId"
    | "customSearchEngines"
    | "newTabBackground"
    | "newTabBookmarks"
    | "closeToTray"
    | "guideVersion"
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
   * How the AI may act in pages that belong to a profile rather than an account.
   *
   * `allowlist` and `denylist` read {@link aiOrigins}; the two whole-profile modes
   * ignore it. The mode and the list are stored separately so switching between
   * them never loses the addresses the user entered.
   *
   * A settings file written before this field existed is loaded as `allowlist`,
   * which is what those installs already did: an empty list stays read-only and
   * is never silently widened to "allow all".
   */
  aiMode: "allowlist" | "denylist" | "allow-all" | "deny-all";
  /**
   * Origins the user named for the profile-page gate.
   *
   * Interpreted according to {@link aiMode}: allowed in an allowlist, blocked in a
   * denylist. Kept as-is in the two whole-profile modes, so returning to a list
   * mode restores the previous configuration rather than an empty one.
   */
  aiOrigins: string[];
}

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  /** True while a bind attempt (or the retry ladder behind it) is in flight. */
  starting?: boolean;
  port: number;
  /** Ready-to-paste URL, e.g. http://127.0.0.1:47821/mcp */
  url: string;
  token: string;
  allowWrite: boolean;
  allowRun: boolean;
  allowDelete: boolean;
  aiMode: "allowlist" | "denylist" | "allow-all" | "deny-all";
  aiOrigins: string[];
  /**
   * Origins the user allowed "for this session" in the authorization window.
   *
   * Kept in memory only: the answer was given about this run of the app, and
   * writing it to disk would silently turn it into the permanent answer the user
   * did not choose.
   */
  aiSessionOrigins: string[];
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
  /** Workspace ids the page belonged to, so the log can group by site. */
  siteId?: string;
  identityId?: string;
  profileId?: string;
  clean?: boolean;
  tabTitle?: string;
  /** What the call did, in one redacted line; see {@link AiActivityRecord}. */
  summary?: string;
  /** How an authorization request ended, when one was shown. */
  approval?: AiApprovalOutcome;
  error?: string;
}

export interface McpPatch {
  enabled?: boolean;
  port?: number;
  allowWrite?: boolean;
  allowRun?: boolean;
  allowDelete?: boolean;
  /** Which policy the stored origin list is read under. */
  aiMode?: "allowlist" | "denylist" | "allow-all" | "deny-all";
  /** Adds or removes one entry of the stored origin list. */
  aiOrigin?: { origin: string; allowed: boolean };
  /**
   * Adds several entries at once.
   *
   * "Add from bookmarks" can produce dozens of origins, and one call per origin
   * would rewrite the settings file dozens of times — each write a chance to
   * leave a half-applied list if the app closes mid-way. Duplicates are dropped
   * by the server.
   */
  aiOriginsAdd?: string[];
  /** Replaces the bearer token; every client must update its config. */
  rotateToken?: boolean;
}

/** Lifecycle of one download, as the toolbar shows it. */
export type DownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

/**
 * One download entry.
 *
 * `savePath` is empty while the save dialog is still open and stays empty when
 * the user cancels it — `state` is the field that says what happened.
 */
export interface DownloadEntry {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  /** Epoch milliseconds. */
  startedAt: number;
  finishedAt?: number;
}

/** What the toolbar may ask a download to do. */
export type DownloadAction = "cancel" | "open" | "reveal" | "remove" | "clear";

/**
 * Which part of the app a message came from.
 *
 * Separate from `tone`: tone is how loud the row is, kind is which producer it
 * belongs to and therefore what the row can offer to do about it.
 *
 * AI activity used to be a fourth kind. It is not a message — nobody needs to be
 * told the assistant clicked something — so it has its own store and its own
 * list; see {@link AiActivityRecord}.
 */
export type MessageKind = "login-capture" | "account" | "app";

/**
 * Something a message row can do.
 *
 * Stored as data, not a callback: history outlives the process, and the thing it
 * points at may not. A capture token dies with the process, a tab closes, an
 * identity is deleted — so a row has to be able to say "this no longer works"
 * rather than pretend.
 */
export type MessageAction =
  | { type: "login-capture"; token: string }
  | { type: "identity"; identityId: string; siteId?: string }
  | { type: "tab"; tabId: string };

export interface AppMessage {
  id: string;
  /** ISO timestamp; the list is ordered by it, newest first. */
  at: string;
  kind: MessageKind;
  tone: "info" | "success" | "warning" | "error";
  /**
   * The headline as an i18n key, so switching language rewrites history too.
   * Anything untranslatable (a server error, a page title) travels in `detail`.
   */
  titleKey: string;
  titleParams?: Record<string, string>;
  detail?: string;
  action?: MessageAction;
  read: boolean;
}

/** A row as the renderer sees it: `stale` is decided live and never stored. */
export interface AppMessageView extends AppMessage {
  stale?: boolean;
}

export interface AddMessageInput {
  kind: MessageKind;
  tone: AppMessage["tone"];
  titleKey: string;
  titleParams?: Record<string, string>;
  detail?: string;
  action?: MessageAction;
}

/**
 * How a page's AI permission came out.
 *
 * `unlisted` is not the same as `blocked`: one is an address the user never
 * decided about (and can be asked about), the other is one they decided against.
 * The gate treats them differently, so the interface has to be able to tell them
 * apart rather than showing both as a grey shield.
 */
export type AiGateState = "open" | "blocked" | "unlisted";

/** What the user answered in the authorization window. */
export type AiApprovalDecision = "allow-once" | "allow-session" | "allow-always" | "deny";

/** How an authorization request ended, as the log records it. */
export type AiApprovalOutcome = AiApprovalDecision | "timeout";

/**
 * One AI call that touched a page.
 *
 * A log entry, not a notification: there is no read flag and no unread count,
 * because nothing here is waiting to be acknowledged. The structured fields are
 * what let the list group by site and say which profile or account was involved
 * — the old message row stored the origin as a display string and redacted the
 * rest.
 */
export interface AiActivityRecord {
  id: string;
  /** ISO timestamp; the list is ordered by it, newest first. */
  at: string;
  tool: string;
  /** Origins the permission is granted in. */
  origin: string;
  siteId?: string;
  identityId?: string;
  profileId?: string;
  /** True when the page belonged to a throwaway session. */
  clean?: boolean;
  tabId: string;
  tabTitle?: string;
  /**
   * One plain-language line naming what the call did ("点击「投放」").
   *
   * Stored rather than derived: a tool name alone does not say what was clicked,
   * and the arguments are not kept — this is the only surviving "what happened",
   * and it is built by the same redacting formatter the authorization card uses.
   */
  summary?: string;
  ok: boolean;
  /** False when the call was refused by the page's origin gate. */
  originAuthorized: boolean;
  /** Present when a window asked the user, or when the call was refused. */
  approval?: AiApprovalOutcome;
  error?: string;
  /** Calls folded into this row by the merge window. */
  count: number;
}

export interface AiActivityInput {
  tool: string;
  origin: string;
  siteId?: string;
  identityId?: string;
  profileId?: string;
  clean?: boolean;
  tabId: string;
  tabTitle?: string;
  summary?: string;
  ok: boolean;
  originAuthorized: boolean;
  approval?: AiApprovalOutcome;
  error?: string;
}

/**
 * The log split by the place it happened.
 *
 * `key` is stable across renders and is what collapse state is keyed by; a site
 * the workspace knows keeps that identity across renames, while a bare origin
 * falls back to the address.
 */
export interface AiActivitySiteGroup {
  key: string;
  siteId?: string;
  origin: string;
  /** Newest first, like the list they came from. */
  records: AiActivityRecord[];
}
