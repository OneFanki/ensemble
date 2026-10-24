import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecretBox } from "@core/credentials/vault";
import { setCoreLocale } from "@core/i18n/translate";
import { nextActiveInstanceId } from "@core/launch/active-instance";
import {
  disposeWindowFocus,
  foregroundWindowPid,
  type ScreenRect,
  warmUpWindowFocus,
} from "@core/launch/window-focus";
import { WorkspaceService } from "@core/service";
import { downloadUpdateAsset } from "@core/update/download";
import { buildWindowsInstallScript, updateFileName } from "@core/update/install";
import { parseAccountBundle } from "@shared/accounts-transfer";
import type { EmbeddedDropTarget, StageRect } from "@shared/embedded";
import { FLOW_TIMEOUT_MS, type Flow, type FlowDraft, resolveParams } from "@shared/flows";
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
  flowDraftSchema,
  identityDraftSchema,
  layoutPresetDraftSchema,
  passwordOwnerSchema,
  settingsPatchSchema,
  siteDraftSchema,
  tagDraftSchema,
  viewDraftSchema,
} from "@shared/schemas";
import { parseExportFile } from "@shared/transfer";
import type {
  AppSettings,
  BookmarkDraft,
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
  type OpenDialogOptions,
  type SaveDialogOptions,
  safeStorage,
  screen,
  shell,
  Tray,
} from "electron";
import { EmbeddedBrowser } from "./embedded/browser";
import { LoginCaptureStore } from "./embedded/login-capture";
import { McpServer } from "./mcp/server";

const isDev = Boolean(process.env["ELECTRON_RENDERER_URL"]);

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
if (userDataOverride) app.setPath("userData", userDataOverride);

class SafeStorageBox implements SecretBox {
  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  get backend(): string {
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend?.();
      return backend ?? "unknown";
    }
    return process.platform === "win32"
      ? "dpapi"
      : process.platform === "darwin"
        ? "keychain"
        : "unknown";
  }

  get kind(): "os" {
    return "os";
  }

  encrypt(plain: string): string {
    // There is no plaintext fallback: a machine without a usable keychain must
    // either install one or protect the vault with a master password.
    if (!this.available) {
      throw new Error("System credential storage is unavailable");
    }
    return `enc:${safeStorage.encryptString(plain).toString("base64")}`;
  }

  decrypt(payload: string): string {
    if (payload.startsWith("enc:")) {
      return safeStorage.decryptString(Buffer.from(payload.slice(4), "base64"));
    }
    throw new Error("Unknown credential payload");
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
 * AI page actions per origin, for the session.
 *
 * Reset when the app restarts rather than persisted: "how many operations the AI
 * made on this site" is a session fact, and a number that kept growing across
 * launches would stop meaning anything.
 */
const aiActions = new Map<string, number>();
/** Kept in sync so the close handler does not need the service to be initialized. */
let settingsCache: AppSettings | null = null;
/** Logins seen in embedded pages, waiting for the user to accept or dismiss. */
const loginCaptures = new LoginCaptureStore();

/**
 * The in-app browser surface. Created on first use so a user who never opens it
 * pays nothing at startup; it owns its own window, tabs and per-identity session
 * partitions.
 */
let embedded: EmbeddedBrowser | null = null;
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

/** Native window-control colors mirror the renderer tokens for each theme. */
const TITLEBAR_COLORS = {
  dark: { color: "#12151a", symbolColor: "#a3abb8" },
  light: { color: "#faf7f0", symbolColor: "#565049" },
} as const;

function isDarkTheme(theme: AppSettings["theme"]): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return nativeTheme.shouldUseDarkColors;
}

function titleBarOverlay(theme: AppSettings["theme"]): Electron.TitleBarOverlay {
  return { ...TITLEBAR_COLORS[isDarkTheme(theme) ? "dark" : "light"], height: 44 };
}

function userDataDir(): string {
  return app.getPath("userData");
}

