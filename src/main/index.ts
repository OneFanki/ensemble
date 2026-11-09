import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretBox } from "@core/credentials/vault";
import { setCoreLocale, t } from "@core/i18n/translate";
import { resolveAuthTokenSource } from "@core/cdp/login";
import { nextActiveInstanceId } from "@core/launch/active-instance";
import { resolveLoginFields } from "@core/login-fields";
import {
  disposeWindowFocus,
  foregroundWindowPid,
  type ScreenRect,
  warmUpWindowFocus,
} from "@core/launch/window-focus";
import { MessageStore } from "@core/messages";
import { WorkspaceService } from "@core/service";
import { downloadUpdateAsset } from "@core/update/download";
import { buildWindowsInstallScript, updateFileName } from "@core/update/install";
import { parseAccountBundle } from "@shared/accounts-transfer";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import type { EmbeddedDropTarget, StageRect } from "@shared/embedded";
import {
  normalizeViewportSize,
  VIEWPORT_MAX_HEIGHT,
  VIEWPORT_MAX_WIDTH,
  VIEWPORT_MIN,
} from "@shared/embedded";
import { FLOW_TIMEOUT_MS, type Flow, type FlowDraft, resolveParams } from "@shared/flows";
import { localeTag, resolveLocale } from "@shared/locale";
import {
  CONNECTIVITY_PROBES,
  type ConnectivityProbe,
  type ConnectivityProbeResult,
} from "@shared/proxy";
import {
  type AccountsExportOutcome,
  type AccountsImportPickOutcome,
  type ExportOutcome,
  type FlowRunOutcome,
  type ImportPickOutcome,
  IPC,
} from "@shared/ipc";
import {
  bookmarkDraftSchema,
  bookmarkFolderDraftSchema,
  flowDraftSchema,
  identityDraftSchema,
  layoutPresetDraftSchema,
  passwordOwnerSchema,
  settingsPatchSchema,
  siteDraftSchema,
  tagDraftSchema,
  viewDraftSchema,
} from "@shared/schemas";
import { detectBookmarkSources, type BookmarkImportSource as DetectSource } from "@core/bookmarks-import";
import { parseExportFile } from "@shared/transfer";
import type {
  AppSettings,
  AddMessageInput,
  AppMessageView,
  BookmarkDraft,
  BookmarkFolderDraft,
  BookmarkImportSourceInfo,
  DownloadAction,
  DownloadEntry,
  FocusLabelPayload,
  IdentityDraft,
  LayoutId,
  LayoutPresetDraft,
  McpPatch,
  PasswordOwner,
  Platform,
  RoleColor,
  SettingsPatch,
  SiteDraft,
  SlotRect,
  TagDraft,
  ViewDraft,
  WorkspaceSnapshot,
} from "@shared/types";
import {
  evaluateUpdate,
  LATEST_RELEASE_API,
  parseLatestRelease,
  type UpdateCheckResult,
  type UpdateProgress,
} from "@shared/update";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  type OpenDialogOptions,
  type SaveDialogOptions,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  webContents,
} from "electron";
import { EmbeddedBrowser, type GuestHost } from "./embedded/browser";
import { BrowserGuestManager } from "./embedded/guests";
import { DownloadManager } from "./downloads";
import { applyProxyToDefaultSession } from "./proxy";
import { fixRealmEncoding, HttpAuthCoordinator } from "./http-auth";
import { LoginCaptureStore } from "./embedded/login-capture";
import { DEV_DEFAULT_PORT, McpServer } from "./mcp/server";
import { createTrustedUpdateFetch } from "./update-fetch";
import { DEV_APP_NAME, devUserDataDir } from "./user-data";

const isDev = Boolean(process.env["ELECTRON_RENDERER_URL"]);

/**
 * The download transport for update assets. One instance for the whole process:
 * it holds no state, and creating a fresh one per download would only re-parse
 * the same header list.
 */
const trustedUpdateFetch = createTrustedUpdateFetch();

/**
 * Runs the app without putting anything on screen.
 *
 * Automated checks (the e2e scripts and the screenshot pass) drive a real app,
 * and a real app window steals focus from whoever is working at the machine —
 * a suite spawns the app dozens of times, so the window kept surfacing in front
 * of unrelated work. Everything the checks read (CDP, DOM, frozen captures,
 * MCP) works on a window that was never shown, so the fix is to not show it.
 *
 * Deliberately an environment variable rather than a settings flag: this is a
 * harness concern, not something a user would ever toggle.
 */
const headless = process.env["ENSEMBLE_HEADLESS"] === "1";

// Lets an end-to-end check run against a throwaway workspace instead of the
// user's real one. Must happen before app ready: Electron derives session and
// partition storage from userData, so a late override would split the two.
const userDataOverride = process.env["ENSEMBLE_USER_DATA"]?.trim();

/**
 * Development runs in a workspace of their own, never the installed app's.
 *
 * See `user-data.ts` for what used to go wrong when the two shared one. The
 * decision is made here, before the single-instance lock below, because that
 * lock lives inside userData: two directories are two instances.
 */
const devDataDir = devUserDataDir({
  packaged: app.isPackaged,
  appDataDir: app.getPath("appData"),
  argv: process.argv,
  envOverride: userDataOverride,
});
/** True when this run is a development build with its own workspace. */
const isolatedDev = devDataDir !== undefined;

if (userDataOverride) app.setPath("userData", userDataOverride);
else if (devDataDir) app.setPath("userData", devDataDir);

/**
 * How this build names itself in the title bar, the tray and the About panel.
 *
 * Set before anything reads `app.name`, and only for a development build: the
 * packaged app's name is what Electron derives its default userData path from, so
 * renaming it there would move an existing installation's data out from under it.
 */
const appDisplayName = isolatedDev ? DEV_APP_NAME : "Ensemble";
if (isolatedDev) app.setName(DEV_APP_NAME);

// Chromium's UI language follows the app's. This is the tag that reaches
// `navigator.language` inside every embedded page, so a site that localizes by
// browser language sees the same language the user reads the app in.
//
// `locale: "system"` resolves to the OS language here — the same resolver the
// renderer uses, so the two can never disagree. Must be set before app ready;
// reading settings.json here is fine because userData was resolved just above.
try {
  const settings = JSON.parse(readFileSync(join(app.getPath("userData"), "settings.json"), "utf8"));
  const locale = resolveLocale(
    settings.locale === "zh" || settings.locale === "en" ? settings.locale : "system",
    app.getPreferredSystemLanguages?.()[0] ?? process.env["LANG"],
  );
  app.commandLine.appendSwitch("lang", localeTag(locale));
} catch {
  // No settings yet (first run): Chromium picks the system language.
}

/**
 * `safeStorage` adapter. Electron 45 deprecated the synchronous
 * `isEncryptionAvailable`/`encryptString`/`decryptString` (removal in 46), so
 * this box speaks the async API only.
 *
 * `available` stays a synchronous property because the vault reads it from
 * synchronous getters (`secure`). It is a snapshot taken once by `init()`,
 * which the app awaits before any window exists — OS-keychain availability does
 * not change over a session, so a snapshot is not a lie.
 */
class SafeStorageBox implements SecretBox {
  private availableSnapshot = false;
  private initialised = false;

  get backend(): string {
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend?.();
      return backend ?? "unknown";
    }
    return process.platform === "win32" ? "dpapi" : process.platform === "darwin" ? "keychain" : "unknown";
  }

  get kind(): "os" {
    return "os";
  }

  get available(): boolean {
    return this.availableSnapshot;
  }

  async init(): Promise<void> {
    this.availableSnapshot = await safeStorage.isAsyncEncryptionAvailable();
    this.initialised = true;
  }

  private ensureReady(): void {
    if (!this.initialised) {
      throw new Error("System credential storage is not initialised");
    }
  }

  async encrypt(plain: string): Promise<string> {
    // There is no plaintext fallback: a machine without a usable keychain must
    // either install one or protect the vault with a master password.
    this.ensureReady();
    if (!this.availableSnapshot) {
      throw new Error("System credential storage is unavailable");
    }
    const encrypted = await safeStorage.encryptStringAsync(plain);
    return `enc:${encrypted.toString("base64")}`;
  }

  async decrypt(payload: string): Promise<string> {
    this.ensureReady();
    if (!payload.startsWith("enc:")) throw new Error("Unknown credential payload");
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(payload.slice(4), "base64"));
    // A rotated key signals `shouldReEncrypt`; re-sealing immediately would race
    // the caller's write. The vault already rewrites on every save, so this
    // passes the plaintext through and the next `set()` persists fresh ciphertext.
    return decrypted.result;
  }
}

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let service: WorkspaceService | null = null;
let quitting = false;
let currentTheme: AppSettings["theme"] = "dark";
let tray: Tray | null = null;
let mcpServer: McpServer | null = null;
/**
 * AI page actions this session, keyed by tab.
 *
 * Keyed by tab rather than by origin because the badge sits on a row, and a row
 * is a tab. Keying by origin made every tab of one site show the same number, so
 * two rows of the same site looked like the AI had worked on both — the count
 * answered a site-level question while claiming to answer a row-level one.
 *
 * Reset when the app restarts rather than persisted: "how many operations the AI
 * made here" is a session fact, and a number that kept growing across launches
 * would stop meaning anything.
 *
 * A closed tab keeps its entry on purpose: reopening the same site in a new tab
 * legitimately starts from zero, and the memory cost of a session's worth of
 * UUID keys is negligible next to holding the pages themselves.
 */
const aiActionsByTab = new Map<string, number>();
/** Kept in sync so the close handler does not need the service to be initialized. */
let settingsCache: AppSettings | null = null;
/** Logins seen in embedded pages, waiting for the user to accept or dismiss. */
const loginCaptures = new LoginCaptureStore();
/**
 * The message centre's history.
 *
 * Created lazily rather than at module scope: `userData` is only final after the
 * dev/installed split has run, so a store built too early would open the file in
 * Electron's default directory instead of beside `workspace.json`.
 */
let messages: MessageStore | null = null;

function messageStore(): MessageStore {
  if (!messages) messages = new MessageStore(join(userDataDir(), "messages.json"));
  return messages;
}

/**
 * The history as the interface sees it.
 *
 * Staleness is decided here, on every read, because it is a fact about the world
 * rather than about the message: a capture token only lives in this process, a
 * tab only while it is open, an identity only until it is deleted. History from
 * last week still says what happened and simply stops offering the action.
 */
function messageViews(): AppMessageView[] {
  const openTabs = new Set(embedded?.state().tabs.map((tab) => tab.id) ?? []);
  const pendingTokens = new Set(loginCaptures.list().map((item) => item.token));
  const identities = new Set((service?.snapshot().identities ?? []).map((item) => item.id));
  return messageStore()
    .list()
    .map((message) => {
      if (!message.action) return message;
      const stale =
        message.action.type === "login-capture"
          ? !pendingTokens.has(message.action.token)
          : message.action.type === "tab"
            ? !openTabs.has(message.action.tabId)
            : !identities.has(message.action.identityId);
      return stale ? { ...message, stale: true } : message;
    });
}

function broadcastMessages(): AppMessageView[] {
  const list = messageViews();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.messagesChanged, list);
  }
  return list;
}

/**
 * The in-app browser surface. Created on first use so a user who never opens it
 * pays nothing at startup; it owns its own window, tabs and per-identity session
 * partitions.
 */
let embedded: EmbeddedBrowser | null = null;
/**
 * CDP sessions on `<webview>` guests.
 *
 * Exists independently of `embedded`: the guest lifecycle belongs to the DOM
 * (the renderer creates and removes the nodes), so this manager has to be live
 * from the first window, not from the first browser tab. Popup routing is
 * attached once a guest is mapped to a tab; until then a guest that asks for a
 * window simply does not get one.
 */
const guestManager = new BrowserGuestManager();

/** Correlation for "show this page briefly" requests (screenshot of a hidden tab). */
let presentSeq = 0;
const presentWaiters = new Map<number, (payload: { requestId: number; shown: boolean }) => void>();

/**
 * The renderer's half of the carrier contract.
 *
 * Main cannot create a `<webview>` node, so mounting is a request: send the
 * page's creation parameters, wait for the renderer to report `dom-ready`, then
 * hand back the guest's `webContents` and its CDP executor. Every page open
 * goes through this once, which is why the wait has a deadline — a renderer
 * that never answers must fail the open instead of hanging a tool call.
 */
const guestHost: GuestHost = {
  async mount({ tabId, partition, url }) {
    const win = mainWindow;
    if (!win || win.isDestroyed()) throw new Error("窗口已关闭");
    // Start waiting before asking: the renderer can report `dom-ready` before
    // the `send` has even returned, and a wait registered afterwards would miss
    // an attach that already happened.
    const pending = guestManager.awaitGuest(tabId, 10_000);
    const request = {
      tabId,
      partition,
      url,
      // Creation-time capability: a node created without it cannot receive
      // popup requests at all, and the request would never reach main.
      allowPopups: true,
    };
    win.webContents.send(IPC.embeddedGuestMount, request);
    /*
     * One retry shortly after the first request.
     *
     * The renderer subscribes to this channel while mounting, which happens a
     * moment after its document has finished loading — and that is exactly when
     * the MCP endpoint starts answering, so a tool call can arrive before the
     * listener exists. A `send` to a channel with no listener is dropped in
     * silence; the retry costs one frame in the normal case and saves a tool
     * call from failing on a renderer that was merely a frame late.
     */
    const retry = setTimeout(() => {
      if (guestManager.guestIdFor(tabId)) return;
      const current = mainWindow;
      if (!current || current.isDestroyed()) return;
      current.webContents.send(IPC.embeddedGuestMount, request);
    }, 400);
    retry.unref?.();
    try {
      await pending;
    } finally {
      clearTimeout(retry);
    }
    const guestId = guestManager.guestIdFor(tabId);
    const contents = guestId ? guestManager.contentsOf(guestId) : undefined;
    const cdp = guestId ? guestManager.cdpFor(guestId) : undefined;
    if (!contents || !cdp) throw new Error("页面没有在预期时间内就绪");
    return { contents, cdp };
  },
  async release(tabId) {
    const guestId = guestManager.guestIdFor(tabId);
    guestManager.releaseKey(tabId);
    if (guestId) await guestManager.teardown(guestId);
  },
  unmount(tabId) {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.embeddedGuestUnmount, { tabId });
  },
  present(tabId, visible) {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return Promise.reject(new Error("窗口已关闭"));
    const requestId = ++presentSeq;
    return new Promise<void>((resolve, reject) => {
      const done = (payload: { requestId: number; shown: boolean }): void => {
        if (payload.requestId !== requestId) return;
        presentWaiters.delete(requestId);
        clearTimeout(timer);
        resolve();
      };
      // A renderer that never replies must not hang a screenshot; the capture
      // itself has its own timeout, so giving up here just means "try anyway".
      const timer = setTimeout(() => {
        presentWaiters.delete(requestId);
        reject(new Error("页面没有及时呈现"));
      }, 1_500);
      timer.unref?.();
      presentWaiters.set(requestId, done);
      win.webContents.send(IPC.embeddedGuestPresent, { requestId, tabId, present: visible });
    });
  },
  holdSession(tabId, hold) {
    const guestId = guestManager.guestIdFor(tabId);
    if (guestId) guestManager.pinSession(guestId, hold);
  },
  primeForCapture: () => guestManager.primeForCapture(),
  targetFor: (tabId) => guestManager.targetFor(tabId),
};
/**
 * Downloads from every identity partition, for the browser toolbar.
 *
 * Created up front rather than with the browser: the list has to survive the
 * surface being closed and reopened, and the IPC channel answers even before a
 * tab exists.
 */
const downloads = new DownloadManager(broadcastDownloads);
/** A parsed import file waiting for its confirmation, keyed by absolute path. */
let pendingImport: { path: string; payload: ReturnType<typeof parseExportFile> } | null = null;
/** An account bundle picked but not yet applied, same lifecycle as `pendingImport`. */
let pendingAccountBundle: {
  path: string;
  payload: ReturnType<typeof parseAccountBundle>;
} | null = null;

// ---- update check / download / install ----

/** Result of the last check, kept so the dialog can download without re-checking. */
let pendingUpdate: UpdateCheckResult | null = null;
/** Absolute path of the verified installer, once the download completed. */
let downloadedUpdate: { path: string; version: string; assetName: string } | null = null;
let updateDownloading = false;
let updateTimer: NodeJS.Timeout | null = null;
/** First check runs a few seconds after launch, once the window is up. */
const UPDATE_FIRST_CHECK_MS = 8_000;
/** How often a background check repeats while the app stays open. */
const UPDATE_REPEAT_MS = 6 * 60 * 60 * 1_000;

/**
 * How long the window load may hold up the rest of startup.
 *
 * The window is visible from the first frame; this deadline only decides when
 * the code behind it (embedded surface, tray, MCP endpoint) stops waiting for a
 * `did-finish-load` that may never arrive.
 */
const RENDERER_LOAD_TIMEOUT_MS = 15_000;

/**
 * Native window-control colors mirror the renderer tokens for each theme.
 *
 * The colour has to be the *frame* token, not the toolbar's: the overlay is
 * drawn over the tab strip band, and the active tab is the only thing there that
 * takes the toolbar colour. Painting the overlay in the toolbar colour left a
 * light rectangle beside a grey strip.
 */
const TITLEBAR_COLORS = {
  dark: { color: "#191d22", symbolColor: "#b0b9c4" },
  light: { color: "#dee2e7", symbolColor: "#4d5661" },
} as const;

function isDarkTheme(theme: AppSettings["theme"]): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return nativeTheme.shouldUseDarkColors;
}

/**
 * Height of the tab-strip band, which is also the drag region.
 *
 * Must match `--titlebar-height` in `tokens.css`: the overlay reserves this many
 * pixels on the right of the strip, and a mismatch either leaves a gap under the
 * buttons or has them overlap the tabs.
 */
const TITLEBAR_HEIGHT = 34;

function titleBarOverlay(theme: AppSettings["theme"]): Electron.TitleBarOverlay {
  return { ...TITLEBAR_COLORS[isDarkTheme(theme) ? "dark" : "light"], height: TITLEBAR_HEIGHT };
}

function userDataDir(): string {
  return app.getPath("userData");
}

function profileRoot(): string {
  return join(userDataDir(), "profiles");
}

/**
 * The OS language tag, e.g. "zh-CN".
 *
 * `app.getPreferredSystemLanguages()` reports the OS setting; `--lang` (which
 * this app sets from its own preference) does not affect it. That distinction is
 * the whole point: resolving `locale: "system"` against `navigator.language`
 * would just read back the app's own choice.
 */
function systemLocaleTag(): string {
  const preferred = app.getPreferredSystemLanguages?.();
  const first = Array.isArray(preferred) && preferred.length > 0 ? preferred[0] : undefined;
  return first ?? process.env["LANG"] ?? process.env["LC_ALL"] ?? "";
}

/**
 * Creates the in-app browser surface on first use.
 *
 * Lazily constructed because a user who never opens it pays nothing at startup.
 * It paints inside the main window, so it is re-attached whenever that window is
 * recreated (the tray keeps the app alive after the window is closed).
 * `service` is read through the closure so the surface always sees the live
 * workspace; credentials never leave the main process.
 */
function ensureEmbeddedBrowser(): EmbeddedBrowser {
  if (embedded) {
    if (mainWindow && !mainWindow.isDestroyed()) embedded.attach(mainWindow);
    return embedded;
  }
  embedded = new EmbeddedBrowser({
    shotDir: join(userDataDir(), "screenshots"),
    // The detached DevTools window is created by the browser manager, so it
    // needs the icon too rather than falling back to electron.exe's.
    ...(appIconPath() ? { appIcon: appIconPath() } : {}),
    resolveLogin: async (identityId) => {
      if (!service) return { ok: false, missing: "no-identity" } as const;
      const identity = service.findIdentity(identityId);
      if (!identity) return { ok: false, missing: "no-identity" } as const;
      const site = service.findSite(identity.siteId);
      if (!site) return { ok: false, missing: "no-site-record" } as const;
      // The resolver mirrors the external launch path, including references.
      // It also reports *which* password is missing, so the toast can say "this
      // site has no default" instead of blaming an account that inherits one.
      const resolution = await service.resolvePasswordDetail(identityId);
      if (!resolution.password) {
        return { ok: false, missing: resolution.missing ?? "identity-empty" } as const;
      }
      return {
        ok: true,
        payload: {
          username: identity.username,
          password: resolution.password,
          // One resolver for the global default and the per-site override, so
          // the built-in surface and the external launcher cannot answer
          // differently.
          submit: service.effectiveAutoSubmit(site),
          extraFields: resolveLoginFields(identity),
          baseUrl: site.baseUrl,
        },
      } as const;
    },
    onShowPage: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.embeddedPage);
      }
    },
    ...(headless ? { headless: true } : {}),
    // Headless runs keep every page unthrottled (same reason as the windows
    // themselves); interactive runs freeze parked pages an AI is not using.
    ...(headless ? {} : { aiIdleFreeze: true }),
    // Read lazily: pages are opened long after the browser is constructed, and
    // the settings may have changed since. Tabs already open keep the proxy they
    // loaded with until they reload, which is how a browser behaves.
    proxy: () => settingsCache ?? (service?.settingsSnapshot() ?? DEFAULT_SETTINGS),
    // Downloads are session state, so every partition the surface configures
    // has to be handed to the manager — a missed one downloads invisibly.
    onSessionReady: (ses) => downloads.attach(ses),
    guests: guestHost,
    // Dragging a layout picker in the sidebar edits the open container only for
    // hand-made views; saved views persist the choice back to the definition.
    onViewLayoutChange: (viewDefinitionId, layoutId) => {
      try {
        service?.setViewLayout(viewDefinitionId, layoutId);
        broadcastWorkspace();
      } catch {
        // The definition may have been deleted while its container stayed open.
      }
    },
    onFocusTab: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IPC.embeddedPage);
      /*
       * Both: show the browser page *and* open find. Ctrl+F pressed inside a
       * guest arrives here as this callback, and the renderer's own keydown
       * handler never fires for it — the page consumed the keystroke.
       */
      mainWindow.webContents.send(IPC.embeddedFindRequested);
    },
    /*
     * A login form was submitted inside a page. The secret stays here: the
     * renderer receives a token and the username, and only picks a site/account
     * name. Writing the vault happens in `IPC.loginCaptureSave` below.
     */
    onLoginCaptured: (capture) => {
      if (!loginCaptures) return;
      const site = service?.findSiteByOrigin(capture.origin);
      /*
       * A multi-tenant system asks for tenant + user + password, so the tenant is
       * part of which account this is: `admin` on tenant A and `admin` on tenant
       * B are different logins. Passing it through is what stops the second
       * tenant being silently treated as "already saved".
       */
      const tenant = capture.extraFields?.find((field) => /tenant|租户|org|企业/i.test(field.label))?.value;
      // Signing in as an account the vault already stores (a saved identity, or
      // a page an AI opened with `fill_browser_login`) must not offer to save a
      // duplicate. Only a genuinely new credential is worth a prompt.
      if (site && service?.hasSavedLogin(site.id, capture.username, tenant)) return;
      const notice = loginCaptures.add(capture);
      if (!notice) return;
      const withSite = site ? (loginCaptures.attachSite(notice.token, site.id) ?? notice) : notice;
      /*
       * The prompt is the moment; the history is the record.
       *
       * The bar disappears on its own and only lives while there is something
       * pending, so without a message the login is only findable again by
       * signing out and back in. Recorded here rather than when the user acts so
       * that ignoring the prompt still leaves a trace of what happened.
       */
      messageStore().add({
        kind: "login-capture",
        tone: "info",
        titleKey: "app.messagesLoginCaptured",
        titleParams: { user: withSite.username, site: site?.name ?? withSite.origin },
        action: { type: "login-capture", token: withSite.token },
      });
      // Two shapes of the same news: the single notice for the prompt, the whole
      // list for the panel behind it. Both are sent so a listener on either one
      // is correct, and the list is what self-corrects after an expiry.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.embeddedLoginCaptured, withSite);
      }
      sendPendingLogins();
      broadcastMessages();
    },
  });
  if (mainWindow && !mainWindow.isDestroyed()) embedded.attach(mainWindow);
  // Pages created later pick the default up in `createTab`; pages already open
  // (after the window was recreated) need it applied now.
  embedded.setDefaultZoom(settingsCache?.browserZoom ?? 100);
  embedded.setDefaultViewport(settingsCache?.browserViewport ?? undefined);
  return embedded;
}

/**
 * Start page of an identity inside the embedded surface.
 *
 * Kept next to the browser factory because both the restore path and the
 * identity page use it; the external launcher has its own equivalent.
 */
function embeddedStartUrl(identityId: string): string | undefined {
  if (!service) return undefined;
  const identity = service.findIdentity(identityId);
  if (!identity) return undefined;
  const site = service.findSite(identity.siteId);
  if (!site) return undefined;
  const path = identity.startPath || site.loginPath || "/";
  try {
    return new URL(path, site.baseUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Opens (or merges into) the container of a saved view.
 *
 * Existing tabs are left alone so logins survive a relaunch; only missing members
 * are created. The definition is single-site today, which keeps slot assignments
 * meaningful, while the container itself has no site of its own.
 *
 * `reveal` decides whether the call also raises the app window and switches it
 * to the browser page. Every UI entry point wants that; an AI client does not —
 * it opens pages to work on them, and stealing focus from whatever the user was
 * doing is the difference between a background tool and an interruption.
 */
async function openEmbeddedView(
  viewId: string,
  options: { reveal?: boolean } = {},
): Promise<ReturnType<EmbeddedBrowser["state"]>> {
  const reveal = options.reveal ?? true;
  if (!service) throw new Error("工作区尚未就绪");
  const view = service.findView(viewId);
  if (!view) throw new Error("视图不存在");
  const browser = ensureEmbeddedBrowser();
  // Reveal first: every member below awaits its own page load, and a
  // four-account view would hold the switch to the browser page for four loads
  // if the switch waited for them. The container is activated at the end, so the
  // stage fills in behind the switch instead of the switch waiting for it.
  if (reveal) browser.focusPage();
  const containerId = browser.ensureView({
    viewDefinitionId: view.id,
    name: view.name,
    layoutId: view.layoutId,
  });
  for (const identityId of view.identityIds) {
    if (browser.findIdentityTab(containerId, identityId)) continue;
    const url = embeddedStartUrl(identityId);
    if (!url) continue;
    const identity = service.findIdentity(identityId);
    const tab = await browser.createTab({
      url,
      identityId,
      siteId: identity?.siteId ?? view.siteId,
      label: identity?.name ?? t("tab.unnamed"),
      ...(identity?.color ? { color: identity.color } : {}),
      viewId: containerId,
      origin: "view",
    });
    // A view launch fills credentials just like an external launch does.
    // Without this, opening a saved view left every login form empty while the
    // single-account path filled fine — the same action behaved differently
    // depending on which entry point was used.
    scheduleEmbeddedLogin(tab.id, identityId);
  }
  // The saved slot assignments are identity ids; map them onto the tabs that
  // exist so a reopened view comes back in the same arrangement.
  const slots: Record<string, number> = {};
  for (const [identityId, index] of Object.entries(view.slotAssignments)) {
    const tab = browser.findIdentityTab(containerId, identityId);
    if (tab) slots[tab.id] = index;
  }
  browser.applySlotAssignments(containerId, slots);
  const next = browser.activateView(containerId);
  service.rememberLaunchedView(view.id);
  return next;
}

/**
 * Launch pipeline for an embedded identity tab: confirm the session, sign in
 * when needed, and land on the account's start path.
 *
 * With a check path configured on the site, an in-page fetch decides: signed in
 * → done, the tab stays on startPath; signed out → navigate to the site's login
 * page, fill, and — only when the site's `autoSubmit` is on, which is the
 * user's standing consent to press the button — submit, wait for the session to
 * appear, then navigate back to startPath. A failed sign-in leaves the filled
 * form on the login page for manual takeover.
 *
 * Without a check path there is no way to tell "already signed in" from "the
 * login page redirected somewhere else", so the routine keeps the old behavior:
 * poll for a password field and fill it, nothing more.
 *
 * Deliberately not awaited: a four-member view must not hold the launch result
 * for a minute while each page comes up.
 */
function scheduleEmbeddedLogin(tabId: string, identityId: string): void {
  if (!service?.settingsSnapshot().autoFillOnLaunch) return;
  const identity = service.findIdentity(identityId);
  if (!identity) return;
  const site = identity.siteId ? service.findSite(identity.siteId) : undefined;
  const browser = ensureEmbeddedBrowser();
  const startUrl = embeddedStartUrl(identityId);

  const report = (extra: {
    filled: boolean;
    submitted: boolean;
    loggedIn?: boolean;
    missingFields?: string[];
    skipped?: "no-password" | "not-login-page" | "cross-origin" | "login-failed";
  }): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.authAutoFilled, {
        identityId,
        label: identity.name,
        missingFields: [],
        unmatchedFields: [],
        ...extra,
      });
    }
    /*
     * Only the outcomes the user has to act on go into history.
     *
     * A successful fill is already visible in the page and does not need to be
     * looked up later; a failure is exactly what someone scrolls back for. The
     * action reopens that identity's login page, which is the fix for every one
     * of these reasons — missing password, wrong origin, form not found, and the
     * generic "still signed out after signing in".
     */
    if (!extra.skipped && !(extra.filled && extra.submitted && extra.loggedIn === false)) {
      return;
    }
    messageStore().add(
      {
        kind: "account",
        tone: extra.skipped === "login-failed" ? "warning" : "error",
        titleKey:
          extra.skipped === "login-failed"
            ? "app.messagesLoginFailed"
            : extra.skipped === "no-password"
              ? "app.messagesLoginNoPassword"
              : extra.skipped === "cross-origin"
                ? "app.messagesLoginCrossOrigin"
                : "app.messagesLoginFormNotFound",
        titleParams: { name: identity.name, site: site?.name ?? "" },
        action: {
          type: "identity",
          identityId,
          ...(identity.siteId ? { siteId: identity.siteId } : {}),
        },
      },
      // One row per identity per five minutes: a batch launch of twelve
      // accounts with the same broken site must not bury everything else.
      5 * 60_000,
    );
    broadcastMessages();
  };

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** true = signed in, false = signed out, "pending" = page not ready yet. */
  const probe = async (): Promise<boolean | "pending" | "unknown"> => {
    if (!site?.authCheckPath) return "unknown";
    try {
      const result = await browser.authProbe(
        tabId,
        site.authCheckPath,
        site.baseUrl,
        site.authCheckSignedOut,
        resolveAuthTokenSource(site),
      );
      if (result.ok) return result.signedIn === true;
      if (result.reason === "cross-origin" || result.reason === "bad-site") return "unknown";
    } catch (error) {
      // The tab may be mid-navigation; the caller decides whether to retry.
    }
    return "pending";
  };

  /**
   * Polls fillLogin until the form is found or the deadline passes. Polling
   * mirrors the external path: a client-rendered login form can take seconds,
   * and giving up on the first "no password field" reads as autofill broken.
   */
  const fillOnLoginPage = async (deadlineMs: number) => {
    const deadline = Date.now() + deadlineMs;
    let last: Awaited<ReturnType<typeof browser.fillLogin>> | undefined;
    while (Date.now() < deadline) {
      try {
        last = await browser.fillLogin(tabId);
      } catch {
        // A navigation can destroy the page between two polls; keep trying.
      }
      if (last?.ok) break;
      if (last && last.reason !== "password-field-not-found") break;
      await wait(500);
    }
    return last;
  };

  void (async () => {
    if (site?.authCheckPath) {
      // The page was loaded by createTab, but a client-side redirect may still
      // be settling; give the probe a few attempts before concluding.
      let state: boolean | "pending" | "unknown" = "pending";
      for (let attempt = 0; attempt < 6 && state === "pending"; attempt += 1) {
        state = await probe();
        if (state === "pending") await wait(500);
      }
      if (state === true) {
        // Already signed in: the launch lands on startPath untouched.
        report({ filled: false, submitted: false, loggedIn: true });
        return;
      }
      if (state === false) {
        // --- Sign in, then return to the start path. ---
        try {
          await browser.navigate(tabId, new URL(site.loginPath, site.baseUrl).toString());
        } catch {
          // A path normalizeEmbeddedUrl rejects leaves the tab where it is;
          // the fill below still runs, protected by its same-origin check.
        }
        const filled = await fillOnLoginPage(15_000);
        if (!filled?.ok) {
          report({
            filled: false,
            submitted: false,
            skipped:
              filled?.reason === "cross-origin"
                ? "cross-origin"
                : filled?.reason === "no-password" || filled?.reason === "no-identity"
                  ? "no-password"
                  : "not-login-page",
          });
          return;
        }
        if (!filled.submitted) {
          // autoSubmit is off: the filled form waits for the user's own button.
          report({ filled: true, submitted: false, missingFields: filled.missingFields });
          return;
        }
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if ((await probe()) === true) {
            if (startUrl) {
              try {
                await browser.navigate(tabId, startUrl);
              } catch {
                // Stay wherever the site landed after sign-in.
              }
            }
            report({
              filled: true,
              submitted: true,
              loggedIn: true,
              missingFields: filled.missingFields,
            });
            return;
          }
          await wait(700);
        }
        // Still signed out after the deadline: the form is filled and the
        // user takes over (captcha, wrong password, extra steps).
        report({
          filled: true,
          submitted: true,
          skipped: "login-failed",
          missingFields: filled.missingFields,
        });
        return;
      }
      // state === "unknown": the probe cannot run on this page; fall through
      // to the legacy fill below instead of guessing.
    }

    // --- Legacy behavior without a check path: poll for a password field. ---
    const filled = await fillOnLoginPage(15_000);
    const skipped = filled?.ok
      ? undefined
      : filled?.reason === "cross-origin"
        ? ("cross-origin" as const)
        : filled?.reason === "no-password" || filled?.reason === "no-identity"
          ? ("no-password" as const)
          : ("not-login-page" as const);
    report({
      filled: filled?.ok === true,
      submitted: filled?.submitted === true,
      missingFields: filled?.missingFields ?? [],
      ...(skipped ? { skipped } : {}),
    });
  })();
}

/**
 * Gives a flow a page to drive.
 *
 * An explicit tab is used as-is: the AI's path, where it already has a
 * signed-in page. Otherwise a tab opens as the given identity, or as the site's
 * first account, and the automatic fill every other launch path uses runs here
 * too — a flow's first step should not have to be "sign in" every time.
 *
 * Shared by the UI's run button and `run_flow` so the two cannot drift: one of
 * them creating a tab differently is exactly the kind of difference that shows
 * up as "works from the app but not from the AI".
 */