function profileRoot(): string {
  return join(userDataDir(), "profiles");
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
      if (!service) return undefined;
      const identity = service.findIdentity(identityId);
      if (!identity) return undefined;
      const site = service.findSite(identity.siteId);
      if (!site) return undefined;
      // The resolver mirrors the external launch path, including references.
      const resolved = service.resolvedPassword(identityId);
      if (!resolved) return undefined;
      const siteFields = site.extraFields ?? [];
      const identityFields = identity.extraFields ?? [];
      const merged = new Map<string, string>();
      for (const field of siteFields) merged.set(field.label, field.value);
      for (const field of identityFields) merged.set(field.label, field.value);
      return {
        username: identity.username,
        password: resolved,
        submit: site.autoSubmit,
        extraFields: [...merged.entries()].map(([label, value]) => ({ label, value })),
        baseUrl: site.baseUrl,
      };
    },
    onShowPage: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.embeddedPage);
      }
    },
    ...(headless ? { headless: true } : {}),
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.embeddedPage);
      }
    },
    /*
     * A login form was submitted inside a page. The secret stays here: the
     * renderer receives a token and the username, and only picks a site/account
     * name. Writing the vault happens in `IPC.loginCaptureSave` below.
     */
    onLoginCaptured: (capture) => {
      if (!loginCaptures) return;
      const site = service?.findSiteByOrigin(capture.origin);
      // Signing in as an account the vault already stores (a saved identity, or
      // a page an AI opened with `fill_browser_login`) must not offer to save a
      // duplicate. Only a genuinely new credential is worth a prompt.
      if (site && service?.hasSavedLogin(site.id, capture.username)) return;
      const notice = loginCaptures.add(capture);
      if (!notice) return;
      const withSite = site ? loginCaptures.attachSite(notice.token, site.id) : notice;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.embeddedLoginCaptured, withSite);
      }
    },
  });
  if (mainWindow && !mainWindow.isDestroyed()) embedded.attach(mainWindow);
  // Pages created later pick the default up in `createTab`; pages already open
  // (after the window was recreated) need it applied now.
  embedded.setDefaultZoom(settingsCache?.browserZoom ?? 100);
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
      label: identity?.name ?? "标签页",
      ...(identity?.color ? { color: identity.color } : {}),
      viewId: containerId,
      origin: "view",
    });
    // A view launch fills credentials just like an external launch does.
    // Without this, opening a saved view left every login form empty while the
    // single-account path filled fine — the same action behaved differently
    // depending on which entry point was used.
    scheduleEmbeddedFill(tab.id, identityId);
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
  if (reveal) browser.focusPage();
  return next;
}

/**
 * Fills an identity's saved login into an embedded tab, once, in the background.
 *
 * The tab is created before its page has loaded, and a client-rendered login
 * form can take several seconds to appear. Polling until the deadline mirrors
 * the external path, which waits for the same reason: giving up on the first
 * "no password field" reads as "autofill is broken".
 *
 * Deliberately not awaited: a four-member view must not hold the launch result
 * for a minute while each page comes up.
 */