async function openFlowTab(
  flow: Flow,
  requestedIdentityId?: string,
  existingTabId?: string,
): Promise<{ tabId: string; identityId?: string }> {
  if (existingTabId) {
    return {
      tabId: existingTabId,
      ...(requestedIdentityId ? { identityId: requestedIdentityId } : {}),
    };
  }
  if (!service) throw new Error("工作区未就绪");
  const site = service.findSite(flow.siteId);
  if (!site) throw new Error("流程所属站点不存在");
  const identityId =
    requestedIdentityId ||
    (service
      .snapshot()
      .identities.filter((identity) => identity.siteId === site.id)
      .map((identity) => identity.id)[0] ??
      "");
  if (!identityId) throw new Error("这个站点还没有账号，流程需要一个已登录的页面");

  const browser = ensureEmbeddedBrowser();
  const created = await browser.createTab({
    url: embeddedStartUrl(identityId) ?? site.baseUrl,
    identityId,
    siteId: site.id,
    label: flow.name,
  });
  browser.activate(created.id);
  scheduleEmbeddedLogin(created.id, identityId);
  // The document is still loading; a step that runs immediately would look at
  // about:blank and fail with "not-found" for a page that is a moment away.
  await new Promise((done) => setTimeout(done, 800));
  return { tabId: created.id, identityId };
}

/** Outcome the renderer shows after a cold start asked to reopen the last view. */
interface RestoreOutcome {  restored: boolean;
  viewId?: string;
  viewName?: string;
  reason?: string;
}

let restoreAttempted = false;

/**
 * Reopens the last launched view on the built-in surface.
 *
 * The built-in surface is the main one, so restoring it there means no system
 * windows appear at startup. The view definition is the source of truth: its
 * layout and members are replayed into a fresh container.
 */
async function restoreLastSurface(): Promise<RestoreOutcome> {
  if (restoreAttempted) return { restored: false, reason: "already-attempted" };
  restoreAttempted = true;
  if (!service) return { restored: false, reason: "disabled" };
  const settings = service.settingsSnapshot();
  if (!settings.restoreLastView) return { restored: false, reason: "disabled" };
  const viewId = settings.lastViewId;
  if (!viewId) return { restored: false, reason: "no-view" };
  const view = service.findView(viewId);
  if (!view) return { restored: false, reason: "missing" };
  try {
    await openEmbeddedView(view.id);
    return { restored: true, viewId: view.id, viewName: view.name };
  } catch (error) {
    return {
      restored: false,
      viewId: view.id,
      viewName: view.name,
      reason: (error as Error).message,
    };
  }
}

/**
 * Pushes the pending-login list to the renderer.
 *
 * One channel for the whole list rather than an event per change: the bar shows
 * the newest entry and a panel shows the rest, and both read from the same list.
 * Sending the list also makes expiry self-correcting — a capture that timed out
 * simply stops appearing.
 */
function sendPendingLogins(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.embeddedLoginChanged, loginCaptures.list());
}

function broadcastWorkspace(): void {
  if (!service) return;
  const snapshot = service.snapshot();
  for (const win of [mainWindow, overlayWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC.workspaceChanged, snapshot);
  }
  syncOverlay(snapshot);
  // The tray menu offers "close all" only while something is running, so it has
  // to be rebuilt whenever that stops being true. Rebuilding on every broadcast
  // would churn a native menu for nothing.
  ensureTrayMenuMatches(snapshot.instances.length);
}

/**
 * Pushes the endpoint state to the window.
 *
 * The status bar shows whether the endpoint is running and on which port on
 * every screen, so a port change or a toggle has to reach it without the user
 * opening settings and back.
 */
function broadcastMcp(): void {
  if (!mcpServer) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.mcpChanged, mcpServer.status());
  }
}

/**
 * The toolbar draws the list, so it is told whenever an entry changes.
 *
 * The manager throttles progress updates; a finished download skips that and
 * arrives immediately, because "it is done" is the one update the user acts on.
 */
function broadcastDownloads(entries: DownloadEntry[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.downloadsChanged, entries);
  }
}

/**
 * Windows are placed on the display the control panel lives on. Using the cursor
 * picked the wrong monitor whenever the mouse was on another screen, which is
 * how a launch could land somewhere the user was not looking.
 */
function workAreaRect(): { x: number; y: number; width: number; height: number } {
  const bounds = mainWindow?.isDestroyed() ? undefined : mainWindow?.getBounds();
  const display = bounds
    ? screen.getDisplayMatching(bounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

// ---- running-instances overlay ----

const OVERLAY_DEFAULT_WIDTH = 196;
const OVERLAY_MIN_WIDTH = 148;
const OVERLAY_MAX_WIDTH = 420;
const OVERLAY_MIN_HEIGHT = 40;
const OVERLAY_DEFAULT_HEIGHT = 92;
/** Ceiling for the automatic height, so a long list scrolls instead of growing. */
const OVERLAY_MAX_HEIGHT = 420;
/** Keeps a tall overlay from covering the whole screen on a laptop display. */
const OVERLAY_MAX_HEIGHT_RATIO = 0.6;
const OVERLAY_MARGIN = 16;
/**
 * Collapsed, the strip becomes a small rounded square that takes no more room
 * than a desktop widget. Its size is fixed: it is a hit target, not a panel.
 *
 * The window is deliberately larger than the visible square: a window clips
 * everything drawn outside its own bounds, so a square that fills the window has
 * its drop shadow cut off at the frame — which is what produced a rectangular
 * black fringe at the rounded corners. The padding is the room the shadow paints
 * into; the square stays centred inside it.
 */
const OVERLAY_BALL_SIZE = 48;
const OVERLAY_BALL_PAD = 8;
/** Last expanded size the renderer asked for; reused when the window is shown again. */
let overlaySize = { width: OVERLAY_DEFAULT_WIDTH, height: OVERLAY_DEFAULT_HEIGHT };
/** True while the strip is collapsed into the small docked square. */
let overlayCompact = false;
/** False until the overlay page has loaded; showing earlier paints a blank frame. */
let overlayReady = false;

interface OverlayState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  compact?: boolean;
}

function overlayStatePath(): string {
  return join(userDataDir(), "overlay.json");
}

/**
 * Window geometry only: position and size are pure window preferences, so they
 * do not belong in the portable workspace export. Collapsed state lives in the
 * overlay renderer's localStorage, which also survives restarts.
 */
function readOverlayState(): OverlayState {
  try {
    const raw = JSON.parse(readFileSync(overlayStatePath(), "utf8")) as Record<string, unknown>;
    const number = (key: string): number | undefined => {
      const value = raw[key];
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };
    const x = number("x");
    const y = number("y");
    const width = number("width");
    const height = number("height");
    return {
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(raw["compact"] === true ? { compact: true } : {}),
    };
  } catch {
    return {};
  }
}

function writeOverlayState(x: number, y: number): void {
  try {
    writeFileSync(
      overlayStatePath(),
      `${JSON.stringify({
        x,
        y,
        width: overlaySize.width,
        height: overlaySize.height,
        compact: overlayCompact,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // A lost position is cosmetic; never let it break the overlay.
  }
}

function overlayDisplayArea(): Electron.Rectangle {
  const bounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : undefined;
  return (bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()).workArea;
}

/**
 * Work area of the display a point belongs to. Dragging has to follow the ball
 * across monitors, so it cannot reuse the main window's display.
 */
function overlayAreaAt(x: number, y: number): Electron.Rectangle {
  return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
}

/** Both axes are clamped here: the renderer asks, the main process decides. */
function clampOverlaySize(width: number, height: number): { width: number; height: number } {
  const area = overlayDisplayArea();
  const maxHeight = Math.max(
    OVERLAY_MIN_HEIGHT,
    Math.min(OVERLAY_MAX_HEIGHT, Math.round(area.height * OVERLAY_MAX_HEIGHT_RATIO)),
  );
  const clamp = (value: number, min: number, max: number) =>
    Math.round(Math.min(Math.max(Number.isFinite(value) ? value : min, min), max));
  return {
    width: clamp(width, OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, area.width)),
    height: clamp(height, OVERLAY_MIN_HEIGHT, maxHeight),
  };
}

/**
 * Re-asserts the topmost state.
 *
 * A single `alwaysOnTop: true` is not enough in practice: other topmost windows
 * (media players, chat apps' floating widgets) can land above a "floating" level
 * window, and Windows drops the flag in some focus transitions. "screen-saver"
 * is the highest level the platform exposes, and re-applying it after show, move
 * and focus changes keeps the strip where the user expects it.
 */
function reinforceOverlayTop(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "screen-saver");
}

function ensureOverlay(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  overlayReady = false;
  const area = overlayDisplayArea();
  const state = readOverlayState();
  overlayCompact = state.compact === true;
  overlaySize = clampOverlaySize(
    state.width ?? OVERLAY_DEFAULT_WIDTH,
    state.height ?? OVERLAY_DEFAULT_HEIGHT,
  );
  const size = currentOverlaySize();
  const maxX = area.x + area.width - size.width;
  // Default to the left edge, vertically centred: the top-right corner is where
  // Windows puts its own caption buttons, and the bottom-right holds the tray.
  const x = Math.min(Math.max(state.x ?? area.x + OVERLAY_MARGIN, area.x), Math.max(area.x, maxX));
  const y = Math.min(
    Math.max(state.y ?? Math.round(area.y + (area.height - size.height) / 2), area.y),
    Math.max(area.y, area.y + area.height - size.height),
  );

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    // Windows draws an invisible resize border around frameless windows even at
    // `resizable: false` (it is what also gives them a native shadow). A 48px
    // collapsed window is mostly border, so pressing near its edge started a
    // native resize instead of our drag. thickFrame: false removes that border
    // and the shadow; the expanded strip is resized by its own in-page handle.
    thickFrame: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // The whole point is staying reachable while browser windows overlap it.
    alwaysOnTop: true,
    skipTaskbar: true,
    title: appDisplayName,
    ...(appIconPath() ? { icon: appIconPath() } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Topmost is not a one-time switch: loses to other topmost windows and to
  // focus transitions, so every state change that can drop it re-applies it.
  win.on("show", () => reinforceOverlayTop(win));
  win.on("focus", () => reinforceOverlayTop(win));
  win.on("blur", () => {
    // Next tick: the window that just took focus may itself be topmost.
    setTimeout(() => reinforceOverlayTop(win), 60);
  });
  win.on("moved", () => {
    if (win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    if (typeof x === "number" && typeof y === "number") writeOverlayState(x, y);
    reinforceOverlayTop(win);
  });
  win.webContents.on("context-menu", () => {
    // The strip has no close button on purpose: an X next to the collapse
    // control is what people hit when they meant "shrink it". Hiding the strip
    // is a rare, deliberate act, so it lives on the right-click menu instead.
    const zh = (settingsCache?.locale ?? "zh") !== "en";
    Menu.buildFromTemplate([
      {
        label: overlayCompact
          ? zh
            ? "展开列表"
            : "Expand the list"
          : zh
            ? "收起为小方块"
            : "Collapse to a square",
        click: () => applyOverlayCompact(!overlayCompact),
      },
      { type: "separator" },
      {
        label: zh
          ? "隐藏悬浮条（可在设置里重新开启）"
          : "Hide the strip (turn it back on in Settings)",
        click: () => hideOverlay(),
      },
    ]).popup({ window: win });
  });
  win.on("closed", () => {
    if (overlayWindow === win) overlayWindow = null;
    overlayReady = false;
  });
  win.webContents.on("did-finish-load", () => {
    overlayReady = true;
    // The first broadcast happened while the page was still loading, so the
    // visibility decision has to be repeated now that content exists.
    syncOverlay();
    reinforceOverlayTop(win);
    // Compiling the PowerShell helper takes ~600ms; doing it now keeps the
    // first click fast instead of paying that cost while the user waits.
    warmUpWindowFocus();
  });

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    // The compact flag travels with the URL so the first paint is already the
    // right shape: reading it over IPC would flash the full strip into a 48px
    // window for a frame.
    const query = overlayCompact ? "?compact=1" : "";
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}${query}#overlay`);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"), {
      hash: "overlay",
      ...(overlayCompact ? { query: { compact: "1" } } : {}),
    });
  }
  overlayWindow = win;
  return win;
}

/**
 * The size a visible overlay should have right now. Collapsed wins over the
 * stored expanded size: the square is a fixed box and ignores the user's list
 * dimensions until it is expanded again.
 */
function currentOverlaySize(): { width: number; height: number } {
  const compact = OVERLAY_BALL_SIZE + OVERLAY_BALL_PAD * 2;
  return overlayCompact ? { width: compact, height: compact } : overlaySize;
}

/**
 * Collapses or expands the overlay and resizes the window to match.
 *
 * Shared by the renderer's collapse button, the right-click menu and startup
 * restore, so the window geometry is decided in exactly one place.
 */
function applyOverlayCompact(compact: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayCompact = compact;
  const [currentX = 0, currentY = 0] = overlayWindow.getPosition();
  // Keep the top-left corner, then pull the window back inside the work area: a
  // right-aligned square would otherwise land offscreen after it grows back into
  // the list. The clamps use the display the overlay itself is on, not the main
  // window's, because the square can be parked on a second monitor.
  const ownBounds = overlayWindow.getBounds();
  const area = overlayAreaAt(ownBounds.x + ownBounds.width / 2, ownBounds.y + ownBounds.height / 2);
  const size = currentOverlaySize();
  const nextX = Math.min(currentX, area.x + area.width - size.width);
  const nextY = Math.min(currentY, area.y + area.height - size.height);
  overlayWindow.setBounds({
    x: Math.max(area.x, nextX),
    y: Math.max(area.y, nextY),
    width: size.width,
    height: size.height,
  });
  const [finalX, finalY] = overlayWindow.getPosition();
  if (typeof finalX === "number" && typeof finalY === "number") {
    writeOverlayState(finalX, finalY);
  }
}

/** Hides the strip and remembers that the user turned it off. */
function hideOverlay(): void {
  overlayWindow?.hide();
  // Same ordering rule as settingsSave: the emit inside saveSettings must not
  // resurrect the overlay it was just asked to hide.
  if (settingsCache) settingsCache = { ...settingsCache, overlayEnabled: false };
  if (!service) return;
  settingsCache = service.saveSettings({ overlayEnabled: false });
  broadcastWorkspace();
}

/** Shows or hides the switcher to match settings and the number of instances. */
function syncOverlay(snapshot?: WorkspaceSnapshot): void {
  // The overlay is an always-on-top window over the user's desktop. A headless
  // run must not put one there, whatever the workspace says.
  if (headless) return;
  const current = snapshot ?? service?.snapshot();
  if (!current) return;
  const enabled = settingsCache?.overlayEnabled ?? true;
  if (!enabled || current.instances.length === 0) {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    stopActiveWatcher();
    return;
  }
  const win = ensureOverlay();
  if (!overlayReady) return;
  const bounds = win.getBounds();
  const size = currentOverlaySize();
  if (bounds.width !== size.width || bounds.height !== size.height) {
    win.setBounds({ ...bounds, ...size });
  }
  if (!win.isVisible()) win.showInactive();
  reinforceOverlayTop(win);
  startActiveWatcher();
}

// ---- which window is in front ----

/**
 * How often the foreground window is resolved. Identical pages give no visual
 * clue about which account a window belongs to, so the switcher highlights the
 * row the user is actually looking at. Windows reads this from the long-lived
 * helper in a few milliseconds; macOS would have to spawn `osascript` each time,
 * so it polls slowly instead.
 */
const ACTIVE_POLL_MS = process.platform === "win32" ? 260 : 1_100;

let activePollTimer: NodeJS.Timeout | null = null;
let activePollBusy = false;
let activeInstanceId: string | null = null;
/**
 * When we last told the overlay "this one is in front".
 *
 * Raising a window and the OS reporting it as foreground are not instantaneous:
 * Windows can take a beat after `SetForegroundWindow`, and a poll landing in that
 * gap would report "nothing of ours is in front" and wipe the highlight the user
 * just triggered. A short grace period absorbs that race without hiding a real
 * failure for long.
 */
let activePublishAt = 0;
const ACTIVE_PUBLISH_GRACE_MS = 900;

function publishActiveInstance(next: string | null): void {
  if (next === activeInstanceId) return;
  activeInstanceId = next;
  if (next !== null) activePublishAt = Date.now();
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(IPC.instanceActive, next);
  }
}

async function pollActiveInstance(): Promise<void> {
  if (activePollBusy || !service) return;
  activePollBusy = true;
  try {
    const next = nextActiveInstanceId({
      foregroundPid: await foregroundWindowPid(),
      selfPid: process.pid,
      instances: service.snapshot().instances,
    });
    // `undefined` means "keep the current highlight": either the foreground
    // could not be read, or it is one of our own windows.
    if (next === undefined) return;
    // A raise we just performed may not have reached the foreground yet.
    if (next === null && Date.now() - activePublishAt < ACTIVE_PUBLISH_GRACE_MS) return;
    publishActiveInstance(next);
  } finally {
    activePollBusy = false;
  }
}

function startActiveWatcher(): void {
  if (activePollTimer || !service) return;
  activePollTimer = setInterval(() => {
    void pollActiveInstance();
  }, ACTIVE_POLL_MS);
  void pollActiveInstance();
}

function stopActiveWatcher(): void {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
  publishActiveInstance(null);
}

// ---- transient identity label over a just-raised window ----

const FOCUS_LABEL_WIDTH = 420;
const FOCUS_LABEL_HEIGHT = 84;
/** Long enough to read a name, short enough not to sit on top of the page. */
const FOCUS_LABEL_DURATION = 2_200;

let focusLabelWindow: BrowserWindow | null = null;
let focusLabelTimer: NodeJS.Timeout | null = null;
let focusLabelSeq = 0;
/** Latest payload while the label page is still loading; only this one is sent. */
let pendingFocusLabel: FocusLabelPayload | null = null;
let waitingForFocusLabelLoad = false;

/**
 * A frameless, click-through window that shows the account name over the window
 * that was just raised. It never takes focus: stealing it would immediately
 * undo the raise it is describing.
 */
function ensureFocusLabel(): BrowserWindow {
  if (focusLabelWindow && !focusLabelWindow.isDestroyed()) return focusLabelWindow;
  const win = new BrowserWindow({
    width: FOCUS_LABEL_WIDTH,
    height: FOCUS_LABEL_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: appDisplayName,
    ...(appIconPath() ? { icon: appIconPath() } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "screen-saver");
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.on("closed", () => {
    if (focusLabelWindow === win) focusLabelWindow = null;
  });
  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}#focus-label`);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"), { hash: "focus-label" });
  }
  focusLabelWindow = win;
  return win;
}

function hideFocusLabel(): void {
  if (focusLabelTimer) {
    clearTimeout(focusLabelTimer);
    focusLabelTimer = null;
  }
  pendingFocusLabel = null;
  if (focusLabelWindow && !focusLabelWindow.isDestroyed()) focusLabelWindow.hide();
}

/** Shows the label over one window; the payload is built from the identity. */
function flashFocusLabel(instanceId: string, rect: ScreenRect | undefined): void {
  if (headless) return;
  if (!(settingsCache?.focusLabelEnabled ?? true)) return;
  if (!service || !rect) return;
  const snapshot = service.snapshot();
  const instance = snapshot.instances.find((item) => item.id === instanceId);
  if (!instance) return;
  const identity = instance.identityId ? service.findIdentity(instance.identityId) : undefined;
  const site = snapshot.sites.find((item) => item.id === instance.siteId);
  focusLabelSeq += 1;
  const payload: FocusLabelPayload = {
    label: instance.label,
    ...(identity?.role ? { role: identity.role } : {}),
    color: identity?.color ?? "slate",
    ...(snapshot.sites.length > 1 && site ? { site: site.name } : {}),
    seq: focusLabelSeq,
  };
  const win = ensureFocusLabel();
  const area = screen.getDisplayMatching({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }).workArea;
  const x = Math.round(
    Math.min(
      Math.max(area.x + OVERLAY_MARGIN, rect.x + rect.width / 2 - FOCUS_LABEL_WIDTH / 2),
      Math.max(area.x, area.x + area.width - FOCUS_LABEL_WIDTH - OVERLAY_MARGIN),
    ),
  );
  const y = Math.round(
    Math.min(
      Math.max(area.y + OVERLAY_MARGIN, rect.y + 14),
      Math.max(area.y, area.y + area.height - FOCUS_LABEL_HEIGHT - OVERLAY_MARGIN),
    ),
  );
  win.setBounds({ x, y, width: FOCUS_LABEL_WIDTH, height: FOCUS_LABEL_HEIGHT });
  const reveal = (next: FocusLabelPayload) => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.focusLabelShow, next);
    win.showInactive();
    win.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "screen-saver");
  };
  if (win.webContents.isLoading()) {
    // Rapid switches while the window is still loading must not queue one send
    // per click: keep only the newest payload and flush it once when ready.
    pendingFocusLabel = payload;
    if (!waitingForFocusLabelLoad) {
      waitingForFocusLabelLoad = true;
      win.webContents.once("did-finish-load", () => {
        waitingForFocusLabelLoad = false;
        const next = pendingFocusLabel;
        pendingFocusLabel = null;
        if (next) reveal(next);
      });
    }
  } else {
    reveal(payload);
  }
  if (focusLabelTimer) clearTimeout(focusLabelTimer);
  focusLabelTimer = setTimeout(hideFocusLabel, FOCUS_LABEL_DURATION);
}

function buildAssetPath(file: string): string {
  // Packaged: unpacked next to the asar so the native tray loader can read it
  // without going through the archive.
  return app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "build", file)
    : join(__dirname, "../../build", file);
}

/**
 * Icon the app presents to the OS.
 *
 * Windows takes it from the executable once packaged; in development the process
 * is electron.exe, whose own icon is Electron's. Passing ours to every window and
 * to native dialogs is what keeps a stray Electron logo out of the taskbar, the
 * window frame and the file pickers.
 */
function appIconPath(): string | undefined {
  const candidates = [join(__dirname, "../../build/icon.png"), buildAssetPath("icon.png")];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Native file pickers, parented to the main window.
 *
 * Without a parent the dialog is a standalone window that belongs to the process
 * — on Windows that means it shows electron.exe's icon and can appear behind the
 * app. A parent makes it modal to Ensemble and inherit Ensemble's icon.
 */
function showOpenDialog(options: OpenDialogOptions) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
}

function showSaveDialog(options: SaveDialogOptions) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showSaveDialog(mainWindow, options)
    : dialog.showSaveDialog(options);
}

function loadTrayImage(): Electron.NativeImage {
  if (process.platform === "darwin") {
    // The menu bar only uses the alpha channel of a template image, so the
    // colored app mark would render as a solid block. 16pt + @2x keeps the
    // glyph sharp and lets macOS tint it for light and dark menu bars.
    const template = nativeImage.createFromPath(buildAssetPath("trayTemplate.png"));
    if (!template.isEmpty()) {
      // nativeImage pairs trayTemplate@2x.png automatically on Retina displays;
      // the Template suffix also marks it as a template image, but set it
      // explicitly so a renamed asset cannot silently lose the tinting.
      template.setTemplateImage(true);
      return template;
    }
  }
  for (const file of ["tray.png", "icon.png"]) {
    const image = nativeImage.createFromPath(buildAssetPath(file));
    if (!image.isEmpty()) return image;
  }
  // A missing tray asset must not break the tray; an empty image keeps the app
  // running invisibly rather than crashing at startup.
  return nativeImage.createFromBuffer(Buffer.from("", "utf8"));
}

function showMainWindow(): void {
  // A headless run has no window to show; raising one would defeat the point.
  if (headless) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Makes an automated run invisible without making the window unreal.
 *
 * A window created with `show: false` and never shown is not a faithful
 * environment: Chromium stops producing compositor frames for it, so
 * `Page.captureScreenshot` hangs rather than returning pixels (measured — the
 * freeze pass and every screenshot went from ~100ms to never completing).
 *
 * Parked outside every display has the same effect one level down: the window
 * itself has frames, but a `<webview>` inside it does not, and a guest never
 * answers a capture while its embedder is at a coordinate no display covers.
 * So the window stays where a display is and is made invisible instead: fully
 * transparent, out of the taskbar, never focused.
 */
function parkWindowOffscreen(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setSkipTaskbar(true);
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.webContents.setBackgroundThrottling(false);
  win.showInactive();
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(loadTrayImage());
  tray.setToolTip(appDisplayName);
  const rebuild = () => {
    if (!tray) return;
    const mcp = mcpServer?.status();
    const running = service?.snapshot().instances.length ?? 0;
    trayInstanceCount = running;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `打开 ${appDisplayName}`, click: () => showMainWindow() },
        { type: "separator" },
        ...(running > 0
          ? [
              {
                label: `关闭所有实例 (${running})`,
                click: () => {
                  void service?.stopAll().then(() => broadcastWorkspace());
                },
              },
              { type: "separator" as const },
            ]
          : []),
        {
          label: mcp?.running ? `AI 接入：已开启 (${mcp.port})` : "AI 接入：已关闭",
          enabled: false,
        },
        { type: "separator" },
        {
          label: "退出",
          click: () => {
            void shutdownAndQuit();
          },
        },
      ]),
    );
  };
  rebuild();
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  trayRebuild = rebuild;
}

let trayRebuild: (() => void) | null = null;
/** Instance count the tray menu was last built for; -1 forces the first build. */
let trayInstanceCount = -1;

function ensureTrayMenuMatches(count: number): void {
  if (count === trayInstanceCount) return;
  trayRebuild?.();
}

/**
 * macOS application menu.
 *
 * A menu-less app has no accelerator table at all: Cmd+, does nothing and
 * Cmd+Q / Cmd+H / Cmd+M lose their standard meanings, because those bindings
 * live in the menu, not in Chromium. Windows and Linux keep the bare window —
 * there the menu bar would draw a strip the layout does not account for.
 *
 * Everything except the settings entry comes from Electron's own roles, so the
 * labels follow the system language.
 */
function buildMacMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: t("menu.settings"),
          accelerator: "Command+,",
          click: () => requestOpenSettings(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    // `windowMenu` carries Minimize/Zoom/Front but not Close, and Cmd+W is a
    // standard macOS binding — with `closeToTray` it hides the window instead of
    // ending the session, which is exactly what the close button already does.
    {
      label: t("menu.window"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "close" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ]);
}

/** Opens Settings from the native menu; the renderer owns the page itself. */
function requestOpenSettings(): void {
  showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.appOpenSettings);
  };
  // A request that lands while the page is still loading would reach a renderer
  // that has not registered its listener yet; hold it until the load settles.
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", send);
    return;
  }
  send();
}

async function createWindow(): Promise<void> {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    // Show immediately: a dark window frame appears in well under a second and the
    // first paint lands right after. Waiting for ready-to-show makes startup feel
    // several hundred milliseconds slower than it is.
    // A headless run still shows the window, but off every display (see below):
    // a window that is never shown stops producing compositor frames, which
    // makes `Page.captureScreenshot` hang instead of returning pixels.
    show: !headless,
    backgroundColor: isDarkTheme(currentTheme) ? "#0b0d10" : "#f3efe6",
    title: appDisplayName,
    titleBarStyle: "hidden",
    // Packaged builds take the executable icon (build/icon.ico); in development
    // the window and taskbar need it passed explicitly.
    ...(appIconPath() ? { icon: appIconPath() } : {}),
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : {
          titleBarOverlay: titleBarOverlay(currentTheme),
        }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // `<webview>` is the carrier for the built-in browser surface (ADR 0011).
      // It has to be on for the window that hosts the nodes; every guest is
      // still hardened in `will-attach-webview`, which is where `webviewTag`
      // is turned back off for the guest itself.
      webviewTag: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(isMac ? buildMacMenu() : null);

  // Guests in this window are hardened and watched by the guest manager. It has
  // to be installed before the renderer loads, because `will-attach-webview`
  // fires the moment the first `<webview>` element is parsed.
  guestManager.install(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env["ELECTRON_RENDERER_URL"];
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith("file://");
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  // F12 / Ctrl+Shift+I with the focus on the app's own chrome (a tab strip, the
  // dock, an address bar). When the focus is inside a page, that page's
  // `before-input-event` handles the toggle and this listener never fires; from
  // the chrome, no page sees the key at all — which read as "F12 does nothing".
  //
  // The same reach applies to reload: with the focus on the chrome, Ctrl+R / F5
  // must still reload the page the chrome is framing instead of falling dead.
  //
  // keyDown only: the keyUp of the same press arrives after DevTools have opened
  // and taken focus, and toggling on it would shut the panel immediately.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const key = input.key.toLowerCase();
    const modifier = process.platform === "darwin" ? input.meta : input.control;
    if (key === "f5" || (modifier && key === "r")) {
      event.preventDefault();
      if (modifier && input.shift) ensureEmbeddedBrowser().hardReloadActive();
      else ensureEmbeddedBrowser().reloadActive();
      return;
    }
    if (key !== "f12" && !(modifier && input.shift && key === "i")) return;
    event.preventDefault();
    ensureEmbeddedBrowser().toggleDevToolsForFocusedPage();
  });

  mainWindow.on("close", (event) => {
    if (quitting) return;
    // Closing the window is the common accident; the tray keeps the MCP endpoint
    // and any running browsers alive. Quit explicitly from the tray or the menu.
    if (settingsCache?.closeToTray) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    event.preventDefault();
    void shutdownAndQuit();
  });

  /*
   * The window is already on screen; what this await guards is everything that
   * comes after it. `loadFile` settles on did-finish-load, and a renderer that
   * never finishes loading leaves that promise pending forever — which used to
   * take the tray, the embedded surface and the MCP endpoint down with it.
   * Racing a deadline keeps a stuck load from becoming a stuck app.
   */
  const loadPromise =
    isDev && process.env["ELECTRON_RENDERER_URL"]
      ? mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"])
      : mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  const loaded = await Promise.race([
    loadPromise.then(
      () => true,
      (error: unknown) => {
        logLine(`renderer load failed: ${(error as Error).message}`);
        console.error("[ensemble] renderer load failed", error);
        return false;
      },
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), RENDERER_LOAD_TIMEOUT_MS)),
  ]);
  if (!loaded) {
    logLine(`renderer load did not finish within ${RENDERER_LOAD_TIMEOUT_MS}ms`);
    console.error(`[ensemble] renderer load did not finish within ${RENDERER_LOAD_TIMEOUT_MS}ms`);
  }

  if (headless) parkWindowOffscreen(mainWindow);

  // Pages survive in the manager while the window is closed to the tray; hand
  // them the new host so the next visit shows the same tabs.
  embedded?.attach(mainWindow);

  // Setting the overlay only in the constructor leaves the caption buttons in the
  // default dark palette on some Windows builds; reapplying once the window exists
  // (and on every theme change) is what actually colors them.
  if (!isMac) mainWindow.setTitleBarOverlay(titleBarOverlay(currentTheme));
  // A headless run has nothing to click a tray icon on, and a tray icon is itself
  // a visible artifact on the user's desktop.
  if (!headless) createTray();
  startUpdateWatcher();
}

// ---- update: check, download, install ----

function sendUpdateProgress(progress: UpdateProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.appUpdateProgress, progress);
  }
}

/** Requests the latest release. Never downloads; that is always a separate click. */
async function checkForUpdate(): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  // The end-to-end probe points this at a local server so the real path (parse,
  // match an asset, verify) runs without publishing anything.
  const endpoint = process.env["ENSEMBLE_UPDATE_API"] ?? LATEST_RELEASE_API;
  try {
    // `net.fetch`, not the global one: both are Chromium's network stack, but
    // only this one uses `session.defaultSession`, where `applyProxyToDefaultSession`
    // put the user's proxy. The global fetch runs on a session the app never
    // configures, so behind Clash the request hung until it timed out and the
    // download bar never moved.
    const response = await net.fetch(endpoint, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ensemble-update-check" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: "error",
        current: app.getVersion(),
        message: `HTTP ${response.status}`,
      } satisfies UpdateCheckResult;
    }
    return evaluateUpdate(
      app.getVersion(),
      parseLatestRelease(await response.json()),
      process.platform as Platform,
      process.arch,
    );
  } catch (error) {
    return {
      status: "error",
      current: app.getVersion(),
      message: (error as Error).message,
    } satisfies UpdateCheckResult;
  } finally {
    clearTimeout(timer);
  }
}

const CONNECTIVITY_TIMEOUT_MS = 5_000;

/**
 * The endpoints one connectivity test run probes.
 *
 * Same list as `CONNECTIVITY_PROBES`, with the e2e's local-server overrides
 * applied; an env override only exists so the flow can be driven without
 * reaching the real network.
 */
function connectivityProbes(): ConnectivityProbe[] {
  return [
    {
      id: "updateApi",
      url:
        process.env["ENSEMBLE_CONNECTIVITY_UPDATE_API"] ??
        CONNECTIVITY_PROBES.find((probe) => probe.id === "updateApi")!.url,
    },
    {
      id: "proxyExit",
      url:
        process.env["ENSEMBLE_CONNECTIVITY_PROBE"] ??
        CONNECTIVITY_PROBES.find((probe) => probe.id === "proxyExit")!.url,
    },
  ];
}

/**
 * One GET through the default session, timed.
 *
 * The session is the point: it carries whatever `applyProxyToDefaultSession`
 * configured, so a probe answers the same question the update check answers.
 * A non-2xx response counts as a failure with its status kept — a proxy that
 * answers 502 is a finding, not a success.
 */