function scheduleEmbeddedFill(tabId: string, identityId: string): void {
  if (!service?.settingsSnapshot().autoFillOnLaunch) return;
  const identity = service.findIdentity(identityId);
  if (!identity) return;
  const browser = ensureEmbeddedBrowser();

  void (async () => {
    const deadline = Date.now() + 15_000;
    let last: Awaited<ReturnType<typeof browser.fillLogin>> | undefined;
    while (Date.now() < deadline) {
      try {
        last = await browser.fillLogin(tabId);
      } catch {
        // A navigation can destroy the page between two polls; keep trying.
      }
      if (last?.ok) break;
      if (last && last.reason !== "password-field-not-found") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const skipped = last?.ok
      ? undefined
      : last?.reason === "cross-origin"
        ? ("cross-origin" as const)
        : last?.reason === "no-password" || last?.reason === "no-identity"
          ? ("no-password" as const)
          : ("not-login-page" as const);
    const report = {
      identityId,
      label: identity.name,
      filled: last?.ok === true,
      submitted: last?.submitted === true,
      missingFields: last?.missingFields ?? [],
      unmatchedFields: [],
      ...(skipped ? { skipped } : {}),
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.authAutoFilled, report);
    }
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
  scheduleEmbeddedFill(created.id, identityId);
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
    title: "Ensemble",
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
    title: "Ensemble",
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
 * freeze pass and every screenshot went from ~100ms to never completing). The
 * window therefore is shown, but parked outside every display, kept out of the
 * taskbar, and never focused, so nothing appears where the machine's user is
 * working while the compositor still behaves normally.
 */
function parkWindowOffscreen(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  // Far enough that no plausible display layout reaches it; the window keeps the
  // size the checks expect because only the origin moves.
  const bounds = win.getBounds();
  win.setBounds({ ...bounds, x: -32_000, y: -32_000 });
  win.setSkipTaskbar(true);
  win.webContents.setBackgroundThrottling(false);
  win.showInactive();
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(loadTrayImage());
  tray.setToolTip("Ensemble");
  const rebuild = () => {
    if (!tray) return;
    const mcp = mcpServer?.status();
    const running = service?.snapshot().instances.length ?? 0;
    trayInstanceCount = running;
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开 Ensemble", click: () => showMainWindow() },
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
    title: "Ensemble",
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
      webviewTag: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

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

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    await mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
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
    const response = await fetch(endpoint, {
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

  handle(IPC.identitySave, (draft: IdentityDraft) => {
    const parsed = identityDraftSchema.parse(draft);
    const { password, captureToken, ...rest } = parsed;
    // A saved login capture owns the secret; it is released exactly once, here.
    // A second use must fail loudly instead of saving an account with no password.
    let captured: ReturnType<typeof loginCaptures.take>;
    if (captureToken) {
      captured = loginCaptures.take(captureToken);
      if (!captured) throw new Error("这次登录信息已保存过，请重新登录后再试");
    }
    workspace.saveIdentity(rest, password ?? captured?.password);
    broadcastWorkspace();
    return workspace.snapshot();
  });
  handle(IPC.identityDelete, (id: string) => {
    workspace.deleteIdentity(String(id));
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

  handle(IPC.bookmarkMove, (id: string, toIndex: number) => {
    workspace.moveBookmark(String(id), Number(toIndex));
    broadcastWorkspace();
    return workspace.snapshot();
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

  handle(IPC.credentialsSet, (owner: PasswordOwner, password: string) => {
    workspace.setPassword(passwordOwnerSchema.parse(owner), String(password));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsClear, (owner: PasswordOwner) => {
    workspace.clearPassword(passwordOwnerSchema.parse(owner));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsCopy, (owner: PasswordOwner) => {
    const password = workspace.copyPassword(passwordOwnerSchema.parse(owner));
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

  handle(IPC.credentialsSetMaster, (password: string) => {
    workspace.setMasterPassword(String(password));
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsRemoveMaster, () => {
    workspace.removeMasterPassword();
    broadcastWorkspace();
    return workspace.snapshot();
  });

  handle(IPC.credentialsChangeMaster, (current: string, next: string) => {
    const changed = workspace.changeMasterPassword(String(current), String(next));
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
    const parsed = settingsPatchSchema.parse(patch);
    // Apply to the cache first: saveSettings emits synchronously, and the overlay
    // visibility decision inside that broadcast must already see the new value.
    if (settingsCache) settingsCache = { ...settingsCache, ...parsed };
    const settings = workspace.saveSettings(parsed);
    settingsCache = settings;
    if (parsed.theme) applyTheme(parsed.theme);
    if (parsed.locale) setCoreLocale(parsed.locale);
    // The zoom setting reaches open pages only through this call: untouched
    // pages follow it, pages the user zoomed by hand keep their factor.
    if (parsed.browserZoom !== undefined) embedded?.setDefaultZoom(settings.browserZoom);
    broadcastWorkspace();
    return settings;
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
    const exported = workspace.exportWorkspace(options?.includeSecrets ? passphrase : undefined);
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
      const exported = workspace.exportAccounts({
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
      const tab = await browser.createTab({
        ...(input?.url ? { url: input.url } : {}),
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
      if (input?.identityId) scheduleEmbeddedFill(tab.id, input.identityId);
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
   * Opens a blank tab into a specific view.
   *
   * The sidebar's "+" on a view header means "add a page here", not "add a page
   * to whatever is on stage", so it names the view explicitly. When every cell
   * is taken the page would otherwise be created off stage and the header's "+"
   * would look broken, so it swaps into the selected cell like the toolbar's "+".
   */
  handle(IPC.embeddedOpenInView, async (viewId: string) => {
    const browser = ensureEmbeddedBrowser();
    const tab = await browser.createTab({ viewId: String(viewId), origin: "manual" });
    browser.activate(tab.id);
    browser.focusPage();
    return browser.state();
  });

  /**
   * Opens a blank tab in one specific slot and focuses it.
   *
   * This is the empty slot's "add a page" button: the click says which cell the
   * page belongs in, so the tab is pinned there rather than wherever the view's
   * focus happened to be.
   */
  handle(IPC.embeddedOpenInSlot, async (viewId: string, slotIndex: number) => {
    const browser = ensureEmbeddedBrowser();
    const tab = await browser.createTab({ viewId: String(viewId), origin: "manual" });
    const pinned = browser.pinTab(String(viewId), Number(slotIndex), tab.id);
    browser.focusPage();
    return pinned;
  });

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
    const tab = await browser.createTab({
      ...(url ? { url } : {}),
      identityId: identity.id,
      siteId: identity.siteId,
      label: identity.name,
      ...(identity.color ? { color: identity.color } : {}),
      origin: "manual",
    });
    browser.focusPage();
    scheduleEmbeddedFill(tab.id, identity.id);
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
  handle(IPC.embeddedViewLayout, (viewId: string, layoutId: LayoutId) =>
    ensureEmbeddedBrowser().setViewLayout(String(viewId), String(layoutId)),
  );
  handle(IPC.embeddedViewSlots, (viewId: string, rects: SlotRect[]) =>
    ensureEmbeddedBrowser().setViewSlotRects(String(viewId), rects),
  );
  handle(IPC.embeddedViewPin, (viewId: string, slotIndex: number, tabId: string | null) =>
    ensureEmbeddedBrowser().pinTab(String(viewId), Number(slotIndex), tabId ? String(tabId) : null),
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
  handle(IPC.embeddedDevTools, (tabId: string, mode?: "docked" | "window") => {
    const browser = ensureEmbeddedBrowser();
    const tab = browser.findTab(String(tabId));
    const next = mode === "window" ? "window" : "docked";
    // Reopening an already-open panel means "move it", not "open it twice": the
    // toolbar calls this for both, and the only difference is the host.
    if (tab?.devtools) browser.setDevToolsMode(String(tabId), next);
    else browser.openDevTools(String(tabId), next);
  });
  handle(IPC.embeddedDevToolsClose, (tabId: string) => {
    ensureEmbeddedBrowser().closeDevTools(String(tabId));
  });
  handle(IPC.embeddedZoom, (tabId: string, direction: "in" | "out" | "reset") =>
    ensureEmbeddedBrowser().zoomBy(
      String(tabId),
      direction === "out" ? "out" : direction === "reset" ? "reset" : "in",
    ),
  );
  handle(
    IPC.embeddedFind,
    (tabId: string, text: string, options?: { forward?: boolean; findNext?: boolean }) =>
      ensureEmbeddedBrowser().findInTab(String(tabId), String(text ?? ""), options ?? {}),
  );
  handle(IPC.embeddedStopFind, (tabId: string) => {
    ensureEmbeddedBrowser().stopFind(String(tabId));
  });
  handle(IPC.embeddedFreeze, () => ensureEmbeddedBrowser().freeze());

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

// A second instance would own its own browsers and MCP port, and both would write
// workspace.json. The first instance wins and simply reveals its window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    mkdirSync(profileRoot(), { recursive: true });
    // Windows groups taskbar entries by AppUserModelID and takes the icon from
    // the packaged executable. In development the process is electron.exe, so
    // without this the taskbar shows Electron's logo for our window.
    if (process.platform === "win32") app.setAppUserModelId("io.github.onefanki.ensemble");

    service = new WorkspaceService({
      userDataDir: userDataDir(),
      profileRoot: profileRoot(),
      platform: process.platform as "win32" | "darwin" | "linux",
      secretBox: new SafeStorageBox(),
      appVersion: app.getVersion(),
      workArea: workAreaRect,
      onChange: broadcastWorkspace,
      onAutoFill: (report) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.authAutoFilled, report);
        }
      },
    });

    settingsCache = service.settingsSnapshot();
    setCoreLocale(settingsCache.locale);
    applyTheme(settingsCache.theme);

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
      // The log is the record; this is the live signal the dock shows. Counted
      // per origin so "the AI is working in that site right now" is visible
      // while it happens, not only afterwards.
      onPageAction: (event) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        aiActions.set(event.origin, (aiActions.get(event.origin) ?? 0) + 1);
        mainWindow.webContents.send(IPC.aiPageAction, {
          origin: event.origin,
          tabId: event.tabId,
          tool: event.tool,
          ok: event.ok,
          originAuthorized: event.originAuthorized,
          count: aiActions.get(event.origin) ?? 0,
        });
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
          if (input.identityId) scheduleEmbeddedFill(created.id, input.identityId);
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
        wait: (tabId, input) => ensureEmbeddedBrowser().wait(tabId, input),
        setLayout: (layoutId, viewId) =>
          ensureEmbeddedBrowser().setViewLayout(
            viewId ?? ensureEmbeddedBrowser().defaultViewId() ?? "",
            layoutId,
          ),
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
      },
      /*
       * Account bundles for AI clients. No save/open dialog: an AI has nobody to
       * answer one, so bundles are read and written under a fixed directory and
       * the path travels in the tool call.
       */
      exportAccounts: (input) => {
        if (!service) throw new Error("工作区未就绪");
        const exported = service.exportAccounts(input);
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
      onChange: broadcastMcp,
    });

    registerIpc(service);
    await createWindow();
    await mcpServer.start();

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