async function runConnectivityProbe(probe: ConnectivityProbe): Promise<ConnectivityProbeResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);
  try {
    const response = await net.fetch(probe.url, {
      headers: { "user-agent": "ensemble-connectivity-test" },
      signal: controller.signal,
    });
    const ms = Math.round(performance.now() - started);
    if (!response.ok) {
      return {
        id: probe.id,
        status: "error",
        ms,
        httpStatus: response.status,
        message: `HTTP ${response.status}`,
      };
    }
    return { id: probe.id, status: "ok", ms, httpStatus: response.status };
  } catch (error) {
    return {
      id: probe.id,
      status: "error",
      ms: Math.round(performance.now() - started),
      message: (error as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Location the verified installer is written to for the current version. */
function updateDownloadPath(assetName: string): string {
  const base = process.env["ENSEMBLE_UPDATE_DIR"] ?? join(app.getPath("temp"), "ensemble-updates");
  return join(base, updateFileName(assetName));
}

/**
 * Downloads the installer for the checked release and verifies its checksum.
 *
 * Nothing about the install happens without a user click, and the file is only
 * treated as ready after the SHA-256 GitHub published matches the bytes on disk.
 */
async function downloadPendingUpdate(result: UpdateCheckResult): Promise<UpdateCheckResult> {
  const asset = result.asset;
  if (!asset?.sha256) {
    throw new Error("该版本没有提供校验值，无法安全下载。");
  }
  if (updateDownloading) throw new Error("正在下载更新，请稍候。");
  if (downloadedUpdate?.version === result.latest) return result;
  updateDownloading = true;
  const destination = updateDownloadPath(asset.name);
  sendUpdateProgress({ phase: "downloading", received: 0, total: asset.size || undefined });
  try {
    let lastEmit = 0;
    await downloadUpdateAsset(asset.url, destination, {
      expectedSha256: asset.sha256,
      // Same network stack as the update check, so the configured proxy still
      // applies, but driven through `net.request`: `net.fetch` leaves
      // `Response.url` empty on every redirect mode, and the downloader reads
      // that field to check where the bytes actually came from.
      fetchImpl: trustedUpdateFetch,
      onProgress: (received, total) => {
        // The renderer only needs a few updates per second; emitting per chunk
        // would flood IPC on a fast connection.
        const now = Date.now();
        if (now - lastEmit < 120 && received !== total) return;
        lastEmit = now;
        sendUpdateProgress({ phase: "downloading", received, ...(total ? { total } : {}) });
      },
    });
    sendUpdateProgress({ phase: "verifying", received: asset.size });
    downloadedUpdate = {
      path: destination,
      version: result.latest ?? result.current,
      assetName: asset.name,
    };
    sendUpdateProgress({ phase: "ready", received: asset.size });
    return result;
  } catch (error) {
    sendUpdateProgress({ phase: "error", received: 0, message: (error as Error).message });
    throw error;
  } finally {
    updateDownloading = false;
  }
}

/**
 * Applies the downloaded update.
 *
 * Windows is the only platform we can chain automatically: the installer runs
 * silently after the app exits and the new build is started again. macOS builds
 * are ad-hoc signed, so an automatic replace would be rejected by Gatekeeper and
 * the dmg is opened for the user instead. Linux AppImages can be swapped in place.
 */
async function installDownloadedUpdate(): Promise<void> {
  const ready = downloadedUpdate;
  if (!ready) throw new Error("还没有下载完成的更新。");
  // In development the "installer" runs out of an unpacked build, and replacing
  // the Electron binary under a dev session would break the site. The
  // escape hatch exists only so the flow can be exercised deliberately.
  if (!app.isPackaged && process.env["ENSEMBLE_ALLOW_DEV_UPDATE"] !== "1") {
    throw new Error("开发模式下不会执行安装。");
  }

  if (process.platform === "win32") {
    const scriptPath = join(app.getPath("temp"), "ensemble-updates", "apply-update.cmd");
    // The running executable is exactly what the new build should replace and
    // relaunch; deriving it from the product name would guess instead of know.
    const targetExe = process.execPath;
    await writeFile(
      scriptPath,
      buildWindowsInstallScript({
        pid: process.pid,
        installerPath: ready.path,
        appExePath: targetExe,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    sendUpdateProgress({ phase: "installing", received: 0 });
    const child = spawn("cmd.exe", ["/c", scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    await shutdownAndQuit();
    return;
  }

  if (process.platform === "darwin") {
    // Open the verified dmg; the user finishes with the standard installer.
    sendUpdateProgress({ phase: "installing", received: 0 });
    await shell.openPath(ready.path);
    return;
  }

  // Linux: only an AppImage can be replaced under a running process by pointing
  // the user at the new file; a .deb needs the package manager.
  if (/\.AppImage$/i.test(ready.path)) {
    const target = process.env["APPIMAGE"];
    if (target) {
      await copyFile(ready.path, target);
      sendUpdateProgress({ phase: "installing", received: 0 });
      app.relaunch();
      await shutdownAndQuit();
      return;
    }
  }
  sendUpdateProgress({ phase: "installing", received: 0 });
  await shell.openPath(ready.path);
}

/** Schedules the launch-time check and the repeating ones. */
function startUpdateWatcher(): void {
  if (updateTimer) return;
  const tick = async () => {
    // Only the check is automatic. A postponed version stays quiet until a newer
    // one appears, which is what makes "later" mean something.
    if (!settingsCache?.autoCheckUpdates) return;
    const result = await checkForUpdate();
    if (result.status !== "available" || !result.asset) return;
    if (settingsCache?.dismissedUpdateVersion === result.latest) return;
    pendingUpdate = result;
    /*
     * Recorded, not just announced.
     *
     * The dialog is easy to dismiss by accident, and then the only way to learn
     * again is to wait six hours or open settings. A row in history keeps it
     * findable; the same waiting version replaces its own row rather than
     * stacking one per check.
     */
    messageStore().add(
      {
        kind: "app",
        tone: "info",
        titleKey: "app.messagesUpdateAvailable",
        titleParams: { version: result.latest ?? "" },
      },
      12 * 60 * 60_000,
    );
    broadcastMessages();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.appUpdateAvailable, result);
    }
  };
  setTimeout(() => void tick(), UPDATE_FIRST_CHECK_MS);
  updateTimer = setInterval(() => void tick(), UPDATE_REPEAT_MS);
}

function stopUpdateWatcher(): void {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
}

async function shutdownAndQuit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    // Order matters: stop accepting new AI requests before tearing down browsers,
    // so a tool call cannot start a launch halfway through shutdown.
    await mcpServer?.stop();
    stopUpdateWatcher();
    // No dialog can outlive the window it was about to answer for.
    httpAuth.abandonAll();
    tray?.destroy();
    tray = null;
    stopActiveWatcher();
    hideFocusLabel();
    if (focusLabelWindow && !focusLabelWindow.isDestroyed()) focusLabelWindow.destroy();
    focusLabelWindow = null;
    // Embedded views are Chromium renderers inside this process, so they must be
    // gone before the app quits; there is no external process to reclaim.
    embedded?.dispose();
    embedded = null;
    // Any guest still attached belongs to the window being destroyed; closing
    // its session first is what keeps the teardown from racing the destruction.
    await guestManager.dispose();
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    overlayWindow = null;
    disposeWindowFocus();
    await service?.shutdown();
  } finally {
    app.quit();
  }
}

function applyTheme(theme: AppSettings["theme"]): void {
  currentTheme = theme;
  nativeTheme.themeSource = theme;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(isDarkTheme(theme) ? "#0b0d10" : "#f3efe6");
  if (process.platform !== "darwin") {
    mainWindow.setTitleBarOverlay(titleBarOverlay(theme));
  }
}

/**
 * Applies a settings patch and every live side effect that belongs to it.
 *
 * Shared by the settings page (IPC) and the MCP `update_settings` tool, so an
 * AI change lands exactly like a person's: theme repainted, locale re-resolved,
 * zoom applied to open pages, proxy re-applied to the default session, workspace
 * rebroadcast. A second copy of this sequence would drift, and the resulting
 * bug — the value is persisted but nothing on screen changes, so the setting
 * looks ignored — is silent and confusing.
 *
 * Returns the parsed patch: the values that were actually written, which is all
 * a caller needs to echo back.
 */
function applySettingsPatch(patch: SettingsPatch): SettingsPatch {
  if (!service) throw new Error("工作区尚未就绪");
  const parsed = settingsPatchSchema.parse(patch);
  // Apply to the cache first: saveSettings emits synchronously, and the overlay
  // visibility decision inside that broadcast must already see the new value.
  if (settingsCache) settingsCache = { ...settingsCache, ...parsed };
  const settings = service.saveSettings(parsed);
  settingsCache = settings;
  if (parsed.theme) applyTheme(parsed.theme);
  // "system" is resolved, not stored: the core layer needs a concrete language,
  // and it has to get the same one the renderer will pick.
  setCoreLocale(resolveLocale(settings.locale, systemLocaleTag()));
  // The zoom setting reaches open pages only through this call: untouched
  // pages follow it, pages the user zoomed by hand keep their factor.
  if (parsed.browserZoom !== undefined) embedded?.setDefaultZoom(settings.browserZoom);
  // Same rule for the viewport default: pages that never made their own choice
  // follow it, and a page that picked a size (or opted out) stays as it is.
  if ("browserViewport" in parsed) {
    embedded?.setDefaultViewport(settings.browserViewport ?? undefined);
  }
  // Proxy changes apply live: a download already failing behind Clash should
  // recover when the user fixes the setting, not on the next launch. Only the
  // default session is touched here; open pages keep the proxy they loaded
  // with until they reload, which is how a browser behaves.
  if (
    parsed.proxyMode !== undefined ||
    parsed.proxyUrl !== undefined ||
    parsed.proxyBypass !== undefined
  ) {
    void applyProxyToDefaultSession(settings).then((state) => {
      console.info(`[proxy] ${state.description}`);
    });
  }
  broadcastWorkspace();
  return parsed;
}

function registerIpc(workspace: WorkspaceService): void {
  const handle = <T>(channel: string, listener: (...args: any[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (_event, ...args) => listener(...args));
  };

  handle(IPC.workspaceGet, () => workspace.snapshot());

  handle(IPC.enginesScan, async () => {
    const engines = await workspace.scanAvailableEngines();
    broadcastWorkspace();
    return engines;
  });

  handle(IPC.enginesAddManual, async () => {
    const result = await showOpenDialog({
      title: "选择浏览器可执行文件",
      properties: ["openFile"],
      ...(process.platform === "win32"
        ? { filters: [{ name: "可执行文件", extensions: ["exe"] }] }
        : {}),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return workspace.enginesSnapshot();
    }
    const filePath = result.filePaths[0] as string;
    workspace.addManualEngine(filePath);
    await workspace.scanAvailableEngines();
    broadcastWorkspace();
    return workspace.enginesSnapshot();
  });

  handle(IPC.enginesRemoveManual, async (exePath: string) => {
    workspace.removeManualEngine(String(exePath));
    await workspace.scanAvailableEngines();
    broadcastWorkspace();
    return workspace.enginesSnapshot();
  });

  handle(IPC.siteSave, (draft: SiteDraft) => {
    workspace.saveSite(siteDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.siteDelete, (id: string) => {
    workspace.deleteSite(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.siteMove, (id: string, toIndex: number) => {
    workspace.moveSite(String(id), Number(toIndex));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.tagSave, (draft: TagDraft) => {
    workspace.saveTag(tagDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.tagDelete, (id: string) => {
    workspace.deleteTag(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.tagMove, (id: string, toIndex: number) => {
    workspace.moveTag(String(id), Number(toIndex));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.identitySave, async (draft: IdentityDraft) => {
    const parsed = identityDraftSchema.parse(draft);
    const { password, captureToken, ...rest } = parsed;
    // A saved login capture owns the secret; it is released exactly once, here.
    // A second use must fail loudly instead of saving an account with no password.
    let captured: ReturnType<typeof loginCaptures.take>;
    if (captureToken) {
      captured = loginCaptures.take(captureToken);
      if (!captured) throw new Error("这次登录信息已保存过，请重新登录后再试");
    }
    /*
     * The tenant is part of the account for a multi-tenant site, and the form only
     * pre-fills it — a user may well have cleared it. Filling in what the capture
     * actually saw keeps the saved account matching the login that produced it,
     * which is what `hasSavedLogin` compares against on the next sign-in.
     */
    const merged = (() => {
      if (!captured?.extraFields?.length) return rest;
      const already = rest.extraFields ?? [];
      const seen = new Set(already.map((field) => field.label.trim().toLowerCase()));
      const missing = captured.extraFields.filter(
        (field) => field.value.trim() && !seen.has(field.label.trim().toLowerCase()),
      );
      return missing.length ? { ...rest, extraFields: [...already, ...missing] } : rest;
    })();
    // Awaited: writing the vault is asynchronous, and the snapshot returned
    // below is what the form reads to report whether a password is stored.
    // Returning before the write landed made a saved capture look like an
    // account without a password.
    await workspace.saveIdentity(merged, password ?? captured?.password);
    broadcastWorkspace();
    // The saved entry leaves the pending list; the bar and the panel read the
    // same list, so both stop offering it.
    if (captured) sendPendingLogins();
    return workspace.snapshot();
  });
  handle(IPC.identityDelete, (id: string) => {
    workspace.deleteIdentity(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });
  handle(IPC.identityLinkSite, (identityIds: unknown, siteId: unknown) => {
    const ids = Array.isArray(identityIds)
      ? identityIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (ids.length === 0) throw new Error("请先选择账号");
    workspace.linkIdentitiesToSite(ids, String(siteId));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.identityRebuildProfile, async (id: string) => {
    await workspace.rebuildIdentityProfile(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.identityDetachReference, (id: string) => {
    workspace.detachReference(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.viewCopyToSite, (viewId: string, targetSiteId: string) => {
    const result = workspace.copyViewToSite(String(viewId), String(targetSiteId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.siteAcceptOrigin, (siteId: string) => {
    workspace.acceptSiteOrigin(String(siteId));
    broadcastWorkspace();
  });

  handle(IPC.siteOriginNotice, () => workspace.takeOriginNotice());

  handle(IPC.viewSave, (draft: ViewDraft) => {
    workspace.saveView(viewDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.viewDelete, (id: string) => {
    workspace.deleteView(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.viewMove, (id: string, toIndex: number) => {
    workspace.moveView(String(id), Number(toIndex));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.viewSetLayout, (viewId: string, layoutId: LayoutId) => {
    workspace.setViewLayout(String(viewId), String(layoutId));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.viewSetSlots, (viewId: string, assignments: Record<string, number>) => {
    workspace.setViewSlotAssignments(String(viewId), assignments);
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.viewRetile, async (viewId: string) => {
    await workspace.retileView(String(viewId));
  });

  handle(IPC.flowSave, (draft: FlowDraft) => {
    workspace.saveFlow(flowDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.flowDelete, (id: string) => {
    workspace.deleteFlow(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkSave, (draft: BookmarkDraft) => {
    workspace.saveBookmark(bookmarkDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkFavicon, (id: string, favicon?: string) => {
    workspace.setBookmarkFavicon(String(id), favicon ? String(favicon) : undefined);
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkDelete, (id: string) => {
    workspace.deleteBookmark(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkDeleteBulk, (bookmarkIds: unknown, folderIds: unknown) => {
    const bookmarks = Array.isArray(bookmarkIds) ? bookmarkIds.map((id) => String(id)) : [];
    const folders = Array.isArray(folderIds) ? folderIds.map((id) => String(id)) : [];
    workspace.deleteBookmarksBulk(bookmarks, folders);
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkMove, (id: string, toIndex: number) => {
    workspace.moveBookmark(String(id), Number(toIndex));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkFolderSave, (draft: BookmarkFolderDraft) => {
    workspace.saveBookmarkFolder(bookmarkFolderDraftSchema.parse(draft));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkFolderDelete, (id: string) => {
    workspace.deleteBookmarkFolder(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.bookmarkFolderMove, (id: string, toIndex: number) => {
    workspace.moveBookmarkFolder(String(id), Number(toIndex));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  /*
   * Import sources are detected per listing and kept here: the renderer
   * addresses one by opaque id, so the file paths never cross the bridge and a
   * stale id is answered with the readable "没有可导入的来源" rather than a
   * wrong file being read.
   */
  let importSources: Array<DetectSource & { id: string }> = [];
  handle(IPC.bookmarkImportSources, () => {
    importSources = detectBookmarkSources(process.platform as Platform).map((source, index) => ({
      ...source,
      id: `src-${index}`,
    }));
    return importSources.map(({ file: _file, ...rest }) => rest) satisfies BookmarkImportSourceInfo[];
  });

  handle(IPC.bookmarkImport, async (id: string) => {
    const source = importSources.find((item) => item.id === String(id));
    if (!source) throw new Error("导入来源已过期，请重新打开导入窗口");
    const imported = await workspace.importBookmarksFromSource(source);
    broadcastWorkspace();
    return { snapshot: workspace.snapshot(), imported };
  });

  handle(
    IPC.flowRun,
    async (input: {
      flowId: string;
      identityId?: string;
      params?: Record<string, string>;
      tabId?: string;
    }): Promise<FlowRunOutcome> => {
      const flow = workspace.snapshot().flows.find((item) => item.id === String(input?.flowId));
      if (!flow) throw new Error("流程不存在");
      const { values } = resolveParams(flow.params, input?.params ?? {});
      const opened = await openFlowTab(flow, input?.identityId, input?.tabId);
      const site = workspace.findSite(flow.siteId);
      if (!site) throw new Error("流程所属站点不存在");
      const run = await ensureEmbeddedBrowser().runFlow(opened.tabId, flow.steps, {
        baseUrl: site.baseUrl,
        vars: values,
        timeoutMs: FLOW_TIMEOUT_MS,
      });
      return {
        tabId: opened.tabId,
        ...(opened.identityId ? { identityId: opened.identityId } : {}),
        run,
      };
    },
  );

  handle(IPC.layoutPresetSave, (draft: LayoutPresetDraft) => {
    const preset = workspace.saveLayoutPreset(layoutPresetDraftSchema.parse(draft));
    broadcastWorkspace();
    return preset;
  });

  handle(IPC.layoutPresetDelete, (id: LayoutId) => {
    workspace.deleteLayoutPreset(String(id));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsSet, async (owner: PasswordOwner, password: string) => {
    await workspace.setPassword(passwordOwnerSchema.parse(owner), String(password));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsClear, (owner: PasswordOwner) => {
    workspace.clearPassword(passwordOwnerSchema.parse(owner));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsCopy, async (owner: PasswordOwner) => {
    const password = await workspace.copyPassword(passwordOwnerSchema.parse(owner));
    if (!password) return false;
    clipboard.writeText(password);
    setTimeout(() => {
      void clipboard.readText().then((current) => {
        if (current === password) clipboard.clear();
      });
    }, 30_000);
    return true;
  });

  handle(IPC.credentialsUnlock, (password: string) => workspace.unlockVault(String(password)));

  handle(IPC.credentialsLock, () => {
    workspace.lockVault();
    return workspace.snapshot();
  });

  handle(IPC.credentialsSetMaster, async (password: string) => {
    await workspace.setMasterPassword(String(password));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsRemoveMaster, async () => {
    await workspace.removeMasterPassword();
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsChangeMaster, async (current: string, next: string) => {
    const changed = await workspace.changeMasterPassword(String(current), String(next));
    if (changed) broadcastWorkspace();
    return changed;
  });

  handle(IPC.instanceLaunch, async (identityId: string, pathOverride?: string) => {
    const result = await workspace.launchIdentity(String(identityId), pathOverride);
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceLaunchBatch, async (identityIds: string[]) => {
    const result = await workspace.launchIdentities(identityIds.map(String));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceLaunchView, async (viewId: string) => {
    const result = await workspace.launchView(String(viewId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceLaunchViewMember, async (viewId: string, identityId: string) => {
    const result = await workspace.launchViewMember(String(viewId), String(identityId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceClean, async (siteId?: string) => {
    const result = await workspace.launchCleanSession(siteId ? String(siteId) : undefined);
    broadcastWorkspace();
    return result;
  });

  handle(IPC.instanceStop, async (id: string) => {
    await workspace.stopInstance(String(id));
    broadcastWorkspace();
  });

  handle(IPC.instanceStopAll, async () => {
    await workspace.stopAll();
    broadcastWorkspace();
  });

  handle(IPC.instanceStopView, async (viewId: string) => {
    await workspace.stopView(String(viewId));
    broadcastWorkspace();
  });

  handle(IPC.instanceFocus, async (id: string) => {
    const instanceId = String(id);
    const focused = await workspace.focusInstance(instanceId);
    // The label is shown from the window rect measured *after* raising, so it
    // lands over the restored window rather than wherever it was minimized to.
    if (focused) {
      const rect = await workspace.instanceWindowRect(instanceId).catch(() => undefined);
      flashFocusLabel(instanceId, rect);
      // Do not wait for the next poll: clicking straight after the raise feels
      // broken if the highlight lags behind.
      publishActiveInstance(instanceId);
    }
    return focused;
  });

  handle(IPC.authCheck, async (identityId: string) => {
    const result = await workspace.checkAuth(String(identityId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.authCheckAll, async (siteId?: string) => {
    const result = await workspace.checkAllAuth(siteId ? String(siteId) : undefined);
    // One broadcast for the whole batch: the service persisted once.
    broadcastWorkspace();
    return result;
  });

  handle(IPC.authReloginExpired, async (siteId?: string) => {
    const result = await workspace.reloginExpired(siteId ? String(siteId) : undefined);
    broadcastWorkspace();
    return result;
  });

  handle(IPC.authFill, async (identityId: string) => {
    const result = await workspace.fillLogin(String(identityId));
    broadcastWorkspace();
    return result;
  });

  handle(IPC.settingsSave, (patch: SettingsPatch) => {
    applySettingsPatch(patch);
    // The renderer expects the full settings object after a save.
    return workspace.settingsSnapshot();
  });

  handle(IPC.dataExport, async (options: { includeSecrets: boolean; passphrase?: string }) => {
    const { canceled, filePath } = await showSaveDialog({
      title: "导出配置",
      defaultPath: join(app.getPath("documents"), `ensemble-${dateStamp()}.json`),
      filters: [{ name: "Ensemble 配置", extensions: ["json"] }],
    });
    const outcome: ExportOutcome = { canceled: true };
    if (canceled || !filePath) return outcome;
    const passphrase = String(options?.passphrase ?? "");
    const exported = await workspace.exportWorkspace(options?.includeSecrets ? passphrase : undefined);
    writeFileSync(filePath, `${JSON.stringify(exported.file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return {
      canceled: false,
      path: filePath,
      counts: exported.counts,
      secretsIncluded: exported.secretsIncluded,
    } satisfies ExportOutcome;
  });

  handle(IPC.dataImportPick, async () => {
    const { canceled, filePaths } = await showOpenDialog({
      title: "导入配置",
      properties: ["openFile"],
      filters: [{ name: "Ensemble 配置", extensions: ["json"] }],
    });
    const outcome: ImportPickOutcome = { canceled: true };
    const filePath = filePaths?.[0];
    if (canceled || !filePath) return outcome;
    let payload: ReturnType<typeof parseExportFile>;
    try {
      payload = parseExportFile(JSON.parse(readFileSync(filePath, "utf8")));
    } catch (error) {
      throw new Error(`无法读取该文件：${(error as Error).message}`);
    }
    pendingImport = { path: filePath, payload };
    return {
      canceled: false,
      path: filePath,
      preview: {
        version: payload.version,
        exportedAt: payload.exportedAt,
        hasSecrets: Boolean(payload.secrets),
        sites: payload.sites.length,
        identities: payload.identities.length,
        views: payload.views.length,
        flows: payload.flows?.length ?? 0,
        layoutPresets: payload.layoutPresets.length,
        bookmarks: payload.bookmarks?.length ?? 0,
      },
    } satisfies ImportPickOutcome;
  });

  handle(IPC.dataImportApply, (passphrase?: string) => {
    if (!pendingImport) throw new Error("请先选择要导入的配置文件");
    const { payload } = pendingImport;
    // Clear only after the merge succeeds: a wrong passphrase throws before any
    // write, and dropping the payload here would force the user to re-pick the
    // very same file just to retype it.
    const result = workspace.importWorkspace(payload, passphrase ? String(passphrase) : undefined);
    pendingImport = null;
    broadcastWorkspace();
    return result;
  });

  /*
   * Account bundles: sharing a chosen subset of accounts with a colleague.
   *
   * Kept separate from `data:export` above, which is a whole-workspace
   * migration file. A bundle is matched by site URL and username on the
   * receiving side, so it lands correctly in someone else's workspace.
   */
  handle(
    IPC.accountsExport,
    async (options: {
      siteIds: string[];
      identityIds: string[];
      passphrase?: string;
      note?: string;
    }) => {
      const { canceled, filePath } = await showSaveDialog({
        title: "导出账号",
        defaultPath: join(app.getPath("documents"), `ensemble-accounts-${dateStamp()}.json`),
        filters: [{ name: "Ensemble 账号包", extensions: ["json"] }],
      });
      const outcome: AccountsExportOutcome = { canceled: true };
      if (canceled || !filePath) return outcome;
      const passphrase = String(options?.passphrase ?? "");
      const exported = await workspace.exportAccounts({
        siteIds: Array.isArray(options?.siteIds) ? options.siteIds.map(String) : [],
        identityIds: Array.isArray(options?.identityIds) ? options.identityIds.map(String) : [],
        ...(passphrase ? { passphrase } : {}),
        ...(options?.note ? { note: String(options.note) } : {}),
      });
      writeFileSync(filePath, `${JSON.stringify(exported.file, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return {
        canceled: false,
        path: filePath,
        counts: exported.counts,
        secretsIncluded: Boolean(exported.file.secrets),
      } satisfies AccountsExportOutcome;
    },
  );

  handle(IPC.accountsImportPick, async () => {
    const { canceled, filePaths } = await showOpenDialog({
      title: "导入账号",
      properties: ["openFile"],
      filters: [{ name: "Ensemble 账号包", extensions: ["json"] }],
    });
    const outcome: AccountsImportPickOutcome = { canceled: true };
    const filePath = filePaths?.[0];
    if (canceled || !filePath) return outcome;
    let payload: ReturnType<typeof parseAccountBundle>;
    try {
      payload = parseAccountBundle(JSON.parse(readFileSync(filePath, "utf8")));
    } catch (error) {
      throw new Error(`无法读取该文件：${(error as Error).message}`);
    }
    pendingAccountBundle = { path: filePath, payload };
    return {
      canceled: false,
      path: filePath,
      preview: workspace.previewAccountBundle(payload),
    } satisfies AccountsImportPickOutcome;
  });

  handle(IPC.accountsImportApply, (passphrase?: string) => {
    if (!pendingAccountBundle) throw new Error("请先选择要导入的账号文件");
    const { payload } = pendingAccountBundle;
    const result = workspace.importAccountBundle(
      payload,
      passphrase ? String(passphrase) : undefined,
    );
    pendingAccountBundle = null;
    broadcastWorkspace();
    return { result, snapshot: workspace.snapshot() };
  });

  handle(IPC.mcpInfo, () => mcpServer?.status());

  handle(IPC.mcpUpdate, async (patch: McpPatch) => {
    if (!mcpServer) throw new Error("MCP 服务未初始化");
    const status = await mcpServer.update(patch ?? {});
    trayRebuild?.();
    return status;
  });

  handle(IPC.downloadsList, () => downloads.list());

  /*
   * One entry point for every toolbar action.
   *
   * `open` and `reveal` are the reason this lives in main: the path stays on
   * this side, and the renderer only ever names an entry by id. A cancelled or
   * interrupted download has no file to open, so those actions no-op instead of
   * failing the whole call.
   */
  handle(IPC.downloadsAct, (action: DownloadAction, id?: string) => {
    const entry = id ? downloads.find(id) : undefined;
    switch (action) {
      case "cancel":
        if (id) downloads.cancel(id);
        break;
      case "remove":
        if (id) downloads.remove(id);
        break;
      case "clear":
        downloads.clear();
        break;
      case "open":
        if (entry?.savePath) void shell.openPath(entry.savePath);
        break;
      case "reveal":
        if (entry?.savePath) shell.showItemInFolder(entry.savePath);
        break;
    }
    return downloads.list();
  });

  handle(IPC.appSetTheme, (theme: AppSettings["theme"]) => {
    applyTheme(theme);
  });

  handle(IPC.appQuit, async () => {
    await shutdownAndQuit();
  });

  handle(IPC.appOpenExternal, async (url: string) => {
    // The renderer only ever passes URLs from its own message table, but a
    // compromised renderer would otherwise get a system-browser launch for any
    // scheme. Restrict to the two the UI needs.
    if (!/^https?:\/\//i.test(String(url))) return;
    await shell.openExternal(String(url));
  });

  handle(IPC.appCheckUpdate, async () => {
    const result = await checkForUpdate();
    // A manual check is an explicit ask: show the result for this version even if
    // the user postponed it earlier, otherwise the button would look broken.
    if (result.status === "available") pendingUpdate = result;
    return result;
  });

  handle(IPC.proxyTestConnectivity, async () => {
    return Promise.all(connectivityProbes().map(runConnectivityProbe));
  });

  handle(IPC.appDownloadUpdate, async () => {
    if (!pendingUpdate || pendingUpdate.status !== "available") {
      throw new Error("没有待安装的新版本，请先检查更新。");
    }
    return downloadPendingUpdate(pendingUpdate);
  });

  handle(IPC.appInstallUpdate, async () => {
    await installDownloadedUpdate();
  });

  handle(IPC.windowMinimize, () => {
    mainWindow?.minimize();
  });

  handle(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
      return false;
    }
    mainWindow.maximize();
    return true;
  });

  handle(IPC.windowClose, () => {
    mainWindow?.close();
  });

  handle(IPC.windowShow, () => {
    showMainWindow();
  });

  handle(IPC.httpAuthRespond, (id: string, username: string, password: string) => {
    httpAuth.submit(id, username, password);
  });

  handle(IPC.httpAuthCancel, (id: string) => {
    httpAuth.cancel(id);
  });

  handle(IPC.overlayResize, (size: { width?: number; height?: number }) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlaySize = clampOverlaySize(
      Number(size?.width ?? overlaySize.width),
      Number(size?.height ?? overlaySize.height),
    );
    if (overlayCompact) return;
    const bounds = overlayWindow.getBounds();
    if (bounds.width !== overlaySize.width || bounds.height !== overlaySize.height) {
      overlayWindow.setBounds({
        ...bounds,
        width: overlaySize.width,
        height: overlaySize.height,
      });
    }
    // Persist right away: a resize is a deliberate user action, and the next
    // show re-applies the stored size.
    const [x, y] = overlayWindow.getPosition();
    if (typeof x === "number" && typeof y === "number") writeOverlayState(x, y);
  });

  handle(IPC.overlayCompact, (compact: boolean) => {
    applyOverlayCompact(compact === true);
  });

  /**
   * Drag support for the collapsed square.
   *
   * The ball is a frameless window with a fixed size, so the renderer cannot move
   * it with CSS. It reports screen coordinates while the pointer is down; with
   * `snap` (pointer released) the window docks to the nearest horizontal edge,
   * which is what makes it feel like a desktop widget rather than a stray window.
   */
  handle(IPC.overlayMove, (position: { x?: number; y?: number; snap?: boolean }) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const size = currentOverlaySize();
    const rawX = Number(position?.x ?? overlayWindow.getBounds().x);
    const rawY = Number(position?.y ?? overlayWindow.getBounds().y);
    let x = Number.isFinite(rawX) ? rawX : 0;
    let y = Number.isFinite(rawY) ? rawY : 0;
    // Resolve the display from the target point, not from where the window still
    // is: a fast drag across monitors would otherwise be clamped to the old one.
    const area = overlayAreaAt(x + size.width / 2, y + size.height / 2);
    const minX = area.x;
    const minY = area.y;
    const maxX = Math.max(minX, area.x + area.width - size.width);
    const maxY = Math.max(minY, area.y + area.height - size.height);
    x = Math.min(Math.max(x, minX), maxX);
    y = Math.min(Math.max(y, minY), maxY);

    if (position?.snap === true) {
      // Only snap horizontally: the ball belongs to an edge, and docking top or
      // bottom would put it under the taskbar or off a full-height window.
      x = x + size.width / 2 < area.x + area.width / 2 ? minX : maxX;
    }
    // setBounds, not setPosition: on Windows a transparent frameless window
    // drifts one pixel taller on every setPosition call (measured at 150% DPI),
    // which made a drag slowly stretch the collapsed square. Naming the size
    // explicitly keeps the window exactly as big as it should be.
    overlayWindow.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: size.width,
      height: size.height,
    });
    if (position?.snap === true) writeOverlayState(Math.round(x), Math.round(y));
  });

  handle(IPC.overlayHide, () => {
    hideOverlay();
  });

  // ---- embedded browser surface ----

  handle(IPC.embeddedStateGet, () => ensureEmbeddedBrowser().state());

  handle(
    IPC.embeddedOpen,
    async (input: {
      url?: string;
      identityId?: string;
      siteId?: string;
      label?: string;
      color?: string;
      viewId?: string | null;
      clean?: boolean;
    }) => {
      const browser = ensureEmbeddedBrowser();
      // "+" while a view is on stage adds to that view; a loose tab would vanish
      // off stage and look like the click did nothing. The dock's "Tabs" block
      // passes `viewId: null` because there the answer is the opposite.
      const explicit = input !== undefined && input !== null && "viewId" in input;
      const viewId = explicit ? (input?.viewId ?? undefined) : browser.defaultViewId();
      // Batch launch names identities without URLs; those pages must land on the
      // account's start page, same as clicking the card — not on a blank tab.
      // Every caller that wants a blank tab omits `identityId`.
      const resolvedUrl =
        input?.url ??
        (input?.identityId ? embeddedStartUrl(String(input.identityId)) : undefined);
      const tab = await browser.createTab({
        ...(resolvedUrl ? { url: resolvedUrl } : {}),
        ...(input?.identityId ? { identityId: input.identityId } : {}),
        ...(input?.siteId ? { siteId: input.siteId } : {}),
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.color ? { color: input.color as RoleColor } : {}),
        ...(viewId ? { viewId } : {}),
        // An identity always owns its own partition; `clean` only decides for a
        // page that has none, so the two never disagree.
        ...(input?.clean ? { clean: true } : {}),
        origin: "manual",
      });
      // Opening a bookmark as one of its accounts is the same intent as
      // clicking that account's card, so it fills the same way. A blank tab or
      // a clean session names no identity and is skipped inside the scheduler.
      if (input?.identityId) scheduleEmbeddedLogin(tab.id, input.identityId);
      // A "+" that omits `viewId` means "add a page here and show it". When the
      // grid is full, the new page has no free cell, so swap it into the
      // selected one — otherwise the stage keeps showing the old page and the
      // click looks like it did nothing. The displaced instance stays in the
      // view off stage. An explicit `viewId` (batch launch) is left alone: there
      // the caller is filling cells one by one, and a fifth member of a 2×2 must
      // not evict one of the four.
      if (!explicit && viewId) browser.activate(tab.id);
      // The caller gets the tab itself; the stores need its id to pin it.
      return tab;
    },
  );

  /**
   * Opens a page in a specific view.
   *
   * The sidebar's "+" on a view header means "add a page here", not "add a page
   * to whatever is on stage", so it names the view explicitly. When every cell
   * is taken the page would otherwise be created off stage and the header's "+"
   * would look broken, so it swaps into the selected cell like the toolbar's "+".
   *
   * `identityId` is the account the user picked in the chooser: the page then
   * opens in that identity's partition, lands on the site's start page and gets
   * the same autofill a launch from anywhere else does. `url`/`clean` cover the
   * daily and throwaway openings of one site into this view.
   */
  handle(
    IPC.embeddedOpenInView,
    async (
      viewId: string,
      options?: { identityId?: string; url?: string; clean?: boolean },
    ) => {
      const browser = ensureEmbeddedBrowser();
      const identity =
        typeof options?.identityId === "string" && options.identityId
          ? service?.findIdentity(String(options.identityId))
          : undefined;
      // Without a URL an identity-born page would stay on about:blank while the
      // renderer keeps drawing the new-tab surface — the dock says the account's
      // name, the stage shows a search box, and nothing ever loads.
      const resolvedUrl =
        options?.url ??
        (identity ? embeddedStartUrl(identity.id) : undefined);
      const tab = await browser.createTab({
        viewId: String(viewId),
        origin: "manual",
        ...(resolvedUrl ? { url: resolvedUrl } : {}),
        ...(identity ? { identityId: identity.id, siteId: identity.siteId } : {}),
        ...(identity ? { label: identity.name, color: identity.color } : {}),
        ...(options?.clean ? { clean: true } : {}),
      });
      if (identity) scheduleEmbeddedLogin(tab.id, identity.id);
      browser.activate(tab.id);
      browser.focusPage();
      return browser.state();
    },
  );

  /**
   * Opens a blank tab in one specific slot and focuses it.
   *
   * This is the empty slot's "add a page" button: the click says which cell the
   * page belongs in, so the tab is pinned there rather than wherever the view's
   * focus happened to be.
   */
  handle(
    IPC.embeddedOpenInSlot,
    async (
      viewId: string,
      slotIndex: number,
      options?: { identityId?: string; url?: string; clean?: boolean },
    ) => {
      const browser = ensureEmbeddedBrowser();
      // An identity-born cell: the page opens in that account's own partition,
      // so the slot's login state is the account the user picked, and the dock
      // already shows its name. Naming it after the identity means a grid of
      // six accounts reads as six accounts instead of six "新标签页".
      const identity =
        typeof options?.identityId === "string" && options.identityId
          ? service?.findIdentity(String(options.identityId))
          : undefined;
      // Same rule as the view header's chooser: an identity cell navigates to the
      // account's start page and gets autofilled, otherwise the cell shows the
      // app's new-tab surface forever while the dock already says the account's
      // name.
      const resolvedUrl =
        options?.url ?? (identity ? embeddedStartUrl(identity.id) : undefined);
      const tab = await browser.createTab({
        viewId: String(viewId),
        origin: "manual",
        ...(resolvedUrl ? { url: resolvedUrl } : {}),
        ...(identity ? { identityId: identity.id, siteId: identity.siteId } : {}),
        ...(identity ? { label: identity.name, color: identity.color } : {}),
        ...(options?.clean ? { clean: true } : {}),
      });
      const pinned = browser.pinTab(String(viewId), Number(slotIndex), tab.id);
      if (identity) scheduleEmbeddedLogin(tab.id, identity.id);
      browser.focusPage();
      return pinned;
    },
  );

  /**
   * "+" in a slot's tab strip: one more page in the same instance.
   *
   * The strip shows the pages a single browser window has, so its "+" must not
   * create a second window — that would double the session and split the cookies
   * a login just produced.
   */
  handle(IPC.embeddedOpenInInstance, async (instanceId: string) => {
    const browser = ensureEmbeddedBrowser();
    const next = await browser.openInInstance(String(instanceId));
    browser.focusPage();
    return next;
  });

  handle(IPC.embeddedDuplicate, async (tabId: string) => {
    const browser = ensureEmbeddedBrowser();
    const next = await browser.duplicateTab(String(tabId));
    browser.focusPage();
    return next;
  });

  handle(IPC.embeddedCloseOthers, (tabId: string) =>
    ensureEmbeddedBrowser().closeOtherTabs(String(tabId)),
  );

  /**
   * Opens an account as a new page in the flat tab strip.
   *
   * This is the accounts page's meaning: "give me this account's page". It is
   * deliberately not a placement rule any more. When a view is on stage, adding
   * the page into a cell (or swapping it in) silently rearranges a screen the
   * user did not point at. The stable behaviour is a new tab in the default
   * group: the stage stays as it is, and moving the page into a view is the
   * drag gesture or the view's own "add tab".
   *
   * It also always creates a page, even for an account that is already open:
   * clicking launch is a request for a page, not for "bring me back to the last
   * place this account appeared". Raising an external window is a different
   * action and is handled by the caller.
   */
  handle(IPC.embeddedOpenIdentity, async (identityId: string) => {
    if (!service) throw new Error("工作区尚未就绪");
    const identity = service.findIdentity(String(identityId));
    if (!identity) throw new Error("账号不存在");
    const browser = ensureEmbeddedBrowser();
    const url = embeddedStartUrl(identity.id);
    // Switch to the browser page before the page exists: createTab waits out the
    // carrier attaching and the page's first load, and a click must feel
    // answered before that. The tab's own record is broadcast as soon as it is
    // created, so the strip shows a loading tab right behind the switch.
    browser.focusPage();
    const tab = await browser.createTab({
      ...(url ? { url } : {}),
      identityId: identity.id,
      siteId: identity.siteId,
      label: identity.name,
      ...(identity.color ? { color: identity.color } : {}),
      origin: "manual",
    });
    scheduleEmbeddedLogin(tab.id, identity.id);
    return browser.state();
  });

  handle(IPC.embeddedOpenView, (viewId: string) => openEmbeddedView(String(viewId)));

  /**
   * Declining a capture drops the secret immediately.
   *
   * Nothing is written until the user says yes, so this is the whole cleanup:
   * no password ever touched disk or the renderer.
   */
  handle(IPC.embeddedLoginDismiss, (token: string) => {
    loginCaptures.discard(String(token));
    sendPendingLogins();
  });
  /** Everything still waiting to be saved; the renderer's list view calls this. */
  handle(IPC.embeddedLoginPending, () => loginCaptures.list());

  /*
   * The message centre.
   *
   * `listMessages` is the one place staleness is decided: a capture token only
   * lives in this process, a tab only exists while it is open, so "can this row
   * still do anything" is a question about right now, not about the message.
   * Answering it on read keeps the stored list honest — history from last week
   * still shows what happened, and simply stops offering the action.
   */

  handle(IPC.messagesList, () => messageViews());
  handle(IPC.messagesAdd, (input: AddMessageInput) => {
    messageStore().add({
      kind: input.kind,
      tone: input.tone,
      titleKey: String(input.titleKey),
      ...(input.titleParams ? { titleParams: input.titleParams } : {}),
      ...(input.detail ? { detail: String(input.detail).slice(0, 500) } : {}),
      ...(input.action ? { action: input.action } : {}),
    });
    return broadcastMessages();
  });
  handle(IPC.messagesRead, (id: string) => {
    messageStore().markRead(String(id));
    return broadcastMessages();
  });
  handle(IPC.messagesReadAll, () => {
    messageStore().markAllRead();
    return broadcastMessages();
  });
  handle(IPC.messagesRemove, (id: string) => {
    // Dropping the row also drops the secret it pointed at: leaving an
    // unreachable password in memory until the process exits is the exact shape
    // of leak a "delete" is supposed to avoid.
    const removed = messageStore().remove(String(id));
    if (removed?.action?.type === "login-capture") {
      loginCaptures.discard(removed.action.token);
      sendPendingLogins();
    }
    return broadcastMessages();
  });
  handle(IPC.messagesClear, () => {
    for (const message of messageStore().list()) {
      if (message.action?.type === "login-capture") {
        loginCaptures.discard(message.action.token);
      }
    }
    messageStore().clear();
    sendPendingLogins();
    return broadcastMessages();
  });

  handle(IPC.embeddedClose, (tabId: string) => ensureEmbeddedBrowser().closeTab(String(tabId)));
  /**
   * Activating a page means "show me this page".
   *
   * The dock is reachable from every rail page, so a click on one of its rows has
   * to bring the browser page forward as well as switch the tab. Only this channel
   * does that: the AI surface calls `activate` directly, and a tool switching tabs
   * must not pull the window in front of whatever the user is doing.
   */
  handle(IPC.embeddedActivate, (tabId: string) => {
    const browser = ensureEmbeddedBrowser();
    const state = browser.activate(String(tabId));
    browser.focusPage();
    return state;
  });
  handle(IPC.embeddedNavigate, (tabId: string, url: string) =>
    ensureEmbeddedBrowser().navigate(String(tabId), String(url)),
  );
  handle(IPC.embeddedBack, (tabId: string) => {
    ensureEmbeddedBrowser().back(String(tabId));
  });
  handle(IPC.embeddedForward, (tabId: string) => {
    ensureEmbeddedBrowser().forward(String(tabId));
  });
  handle(IPC.embeddedReload, (tabId: string) => {
    ensureEmbeddedBrowser().reload(String(tabId));
  });
  handle(IPC.embeddedClearCacheReload, (tabId: string) =>
    ensureEmbeddedBrowser().clearCacheAndReload(String(tabId)),
  );
  /** Same rule as a page click: picking a container shows it. */
  handle(IPC.embeddedViewActivate, (viewId: string | null) => {
    const browser = ensureEmbeddedBrowser();
    const state = browser.activateView(viewId ? String(viewId) : null);
    browser.focusPage();
    return state;
  });
  handle(IPC.embeddedViewCreate, (input?: { name?: string; layoutId?: LayoutId }) => {
    const browser = ensureEmbeddedBrowser();
    const state = browser.createView({
      ...(input?.name ? { name: String(input.name) } : {}),
      ...(input?.layoutId ? { layoutId: String(input.layoutId) } : {}),
    });
    // The dock is reachable from every page; a new empty view is invisible
    // until the browser page is in front.
    browser.focusPage();
    return state;
  });
  handle(IPC.embeddedDevtoolsPark, (parked: boolean) => {
    ensureEmbeddedBrowser().setDevtoolsParked(Boolean(parked));
  });

  handle(IPC.embeddedLaunchBatch, async (identityIds: string[]) => {    const browser = ensureEmbeddedBrowser();
    if (!service) throw new Error("工作区未就绪");
    const members = (Array.isArray(identityIds) ? identityIds : [])
      .map((id) => service?.findIdentity(String(id)))
      .filter((identity) => identity !== undefined);
    if (members.length === 0) throw new Error(t("error.viewMembers"));
    const siteId = members[0]?.siteId;
    // Same rule as the external batch: one layout describes one screen, so a
    // batch spanning two sites has no sensible tiling.
    if (members.some((identity) => identity.siteId !== siteId)) {
      throw new Error(t("error.batchMixedSites"));
    }
    // A batch is the one launch that is about a layout: one scratch container,
    // laid out with the current default layout, gone from the workspace when
    // closed. The whole run — creation, pinning, rollback — lives in the main
    // process so a renderer navigation cannot interrupt it halfway.
    //
    // The container is broadcast ahead of the pages and outside the hold:
    // the switch below lands on a stage that already shows the batch taking
    // shape (empty cells ready to fill) instead of whatever was on stage
    // before, and every pinned page then lights its cell as it lands.
    const layout = service.settingsSnapshot().layout;
    const state = browser.createView({ layoutId: layout });
    const viewId = state.activeViewId;
    if (!viewId) throw new Error("批量启动容器创建失败");
    browser.focusPage();
    return browser.launchIdentityBatch(
      members.map((identity) => ({
        identityId: identity.id,
        ...(identity.siteId ? { siteId: identity.siteId } : {}),
        label: identity.name,
        ...(identity.color ? { color: identity.color } : {}),
        url: embeddedStartUrl(identity.id),
      })),
      viewId,
      (tab, index) => {
        const identityId = members[index]?.id;
        if (identityId) scheduleEmbeddedLogin(tab.id, identityId);
      },
    );
  });
  handle(IPC.embeddedViewLayout, (viewId: string, layoutId: LayoutId) =>
    ensureEmbeddedBrowser().setViewLayout(String(viewId), String(layoutId)),
  );
  /**
   * Layout for the flat list: no container exists yet, so this creates one.
   *
   * The dock offers a layout picker on the "tabs" block even though those pages
   * are not in any view — choosing a grid there is the honest way to say "I want
   * these side by side", and it goes through the same grouping the AI tool uses.
   */
  handle(IPC.embeddedGroupLoose, (layoutId: LayoutId) => {
    const browser = ensureEmbeddedBrowser();
    const viewId = browser.layoutTargetView(String(layoutId));
    if (viewId) browser.focusPage();
    return viewId;
  });
  handle(IPC.embeddedViewSlots, (viewId: string, rects: SlotRect[]) =>
    ensureEmbeddedBrowser().setViewSlotRects(String(viewId), rects),
  );
  handle(IPC.embeddedViewPin, (viewId: string, slotIndex: number, tabId: string | null) =>
    ensureEmbeddedBrowser().pinTab(String(viewId), Number(slotIndex), tabId ? String(tabId) : null),
  );
  handle(IPC.embeddedViewSplit, (viewId: string, slotIndex: number, pageId: string) =>
    ensureEmbeddedBrowser().splitTabIntoSlot(String(viewId), Number(slotIndex), String(pageId)),
  );
  handle(IPC.embeddedViewUnsplit, (viewId: string, slotIndex: number) =>
    ensureEmbeddedBrowser().unsplitSlot(String(viewId), Number(slotIndex)),
  );
  handle(IPC.embeddedViewRename, (viewId: string, name: string) =>
    ensureEmbeddedBrowser().renameView(String(viewId), String(name ?? "")),
  );
  handle(IPC.embeddedViewColor, (viewId: string, color: string | null) =>
    ensureEmbeddedBrowser().setViewColor(
      String(viewId),
      color ? (String(color) as RoleColor) : null,
    ),
  );
  handle(IPC.embeddedViewCollapse, (viewId: string, collapsed: boolean) =>
    ensureEmbeddedBrowser().setViewCollapsed(String(viewId), Boolean(collapsed)),
  );
  handle(IPC.embeddedViewClose, (viewId: string, mode: "all" | "opened") =>
    ensureEmbeddedBrowser().closeView(String(viewId), mode === "opened" ? "opened" : "all"),
  );
  handle(IPC.embeddedDropTab, (tabId: string, target: EmbeddedDropTarget) =>
    ensureEmbeddedBrowser().dropTab(String(tabId), target),
  );
  handle(IPC.embeddedFill, (tabId: string) => ensureEmbeddedBrowser().fillLogin(String(tabId)));
  handle(IPC.embeddedDevTools, (tabId: string) => {
    ensureEmbeddedBrowser().openDevTools(String(tabId));
  });
  handle(IPC.embeddedDevToolsClose, (tabId: string) => {
    ensureEmbeddedBrowser().closeDevTools(String(tabId));
  });
  handle(IPC.embeddedDevToolsResize, (tabId: string) => {
    ensureEmbeddedBrowser().beginDevToolsResize(String(tabId));
  });
  handle(IPC.embeddedDevToolsResizeEnd, () => {
    ensureEmbeddedBrowser().endDevToolsResize();
  });
  handle(IPC.embeddedZoom, (tabId: string, direction: "in" | "out" | "reset") =>
    ensureEmbeddedBrowser().zoomBy(
      String(tabId),
      direction === "out" ? "out" : direction === "reset" ? "reset" : "in",
    ),
  );
  handle(
    IPC.embeddedViewport,
    (
      tabId: string,
      mode: "adaptive" | "inherit" | { width: number; height: number } | null,
    ) => {
      // Three answers, not two: pin this page, explicitly opt out of the
      // workspace default, or go back to following it. `null` used to mean both
      // "adaptive" and "inherit", which is why a global default could not exist.
      if (mode === "inherit") return ensureEmbeddedBrowser().setViewport(String(tabId), undefined);
      if (mode === null || mode === "adaptive") {
        return ensureEmbeddedBrowser().setViewport(String(tabId), null);
      }
      // Round-tripped through the renderer as plain data; re-validate here
      // rather than trusting whatever shape arrived over IPC.
      const viewport = normalizeViewportSize(Number(mode.width), Number(mode.height));
      if (!viewport) {
        throw new Error(
          `分辨率必须在 ${VIEWPORT_MIN}–${VIEWPORT_MAX_WIDTH} × ${VIEWPORT_MIN}–${VIEWPORT_MAX_HEIGHT} 之间`,
        );
      }
      return ensureEmbeddedBrowser().setViewport(String(tabId), viewport);
    },
  );
  handle(
    IPC.embeddedFind,
    (tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean }) =>
      ensureEmbeddedBrowser().findInTab(String(tabId), String(text ?? ""), options ?? {}),
  );
  handle(IPC.embeddedStopFind, (tabId: string) => {
    ensureEmbeddedBrowser().stopFind(String(tabId));
  });

  /**
   * A `<webview>` node attached and can be driven.
   *
   * Main cannot discover guests on its own: the renderer creates the nodes. The
   * report is what turns an attached guest into something the surface can talk
   * to, and it is idempotent so a reload of the embedder does not double-drive.
   */
  handle(IPC.embeddedGuestRegister, (guestId: number, tabId?: string, partition?: string) => {
    const id = Number(guestId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("无效的页面标识");
    const contents = webContents.fromId(id);
    if (!contents) throw new Error("页面已关闭");
    const host = mainWindow?.webContents ?? undefined;
    const handle =
      typeof tabId === "string" && tabId
        ? guestManager.attachByKey(tabId, contents, host)
        : guestManager.register(contents, host);
    guestManager.describe(handle.guestId, typeof partition === "string" ? partition : undefined);
  });

  /**
   * Close the CDP session before the renderer removes the node.
   *
   * The reply is the signal that detaching finished: unmounting earlier would
   * take the native target out from under an in-flight command, which crashes
   * the process rather than failing the call.
   */
  handle(IPC.embeddedGuestTeardown, async (guestId: number) => {
    const id = Number(guestId);
    if (!Number.isInteger(id) || id <= 0) return;
    await guestManager.teardown(String(id));
  });

  /**
   * The renderer finished (or failed) a presentation request.
   *
   * Resolving the waiting screenshot here — rather than sleeping a guessed
   * number of frames — is what keeps a capture of a background tab to tens of
   * milliseconds instead of a timeout.
   */
  handle(IPC.embeddedGuestPresented, (requestId: number, shown: boolean) => {
    const done = presentWaiters.get(Number(requestId));
    if (!done) return;
    presentWaiters.delete(Number(requestId));
    done({ requestId: Number(requestId), shown: Boolean(shown) });
  });

  /**
   * The renderer laid a node out.
   *
   * Until this arrives the page's viewport is 0×0, and every visibility check
   * inside it answers false — so commands that read the page wait for it rather
   * than reporting "element not found".
   */
  handle(IPC.embeddedGuestLaidOut, (tabId: string) => {
    if (typeof tabId !== "string" || !tabId) return;
    guestManager.confirmLaidOut(tabId);
  });

  // The chrome reports the content area it reserves for native views. `send`
  // rather than `invoke`: it fires on every resize and needs no reply.
  ipcMain.on(IPC.embeddedStage, (_event, stage: StageRect | null) => {
    if (!embedded) return;
    if (!stage || typeof stage !== "object") {
      embedded.setStage(null);
      return;
    }
    const width = Number(stage.width);
    const height = Number(stage.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      embedded.setStage(null);
      return;
    }
    embedded.setStage({
      x: Number(stage.x) || 0,
      y: Number(stage.y) || 0,
      width,
      height,
    });
  });
}

function dateStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/**
 * Startup diagnostics on disk.
 *
 * A packaged macOS app launched from Finder has no readable stdout, so a failed
 * bind or a renderer that never finished loading left no trace anywhere the user
 * (or a later debugging session) could look. Startup-critical lines land in
 * userData/logs/main.log instead. The file is truncated past the cap rather than
 * rotated: one bounded file, nothing to clean up by hand.
 */
const LOG_MAX_BYTES = 512 * 1024;

function logLine(message: string): void {
  try {
    const dir = join(userDataDir(), "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "main.log");
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, "");
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // Diagnostics must never be the reason startup fails.
  }
}

// A second instance would own its own browsers and MCP port, and both would write
// workspace.json. The first instance wins and simply reveals its window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  // Windows' native window occlusion tracking has been observed to mark a
  // docked DevTools view (a WebContentsView beside another one) as occluded:
  // its chrome paints once, the content area never does, and the panel reads as
  // a black rectangle. The headless probe cannot see this — it reproduces only
  // on a real, composited window. The app keeps its pages on screen by design,
  // so the tracker's savings are worthless here and the false positives are
  // fatal. Must be set before `app.whenReady`.
  if (process.platform === "win32") {
    app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  }

  app.whenReady().then(async () => {
    mkdirSync(profileRoot(), { recursive: true });
    // Windows groups taskbar entries by AppUserModelID and takes the icon from
    // the packaged executable. In development the process is electron.exe, so
    // without this the taskbar shows Electron's logo for our window.
    //
    // A development build carries its own id. Sharing the packaged app's id made
    // Windows treat both windows as one application: they stacked into a single
    // taskbar button, so the dev window and the installed one could not be
    // pinned, switched or closed independently.
    if (process.platform === "win32") {
      app.setAppUserModelId(
        isolatedDev ? "io.github.onefanki.ensemble.dev" : "io.github.onefanki.ensemble",
      );
    }
    // The About panel is reachable from the app menu; without this it shows the
    // bare product name with no version, which is the first thing a bug report
    // needs.
    if (process.platform === "darwin") {
      app.setAboutPanelOptions({
        applicationName: appDisplayName,
        applicationVersion: app.getVersion(),
        version: `Electron ${process.versions.electron ?? ""}`,
        copyright: "MIT License",
      });
    }

    // Initialised before the service exists: the vault reads `available` from
    // synchronous getters, so the keychain probe must already have settled.
    const secretBox = new SafeStorageBox();
    await secretBox.init();

    service = new WorkspaceService({
      userDataDir: userDataDir(),
      profileRoot: profileRoot(),
      platform: process.platform as "win32" | "darwin" | "linux",
      secretBox,
      appVersion: app.getVersion(),
      systemLocale: systemLocaleTag(),
      workArea: workAreaRect,
      onChange: broadcastWorkspace,
      onAutoFill: (report) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.authAutoFilled, report);
        }
      },
    });

    settingsCache = service.settingsSnapshot();
    setCoreLocale(resolveLocale(settingsCache.locale, systemLocaleTag()));
    applyTheme(settingsCache.theme);
    // Before anything reaches the network — the startup update check included.
    // Awaited so the proxy is in force for that first request rather than racing
    // it; `setProxy` only touches in-memory Chromium state, so this is fast.
    await applyProxyToDefaultSession(settingsCache);

    // Follow OS appearance changes while the setting is "system": the renderer
    // gets prefers-color-scheme updates itself, but the native window background
    // and Windows/Linux caption buttons have to be recolored here.
    nativeTheme.on("updated", () => {
      if (currentTheme !== "system") return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setBackgroundColor(isDarkTheme("system") ? "#0b0d10" : "#f3efe6");
      if (process.platform !== "darwin") {
        mainWindow.setTitleBarOverlay(titleBarOverlay("system"));
      }
    });

    // initialize() only reads local JSON and the engine cache, so the window can
    // appear right away. Orphan sweeping and engine scanning run afterwards.
    await service.initialize();
    settingsCache = service.settingsSnapshot();

    mcpServer = new McpServer({
      settingsPath: join(userDataDir(), "mcp.json"),
      auditPath: join(userDataDir(), "mcp-audit.log"),
      service,
      appVersion: app.getVersion(),
      // A development build gets the next port, so it can run beside the
      // installed app instead of fighting it for one socket.
      ...(isolatedDev ? { defaultPort: DEV_DEFAULT_PORT } : {}),
      // The log is the record; this is the live signal the dock shows.
      onPageAction: (event) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        aiActionsByTab.set(event.tabId, (aiActionsByTab.get(event.tabId) ?? 0) + 1);
        mainWindow.webContents.send(IPC.aiPageAction, {
          origin: event.origin,
          tabId: event.tabId,
          tool: event.tool,
          ok: event.ok,
          originAuthorized: event.originAuthorized,
          count: aiActionsByTab.get(event.tabId) ?? 0,
        });
        /*
         * History keeps the tool calls, not every page event: one row per call
         * is what answers "what did the AI do to this page", and the dock's live
         * counter covers "how much is it doing right now". Failures are kept at
         * warning tone so they stand out when scrolling back.
         */
        messageStore().add(
          {
            kind: "ai",
            tone: event.ok ? "info" : "warning",
            titleKey: event.ok ? "app.messagesAiAction" : "app.messagesAiActionFailed",
            titleParams: { tool: event.tool, site: event.origin },
            action: { type: "tab", tabId: event.tabId },
          },
          // Repeated clicks on one element are one intent; five minutes of the
          // same tool on the same page collapses into the newest row.
          60_000,
        );
        broadcastMessages();
      },
      embedded: {
        state: () => ensureEmbeddedBrowser().state(),
        createTab: async (input) => {
          const browser = ensureEmbeddedBrowser();
          const viewId = browser.defaultViewId();
          const created = await browser.createTab({
            ...(input.url ? { url: input.url } : {}),
            ...(input.identityId ? { identityId: input.identityId } : {}),
            ...(input.siteId ? { siteId: input.siteId } : {}),
            ...(input.label ? { label: input.label } : {}),
            ...(input.color ? { color: input.color as RoleColor } : {}),
            // AI scratch work goes in a throwaway session, never the daily
            // profile.
            //
            // An identity-less tab opened by a person is everyday browsing, but
            // one opened by an AI client is a scratch surface — automating a
            // page the user happens to be signed in to is exactly what the
            // origin gate exists to prevent, and letting the AI create such a
            // tab would sidestep it. A `clean` session is disposable by
            // construction and has no user login to protect, so everything the
            // AI does there is its own.
            ...(input.identityId ? {} : { clean: true }),
            // An AI opening pages for comparison expects them on stage together,
            // so a new tab joins the view the user is looking at.
            ...(viewId ? { viewId } : {}),
            origin: "ai",
          });
          // Deliberately no `focusPage()` here.
          //
          // Raising the window and switching it to the browser page is right for
          // a click from the UI — the person just asked to see a page. An AI
          // client is different: it opens pages to work on them, often while the
          // user is reading or editing something else in the same app, and having
          // the window jump to the front on every `open_browser_tab` makes the
          // endpoint unusable. The page gets a real viewport either way:
          // `createTab` lays it out inside the window before parking it, so
          // screenshots and DOM queries work while it is off screen.
          //
          // The tab still lands on stage when the browser page happens to be
          // visible, because the view on stage is what `viewId` names.
          if (input.identityId) scheduleEmbeddedLogin(created.id, input.identityId);
          return created;
        },
        navigate: (tabId, url) => ensureEmbeddedBrowser().navigate(tabId, url),
        // Facts for the per-origin AI gate. Passed as a function so the MCP
        // server never holds a tab reference of its own.
        aiPageContext: (tabId) => ensureEmbeddedBrowser().aiPageContext(tabId),
        closeTab: (tabId) => ensureEmbeddedBrowser().closeTab(tabId),
        activate: (tabId) => ensureEmbeddedBrowser().activate(tabId),
        snapshotDom: (tabId, options) => ensureEmbeddedBrowser().snapshotDom(tabId, options),
        click: (tabId, target) => ensureEmbeddedBrowser().click(tabId, target),
        type: (tabId, target, text, options) =>
          ensureEmbeddedBrowser().type(tabId, target, text, options),
        fillForm: (tabId, fields) => ensureEmbeddedBrowser().fillForm(tabId, fields),
        runFlow: (tabId, steps, options) =>
          ensureEmbeddedBrowser().runFlow(tabId, steps, options),
        evaluate: (tabId, expression) => ensureEmbeddedBrowser().evaluate(tabId, expression),
        screenshot: (tabId, options) => ensureEmbeddedBrowser().screenshot(tabId, options),
        visibility: (tabId, target) => ensureEmbeddedBrowser().visibility(tabId, target),
        readPageActivity: (tabId) => ensureEmbeddedBrowser().readPageActivity(tabId),
        wait: (tabId, input) => ensureEmbeddedBrowser().wait(tabId, input),
        setLayout: (layoutId, viewId) =>
          ensureEmbeddedBrowser().setViewLayout(
            viewId ?? ensureEmbeddedBrowser().defaultViewId() ?? "",
            layoutId,
          ),
        setViewport: (tabId, size) => ensureEmbeddedBrowser().setViewport(tabId, size),
        pinTab: (slotIndex, tabId, viewId) =>
          ensureEmbeddedBrowser().pinTab(
            viewId ?? ensureEmbeddedBrowser().defaultViewId() ?? "",
            slotIndex,
            tabId,
          ),
        moveTab: (tabId, target) => ensureEmbeddedBrowser().dropTab(tabId, target),
        fillLogin: (tabId) => ensureEmbeddedBrowser().fillLogin(tabId),
        defaultTabId: (requested) => ensureEmbeddedBrowser().defaultTabId(requested),
        defaultViewId: () => ensureEmbeddedBrowser().defaultViewId(),
        layoutTargetView: (layoutId) => ensureEmbeddedBrowser().layoutTargetView(layoutId),
        // Same reasoning as the AI `createTab` above: an AI opening a view must
        // not take the window away from the user. Recording `lastViewId` still
        // happens, so "restore last scene" sees what the AI worked on.
        openView: (viewId) => openEmbeddedView(viewId, { reveal: false }),
        /**
         * A container for a saved view, without opening its members.
         *
         * `compose_view` combines tabs that are already open, so it needs the
         * container only — `openView` would open a fresh tab per saved member
         * and leave the originals loose beside the duplicates.
         */
        openViewContainer: (viewId) => {
          if (!service) throw new Error("工作区尚未就绪");
          const view = service.findView(viewId);
          if (!view) throw new Error("视图不存在");
          return ensureEmbeddedBrowser().ensureView({
            viewDefinitionId: view.id,
            name: view.name,
            layoutId: view.layoutId,
          });
        },
      },
      /*
       * Account bundles for AI clients. No save/open dialog: an AI has nobody to
       * answer one, so bundles are read and written under a fixed directory and
       * the path travels in the tool call.
       */
      exportAccounts: async (input) => {
        if (!service) throw new Error("工作区未就绪");
        const exported = await service.exportAccounts(input);
        const dir = join(userDataDir(), "accounts-export");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `accounts-${dateStamp()}-${Date.now().toString(36)}.json`);
        writeFileSync(file, `${JSON.stringify(exported.file, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        return {
          path: file,
          counts: exported.counts,
          withPasswords: exported.counts.withPasswords,
        };
      },
      previewAccounts: (filePath) => {
        if (!service) throw new Error("工作区未就绪");
        const parsed = parseAccountBundle(JSON.parse(readFileSync(filePath, "utf8")));
        return service.previewAccountBundle(parsed);
      },
      importAccounts: (filePath, passphrase) => {
        if (!service) throw new Error("工作区未就绪");
        const parsed = parseAccountBundle(JSON.parse(readFileSync(filePath, "utf8")));
        const result = service.importAccountBundle(parsed, passphrase);
        broadcastWorkspace();
        return result;
      },
      createFlowTab: (flow, identityId) => openFlowTab(flow, identityId),
      // One implementation for both entry points: this is the same path the
      // settings page takes, so an AI changing the theme or proxy gets the live
      // side effects rather than a value that is only written to disk.
      updateSettings: (patch) => applySettingsPatch(patch),
      onChange: broadcastMcp,
    });

    registerIpc(service);
    /*
     * The endpoint starts before the window, never after it.
     *
     * These used to be serial: `await createWindow(); await mcpServer.start()`.
     * `createWindow` awaits the renderer load, whose promise settles on
     * did-finish-load — a load that never finished therefore left the endpoint
     * unbound for the whole session, while `status()` reported enabled-but-not-
     * running with no error to explain it. Nothing in the server needs the
     * window (`ensureEmbeddedBrowser` attaches lazily), so the window cannot
     * gate it any more.
     *
     * Started, not awaited: a busy port spends the whole retry ladder (~9 s)
     * inside `start()`, and that wait belongs behind the window, not in front of
     * it — the upgrade case where the previous instance is still releasing the
     * socket is exactly when the window would otherwise sit missing. The status
     * line lands in main.log as soon as the bind settles, whichever finishes
     * first.
     */
    const mcp = mcpServer;
    const mcpReady = mcp
      .start()
      .then(() => {
        const endpoint = mcp.status();
        logLine(
          endpoint.running
            ? `mcp listening on ${endpoint.url}`
            : `mcp not running (enabled=${endpoint.enabled})${endpoint.error ? `: ${endpoint.error}` : ""}`,
        );
      })
      .catch((error: unknown) => {
        logLine(`mcp start failed: ${(error as Error).message}`);
      });
    await createWindow();
    await mcpReady;

    /**
     * A freshly started window opens with one blank page.
     *
     * An empty stage is a dead end: the toolbar is there but nothing it acts on
     * exists yet, and the new-tab surface — search box, engine picker, backdrop —
     * only appears once a page exists. Opening one is what makes the app usable
     * the moment it starts, for the person typing an address and equally for an
     * AI that later looks for a tab to drive.
     *
     * Runs after the restore attempt: a restored view already has pages, and
     * adding a blank one on top would put an empty tab in front of real work.
     */
    const ensureStarterTab = async (): Promise<void> => {
      try {
        const browser = ensureEmbeddedBrowser();
        if (browser.state().tabs.length > 0) return;
        await browser.createTab({});
        // No `focusPage()`: the window is already in front at startup, and the
        // renderer mounts the browser page on its own.
      } catch (error) {
        // A blank starter page is a convenience; never let it abort startup.
        console.error("[ensemble] could not open the starter tab", error);
      }
    };

    // Maintenance runs in the background, but restoring waits on it so a cold
    // start does not race the engine scan and fail with "no browser".
    void service.startBackgroundMaintenance();
    const restoreTarget = mainWindow;
    // Internal "nothing to do" reasons never reach the UI; an actual launch
    // failure does, because the user asked for the restore to happen.
    const quietReasons = new Set(["disabled", "no-view", "already-attempted", "missing"]);
    void restoreLastSurface().then(async (outcome) => {
      if (outcome.restored || (outcome.reason && !quietReasons.has(outcome.reason))) {
        if (restoreTarget && !restoreTarget.isDestroyed()) {
          restoreTarget.webContents.send(IPC.viewRestored, outcome);
        }
      }
      await ensureStarterTab();
      broadcastWorkspace();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      else showMainWindow();
    });
  });
}

/*
 * HTTP authentication: nginx's basic-auth wall, protected backends, proxy
 * logins. Without a handler Electron cancels every challenge silently, and the
 * user stares at a raw 401 page with nowhere to type. The coordinator shows one
 * dialog per protection space (queued, so a page and its favicon opening the
 * same origin produce one prompt) and caches answers per browser session for
 * the rest of the process lifetime — credentials were never asked to be
 * remembered, so nothing is persisted.
 */
const httpAuth = new HttpAuthCoordinator();
const httpAuthSessions = new Map<Electron.Session, string>();
let httpAuthSessionSeq = 0;

app.on(
  "login",
  (event, webContents, authenticationResponseDetails, authInfo, callback) => {
    event.preventDefault();
    const ses = webContents?.session ?? session.defaultSession;
    let sessionKey = httpAuthSessions.get(ses);
    if (!sessionKey) {
      httpAuthSessionSeq += 1;
      sessionKey = `s${httpAuthSessionSeq}`;
      httpAuthSessions.set(ses, sessionKey);
    }
    let origin = "";
    try {
      origin = new URL(authenticationResponseDetails.url).origin;
    } catch {
      // A malformed request URL still deserves the dialog; the key just gets
      // less specific and the credentials less reusable.
    }
    const shown = httpAuth.begin(
      `${authInfo.isProxy ? "proxy" : origin}|${authInfo.host}:${authInfo.port}|${authInfo.realm ?? ""}`,
      {
        host: authInfo.host,
        ...(authInfo.port ? { port: authInfo.port } : {}),
        ...(authInfo.realm ? { realm: fixRealmEncoding(authInfo.realm) } : {}),
        scheme: authInfo.scheme,
        isProxy: authInfo.isProxy,
      },
      callback,
    );
    if (shown) mainWindow?.webContents.send(IPC.httpAuthChallenge, shown);
  },
);

// Registering this listener takes over the quit decision: without an explicit
// app.quit() here the process stays alive after the last window closes (and a
// portable build's exe stays locked on Windows).
app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
  if (quitting) {
    app.quit();
    return;
  }
  // Tray mode keeps the process (and with it the MCP endpoint) alive even if the
  // window was destroyed without a close event.
  if (settingsCache?.closeToTray) return;
  // Windows were destroyed without a close event; still stop our browsers.
  void shutdownAndQuit();
});

/**
 * Every quit path (tray menu, system shutdown, `app.quit()` from anywhere) funnels
 * through the same teardown: the MCP socket is closed first so no AI client can
 * start work while browsers are being reclaimed.
 */
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void shutdownAndQuit();
});

process.on("uncaughtException", (error) => {
  console.error("[ensemble] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[ensemble] unhandled rejection", reason);
});
