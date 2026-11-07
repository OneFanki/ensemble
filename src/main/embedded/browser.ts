import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDomSnapshotExpression,
  buildClickHitExpression,
  buildElementPointExpression,
  buildFocusExpression,
  buildReadExpression,
  buildSelectExpression,
  buildVisibilityExpression,
  buildWaitExpression,
  type DomSnapshot,
  describeTarget,
  type TargetInput,
  type VisibilityProbe,
  type WaitCondition,
  type WaitResult,
} from "@core/cdp/inspect";
import {
  bodyMarksSignedOut,
  buildAuthCheckExpression,
  buildFillExpression,
  type AuthTokenSource,
} from "@core/cdp/login";
import type { MissingCredentialReason } from "@core/credentials/vault";
import { t } from "@core/i18n/translate";
import { type AiPageContext, aiOriginOf } from "@shared/ai-policy";
import {
  clampZoom,
  desktopUserAgent,
  EMBEDDED_DEVTOOLS_DEFAULT,
  EMBEDDED_DEVTOOLS_GRIP,
  EMBEDDED_DEVTOOLS_HEAD,
  EMBEDDED_DEVTOOLS_MAX,
  EMBEDDED_DEVTOOLS_MIN,
  EMBEDDED_SLOT_HEADER,
  type EmbeddedState,
  type EmbeddedTab,
  type EmbeddedView,
  embeddedPartition,
  embeddedSlotRects,
  embeddedTabPartition,
  embeddedViewRect,
  inlineFavicon,
  insetSlotRects,
  isBlankTab,
  isEmbeddedLayout,
  stageDrawsSlotHeaders,
  neighborZoomStep,
  normalizeEmbeddedUrl,
  planTabClick,
  resolveSlotPages,
  resolveSlotTabs,
  settleSplitPages,
  type EmbeddedViewport,
  type StageRect,
  viewIsOnScreen,
  viewportFitRect,
  ZOOM_STEPS,
} from "@shared/embedded";
import {
  type FlowRunResult,
  type FlowStep,
  type FlowStepResult,
  interpolateStep,
} from "@shared/flows";
import type { AppSettings, LayoutId, RoleColor, SlotRect } from "@shared/types";
import {
  BrowserWindow,
  Menu,
  screen,
  session,
  shell,
  WebContentsView,
  type Event as ElectronEvent,
  type InputEvent,
  type Session,
  type WebContents,
} from "electron";
import { EmbeddedCdp, type CdpExecutor } from "./cdp";
import { GuestPageSurface, type PageSurface } from "./surface";
import { GuestCdp, type GuestCdpTarget } from "./guest-cdp";
import { LOGIN_CAPTURE_BINDING, LOGIN_CAPTURE_SCRIPT } from "./login-capture";
import { applyProxyToSession } from "../proxy";

/**
 * How long CDP traffic keeps a parked page exempt from the freeze sweep.
 *
 * Generous on purpose: a polling wait or a slow flow re-marks the page on every
 * command, so the window only ever lapses on real idleness — an AI session that
 * stopped talking, a page parked while the user reads the accounts page.
 */
const AI_ACTIVE_WINDOW_MS = 60_000;
const FREEZE_SWEEP_INTERVAL_MS = 10_000;

export interface EmbeddedLoginPayload {
  username: string;
  password: string;
  submit: boolean;
  extraFields: { label: string; value: string }[];
  /** Site origin the credentials belong to. */
  baseUrl: string;
}

/**
 * What the credential resolver found.
 *
 * `missing` is passed straight through to the toast that explains why nothing
 * was typed, so the user is told "this site has no default password" instead of
 * "this account has no password" when the account is merely inheriting one.
 */
export type ResolveLoginResult =
  | { ok: true; payload: EmbeddedLoginPayload }
  | { ok: false; missing: MissingCredentialReason | "no-identity" | "no-site-record" };

interface TabRecord {
  id: string;
  identityId?: string;
  siteId?: string;
  label: string;
  color?: RoleColor;
  viewId?: string;
  origin: "view" | "manual" | "ai";
  /**
   * Zoom this page was set to by hand, in percent.
   *
   * Absent means "follow the global default", which is what lets the setting
   * apply to every page the user has not touched while leaving a deliberately
   * zoomed page alone. It is in-memory on purpose: a tab does not survive a
   * restart, and persisting per-page zoom would resurrect settings for pages
   * that no longer exist.
   */
  zoomOverride?: number;
  /**
   * The page's own viewport choice.
   *
   * Absent means "inherit the workspace default" — the common case, and what
   * makes one global size reach every page. `null` is an explicit "adaptive,
   * even when a default exists"; an object pins this page alone. The page's
   * effective size is {@link viewportOf}, never this field directly.
   */
  viewportOverride?: EmbeddedViewport | null;
  /** Zoom factor the current viewport fit resolved to; drives `applyZoom`. */
  viewportScale?: number;
  /**
   * The browser instance (window) this page belongs to.
   *
   * A view slot is one isolated browser instance, not one page: a page can open
   * more pages with `window.open`, and those pages belong to the same instance
   * rather than becoming new slot candidates. The root page's id doubles as the
   * instance id.
   */
  instanceId: string;
  /** Page that opened this one, for ordering and for closing the opener's group. */
  openerId?: string;
  /**
   * Where this page is displayed.
   *
   * An interface rather than a concrete `WebContentsView`: the page may be
   * hosted by main (today) or by the renderer as a `<webview>` (migration in
   * progress). Everything the manager asks of a page — navigate, drive over
   * CDP, occupy a rectangle — is the same either way.
   */
  view: PageSurface;
  /**
   * Command surface for this page.
   *
   * An interface, not `EmbeddedCdp`: a page hosted as a `<webview>` is driven
   * through the guest manager (which owns idle release and the teardown
   * handshake), and every caller must go through that route or the handshake
   * loses track of in-flight commands.
   */
  cdp: CdpExecutor;
  url: string;
  title: string;
  /** Inlined site icon; cleared when the page moves to another origin. */
  favicon?: string;
  loading: boolean;
  /** `Runtime.addBinding` only needs to run once per target, not per navigation. */
  captureBinding?: boolean;
  crashed: boolean;
  /**
   * The DevTools panel this app hosts for the page, when one exists.
   *
   * A guest cannot hand its tools to a `<webview>` — `setDevToolsWebContents`
   * needs a `WebContents` the embedder owns outright, and a guest is sandboxed
   * by its embedder, so a webview host never receives the `DevToolsHost` binding
   * and renders the front-end with no connection to anything. The panel
   * therefore stays a native `WebContentsView` laid out by this manager *beside*
   * the page's cell: the page keeps the left part, the tools take the right, and
   * the renderer draws the drag handle in the gap between the two.
   */
  devtools?: DevToolsRecord;
  /** Monotonic per page, so an in-flight setup step can detect a newer panel. */
  devtoolsGeneration?: number;
}

interface DevToolsRecord {
  view: WebContentsView;
  /** Fraction of the cell the panel takes; the page gets the rest. */
  width: number;
  /** Value of `TabRecord.devtoolsGeneration` when this panel was created. */
  generation: number;
}

interface ViewRecord extends EmbeddedView {
  /** Tabs this container was opened from; absent for hand-made views. */
  viewDefinitionId?: string;
}

/** Where a page's renderer comes from. */
export interface GuestHost {
  /**
   * Creates the node for a page and resolves once it can be driven.
   *
   * The renderer owns the DOM, so main has to ask; the reply arrives after the
   * node reports `dom-ready` with its guest id. Resolving late is normal — this
   * is one round trip through IPC — but it can also fail, which is why callers
   * get a rejection rather than a page that silently cannot be driven.
   */
  mount(input: {
    tabId: string;
    partition: string;
    url: string;
  }): Promise<{ contents: WebContents }>;
  /**
   * Closes the page's CDP session.
   *
   * Resolves once it is safe to remove the node: detaching after the guest is
   * destroyed takes the native target out from under an in-flight command.
   */
  release(tabId: string): Promise<void>;
  /** Tells the renderer the node may be removed. Sent after `release`. */
  unmount(tabId: string): void;
  /**
   * Asks the renderer to show a page for a moment, or to put it back.
   *
   * A guest only produces frames while it is actually painting, so a screenshot
   * of a background tab has to present it first. Resolves once the renderer
   * reports the change applied — not when a frame has landed; the caller still
   * retries its capture.
   */
  present(tabId: string, visible: boolean): Promise<void>;
  /**
   * Keeps a page's CDP session attached while it can emit unprompted events.
   *
   * Idle release is right for request/response traffic, but an event the page
   * pushes while nothing is attached reaches nobody and is not replayed later.
   * Login capture is the one such stream, so the session is held only while a
   * page actually has a credential form to submit.
   */
  holdSession?(tabId: string, hold: boolean): void;
  /**
   * Makes the embedding window produce a frame before a guest is captured.
   *
   * A guest's compositor stays silent until its embedder has painted, and a
   * silent guest answers `Page.captureScreenshot` by never replying. The window
   * cannot be assumed to have painted: a headless run parks it off every
   * display, and a minimised one is equally frame-less.
   */
  primeForCapture?(): Promise<boolean>;
  /** The command target for a page's guest, resolved per command. */
  targetFor(tabId: string): GuestCdpTarget;
}

export interface EmbeddedBrowserOptions {
  /** Where screenshots are written; created on demand. */
  shotDir: string;
  /** Icon for app-owned windows (the DevTools window), so none shows Electron's. */
  appIcon?: string;
  /**
   * Credentials for one identity, or the specific reason they are unavailable.
   *
   * The reason is part of the contract rather than "undefined means missing":
   * an account that inherits a site default and a site that never got one used
   * to produce the same "no password" toast, which points at the wrong dialog
   * half the time. Whatever this reports is shown to the user verbatim.
   */
  resolveLogin?: (identityId: string) => Promise<ResolveLoginResult>;
  onStateChange?: (state: EmbeddedState) => void;
  /** Asks the renderer to switch to the browser page. */
  onShowPage?: () => void;
  /**
   * Never raise the host window.
   *
   * Set by automated runs, which drive a real app on a machine somebody is
   * working on. Raising the window is a user-facing courtesy — "you asked for
   * this page, here it is" — and a test asking for a page is not a user.
   */
  headless?: boolean;
  /**
   * Put parked pages to sleep once they have been idle for a while.
   *
   * A page parked off the window is still "visible" to Chromium, so the stock
   * background throttling never fires while the app window itself is on screen,
   * and neither CPU throttling nor `setVisible(false)` stops a rAF-driven
   * scene (both measured). What does is CDP `Page.setWebLifecycleState:
   * "frozen"` — it suspends the page's JavaScript entirely (an evaluate against
   * a frozen page never returns), which stops the scene's timers and render
   * loop with it. The sweep freezes parked pages after `AI_ACTIVE_WINDOW_MS`
   * without CDP traffic; the first CDP command of an AI burst wakes the page
   * before the command runs (the hook in `EmbeddedCdp.send` awaits the wake),
   * and re-staging or navigation wakes it too. Headless runs keep this off:
   * their timing assertions assume pages run unthrottled.
   */
  aiIdleFreeze?: boolean;
  /**
   * Hosts pages as `<webview>` nodes owned by the renderer.
   *
   * Required, not optional: the guest is the only carrier. Keeping a second one
   * around meant every layout path carried a branch for moving native views that
   * no longer existed, and those branches were what silently parked pages over
   * the chrome whenever a new overlay forgot to announce itself.
   */
  guests: GuestHost;
  /** Persists a runtime layout change back to the view definition. */
  onViewLayoutChange?: (viewDefinitionId: string, layoutId: LayoutId) => void;
  onFocusTab?: (tabId: string) => void;
  /**
   * A login form was submitted inside an embedded page.
   *
   * The password travels from page to main through a CDP binding, never through
   * the app's renderer; the callback is where it is turned into a vault entry.
   */
  onLoginCaptured?: (capture: {
    tabId: string;
    username: string;
    password: string;
    origin: string;
    path: string;
  }) => void;
  /**
   * Proxy settings for the partitions this browser creates.
   *
   * Each identity and each clean session has its own partition, and Chromium
   * keeps proxy rules per partition — so the same settings have to be pushed to
   * every one of them, and again whenever they change. A page loaded before the
   * change keeps the proxy it started with; a reload picks up the new one, which
   * is how a normal browser behaves.
   */
  proxy?: () => Pick<AppSettings, "proxyMode" | "proxyUrl" | "proxyBypass">;
  /**
   * A session partition was just configured.
   *
   * Downloads live on the session, not the page, so the download manager has to
   * hook every partition this surface creates — identity partitions and clean
   * sessions alike.
   */
  onSessionReady?: (ses: Session) => void;
}

/** Scheme + host of a URL, or "" for anything that does not parse. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Whether two URLs address the same document.
 *
 * Used only to recognise that a navigation arrived: absolute vs relative form
 * and a trailing slash are the same page, while a genuinely different path is
 * not. Query and hash are ignored — a login bounce keeps them different on
 * purpose, and treating that as "still navigating" would time out.
 */
function sameDocumentUrl(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    const trim = (path: string) => path.replace(/\/+$/, "") || "/";
    return a.origin === b.origin && trim(a.pathname) === trim(b.pathname);
  } catch {
    return actual === expected;
  }
}

/**
 * The in-app browser surface.
 *
 * Pages are `<webview>` guests owned by the window's renderer, so a whole cast
 * of accounts fits on one screen without opening a system window each. This class
 * decides where each page goes and drives it over CDP; the renderer draws both
 * the chrome (tab strip, per-slot header, sidebar) and the page nodes.
 *
 * Only one view is on stage at a time: a view is a shared screen region, and
 * every view keeps its own grid layout and focused slot while it is off screen.
 *
 * Session partitions are per identity and separate from the external browser's
 * profile directory on purpose — see `embeddedPartition`.
 */
export class EmbeddedBrowser {
  private host: BrowserWindow | null = null;

  /** The renderer-side page host. Always present; see `EmbeddedBrowserOptions`. */
  private get guests(): GuestHost {
    return this.options.guests;
  }
  private tabs: TabRecord[] = [];
  private views: ViewRecord[] = [];
  /** Active page per browser instance; the page a slot shows. */
  private instanceActive = new Map<string, string>();
  /**
   * Instances opened as a deliberate clean session.
   *
   * Kept out of `TabRecord` because it is a property of the instance (the shared
   * session), not of a page: every page this instance opens has to stay in the
   * same throwaway partition, or a popup mid-flow would silently switch to the
   * daily profile.
   */
  private cleanInstances = new Set<string>();
  private activeTabId: string | undefined;
  private activeViewId: string | undefined;
  private stage: StageRect | null = null;
  /** Last stage size, kept so off-screen pages keep a realistic viewport. */
  private lastStage: StageRect | null = null;
  /**
   * Last window content size that was actually readable.
   *
   * The window can be briefly unmeasurable (hidden to the tray), and keeping the
   * last real value beats any fallback: the size decides whether a page counts
   * as visible, which decides which screenshot path is taken.
   */
  private lastContentSize: { width: number; height: number } | null = null;
  private pendingState = false;
  /**
   * Broadcasts held back while a multi-page operation is in flight.
   *
   * A view launch creates several pages one after another, and each page
   * published its own state: first the new (still empty) view on stage, then one
   * broadcast per page as it arrived. Every intermediate state is legitimate on
   * its own, but the renderer draws each one, so the stage went blank for ~120ms
   * and then filled in cell by cell — what a user sees as the page flickering.
   *
   * Counted rather than boolean: launches can overlap with an AI tool opening a
   * page of its own, and whoever finishes last has to be the one that flushes.
   */
  private stateHold = 0;
  private stateHeld = false;
  private viewSeq = 0;
  /**
   * Rebuilds in flight, one per page at most.
   *
   * The ticket lets a close cancel a rebuild that is already waiting for the
   * old front-end to die: without it, closing the panel during that wait let the
   * rebuild bring it back a moment later.
   */
  private devtoolsRebuilds = new Map<string, { cancelled: boolean }>();
  /** Default zoom for pages that have not been adjusted by hand. */
  private defaultZoom = 100;
  /**
   * Workspace default fixed viewport, mirrored from settings.
   *
   * `undefined` means adaptive. Kept here rather than read from settings on
   * demand because `applyLayout` runs on every geometry change and must not
   * touch the workspace store.
   */
  private defaultViewport: EmbeddedViewport | undefined;
  /**
   * Downloaded icons, keyed by source URL.
   *
   * Many pages of one site share an icon and a site re-reports it on every
   * navigation, so fetching per event would hit the network far more than
   * needed. Bounded because the entries hold base64 payloads.
   */
  private faviconCache = new Map<string, { data: string; fetched: number }>();
  /**
   * Per-page AI activity bookkeeping for the parked-page sleep.
   *
   * `aiActiveUntil` records how long CDP traffic keeps a page exempt from the
   * sweep; `frozenTabs` tracks pages currently frozen (JavaScript suspended);
   * `stagedTabs` mirrors "which pages are on stage right now" (recomputed by
   * `applyLayout`, the one placement authority) so the sweep never freezes a
   * page the user is looking at. All three are runtime-only: a restart starts
   * from scratch.
   */
  private aiActiveUntil = new Map<string, number>();
  private frozenTabs = new Set<string>();
  private stagedTabs = new Set<string>();
  private freezeSweep: NodeJS.Timeout | undefined;
  /** The live split drag, if one is in progress. */
  private devtoolsResize:
    | {
        timer: NodeJS.Timeout;
        listeners: Array<{
          contents: WebContents;
          handler: (event: ElectronEvent, input: InputEvent) => void;
        }>;
      }
    | undefined;

  constructor(private readonly options: EmbeddedBrowserOptions) {
    // The sweep must exist from construction, not from the first CDP command:
    // it used to be armed lazily inside `markCdpActivity`, so a session with no
    // AI traffic — the common one — never froze anything at all.
    if (options.aiIdleFreeze) {
      this.freezeSweep = setInterval(() => this.sweepFrozenCandidates(), FREEZE_SWEEP_INTERVAL_MS);
      this.freezeSweep.unref?.();
    }
  }

  /**
   * Applies the global zoom setting.
   *
   * Pages with no override follow it, so changing the setting is visible on
   * every untouched page immediately. A page the user zoomed by hand keeps its
   * factor: silently resetting it would undo exactly what the keystroke was for.
   */
  setDefaultZoom(percent: number): void {
    const next = clampZoom(percent);
    if (next === this.defaultZoom) return;
    this.defaultZoom = next;
    for (const tab of this.tabs) {
      if (tab.zoomOverride !== undefined) continue;
      this.applyZoom(tab, next);
    }
    this.emitState();
  }

  /**
   * Sets the workspace default fixed viewport.
   *
   * Pages that made no viewport choice of their own follow it — that is the
   * whole point of having a default, and it is what makes "set it once, look at
   * four accounts at 390×844" one action instead of four. Pages that pinned
   * their own size (`viewportOverride` is an object) or explicitly opted out
   * (`null`) are left alone.
   *
   * Clearing it has to hand the zoom factor back. While a viewport is active the
   * fit scale *owns* `webContents` zoom, so a page that stops having a fixed size
   * keeps rendering at that scale unless it is reset here — and the chrome, which
   * reads `zoomOverride ?? defaultZoom`, would truthfully report 100% while the
   * page was still shrunk. Reported as "the zoom says 100% but it is not".
   */
  setDefaultViewport(size: EmbeddedViewport | undefined): void {
    if (
      this.defaultViewport?.width === size?.width &&
      this.defaultViewport?.height === size?.height
    ) {
      return;
    }
    this.defaultViewport = size;
    for (const tab of this.tabs) {
      // A page that made its own choice does not follow the default either way.
      // "Its own choice" means a size or a deliberate opt-out — both leave the
      // page at a zoom someone else decided. What must not survive either way is
      // the fit scale: it is a property of having *been* fitted, and once no
      // viewport applies it silently keeps the page shrunk at the old factor.
      if (tab.viewportOverride !== undefined) {
        if (!this.viewportOf(tab)) {
          delete tab.viewportScale;
          this.applyZoom(tab, tab.zoomOverride ?? this.defaultZoom);
        }
        continue;
      }
      if (this.viewportOf(tab)) continue;
      delete tab.viewportScale;
      this.applyZoom(tab, tab.zoomOverride ?? this.defaultZoom);
    }
    this.applyLayout();
    this.emitState();
  }

  /**
   * The size a page actually renders at.
   *
   * One resolution order for the whole surface: an explicit page choice wins,
   * otherwise the workspace default applies, otherwise the page fills its cell.
   * Every reader (`describe`, `placePageSurface`, `applyZoom`, `zoomBy`) goes
   * through this so the chrome and the native geometry can never disagree.
   */
  private viewportOf(tab: TabRecord): EmbeddedViewport | undefined {
    if (tab.viewportOverride !== undefined) return tab.viewportOverride ?? undefined;
    return this.defaultViewport;
  }

  /** Binds the surface to the main window; safe to call again on recreation. */
  attach(win: BrowserWindow): void {
    if (this.host === win) return;
    this.host = win;
    this.stage = null;
    // A destroyed window takes its child views with it; drop the records rather
    // than keeping handles to closed renderers.
    win.once("closed", () => {
      if (this.host !== win) return;
      this.host = null;
      this.stage = null;
      this.closeAllTabs();
      this.emitState();
    });
    // Parked pages sit just past the content edge, so shrinking the window would
    // pull them back inside and paint them over whatever page is showing. A full
    // re-layout re-parks them and then puts the page on stage back with the last
    // known stage rect; the renderer's resize observer corrects that rect a
    // moment later. Doing only the parking would leave the stage blank during
    // the drag.
    win.on("resize", () => {
      if (this.host !== win) return;
      this.applyLayout();
    });
    this.sendState();
  }

  isOpen(): boolean {
    return Boolean(this.host && !this.host.isDestroyed());
  }

  state(): EmbeddedState {
    return {
      tabs: this.tabs.map((tab) => this.describe(tab)),
      views: this.views.map((view) => this.describeView(view)),
      ...(this.activeTabId ? { activeTabId: this.activeTabId } : {}),
      ...(this.activeViewId ? { activeViewId: this.activeViewId } : {}),
      carrier: "guest",
    };
  }

  private describe(tab: TabRecord): EmbeddedTab {
    const contents = tab.view?.webContents;
    const effectiveViewport = this.viewportOf(tab);
    const pending = !contents || contents.isDestroyed();
    return {
      id: tab.id,
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      ...(tab.siteId ? { siteId: tab.siteId } : {}),
      label: tab.label,
      ...(tab.color ? { color: tab.color } : {}),
      url: tab.url,
      title: tab.title,
      ...(tab.favicon ? { favicon: tab.favicon } : {}),
      loading: tab.loading,
      canGoBack: this.safeNav(tab, "canGoBack"),
      canGoForward: this.safeNav(tab, "canGoForward"),
      ...(tab.viewId ? { viewId: tab.viewId } : {}),
      origin: tab.origin,
      instanceId: tab.instanceId,
      ...(tab.openerId ? { openerId: tab.openerId } : {}),
      ...(this.cleanInstances.has(tab.instanceId) ? { clean: true } : {}),
      partition: this.partitionOf(tab),
      active: this.instanceActive.get(tab.instanceId) === tab.id,
      // In viewport mode the fit scale *is* the effective zoom; reporting the
      // untouched override here would make the chrome claim 100% while the
      // page actually renders at the fit factor. `viewport` is the *effective*
      // size so the menu can mark the active row; `viewportOverride` is what
      // the page itself chose, which the menu needs to show "inherit".
      zoom: effectiveViewport
        ? Math.round((tab.viewportScale ?? 1) * 100)
        : (tab.zoomOverride ?? this.defaultZoom),
      ...(effectiveViewport ? { viewport: effectiveViewport } : {}),
      ...(tab.viewportOverride === undefined
        ? {}
        : { viewportOverride: tab.viewportOverride ?? null }),
      devtoolsOpen: this.devtoolsOpen(tab),
      ...(tab.devtools ? { devtoolsWidth: tab.devtools.width } : {}),
      // No bounds while the carrier is still being created: the renderer uses
      // the absence to mean "not laid out yet" and keeps the node hidden until
      // a real rect arrives, instead of placing it at 0×0.
      ...(pending
        ? {}
        : {
            bounds: (() => {
              const rect = tab.view.getBounds();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            })(),
          }),
    };
  }

  /**
   * Whether this page has a panel open.
   *
   * Answered from our own record, not from `isDevToolsOpened()`: once the tools
   * are handed a `WebContents` of ours through `setDevToolsWebContents`, Electron
   * no longer reports them as "this page's DevTools" and the getter stays false
   * for a panel that is running and visible. Measured on Electron 45.
   *
   * Reported as open only while the panel is actually docked. A panel whose page
   * left the stage is parked at 0×0 — it still exists, so `tab.devtools` is the
   * wrong answer: the renderer draws the drag seam from this flag, and a seam
   * over a page with no panel beside it is a handle that moves nothing. A blank
   * page never docks one at all (`cellOf` refuses: the app draws that surface,
   * not the guest), so it reports closed however many times it was clicked.
   */
  private devtoolsOpen(tab: TabRecord): boolean {
    return Boolean(tab.devtools) && this.cellOf(tab) !== undefined;
  }

  private describeView(view: ViewRecord): EmbeddedView {
    return {
      id: view.id,
      name: view.name,
      ...(view.color ? { color: view.color } : {}),
      ...(view.viewDefinitionId ? { viewDefinitionId: view.viewDefinitionId } : {}),
      layoutId: view.layoutId,
      ...(view.slotRects?.length ? { slotRects: view.slotRects.map((rect) => ({ ...rect })) } : {}),
      slotTabs: [...view.slotTabs],
      ...(view.slotPages?.some(Boolean) ? { slotPages: [...view.slotPages] } : {}),
      ...(view.launching ? { launching: { ...view.launching } } : {}),
      collapsed: view.collapsed,
      ...(view.focusedTabId ? { focusedTabId: view.focusedTabId } : {}),
    };
  }

  private safeNav(tab: TabRecord, direction: "canGoBack" | "canGoForward"): boolean {
    try {
      const history = tab.view.webContents.navigationHistory;
      return direction === "canGoBack" ? history.canGoBack() : history.canGoForward();
    } catch {
      return false;
    }
  }

  /** Raises the main window and asks its renderer to show the browser page. */
  focusPage(): void {
    const host = this.host;
    // Still tell the renderer which page to show — the window just does not come
    // forward, so an automated run leaves the desktop alone.
    if (this.options.headless) {
      this.options.onShowPage?.();
      return;
    }
    if (!host || host.isDestroyed()) return;
    if (host.isMinimized()) host.restore();
    host.show();
    host.focus();
    this.options.onShowPage?.();
  }

  /** The renderer reports where the views may paint. */
  setStage(stage: StageRect | null): void {
    this.stage = stage;
    if (stage) this.lastStage = stage;
    this.applyLayout();
    /*
     * The renderer draws a guest from `bounds`, so a layout change only reaches
     * the screen through a state broadcast. Without this the nodes kept the
     * rect they were given before the run dock opened and covered it: the dock
     * looked dead to the pointer, and dragging its resize handle started on the
     * handle and then entered a page's box.
     */
    this.sendState();
  }

  // ---------- views ----------

  private findView(viewId: string): ViewRecord | undefined {
    return this.views.find((view) => view.id === viewId);
  }

  private requireView(viewId: string): ViewRecord {
    const view = this.findView(viewId);
    if (!view) throw new Error(`视图不存在：${viewId}`);
    return view;
  }

  private activeView(): ViewRecord | undefined {
    return this.activeViewId ? this.findView(this.activeViewId) : undefined;
  }

  private viewTabs(viewId: string): TabRecord[] {
    return this.tabs.filter((tab) => tab.viewId === viewId);
  }

  /** Pages of one browser instance, in creation order. */
  private instanceTabs(instanceId: string): TabRecord[] {
    return this.tabs.filter((tab) => tab.instanceId === instanceId);
  }

  /** The page id that doubles as the instance id. */
  private instanceRoot(instanceId: string): TabRecord | undefined {
    return this.tabs.find((tab) => tab.id === instanceId) ?? this.instanceTabs(instanceId)[0];
  }

  /** Page the instance is currently showing; falls back to its first page. */
  private activePageOf(instanceId: string): TabRecord | undefined {
    const activeId = this.instanceActive.get(instanceId);
    return (
      (activeId ? this.tabs.find((tab) => tab.id === activeId) : undefined) ??
      this.instanceRoot(instanceId)
    );
  }

  /**
   * Page a slot actually shows.
   *
   * `slotTabs` names the instance; `slotPages` pins which of its pages that cell
   * displays. A pin is what makes side-by-side comparison of one account work:
   * the same instance in two cells, each showing a different page. Without a pin
   * the cell follows the instance's active page, which is right for the ordinary
   * one-cell-per-instance case.
   *
   * The pin is validated against the instance in that slot, so a closed page or
   * a reshuffled instance cannot leave a cell pointing at a stranger.
   */
  private pageForSlot(view: ViewRecord, index: number): TabRecord | undefined {
    const rootId = view.slotTabs[index];
    if (!rootId) return undefined;
    const root = this.findTab(rootId);
    const instanceId = root?.instanceId ?? rootId;
    const pinnedId = view.slotPages?.[index];
    if (pinnedId) {
      const pinned = this.findTab(pinnedId);
      if (pinned && pinned.instanceId === instanceId) return pinned;
    }
    return this.activePageOf(instanceId);
  }

  /** One representative (the root) per instance inside a view. */
  private viewRoots(viewId: string): TabRecord[] {
    const seen = new Set<string>();
    const roots: TabRecord[] = [];
    for (const tab of this.tabs) {
      if (tab.viewId !== viewId || seen.has(tab.instanceId)) continue;
      seen.add(tab.instanceId);
      const root = this.instanceRoot(tab.instanceId);
      if (root) roots.push(root);
    }
    return roots;
  }

  /**
   * Switches which page an instance shows.
   *
   * Slot membership is by instance, so this changes pixels without touching the
   * layout: a page opened by `window.open` takes over its opener's slot.
   */
  private setActivePage(tab: TabRecord): void {
    this.instanceActive.set(tab.instanceId, tab.id);
  }

  /**
   * Marks a visible page as the selected one, without changing the layout.
   *
   * Used when the click happened inside the native page itself: the slot is
   * already correct, only the selection label and the typing target move.
   */
  private selectPage(tab: TabRecord): void {
    this.setActivePage(tab);
    this.activeTabId = tab.id;
    const root = this.instanceRoot(tab.instanceId);
    if (root?.viewId) {
      const view = this.findView(root.viewId);
      if (view) {
        view.focusedTabId = root.id;
        this.activeViewId = view.id;
      }
    }
    this.emitState();
  }

  private requireTab(tabId: string): TabRecord {
    const tab = this.findTab(tabId);
    if (!tab) throw new Error(`标签页不存在：${tabId}`);
    if (tab.view.webContents.isDestroyed()) throw new Error("页面已关闭");
    return tab;
  }

  /**
   * Opens (or reuses) the container for a saved view definition.
   *
   * Reopening merges into the existing container so logins survive; the caller
   * adds the members that are missing and then calls `activateView`.
   */
  ensureView(input: {
    viewDefinitionId: string;
    name: string;
    layoutId: LayoutId;
    color?: RoleColor;
  }): string {
    const existing = this.views.find((view) => view.viewDefinitionId === input.viewDefinitionId);
    if (existing) {
      existing.name = input.name;
      if (input.color) existing.color = input.color;
      if (isEmbeddedLayout(input.layoutId) && existing.slotTabs.length === 0) {
        existing.layoutId = input.layoutId;
      }
      return existing.id;
    }
    const view = this.addView({
      name: input.name,
      layoutId: input.layoutId,
      viewDefinitionId: input.viewDefinitionId,
      ...(input.color ? { color: input.color } : {}),
    });
    return view.id;
  }

  /**
   * Creates an empty view container and puts it on stage.
   *
   * Views are only ever created explicitly: dropping tabs together reorders them
   * instead. An empty container therefore has to survive, or a newly created one
   * would vanish before the user could drag anything into it.
   *
   * "No layout" is the default: a container is usually made to receive a handful
   * of pages one at a time, and a 2×1 default meant the first page arrived
   * squeezed into half the stage beside an empty cell the user never asked for.
   * The layout is then chosen by what actually gets dropped in, or by the picker
   * in the view's header.
   */
  createView(input: { name?: string; layoutId?: LayoutId; color?: RoleColor }): EmbeddedState {
    const view = this.addView({
      name: input.name ?? "",
      layoutId: input.layoutId ?? "free",
      ...(input.color ? { color: input.color } : {}),
    });
    this.activeViewId = view.id;
    delete this.activeTabId;
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  private addView(input: {
    name: string;
    layoutId: LayoutId;
    color?: RoleColor;
    viewDefinitionId?: string;
  }): ViewRecord {
    const slotCount = embeddedSlotRects(input.layoutId, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }).length;
    this.viewSeq += 1;
    const view: ViewRecord = {
      id: randomUUID(),
      name: input.name.trim() || `视图 ${this.viewSeq}`,
      ...(input.color ? { color: input.color } : {}),
      ...(input.viewDefinitionId ? { viewDefinitionId: input.viewDefinitionId } : {}),
      layoutId: input.layoutId,
      slotTabs: new Array<string | null>(slotCount).fill(null),
      collapsed: false,
    };
    this.views.push(view);
    return view;
  }

  /** Brings a view on stage; `null` returns to the flat loose-tab list. */
  activateView(viewId: string | null): EmbeddedState {
    if (!viewId) {
      this.activeViewId = undefined;
      const loose = this.tabs.filter((tab) => !tab.viewId);
      const remembered = loose.find((tab) => tab.id === this.activeTabId);
      this.activeTabId = (remembered ?? loose[0])?.id;
    } else {
      const view = this.requireView(viewId);
      this.activeViewId = view.id;
      // Prefer the remembered focus, then the first occupied slot, then any tab
      // the view still owns (a collapsed or emptied view keeps its members).
      const slotTab = view.slotTabs.find((id): id is string => Boolean(id));
      const root =
        (view.focusedTabId ? this.findTab(view.focusedTabId) : undefined) ||
        (slotTab ? this.findTab(slotTab) : undefined) ||
        this.viewRoots(view.id)[0];
      this.activeTabId = root ? (this.activePageOf(root.instanceId)?.id ?? root.id) : undefined;
      if (root) view.focusedTabId = root.id;
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  setViewLayout(viewId: string, layoutId: LayoutId): EmbeddedState {
    const view = this.requireView(viewId);
    // "1x1" and "free" mean the same thing here (one page fills the stage), so
    // the surface keeps only "free" as the canonical value.
    const next = layoutId === "1x1" ? "free" : layoutId;
    if (!isEmbeddedLayout(next)) return this.state();
    view.layoutId = next;
    // Picking a preset discards a hand-dragged geometry; the preset is the new
    // intent, and keeping the old fractions would make the choice look ignored.
    delete view.slotRects;
    // Normalized here as well as in `applyLayout`: this container may not be the
    // one on stage, so the generic pass would not touch it.
    this.normalizeSlots(view);
    this.applyLayout();
    if (view.viewDefinitionId) {
      this.options.onViewLayoutChange?.(view.viewDefinitionId, next);
    }
    this.emitState();
    return this.state();
  }

  /**
   * Applies slot geometry dragged by hand.
   *
   * `rects` are fractions of the stage (0–1). The container keeps them for this
   * run; the saved view definition still stores a preset, so reopening falls back
   * to the preset's even split.
   */
  setViewSlotRects(viewId: string, rects: SlotRect[]): EmbeddedState {
    const view = this.requireView(viewId);
    if (!rects.length) return this.state();
    view.slotRects = rects.map((rect) => ({
      x: Math.max(0, Math.min(1, rect.x)),
      y: Math.max(0, Math.min(1, rect.y)),
      width: Math.max(0.02, Math.min(1, rect.width)),
      height: Math.max(0.02, Math.min(1, rect.height)),
    }));
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /** Pins a tab into one slot of a view; `null` clears it. */
  pinTab(viewId: string, slotIndex: number, tabId: string | null): EmbeddedState {
    const view = this.requireView(viewId);
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    if (slotIndex < 0 || slotIndex >= slotCount) throw new Error("槽位不存在");
    const tab = tabId ? this.requireTab(tabId) : undefined;
    const root = tab ? (this.instanceRoot(tab.instanceId) ?? tab) : undefined;
    this.placeInstanceInSlot(view, slotIndex, root, tab);
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Puts one *page* into a slot, splitting an instance across two cells.
   *
   * This is the drag-a-tab-onto-a-cell gesture inside a single browser window:
   * two pages of the same account side by side. The instance is not duplicated —
   * both cells name the same instance, and `slotPages` says which page each one
   * shows. Cookies, storage and the session partition stay shared, which is the
   * entire point; a second instance would be a second login.
   *
   * The instance is pinned into the target slot even when it already occupies
   * another one: the same instance appearing twice is the feature here, and
   * `resolveSlotTabs` is told so explicitly for this call.
   */
  splitTabIntoSlot(viewId: string, slotIndex: number, pageId: string): EmbeddedState {
    const view = this.requireView(viewId);
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    if (slotIndex < 0 || slotIndex >= slotCount) throw new Error("槽位不存在");
    const page = this.requireTab(pageId);
    const root = this.instanceRoot(page.instanceId) ?? page;
    if (root.viewId && root.viewId !== view.id) {
      // A page from another view joins this one whole; there is no half-move.
      this.detachFromView(root);
    }
    for (const item of this.instanceTabs(root.instanceId)) item.viewId = view.id;

    const next = [...view.slotTabs];
    while (next.length < slotCount) next.push(null);
    // The slot assignment itself may already hold this instance in another cell;
    // that is allowed here and is what makes the split work.
    next[slotIndex] = root.id;
    const pages = this.normalizeSlotPages(view);
    /**
     * Freeze what the other cells are showing *before* the new page becomes the
     * instance's active one.
     *
     * Every cell without a pin follows the instance's active page. Dropping a
     * page here is about to make that page active, so each sibling cell would
     * silently switch to it — both halves would show the same thing, which is
     * exactly what the split was meant to avoid. Writing today's page into each
     * sibling's pin keeps the picture stable, and clicking a cell's own strip can
     * still change it, one cell at a time.
     *
     * The dropped page itself is excluded: it is about to own the target cell,
     * and freezing a sibling onto it would pin one page into two cells — one
     * surface cannot fill both, and the loser of the `setBounds` fight renders
     * as an empty cell.
     */
    for (let index = 0; index < next.length; index += 1) {
      if (index === slotIndex || pages[index]) continue;
      if (view.slotTabs[index] !== root.id) continue;
      const showing = this.pageForSlot(view, index);
      if (showing && showing.id !== page.id) pages[index] = showing.id;
    }
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      next,
      slotCount,
      { allowDuplicates: true },
    );
    pages[slotIndex] = page.id;

    /**
     * A pin is not the only way a sibling lands on the dropped page: a stale
     * pin from an earlier split, or plain following of the instance's active
     * page, points at it just as well. `settleSplitPages` re-pins those cells
     * to another page of the instance, or releases them when the instance has
     * only the one page — releasing means the cell goes back to the slot table
     * so another instance (or nobody) fills it.
     */
    const settled = settleSplitPages({
      slotTabs: view.slotTabs,
      slotPages: pages,
      slotIndex,
      rootId: root.id,
      pageId: page.id,
      instanceActiveId: this.activePageOf(root.instanceId)?.id,
      otherPages: this.instanceTabs(root.instanceId)
        .map((item) => item.id)
        .filter((id) => id !== page.id),
    });
    if (settled.released.length > 0) {
      view.slotTabs = resolveSlotTabs(
        this.viewRoots(view.id).map((item) => item.id),
        settled.slotTabs,
        slotCount,
        { allowDuplicates: true },
      );
    }
    view.slotPages = settled.slotPages;

    view.focusedTabId = root.id;
    this.activeTabId = page.id;
    this.activeViewId = view.id;
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Ends a split: every cell of that instance goes back to following it.
   *
   * "Un-split" has to clear all of the instance's pins, not just the clicked
   * cell's. One cell following the window while its sibling still pins a page is
   * the same confusion in a smaller dose — both cells would still be showing
   * different pages, just without a visible reason.
   *
   * The duplicate slot entry itself stays: the user may still want the same
   * instance visible in two cells after a merge (a console and a page, say), and
   * the merge control is about "this cell shows what the window shows", not about
   * destroying the second cell.
   */
  unsplitSlot(viewId: string, slotIndex: number): EmbeddedState {
    const view = this.requireView(viewId);
    const rootId = view.slotTabs[slotIndex];
    if (!rootId) return this.state();
    if (view.slotPages) {
      view.slotPages = view.slotPages.map((id, index) =>
        view.slotTabs[index] === rootId ? null : id,
      );
      this.dropOrphanPins(view);
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }
  private normalizeSlotPages(view: ViewRecord): (string | null)[] {
    return resolveSlotPages(view.slotTabs, view.slotPages, (tabId) =>
      this.findTab(tabId)?.instanceId,
    );
  }

  /**
   * Writes one instance into a view's slot table. Shared by the drag-and-drop
   * pin and the batch launcher; callers decide whether an out-of-range slot is
   * an error (the UI) or a silent skip (the batch).
   */
  private placeInstanceInSlot(
    view: ViewRecord,
    slotIndex: number,
    root: TabRecord | undefined,
    pinned?: TabRecord,
  ): void {
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    if (root && root.viewId !== view.id) {
      // Pinning is also how a loose instance joins a view.
      this.assignView(root, view.id);
    }
    const next = [...view.slotTabs];
    while (next.length < slotCount) next.push(null);
    if (root) {
      const duplicate = next.indexOf(root.id);
      if (duplicate >= 0) next[duplicate] = null;
    }
    next[slotIndex] = root ? root.id : null;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      next,
      slotCount,
    );
    if (root && view.focusedTabId !== root.id) {
      view.focusedTabId = root.id;
      this.activeTabId = pinned?.id ?? root.id;
    }
    this.activeViewId = view.id;
  }

  /**
   * Launches a batch of identities into one view, a few pages at a time.
   *
   * The batch belongs to the main process, not to a renderer for-loop: pages
   * are created `concurrency` at a time (each `createTab` waits out a full page
   * load, so serial creation made a four-member batch take four loads end to
   * end), and each page is pinned into the slot matching its order — against
   * the slot count read *at pin time*, so a layout switched to Free mid-run
   * just leaves the extras off stage instead of throwing "槽位不存在" and
   * killing the run. Any failure recycles every page this call created together
   * with the container: a batch is all-or-nothing (same rule as the external
   * launcher).
   *
   * The default concurrency covers a whole typical selection at once — a batch
   * the user picks by hand is small, and queuing a fourth account behind three
   * finished ones read as "the launch stalled". The cap is memory, not policy:
   * every page is a full renderer process on its own profile partition.
   */
  async launchIdentityBatch(
    inputs: Array<{
      identityId?: string;
      siteId?: string;
      label?: string;
      color?: RoleColor;
      url?: string;
    }>,
    viewId: string,
    onCreated?: (tab: EmbeddedTab, index: number) => void,
    concurrency = 8,
  ): Promise<EmbeddedState> {
    const view = this.requireView(viewId);
    let failed = false;
    let cursor = 0;
    // The launch marker is what the stage shows while the cells are still
    // empty — a free layout has one cell, so without it nothing on screen moves
    // until the first page lands. It dies with the batch, success or rollback.
    view.launching = { total: inputs.length, done: 0 };
    // Held from before the first page so the noisy per-createTab broadcasts
    // stay merged; the container itself was broadcast by the caller, and every
    // pin above flushes what is held so the stage fills cell by cell.
    this.stateHold += 1;
    const worker = async (): Promise<void> => {
      while (cursor < inputs.length && !failed) {
        const index = cursor++;
        const input = inputs[index];
        if (!input) break;
        try {
          const tab = await this.createTab({
            ...(input.url ? { url: input.url } : {}),
            ...(input.identityId ? { identityId: input.identityId } : {}),
            ...(input.siteId ? { siteId: input.siteId } : {}),
            ...(input.label ? { label: input.label } : {}),
            ...(input.color ? { color: input.color } : {}),
            viewId: view.id,
            origin: "manual",
          });
          onCreated?.(tab, index);
          this.pinBatchTab(view, index, tab.id);
          // The cell lights up the moment its page is pinned, not when the whole
          // batch has finished loading: from the accounts page the switch to the
          // browser page lands first, and this is what the user watches.
          if (view.launching) view.launching.done += 1;
          this.flushHeldState();
        } catch (error) {
          // Flag first: sibling workers check it before starting another page.
          failed = true;
          throw error;
        }
      }
    };
    // allSettled, not all: a rollback must wait out the in-flight page loads,
    // or pages that land after the recycle would survive as orphans.
    const results = await Promise.allSettled(
      Array.from({ length: Math.max(1, Math.min(concurrency, inputs.length)) }, worker),
    );
    const failure = results.find((item) => item.status === "rejected");
    if (failure) {
      failed = true;
      // The container came from this call, so it goes back with the pages —
      // the launch marker dies with it.
      this.closeView(view.id, "all");
      // A rollback changes the surface too: release the hold before reporting,
      // or the renderer keeps showing pages that no longer exist.
      this.stateHold = Math.max(0, this.stateHold - 1);
      this.stateHeld = false;
      this.emitState();
      throw failure.reason;
    }
    // No trailing activate(): the old renderer loop never activated during a
    // batch, and activate() routes through planTabClick, whose grid plan would
    // write a slot entry even into a Free layout's empty slot table. Pinning
    // has already focused the page in slot 0 for a slotted layout.
    this.applyLayout();
    delete view.launching;
    // Release and publish what is left: intermediate frames went out through the
    // per-pin flushes above, so this is only the final correction.
    this.stateHold = Math.max(0, this.stateHold - 1);
    this.stateHeld = false;
    this.emitState();
    return this.state();
  }

  /**
   * Batch-time pin: slots are counted when the pin runs, not when the batch
   * started, and an out-of-range index is a skip rather than an error — with
   * more members than cells the extras stay in the view off stage, which is the
   * same rule a manual drop follows.
   */
  private pinBatchTab(view: EmbeddedView, slotIndex: number, tabId: string): void {
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    if (slotIndex < 0 || slotIndex >= slotCount) return;
    const tab = this.requireTab(tabId);
    const root = this.instanceRoot(tab.instanceId) ?? tab;
    this.placeInstanceInSlot(view, slotIndex, root, tab);
    this.applyLayout();
    this.emitState();
  }

  renameView(viewId: string, name: string): EmbeddedState {
    const view = this.requireView(viewId);
    const next = name.trim();
    if (next) view.name = next;
    this.emitState();
    return this.state();
  }

  setViewColor(viewId: string, color: RoleColor | null): EmbeddedState {
    const view = this.requireView(viewId);
    if (color) view.color = color;
    else delete view.color;
    this.emitState();
    return this.state();
  }

  setViewCollapsed(viewId: string, collapsed: boolean): EmbeddedState {
    const view = this.requireView(viewId);
    view.collapsed = collapsed;
    this.emitState();
    return this.state();
  }

  /**
   * Points the toolbar back at the page the view already shows.
   *
   * Joining a full grid leaves the new page off stage. Letting it become the
   * active tab anyway would make the address bar describe a page nobody can see
   * while the "selected" marker stays on another cell.
   */
  keepViewSelection(viewId: string, preferredTabId?: string): EmbeddedState {
    const view = this.findView(viewId);
    if (!view) return this.state();
    const occupied = view.slotTabs.filter((id): id is string => Boolean(id));
    const selected =
      (preferredTabId && occupied.includes(preferredTabId) ? preferredTabId : undefined) ??
      occupied[0];
    const target = selected ? this.findTab(selected) : undefined;
    const page = target ? this.activePageOf(target.instanceId) : undefined;
    if (page && target) {
      this.activeTabId = page.id;
      this.setActivePage(page);
      view.focusedTabId = target.id;
    }
    this.activeViewId = view.id;
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Closes a view container. `"all"` closes every tab; `"opened"` closes only
   * tabs the view launched and leaves hand-made or AI-added tabs running.
   */
  closeView(viewId: string, mode: "all" | "opened" = "all"): EmbeddedState {
    const view = this.findView(viewId);
    if (!view) return this.state();
    const doomed = this.viewTabs(view.id).filter((tab) => mode === "all" || tab.origin === "view");
    for (const tab of doomed) this.discardTab(tab);
    for (const tab of this.viewTabs(view.id)) delete tab.viewId;
    this.views = this.views.filter((item) => item.id !== view.id);
    if (this.activeViewId === view.id) {
      this.activeViewId = undefined;
      const loose = this.tabs.filter((tab) => !tab.viewId);
      this.activeTabId = loose[0]?.id;
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Drop handling for the sidebar.
   *
   * Rows reorder the flat tab list; the middle band of a row that belongs to a
   * view joins that view. Dropping onto a view block joins it regardless of the
   * band. Nothing here creates a view: containers come from the explicit button,
   * which is the only way an empty one can survive long enough to be filled.
   */
  dropTab(
    tabId: string,
    target:
      | { kind: "tab"; tabId: string; edge: "before" | "after" | "middle" }
      | { kind: "view"; viewId: string }
      | { kind: "loose" },
  ): EmbeddedState {
    const tab = this.requireTab(tabId);
    if (target.kind === "loose") {
      this.detachFromView(tab);
      // "Loose" means "take it out of the view"; appending moves it to the end of
      // the flat strip, which is where new loose tabs live.
      const from = this.tabs.indexOf(tab);
      if (from >= 0 && from !== this.tabs.length - 1) {
        this.tabs.splice(from, 1);
        this.tabs.push(tab);
      }
      this.activeViewId = undefined;
      this.activeTabId = tab.id;
      this.applyLayout();
      this.emitState();
      return this.state();
    }
    if (target.kind === "view") {
      const view = this.requireView(target.viewId);
      this.assignView(tab, view.id);
      this.activeViewId = view.id;
      this.activeTabId = tab.id;
      view.focusedTabId = tab.id;
      this.applyLayout();
      this.emitState();
      return this.state();
    }
    const targetTab = this.requireTab(target.tabId);
    if (targetTab.id === tab.id) return this.state();
    const targetView = targetTab.viewId ? this.findView(targetTab.viewId) : undefined;
    const joining = target.edge === "middle" && targetView;
    if (joining && targetView) {
      this.assignView(tab, targetView.id);
      this.activeViewId = targetView.id;
      this.activeTabId = tab.id;
      targetView.focusedTabId = tab.id;
    } else {
      // Dropping a view member next to a loose row means leaving the view: the
      // loose strip is where it is about to appear.
      if (!targetView && tab.viewId) this.detachFromView(tab);
      // Reordering into a member row of another view means joining it there.
      if (targetView && tab.viewId !== targetView.id) this.assignView(tab, targetView.id);
      const after = target.edge === "after" || (target.edge === "middle" && !targetView);
      this.reorder(tab, targetTab, after);
      if (targetView) this.resequenceView(targetView);
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Rebuilds the slot order from the tab order.
   *
   * Called after a reorder inside a view: the sidebar order is the layout order,
   * so keeping old pins would make dragging look like it did nothing.
   *
   * A split view is exempt. Its slot table repeats one instance on purpose and
   * each cell pins a page by position — refilling from the tab order collapses
   * the duplicate back into one cell and drops the pins. Reordering a split
   * instance's pages changes which strip pill sits where, not which cell shows
   * which page, so the grid simply stays as it is.
   */
  private resequenceView(view: ViewRecord): void {
    if (this.viewHasSplit(view)) return;
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      undefined,
      slotCount,
    );
  }

  private reorder(tab: TabRecord, anchor: TabRecord, after = false): void {
    const from = this.tabs.indexOf(tab);
    if (from < 0 || tab === anchor) return;
    this.tabs.splice(from, 1);
    let to = this.tabs.indexOf(anchor);
    if (to < 0) to = this.tabs.length;
    else if (after) to += 1;
    this.tabs.splice(to, 0, tab);
  }

  /** Puts a browser instance into a view, swapping it into a free or focused slot. */
  private assignView(tab: TabRecord, viewId: string): void {
    const view = this.findView(viewId);
    if (!view) return;
    const root = this.instanceRoot(tab.instanceId) ?? tab;
    // Moving between views detaches first; landing in the view the tab already
    // names (the normal path — the field is written at creation) keeps
    // everything and still resolves the slot below, because a fresh tab is not
    // in any slot yet.
    if (root.viewId && root.viewId !== view.id) this.detachFromView(root);
    for (const page of this.instanceTabs(root.instanceId)) page.viewId = view.id;
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      view.slotTabs,
      slotCount,
    );
  }

  /**
   * Removes a browser instance from its view, leaving the container in place.
   *
   * An emptied container is deliberately kept: it was created on purpose, and
   * closing it automatically would make it impossible to drag a second page in.
   */
  private detachFromView(tab: TabRecord): void {
    const root = this.instanceRoot(tab.instanceId) ?? tab;
    if (!root.viewId) return;
    const viewId = root.viewId;
    for (const page of this.instanceTabs(root.instanceId)) delete page.viewId;
    const view = this.findView(viewId);
    if (!view) return;
    view.slotTabs = view.slotTabs.map((id) => (id === root.id ? null : id));
    if (view.focusedTabId === root.id) delete view.focusedTabId;
  }

  // ---------- tabs ----------

  async createTab(input: {
    url?: string;
    identityId?: string;
    siteId?: string;
    label?: string;
    color?: RoleColor;
    viewId?: string;
    origin?: "view" | "manual" | "ai";
    /**
     * Open with no shared state at all.
     *
     * Only an explicit "clean open" sets this. A page with no identity that
     * omits it lands in the daily profile — that is what makes a bookmark and a
     * typed address reuse the login the user already has.
     */
    clean?: boolean;
    /** Existing instance that should own this page; omitted creates a new one. */
    instanceId?: string;
    openerId?: string;
  }): Promise<EmbeddedTab> {
    const id = randomUUID();
    const parent = input.instanceId ? this.instanceRoot(input.instanceId) : undefined;
    // The group key, not the parent page's id: closing the page that used to be
    // the root must not turn the surviving pages into a new instance, and a page
    // opened into that instance still has to join them.
    const instanceId = parent ? parent.instanceId : id;
    // A page opened by another page shares its session: that is what makes it
    // the same browser instance rather than a second window.
    const identityId = input.identityId ?? parent?.identityId;
    const siteId = input.siteId ?? parent?.siteId;
    // A popup inherits its opener's world, including a deliberate clean open: it
    // must not jump into the daily profile halfway through a throwaway flow.
    const clean = input.clean ?? (parent ? this.cleanInstances.has(parent.instanceId) : false);
    const partition = embeddedTabPartition({
      ...(identityId ? { identityId } : {}),
      clean,
      instanceId,
    });
    // Remembered per instance: `clean` is not part of the tab record, and the
    // next page opened by this instance has to agree with it.
    if (clean) this.cleanInstances.add(instanceId);
    this.configureSession(partition);
    /*
     * The tab is in the list before its carrier exists.
     *
     * A guest's `webContents` only appears once the renderer mounts the node,
     * and mounting is driven by a state broadcast — so publishing the tab after
     * the node exists is a deadlock: the renderer never sees the page it is
     * being asked to host, gives it no box, and the guest reports a 0×0
     * viewport.
     */
    const tab: TabRecord = {
      id,
      ...(identityId ? { identityId } : {}),
      ...(siteId ? { siteId } : {}),
      // From the very first broadcast the tab belongs to its view. Writing the
      // field only after the carrier opened (the old behaviour) left the tab
      // looking loose during the await — and with a batch's workers interleaving,
      // another worker's mid-hold flush then showed it under the loose group
      // before it moved into the view.
      ...(input.viewId && this.findView(input.viewId) ? { viewId: input.viewId } : {}),
      label: input.label?.trim() || t("page.untitled"),
      ...(input.color ? { color: input.color } : {}),
      origin: input.origin ?? parent?.origin ?? "manual",
      instanceId,
      ...(input.openerId ? { openerId: input.openerId } : {}),
      // Placeholder until the node attaches; nothing may touch it before
      // `openCarrier` returns, because a guest page has no `webContents` until
      // the renderer creates one.
      view: null as unknown as PageSurface,
      cdp: null as unknown as CdpExecutor,
      url: "about:blank",
      title: "",
      loading: false,
      crashed: false,
    };
    this.tabs.push(tab);
    this.emitState();
    const carrier = await this.openCarrier({ tabId: id, partition, url: input.url ?? "about:blank" });
    tab.view = carrier.view;
    tab.cdp = carrier.cdp;
    this.wireTab(tab);
    // A new page starts at the global default; only a deliberate keystroke
    // creates an override, so the setting keeps applying to everything else.
    this.applyZoom(tab, parent ? (parent.zoomOverride ?? this.defaultZoom) : this.defaultZoom);
    this.activeTabId = id;
    this.setActivePage(tab);

    if (parent) {
      // A popup joins its opener's container and slot; it never becomes a new
      // slot candidate. The view on stage stays whatever it was: a page in an
      // off-stage view must not drag its view forward just by opening a popup.
      if (parent.viewId) {
        tab.viewId = parent.viewId;
        const owner = this.findView(parent.viewId);
        if (owner) owner.focusedTabId = parent.id;
      }
    } else if (input.viewId && this.findView(input.viewId)) {
      // Opening a loose tab must actually show it, even when another view was on
      // stage; opening into a view brings that view forward instead.
      this.assignView(tab, input.viewId);
      const owner = this.findView(input.viewId);
      // Select the new page only when it really landed in a cell. An off-stage
      // page that stole the marker would leave "selected" pointing at something
      // invisible, and the next swap would target slot 1 instead of the cell the
      // user is looking at.
      if (owner && owner.slotTabs.includes(tab.id)) owner.focusedTabId = tab.id;
      this.activeViewId = input.viewId;
    } else {
      delete this.activeViewId;
    }
    this.applyLayout();

    const target = normalizeEmbeddedUrl(input.url ?? "about:blank");
    if (!target) {
      this.closeTab(tab.id);
      throw new Error("只支持 http(s) 地址");
    }
    await tab.view.webContents.loadURL(target).catch(() => {
      // A failed load still leaves a usable tab; the error page is visible.
    });
    this.syncTab(tab);
    this.applyLayout();
    this.emitState();
    return this.describe(tab);
  }

  /**
   * Resolves how a new page will be displayed.
   *
   * A guest's `webContents` arrives asynchronously — the renderer has to mount
   * the node first — so this is the only place the manager learns the page's
   * `webContents`; everything downstream talks to `PageSurface` and
   * `CdpExecutor`.
   */
  private async openCarrier(input: {
    tabId: string;
    partition: string;
    url: string;
  }): Promise<{ view: PageSurface; cdp: CdpExecutor }> {
    const mounted = await this.guests.mount({
      tabId: input.tabId,
      partition: input.partition,
      url: input.url,
    });
    // The executor is built here, not by the host: it needs both the guest the
    // host just registered and the presentation hook, and the manager is the
    // only place that knows the tab id those two are keyed by.
    return {
      view: new GuestPageSurface(mounted.contents, () => ({
        x: this.stage?.x ?? 0,
        y: this.stage?.y ?? 0,
      })),
      cdp: this.guestExecutor(input.tabId),
    };
  }

  /**
   * The CDP executor for a page whose guest is registered under `tabId`.
   *
   * Built here rather than by the host because it needs both the guest (which
   * the host registered) and the presentation hook for screenshots, and the
   * manager is the only place that knows which tab both are keyed by.
   */
  private guestExecutor(tabId: string): CdpExecutor {
    const guests = this.options.guests;
    if (!guests) throw new Error("没有可用的页面载体");
    return new GuestCdp(guests.targetFor(tabId), tabId, (id, visible) =>
      guests.present(id, visible),
    );
  }

  private configureSession(partition: string): void {
    const target = session.fromPartition(partition);
    // No preload is ever registered on these partitions: they run untrusted
    // remote pages, so the only bridge is the main process.
    const userAgent = desktopUserAgent(target.getUserAgent());
    if (userAgent && !userAgent.includes("Electron/")) target.setUserAgent(userAgent);
    // Chromium keeps proxy rules per session, so every identity partition needs
    // them applied — the default session's rules do not reach these.
    const proxy = this.options.proxy?.();
    if (proxy) void applyProxyToSession(target, proxy);
    target.setPermissionRequestHandler((_contents, permission, callback) => {
      // Remote pages get no camera, microphone, geolocation or notifications by
      // default. Anything a test needs must be added here deliberately.
      const allowed: string[] = [];
      callback(allowed.includes(permission));
    });
    target.setPermissionCheckHandler(() => false);
    // Same reason as the proxy: a download is session state, so a partition
    // that is never handed to the manager would download invisibly.
    this.options.onSessionReady?.(target);
  }

  /**
   * Installs the login-form listener in a freshly loaded document.
   *
   * `Runtime.addBinding` exposes one function to the page; the value it passes
   * arrives here as a `bindingCalled` event, so the password is in main-process
   * memory and never in the renderer that draws the app chrome.
   */
  private async installLoginCapture(tab: TabRecord): Promise<void> {
    if (!this.options.onLoginCaptured) return;
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    try {
      // The binding survives navigations within the same renderer; adding it
      // twice throws, so it is remembered per tab.
      if (!tab.captureBinding) {
        await tab.cdp.send("Runtime.addBinding", { name: LOGIN_CAPTURE_BINDING });
        tab.captureBinding = true;
      }
      await tab.cdp.evaluate(LOGIN_CAPTURE_SCRIPT);
      /*
       * The listener lives in the page, but the binding's events are only
       * delivered while a CDP session is attached. Idle release is right for
       * commands — the next one reopens — but a form submitted by the user
       * arrives whenever they press Enter, and an event emitted with nobody
       * attached is dropped rather than queued. So the session stays held for
       * as long as an instrumented document is loaded.
       */
      this.options.guests?.holdSession?.(tab.id, true);
    } catch {
      // A page that navigated away or a failed load has nothing to instrument.
    }
  }

  /**
   * The session a page lives in.
   *
   * Derived rather than stored: the identity and the instance already say it, and
   * a copy on the tab record would be one more thing that can disagree. The icon
   * fetch needs it because an icon request has to travel through the same session
   * the page uses (cookies, region, referrer), not the app's default session.
   */
  private partitionOf(tab: TabRecord): string {
    return embeddedTabPartition({
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      clean: this.cleanInstances.has(tab.instanceId),
      instanceId: tab.instanceId,
    });
  }

  /**
   * Downloads a site icon and inlines it.
   *
   * Electron reports icons through `page-favicon-updated`, but the renderer
   * cannot be handed a remote URL: its CSP only allows `data:` images, and a
   * remote fetch from the app renderer would leak a request the page's own
   * session already made. So the bytes are fetched with the tab's session and
   * converted here; the type and size rules live in `inlineFavicon` so they can
   * be tested without Electron.
   *
   * Failure is silent on purpose — an icon is decoration, and a site behind a
   * login can answer 403 for a request the page itself would have made.
   */
  private async loadFavicon(tab: TabRecord, url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    const hit = this.faviconCache.get(url);
    if (hit) {
      tab.favicon = hit.data;
      return;
    }
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    try {
      const response = await session.fromPartition(this.partitionOf(tab)).fetch(url);
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const data = inlineFavicon(response.headers.get("content-type"), bytes);
      if (!data) return;
      this.faviconCache.set(url, { data, fetched: Date.now() });
      if (this.faviconCache.size > 120) {
        // Cheap eviction: drop the oldest quarter instead of tracking hits.
        const oldest = [...this.faviconCache.entries()]
          .sort((a, b) => a[1].fetched - b[1].fetched)
          .slice(0, 30);
        for (const [key] of oldest) this.faviconCache.delete(key);
      }
      tab.favicon = data;
    } catch {
      // Offline, blocked, or gone: keep whatever the tab showed before.
    }
  }

  private wireTab(tab: TabRecord): void {
    const contents = tab.view.webContents;
    const update = () => {
      this.syncTab(tab);
      this.emitState();
    };

    contents.on("page-favicon-updated", (_event, urls) => {
      const first = urls[0];
      if (!first) return;
      void this.loadFavicon(tab, first).then(() => this.emitState());
    });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title;
      update();
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      update();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      this.syncTab(tab);
      update();
    });
    contents.on("did-navigate", (_event, url) => {
      // An icon belongs to an origin, not to a tab. Keeping the old one across a
      // navigation would label the new site with the previous site's mark until
      // the new icon arrives.
      if (originOf(url) !== originOf(tab.url)) delete tab.favicon;
      tab.url = url;
      update();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      tab.url = url;
      update();
    });
    // DevTools can also be closed from their own header; the toolbar's toggle
    // state has to follow that, or the button stays "on" after the panel is gone.
    contents.on("devtools-opened", update);
    contents.on("devtools-closed", update);
    /*
     * Login capture: the page hands the credentials to the main process through
     * a CDP binding, so they never enter the app's renderer. The script is
     * installed per document (a navigation replaces `window`).
     */
    contents.debugger.on("message", (_event, method, params) => {
      if (method !== "Runtime.bindingCalled") return;
      const payload = params as { name?: string; payload?: string } | undefined;
      if (payload?.name !== LOGIN_CAPTURE_BINDING || typeof payload.payload !== "string") return;
      let parsed: { username?: unknown; password?: unknown; origin?: unknown; path?: unknown };
      try {
        parsed = JSON.parse(payload.payload) as typeof parsed;
      } catch {
        return;
      }
      if (
        typeof parsed.username !== "string" ||
        typeof parsed.password !== "string" ||
        typeof parsed.origin !== "string"
      ) {
        return;
      }
      if (!parsed.username.trim() || !parsed.password) return;
      this.options.onLoginCaptured?.({
        tabId: tab.id,
        username: parsed.username.trim().slice(0, 200),
        password: parsed.password.slice(0, 500),
        origin: parsed.origin,
        path: typeof parsed.path === "string" ? parsed.path : "/",
      });
    });
    contents.on("did-finish-load", () => {
      void this.installLoginCapture(tab);
    });
    /*
     * Clicking anywhere inside a page selects that cell.
     *
     * Without this, the selection only moves when a dock row or a slot header is
     * clicked, which reads as "the highlighted cell is the last one I clicked in
     * the sidebar" instead of "the cell I am typing into". The native page owns
     * the click, so its focus event is the only signal that reaches us.
     */
    contents.on("focus", () => {
      if (this.activeTabId === tab.id) return;
      this.selectPage(tab);
    });
    contents.on("render-process-gone", () => {
      tab.crashed = true;
      update();
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted navigation caused by another navigation starting.
      if (!isMainFrame || code === -3) return;
      tab.title = `${description || "加载失败"}`;
      tab.url = url;
      update();
    });
    contents.on("context-menu", (_event, params) => {
      const menu = Menu.buildFromTemplate([
        {
          label: "后退",
          enabled: this.safeNav(tab, "canGoBack"),
          click: () => contents.navigationHistory.goBack(),
        },
        {
          label: "前进",
          enabled: this.safeNav(tab, "canGoForward"),
          click: () => contents.navigationHistory.goForward(),
        },
        { type: "separator" },
        { label: "重新加载", click: () => contents.reload() },
        {
          label: "复制链接",
          enabled: Boolean(params.linkURL),
          click: () => {
            void import("electron").then(({ clipboard }) =>
              clipboard.writeText(params.linkURL || tab.url),
            );
          },
        },
        {
          label: "在系统浏览器中打开",
          click: () => {
            const target = normalizeEmbeddedUrl(tab.url);
            if (target) void shell.openExternal(target);
          },
        },
      ]);
      menu.popup({ window: this.host ?? undefined });
    });
    contents.setWindowOpenHandler(({ url }) => {
      const target = normalizeEmbeddedUrl(url);
      if (target && /^https?:/i.test(target)) {
        // A popup belongs to the instance that opened it: same session, same
        // view slot. Treating it as a new slot would turn a login popup into an
        // extra screen region the user never asked for.
        void this.createTab({
          url: target,
          instanceId: tab.instanceId,
          openerId: tab.id,
          label: tab.label,
          ...(tab.color ? { color: tab.color } : {}),
        });
      } else if (/^https?:/i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (normalizeEmbeddedUrl(url)) return;
      event.preventDefault();
      if (/^https?:/i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
    });
    contents.on("before-input-event", (event, input) => {
      // One physical press arrives twice: `before-input-event` fires for the
      // keyDown and again for the keyUp. Shortcuts act on the way down only —
      // they are commands, not states.
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const modifier = process.platform === "darwin" ? input.meta : input.control;
      if (modifier && key === "f") {
        event.preventDefault();
        this.options.onFocusTab?.(tab.id);
      }
      if (modifier && key === "w") {
        event.preventDefault();
        this.closeTab(tab.id);
      }
      // Browser muscle memory: Ctrl+R / F5 reload the page the key lands on,
      // Ctrl+Shift+R bypasses the cache. Electron binds no default reload, so
      // without the interception the keystroke dies in the page and reads as
      // a dead shortcut.
      if (key === "f5" || (modifier && key === "r")) {
        event.preventDefault();
        if (modifier && input.shift) this.hardReload(tab.id);
        else this.reload(tab.id);
      }
      // The same toggle Chrome offers: F12, and Ctrl+Shift+I for laptops whose
      // F12 shares a row with volume.
      // Auto-repeat is ignored: holding the key would otherwise flip the panel
      // open and shut until the user lets go.
      if (!input.isAutoRepeat && (key === "f12" || (modifier && input.shift && key === "i"))) {
        event.preventDefault();
        if (this.devtoolsOpen(tab)) this.closeDevTools(tab.id);
        else this.openDevTools(tab.id);
      }
      // Zoom has to be intercepted here: a page can swallow Ctrl +/- itself
      // (code editors do), and the gesture must still work on that page.
      if (modifier && (key === "=" || key === "+")) {
        event.preventDefault();
        this.zoomBy(tab.id, "in");
      }
      if (modifier && (key === "-" || key === "_")) {
        event.preventDefault();
        this.zoomBy(tab.id, "out");
      }
      if (modifier && key === "0") {
        event.preventDefault();
        this.zoomBy(tab.id, "reset");
      }
    });
  }

  private syncTab(tab: TabRecord): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    tab.url = contents.getURL() || tab.url;
    const title = contents.getTitle();
    if (title) tab.title = title;
  }

  /**
   * Waits for the page to have landed on `url` with a parsed document.
   *
   * `readyState` alone is not enough: the document being replaced is *also*
   * `complete`, so a check that only looked at it returned immediately against
   * the old page — the flow then waited on elements of the page it was leaving
   * and read from the wrong document. The URL is the signal that the navigation
   * actually happened.
   */
  private async whenReady(tab: TabRecord, url: string, timeoutMs = 10_000): Promise<void> {
    const startedAt = Date.now();
    const wanted = normalizeEmbeddedUrl(url) ?? url;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const ready = await tab.cdp.evaluate<{ href: string; state: string }>(
          "({ href: location.href, state: document.readyState })",
        );
        const landed =
          ready.href === wanted ||
          // Redirects (trailing slash, http→https, login bounce) are normal;
          // compare origins and paths so a redirect still counts as arrival.
          sameDocumentUrl(ready.href, wanted);
        if (landed && (ready.state === "interactive" || ready.state === "complete")) return;
      } catch {
        // Navigation in progress: the execution context is being replaced.
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  async navigate(tabId: string, url: string): Promise<EmbeddedTab> {
    const tab = this.requireTab(tabId);
    const target = normalizeEmbeddedUrl(url);
    if (!target) throw new Error("只支持 http(s) 地址");
    // A frozen page must take the navigation; loadURL alone can leave the
    // old document parked in the lifecycle cache.
    this.wakeTab(tabId);
    await tab.view.webContents.loadURL(target).catch(() => {
      // The error page is the feedback; the tab stays alive.
    });
    // A flow's next step runs immediately after this, and a guest's `loadURL`
    // resolves before the new document is ready — the first `wait` then matched
    // the *old* page and the following `read` looked in the wrong document.
    // Native views never showed this because their load settled first.
    if (this.options.guests) {
      await this.whenReady(tab, target);
    }
    this.syncTab(tab);
    // The page is no longer blank, so it has to take over its cell: until now
    // the renderer was drawing the new-tab surface there instead.
    this.applyLayout();
    this.emitState();
    return this.describe(tab);
  }

  back(tabId: string): void {
    const tab = this.requireTab(tabId);
    this.wakeTab(tabId);
    if (this.safeNav(tab, "canGoBack")) tab.view.webContents.navigationHistory.goBack();
  }

  forward(tabId: string): void {
    const tab = this.requireTab(tabId);
    this.wakeTab(tabId);
    if (this.safeNav(tab, "canGoForward")) tab.view.webContents.navigationHistory.goForward();
  }

  reload(tabId: string): void {
    const tab = this.requireTab(tabId);
    this.wakeTab(tabId);
    tab.crashed = false;
    tab.view.webContents.reload();
  }

  /** Reloads bypassing the HTTP cache — Chrome's Ctrl+Shift+R. */
  hardReload(tabId: string): void {
    const tab = this.requireTab(tabId);
    this.wakeTab(tabId);
    tab.crashed = false;
    tab.view.webContents.reloadIgnoringCache();
  }

  /** Reloads whatever page the chrome is currently framing (app-level Ctrl+R). */
  reloadActive(): void {
    if (this.activeTabId) this.reload(this.activeTabId);
  }

  /**
   * Drops the page's HTTP cache, then reloads it — "empty cache and reload".
   *
   * The cache is per session, not per page: Electron offers no per-URL purge, so
   * this clears the identity's whole partition cache. That is the honest scope —
   * other pages in the same profile will re-fetch too — and it is why the menu
   * item is not a plain refresh.
   *
   * The reload waits for the clear: reloading first lets in-flight subresources
   * be answered from the cache being cleared, which is the exact thing the user
   * clicked to avoid.
   */
  async clearCacheAndReload(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    this.wakeTab(tabId);
    await session.fromPartition(this.partitionOf(tab)).clearCache();
    if (tab.view.webContents.isDestroyed()) return;
    tab.crashed = false;
    // `reloadIgnoringCache` as well: the clear handles what is on disk, this
    // handles what is already in the renderer's memory cache.
    tab.view.webContents.reloadIgnoringCache();
  }

  hardReloadActive(): void {
    if (this.activeTabId) this.hardReload(this.activeTabId);
  }

  /**
   * The click rules live in `planTabClick`; this applies the result, re-runs the
   * grid math when an instance swapped into a slot, and moves focus into the page.
   *
   * Slot membership is by instance, so a click on a secondary page only switches
   * which page that instance shows; only a click on an instance's root page can
   * pull it onto the stage.
   */
  activate(tabId: string): EmbeddedState {
    const tab = this.requireTab(tabId);
    this.setActivePage(tab);
    const root = this.instanceRoot(tab.instanceId) ?? tab;
    const plan = planTabClick(
      {
        tabs: this.tabs.map((item) => this.describe(item)),
        views: this.views.map((view) => this.describeView(view)),
        ...(this.activeTabId ? { activeTabId: this.activeTabId } : {}),
        ...(this.activeViewId ? { activeViewId: this.activeViewId } : {}),
      },
      root.id,
    );
    this.activeTabId = tab.id;
    if (plan.activeViewId) this.activeViewId = plan.activeViewId;
    else delete this.activeViewId;
    for (const next of plan.views) {
      const current = this.findView(next.id);
      if (!current) continue;
      current.slotTabs = [...next.slotTabs];
      if (next.focusedTabId) current.focusedTabId = next.focusedTabId;
      else delete current.focusedTabId;
    }
    this.applyLayout();
    this.focusActiveView();
    this.emitState();
    return this.state();
  }

  private focusActiveView(): void {
    if (!this.activeTabId) return;
    const tab = this.findTab(this.activeTabId);
    const contents = tab?.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    contents.focus();
  }

  closeTab(tabId: string): EmbeddedState {
    const tab = this.findTab(tabId);
    if (!tab) return this.state();
    const view = tab.viewId ? this.findView(tab.viewId) : undefined;
    // A split cell that was showing this exact page loses its pin first, so the
    // cell falls back to the instance's active page instead of pointing at a
    // closed one. `normalizeSlotPages` would catch it later, but the cell would
    // be blank for one broadcast before that runs.
    //
    // The cell itself goes too when the instance still holds another cell: with
    // no page of its own it would draw the same window as its sibling, which is
    // the duplicate the pinning exists to avoid.
    if (view?.slotPages) {
      const released: number[] = [];
      view.slotPages = view.slotPages.map((id, index) => {
        if (id !== tabId) return id;
        const rootId = view.slotTabs[index];
        if (rootId && view.slotTabs.some((other, at) => at !== index && other === rootId)) {
          released.push(index);
        }
        return null;
      });
      if (!view.slotPages.some(Boolean)) delete view.slotPages;
      for (const index of released) view.slotTabs[index] = null;
      this.dropOrphanPins(view);
    }
    const instanceId = tab.instanceId;
    const wasActive = this.instanceActive.get(instanceId) === tabId;
    const siblings = this.instanceTabs(instanceId).filter((item) => item.id !== tabId);
    this.discardTab(tab);
    // The instance keeps running on its remaining pages: closing one page is not
    // closing the window. Only the last page frees the view slot.
    if (view && siblings.length === 0) {
      view.slotTabs = view.slotTabs.map((id) => (id === instanceId || id === tabId ? null : id));
      if (view.focusedTabId === instanceId || view.focusedTabId === tabId) {
        delete view.focusedTabId;
      }
      // The container stays: it may be intentionally empty, waiting for a page.
    } else if (view && siblings.length > 0) {
      /**
       * A slot names an instance by its root page's id. Closing that page left
       * the slot pointing at a tab that no longer exists, so resolving the grid
       * dropped the cell's contents — the surviving pages were still running,
       * just unreachable from the stage. The oldest survivor takes the name.
       */
      const successor = siblings[0];
      if (successor) {
        view.slotTabs = view.slotTabs.map((id) =>
          id === tabId || id === instanceId ? successor.id : id,
        );
        if (view.focusedTabId === tabId || view.focusedTabId === instanceId) {
          view.focusedTabId = successor.id;
        }
      }
    }
    const survivor = siblings[siblings.length - 1];
    if (survivor) {
      if (wasActive || !this.instanceActive.has(instanceId)) this.setActivePage(survivor);
    } else {
      this.instanceActive.delete(instanceId);
    }
    if (this.activeTabId === tabId) {
      // Stay inside the instance first, then the same view, then anywhere.
      const inView = view ? this.tabs.filter((item) => item.viewId === view.id) : [];
      this.activeTabId =
        survivor?.id ?? inView[inView.length - 1]?.id ?? this.tabs[this.tabs.length - 1]?.id;
      if (survivor && view) view.focusedTabId = this.instanceRoot(instanceId)?.id;
    }
    this.applyLayout();
    this.emitState();
    return this.state();
  }

  /**
   * Opens one more page inside an existing browser instance.
   *
   * This is the strip's "+". A new instance would be a second browser with a
   * second session, which is the opposite of what a profile with a console open
   * needs; the page has to join the same cookies, storage and window.
   */
  async openInInstance(instanceId: string): Promise<EmbeddedState> {
    const root = this.instanceRoot(instanceId);
    if (!root) throw new Error(`浏览器实例不存在：${instanceId}`);
    const tab = await this.createTab({ instanceId: root.id });
    this.activate(tab.id);
    return this.state();
  }

  /**
   * Duplicates a page in its own instance.
   *
   * Same session, same address, same cell — the copy only becomes a second page
   * in the strip, which is what "duplicate this tab" means in a browser. A blank
   * page has nothing to duplicate but the tab itself, so the copy is blank too.
   */
  async duplicateTab(tabId: string): Promise<EmbeddedState> {
    const tab = this.requireTab(tabId);
    const copy = await this.createTab({
      instanceId: tab.instanceId,
      openerId: tab.id,
      label: tab.label,
      ...(isBlankTab(tab) ? {} : { url: tab.url }),
    });
    this.activate(copy.id);
    return this.state();
  }

  /** Closes every page of an instance except the one named. */
  closeOtherTabs(tabId: string): EmbeddedState {
    const tab = this.requireTab(tabId);
    for (const sibling of this.instanceTabs(tab.instanceId)) {
      if (sibling.id !== tab.id) this.closeTab(sibling.id);
    }
    return this.state();
  }

  private discardTab(tab: TabRecord): void {
    const index = this.tabs.indexOf(tab);
    if (index >= 0) this.tabs.splice(index, 1);
    this.aiActiveUntil.delete(tab.id);
    this.frozenTabs.delete(tab.id);
    this.stagedTabs.delete(tab.id);
    // The last page of an instance carries the instance with it; drop the
    // clean-session marker with it so the set does not grow forever.
    if (!this.tabs.some((item) => item.instanceId === tab.instanceId)) {
      this.cleanInstances.delete(tab.instanceId);
      this.instanceActive.delete(tab.instanceId);
    }
    // A page still waiting for its carrier has neither an executor nor a
    // surface; the tab record is written before either exists, so closing it
    // early has to be a no-op rather than a null dereference.
    tab.cdp?.detach();
    // A guest's node belongs to the renderer, so it cannot be removed here —
    // and it must not be: destroying the guest while a CDP command is in flight
    // is a process-level crash. The handshake closes the session, and only its
    // reply authorises the renderer to drop the node.
    const guests = this.guests;
    void guests
      .release(tab.id)
      .catch(() => undefined)
      .then(() => guests.unmount(tab.id));
  }

  private closeAllTabs(): void {
    for (const tab of [...this.tabs]) this.discardTab(tab);
    this.tabs = [];
    this.views = [];
    this.cleanInstances.clear();
    this.activeTabId = undefined;
    this.activeViewId = undefined;
  }

  /** Closes the surface entirely; used on app shutdown. */
  dispose(): void {
    this.closeAllTabs();
    this.host = null;
    this.stage = null;
    this.lastStage = null;
  }

  /**
   * Rebuilds a view's slot table from its layout.
   *
   * The slot count follows the layout, not the stage: it is decided by the preset
   * or the hand-dragged fractions, so this must not depend on the browser page
   * being mounted.
   */
  private normalizeSlots(view: ViewRecord): void {
    const count = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    view.slotTabs = resolveSlotTabs(
      this.viewRoots(view.id).map((tab) => tab.id),
      view.slotTabs,
      count,
      // A slot table that already repeats an instance is a deliberate split;
      // re-resolving must not collapse it back to one cell.
      { allowDuplicates: this.viewHasSplit(view) },
    );
    // Page pins follow the slots they belong to: a reshuffle that moved a cell
    // to another instance, or a trimmed tail, must not leave a stale pin.
    const pages = this.normalizeSlotPages(view);
    if (pages.some(Boolean)) view.slotPages = pages;
    else delete view.slotPages;
    if (view.focusedTabId && !view.slotTabs.includes(view.focusedTabId)) {
      // The focused page may sit in a trimmed slot; keep the marker honest
      // instead of leaving it on a cell that no longer exists.
      const first = view.slotTabs.find((id): id is string => Boolean(id));
      if (first) view.focusedTabId = first;
      else delete view.focusedTabId;
    }
  }

  /** True while two slots of this view hold the same instance on purpose. */
  private viewHasSplit(view: ViewRecord): boolean {
    const seen = new Set<string>();
    for (const id of view.slotTabs) {
      if (!id) continue;
      if (seen.has(id)) return true;
      seen.add(id);
    }
    return false;
  }

  /**
   * Drops pins whose cell no longer repeats another cell's instance.
   *
   * A pin is only meaningful while its instance fills at least two cells. Once a
   * split collapses — the pinned page closed, the duplicate cell cleared — any pin
   * left behind would silently freeze the surviving cell on whatever page it was
   * showing, and the strip would look like it could still switch pages but could
   * not.
   */
  private dropOrphanPins(view: ViewRecord): void {
    if (!view.slotPages) return;
    const pages = this.normalizeSlotPages(view);
    if (pages.some(Boolean)) view.slotPages = pages;
    else delete view.slotPages;
  }

  /**
   * The rect a page's view takes inside its cell, and the zoom to go with it.
   *
   * Adaptive pages fill the cell at their usual zoom. Fixed-viewport pages are
   * scaled to fit and centred, with the zoom factor set to the fit scale so the
   * page lays out at exactly the requested CSS size — the same trade devtools
   * responsive mode makes. Remembering the resolved scale on the tab keeps
   * `applyZoom` honest from wherever layout next touches the page.
   */
  private placePageSurface(tab: TabRecord, cell: StageRect): StageRect {
    const viewport = this.viewportOf(tab);
    if (!viewport) {
      delete tab.viewportScale;
      return cell;
    }
    const { rect, scale } = viewportFitRect(cell, viewport);
    tab.viewportScale = scale;
    tab.view.webContents.setZoomFactor(scale);
    return rect;
  }

  private applyLayout(): void {
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    /**
     * Slot tables are layout *state*, not geometry, so they are normalized even
     * when no stage has been reported.
     *
     * The browser page is not always mounted: the user may be on the accounts
     * page, and an MCP call can arrive before the renderer has reported its
     * stage. Skipping this left `slotTabs` at the old length, so switching 2×2 →
     * 2×1 from `set_browser_layout` still listed four entries and a later launch
     * reused a grid the user had already changed.
     */
    const current = this.activeView();
    if (current) this.normalizeSlots(current);
    if (!this.stage) {
      // No stage means the browser page is not mounted (the console covers it,
      // or the window has no chrome yet). Guests keep their nodes but give up
      // their place: the renderer hides a page that reports no rect, and
      // leaving the last rect behind would paint pages over the console.
      for (const tab of this.tabs) {
        // A tab is published before its carrier exists — the renderer has to
        // see the page in order to mount a node for it — so this can run while
        // `view` is still the placeholder. Reading `webContents` off it threw
        // here on the first state broadcast of a fresh session.
        const contents = tab.view?.webContents;
        if (!contents || contents.isDestroyed()) continue;
        tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
      this.stagedTabs.clear();
      this.dockAllDevTools();
      return;
    }

    const view = this.activeView();
    if (!view) {
      /*
       * Flat mode: one page fills the whole stage.
       *
       * This used to subtract `EMBEDDED_SLOT_HEADER` from the top, because the
       * flat stage drew a header band with the instance's page tabs. It does not
       * draw one any more — the window-level strip above the toolbar owns the
       * tabs in every mode, and the flat band was a second identical row. The
       * subtraction stayed behind, so every flat page was inset 26px and the
       * stage showed a dark band above it that belonged to nothing.
       */
      const staged = new Set<string>();
      const tab = this.activeTabId ? this.findTab(this.activeTabId) : undefined;
      const page = tab ? this.activePageOf(tab.instanceId) : undefined;
      // A page that has not navigated anywhere keeps its rect off the stage so the
      // app's own new-tab surface (search box, engine picker) is what the user
      // sees. The renderer draws it; there is no page to draw behind it.
      if (page && !page.viewId && !isBlankTab(page) && !page.view.webContents.isDestroyed()) {
        void this.wakeTab(page.id);
        page.view.setBounds(this.placePageSurface(page, this.stage));
        staged.add(page.id);
      }
      this.parkUnstaged(staged);
      this.dockAllDevTools();
      return;
    }

    const slots = insetSlotRects(
      embeddedSlotRects(view.layoutId, this.stage, view.slotRects),
      this.stage,
    );
    // One cell is the browser, not a grid: no band, so the page gets the whole
    // rectangle. Several cells keep the band, because the account name and the
    // page tabs are what tell the cells apart.
    const header = stageDrawsSlotHeaders(slots.length) ? EMBEDDED_SLOT_HEADER : 0;
    const staged = new Set<string>();
    // `slotTabs` was already normalized above; the geometry is the only thing
    // left to do here.
    slots.forEach((slot, index) => {
      const rootId = view.slotTabs[index];
      if (!rootId) return;
      // A slot shows one instance; which page of it is on screen is decided by
      // `slotPages` when the cell pinned one (same-account side by side), and by
      // `instanceActive` otherwise, so popups reuse the slot instead of adding a
      // cell.
      const page = this.pageForSlot(view, index);
      // Same placeholder hazard as the flat branch: a tab can sit in `slotTabs`
      // before its carrier exists (assigned at creation, or mid-batch), so the
      // view may still be the null placeholder here.
      if (!page || !page.view || page.view.webContents.isDestroyed()) return;
      // Same reason as the flat branch: a blank page keeps its cell for HTML.
      if (isBlankTab(page)) return;
      void this.wakeTab(page.id);
      page.view.setBounds(this.placePageSurface(page, embeddedViewRect(slot, header)));
      staged.add(page.id);
    });
    this.parkUnstaged(staged);
    this.dockAllDevTools();
  }

  /**
   * Re-seats every open panel beside its page after a layout pass.
   *
   * `applyLayout` writes each page's *full* cell, which is correct for a page
   * with no panel and wrong for one with a panel: the panel would be left where
   * it was while the page grew under it. Docking afterwards is what keeps the
   * two halves of the split on the same cell through a resize, a layout change,
   * a tab switch and a dragged stage divider. Pages that left the stage get
   * their panel parked by the same call.
   */
  private dockAllDevTools(): void {
    for (const tab of this.tabs) {
      if (tab.devtools) this.placeDevTools(tab);
    }
  }

  /**
   * Clears the placement of every page this pass did not stage.
   *
   * `stagedTabs` is documented as "recomputed by applyLayout", but it was only
   * ever added to, and no page's bounds were ever cleared. Switching to a new tab
   * therefore left the previous page holding a full-stage rect: `getBounds()`
   * still said "I am the stage", `viewIsOnScreen` still said yes, and the
   * renderer kept painting it. The tab strip moved, the address bar emptied, and
   * the pixels did not — reported as "the new tab does not actually switch".
   *
   * Only pages that *had* a box are cleared. A page that has never been placed
   * (a background tab opened through MCP, one that is still loading) keeps its
   * zero rect and, more importantly, is never given one here: writing a rect and
   * then clearing it would leave the guest with a box it was laid out for and
   * then had taken away, and `capturePage` on that reports `UnknownVizError`
   * instead of pixels — which is how a background screenshot stopped working
   * when this first cleared everything unconditionally.
   */
  private parkUnstaged(staged: Set<string>): void {
    for (const tab of this.tabs) {
      if (staged.has(tab.id)) continue;
      const contents = tab.view?.webContents;
      if (!contents || contents.isDestroyed()) continue;
      const bounds = tab.view.getBounds();
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    this.stagedTabs = staged;
  }

  /**
   * Records CDP traffic and wakes the page if the sweep put it to sleep.
   *
   * Awaited by `EmbeddedCdp.send` before the actual command runs, so the first
   * command of a burst — a screenshot, a click — never lands on a frozen page:
   * a frozen page suspends JavaScript entirely, and an evaluate against it
   * would never return. The wake is awaited (not fired and forgotten) so the
   * ordering holds without relying on CDP pipelining. Everything AI does flows
   * through the CDP facade, which makes this the single choke point for "the
   * AI is using this page right now".
   */
  private async markCdpActivity(tabId: string): Promise<void> {
    if (!this.options.aiIdleFreeze) return;
    this.aiActiveUntil.set(tabId, Date.now() + AI_ACTIVE_WINDOW_MS);
    await this.wakeTab(tabId);
  }

  /** Wakes a sleeping page: AI traffic, re-staging, navigation, reload. */
  private async wakeTab(tabId: string): Promise<void> {
    if (!this.options.aiIdleFreeze) return;
    const tab = this.findTab(tabId);
    if (!tab || !this.frozenTabs.delete(tab.id)) return;
    try {
      await tab.cdp.lifecycle("active");
    } catch {
      // Best-effort: a failed wake is retried by the next CDP command, and
      // navigation paths below do not depend on the lifecycle state.
    }
  }

  /**
   * Freezes parked pages whose AI activity window has lapsed.
   *
   * Conservative on purpose: pages on stage, loading, crashed, blank, audible,
   * or with a DevTools panel attached keep running. A page that refuses the
   * lifecycle command simply stays awake — the feature degrades to "no
   * sleeping" instead of breaking automation.
   */
  private sweepFrozenCandidates(): void {
    const now = Date.now();
    for (const id of [...this.aiActiveUntil.keys()]) {
      if (!this.findTab(id)) {
        this.aiActiveUntil.delete(id);
        this.frozenTabs.delete(id);
        this.stagedTabs.delete(id);
      }
    }
    for (const tab of this.tabs) {
      if (this.stagedTabs.has(tab.id) || this.frozenTabs.has(tab.id)) continue;
      // A page is published before its carrier exists so the renderer can be
      // asked to host it; the sweep runs on a timer and can land in that window.
      const contents = tab.view?.webContents;
      if (!contents || contents.isDestroyed()) continue;
      if (contents.isLoading() || tab.crashed) continue;
      if (isBlankTab(tab) || this.devtoolsOpen(tab)) continue;
      if (contents.isCurrentlyAudible()) continue;
      if ((this.aiActiveUntil.get(tab.id) ?? 0) > now) continue;
      this.frozenTabs.add(tab.id);
      void tab.cdp.lifecycle("frozen").catch(() => this.frozenTabs.delete(tab.id));
    }
  }

  /**
   * Size of the window content area, used to decide whether a page can be seen.
   *
   * The screen bounds must not be confused with the stage: a page that is off
   * stage sits left of the *window*, and judging that against the stage width
   * gives the wrong answer. With the window hidden to the tray,
   * `getContentBounds()` is not always usable, so the last real measurement is
   * remembered instead of falling back to a guess.
   */
  private hostContentSize(): { width: number; height: number } {
    const host = this.host;
    if (host && !host.isDestroyed()) {
      const bounds = host.getContentBounds();
      if (bounds.width > 0 && bounds.height > 0) {
        this.lastContentSize = { width: bounds.width, height: bounds.height };
        return this.lastContentSize;
      }
    }
    if (this.lastContentSize) return this.lastContentSize;
    return { width: 1920, height: 1080 };
  }

  private emitState(): void {
    this.options.onStateChange?.(this.state());
    // Held: remember that something changed and let the operation's final
    // release flush one broadcast instead of a dozen.
    if (this.stateHold > 0) {
      this.stateHeld = true;
      return;
    }
    this.sendState();
  }

  /**
   * Runs `work` without broadcasting intermediate states.
   *
   * The final state is always sent, even when `work` throws: a rollback changes
   * the surface too, and a renderer left showing pages that no longer exist is
   * worse than a brief wait.
   */
  withoutBroadcasts<T>(work: () => Promise<T>): Promise<T> {
    return this.withHeldState(work);
  }

  /**
   * Publishes one broadcast while a hold is active, without ending it.
   *
   * A batch holds its state so the noisy per-createTab broadcasts stay merged,
   * but the hold must not blind a launch: each page that lands in its cell
   * flushes what is held, so the stage fills one cell at a time while the rest
   * are still loading. `sendState` coalesces bursts, so three workers flushing
   * within the same tick still produce one frame.
   */
  private flushHeldState(): void {
    if (this.stateHeld) {
      this.stateHeld = false;
      this.sendState();
    }
  }

  private async withHeldState<T>(work: () => Promise<T>): Promise<T> {
    this.stateHold += 1;
    try {
      return await work();
    } finally {
      this.stateHold = Math.max(0, this.stateHold - 1);
      if (this.stateHold === 0 && this.stateHeld) {
        this.stateHeld = false;
        this.sendState();
      }
    }
  }

  private sendState(): void {
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    if (this.pendingState) return;
    this.pendingState = true;
    // Coalesce bursts: load events fire several times per navigation.
    setImmediate(() => {
      this.pendingState = false;
      const current = this.host;
      if (!current || current.isDestroyed()) return;
      current.webContents.send("embedded:state", this.state());
    });
  }

  findTab(tabId: string): TabRecord | undefined {
    return this.tabs.find((tab) => tab.id === tabId);
  }

  /** Tab the caller means when it omits an id: the active one, else the first. */
  defaultTabId(requested?: string): string {
    if (requested) return requested;
    if (this.activeTabId && this.findTab(this.activeTabId)) return this.activeTabId;
    const view = this.activeView();
    const onStage = view?.slotTabs.find((id): id is string => Boolean(id));
    if (onStage) return onStage;
    const first = this.tabs[0];
    if (!first) throw new Error("没有打开的标签页");
    return first.id;
  }

  /** View on stage, for AI tools that omit an explicit view id. */
  defaultViewId(): string | undefined {
    return this.activeViewId;
  }

  /**
   * View a layout tool should act on.
   *
   * Asking for a grid while every tab is loose means "put these pages on one
   * screen", so the tabs are grouped into a new view instead of failing. That is
   * the same result as dragging the tabs together by hand.
   */
  layoutTargetView(layoutId?: string): string | undefined {
    if (this.activeViewId) return this.activeViewId;
    const loose = this.tabs.filter((tab) => !tab.viewId);
    if (loose.length === 0) return undefined;
    const layout = layoutId && isEmbeddedLayout(layoutId) ? layoutId : "2x1";
    const view = this.addView({ name: "新视图", layoutId: layout });
    for (const tab of loose) this.assignView(tab, view.id);
    this.activeViewId = view.id;
    this.activeTabId = loose[0]?.id;
    this.applyLayout();
    this.emitState();
    return view.id;
  }

  /**
   * Root page of an identity inside a view, if it is already open.
   *
   * Root pages only: a popup also carries the identity, but reusing it as the
   * view member would hide which window a saved view actually opened.
   */
  findIdentityTab(viewId: string, identityId: string): EmbeddedTab | undefined {
    const tab = this.tabs.find(
      (item) =>
        item.viewId === viewId && item.identityId === identityId && item.instanceId === item.id,
    );
    return tab ? this.describe(tab) : undefined;
  }

  /** Loose root page of an identity, used to merge repeated opens. */
  findLooseIdentityTab(identityId: string): EmbeddedTab | undefined {
    const tab = this.tabs.find(
      (item) => !item.viewId && item.identityId === identityId && item.instanceId === item.id,
    );
    return tab ? this.describe(tab) : undefined;
  }

  /** The instance root page for an identity, wherever it lives. */
  findIdentityRoot(identityId: string): EmbeddedTab | undefined {
    const tab = this.tabs.find(
      (item) => item.identityId === identityId && item.instanceId === item.id,
    );
    return tab ? this.describe(tab) : undefined;
  }

  /**
   * First cell of a view that holds no instance.
   *
   * Opening an account has to distinguish "there is room, put it on stage" from
   * "the grid is full, keep it off stage". Without that split, every open either
   * replaces the selected cell or shoves the whole view aside.
   */
  firstEmptySlot(viewId: string): number | undefined {
    const view = this.findView(viewId);
    if (!view) return undefined;
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    const slots = resolveSlotTabs(
      this.viewRoots(view.id).map((item) => item.id),
      view.slotTabs,
      slotCount,
    );
    const index = slots.indexOf(null);
    return index >= 0 ? index : undefined;
  }

  /**
   * Re-applies a saved `slotAssignments` map after a container was (re)opened.
   *
   * The definition stores identity ids, the container stores tab ids; the caller
   * has already translated them. Unknown slots are ignored by `resolveSlotTabs`.
   */
  applySlotAssignments(viewId: string, slots: Record<string, number>): void {
    const view = this.findView(viewId);
    if (!view) return;
    const slotCount = embeddedSlotRects(
      view.layoutId,
      { x: 0, y: 0, width: 1, height: 1 },
      view.slotRects,
    ).length;
    const next: (string | null)[] = new Array<string | null>(slotCount).fill(null);
    for (const [tabId, index] of Object.entries(slots)) {
      if (index >= 0 && index < slotCount && !next[index] && this.findTab(tabId)) {
        next[index] = tabId;
      }
    }
    view.slotTabs = resolveSlotTabs(
      this.viewTabs(view.id).map((tab) => tab.id),
      next,
      slotCount,
    );
    this.applyLayout();
  }

  // ---------- AI-facing operations ----------

  /**
   * What an AI client needs to know before it may send input to a tab.
   *
   * The policy lives in `shared/ai-policy.ts`; this only reports facts about the
   * page. `clean` is read from the instance marker because an identity-less tab
   * is either daily or clean and the URL cannot tell them apart.
   */
  aiPageContext(tabId: string): AiPageContext {
    const tab = this.requireTab(tabId);
    return {
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      ...(this.cleanInstances.has(tab.instanceId) ? { clean: true } : {}),
      origin: aiOriginOf(tab.url),
    };
  }

  async snapshotDom(tabId: string, options: { maxNodes?: number } = {}): Promise<DomSnapshot> {
    const tab = this.requireTab(tabId);
    return tab.cdp.snapshotDom(buildDomSnapshotExpression(options));
  }

  async visibility(tabId: string, target: TargetInput): Promise<VisibilityProbe> {
    const tab = this.requireTab(tabId);
    return tab.cdp.visibility(buildVisibilityExpression(target));
  }

  async click(
    tabId: string,
    target: TargetInput,
  ): Promise<{
    ok: true;
    tag?: string;
    text?: string;
    selector?: string;
    /** Where the events actually landed; `onTarget: false` means they missed. */
    hit?: { onTarget: boolean; tag?: string; text?: string };
  }> {
    const tab = this.requireTab(tabId);
    const point = await tab.cdp.elementPoint(buildElementPointExpression(target));
    if (!point.ok || point.x === undefined || point.y === undefined) {
      throw new Error(`无法点击 ${describeTarget(target)}：${point.reason ?? "unknown"}`);
    }
    await tab.cdp.clickAt(point.x, point.y);
    // An overlay, a late scroll or a re-render can redirect the events. Reading
    // the hit back turns "the site ignored my click" from a guess into a fact
    // the caller can act on.
    let hit: { onTarget: boolean; tag?: string; text?: string } | undefined;
    try {
      hit = await tab.cdp.evaluate(buildClickHitExpression(point.x, point.y));
    } catch {
      // Navigation right after the click destroys the context; the click still
      // happened, so the result is reported without hit facts.
    }
    return {
      ok: true,
      ...(point.tag ? { tag: point.tag } : {}),
      ...(point.text ? { text: point.text } : {}),
      ...(point.selector ? { selector: point.selector } : {}),
      ...(hit ? { hit } : {}),
    };
  }

  /**
   * Replaces a field's contents and optionally submits.
   *
   * The single place these three steps live: a guest only accepts keyboard and
   * text input for the element its last real pointer event landed on, so the
   * field has to be clicked first. Three copies of that rule is how one call
   * site ends up typing into the wrong element while the others work — which is
   * exactly what happened.
   */
  private async typeInto(
    tab: TabRecord,
    target: TargetInput,
    value: string,
    options: { clear?: boolean; submit?: boolean } = {},
  ): Promise<void> {
    if (tab.cdp.requiresPointerBeforeTyping) {
      const point = await tab.cdp
        .elementPoint(buildElementPointExpression(target))
        .catch(() => undefined);
      if (point?.ok && point.x !== undefined && point.y !== undefined) {
        await tab.cdp.clickAt(point.x, point.y).catch(() => undefined);
      }
    }
    if (options.clear !== false) await tab.cdp.selectAll().catch(() => undefined);
    await tab.cdp.insertText(value);
    if (options.submit) await tab.cdp.pressNamedKey("Enter");
  }

  async type(
    tabId: string,
    target: TargetInput,
    text: string,
    options: { submit?: boolean; clear?: boolean } = {},
  ): Promise<{ ok: true; secret?: true; selector?: string }> {
    const tab = this.requireTab(tabId);
    const focus = await tab.cdp.evaluate<{
      ok: boolean;
      reason?: string;
      inputType?: string;
      selector?: string;
    }>(buildFocusExpression(target));
    if (!focus.ok)
      throw new Error(`无法输入到 ${describeTarget(target)}：${focus.reason ?? "unknown"}`);
    await this.typeInto(tab, target, text, options);
    // Reported so the MCP layer can keep the value out of its audit log; a
    // password field can be a brand-new credential (creating a tenant), so it
    // cannot always go through `fill_browser_login`.
    return {
      ok: true,
      ...(focus.selector ? { selector: focus.selector } : {}),
      ...(focus.inputType === "password" ? { secret: true as const } : {}),
    };
  }

  /**
   * Waits for a page condition, polling inside the tab.
   *
   * A navigation destroys the execution context the polling loop lives in, so a
   * failure of that kind is retried with the time that is left: by then the new
   * document may already satisfy the condition. Without the retry, "click 登录,
   * then wait for the console" always reports a destroyed context instead of the
   * page it was waiting for.
   */
  async wait(
    tabId: string,
    input: {
      condition: WaitCondition;
      target?: TargetInput;
      text?: string;
      timeoutMs: number;
    },
  ): Promise<WaitResult> {
    const tab = this.requireTab(tabId);
    const started = Date.now();
    const deadline = started + input.timeoutMs;
    let last: WaitResult | undefined;
    while (Date.now() < deadline) {
      const remaining = Math.max(200, deadline - Date.now());
      const expression = buildWaitExpression({ ...input, timeoutMs: remaining });
      try {
        const result = await Promise.race([
          tab.cdp.evaluate<WaitResult>(expression, { awaitPromise: true }),
          new Promise<WaitResult>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: false,
                  waitedMs: remaining,
                  timedOut: true,
                  reason: "evaluate-timeout",
                }),
              remaining + 400,
            ),
          ),
        ]);
        if (result.ok || !result.timedOut || result.reason !== "evaluate-timeout") return result;
        last = result;
      } catch (error) {
        // Context destroyed by a navigation, or the tab went away mid-poll.
        last = {
          ok: false,
          waitedMs: Date.now() - started,
          timedOut: true,
          reason: String((error as Error)?.message ?? error).slice(0, 200),
        };
      }
    }
    return (
      last ?? {
        ok: false,
        waitedMs: Date.now() - started,
        timedOut: true,
        reason: "timeout",
      }
    );
  }

  /**
   * Fills several fields in one call.
   *
   * The point is not saving keystrokes but round trips: each field used to be
   * its own MCP request, and a slow backend meant the caller had to poll between
   * them anyway. One call also keeps the page from being left half-filled when a
   * single request times out.
   */
  async fillForm(
    tabId: string,
    fields: Array<{
      target: TargetInput;
      value: string;
      submit?: boolean;
      clear?: boolean;
    }>,
  ): Promise<{
    ok: true;
    filled: Array<{ field: string; selector?: string; secret?: true }>;
  }> {
    const tab = this.requireTab(tabId);
    const filled: Array<{ field: string; selector?: string; secret?: true }> = [];
    for (const field of fields) {
      const name = describeTarget(field.target);
      const focus = await tab.cdp.evaluate<{
        ok: boolean;
        reason?: string;
        inputType?: string;
        selector?: string;
      }>(buildFocusExpression(field.target));
      if (!focus.ok) {
        throw new Error(
          `第 ${filled.length + 1} 个字段（${name}）无法输入：${focus.reason ?? "unknown"}`,
        );
      }
      await this.typeInto(tab, field.target, field.value, {
        clear: field.clear !== false,
        ...(field.submit ? { submit: true } : {}),
      });
      filled.push({
        field: name,
        ...(focus.selector ? { selector: focus.selector } : {}),
        // The MCP layer masks every value whose field reported `secret`, so one
        // password in the middle of a form must not leak the rest of the call.
        ...(focus.inputType === "password" ? { secret: true as const } : {}),
      });
    }
    return { ok: true, filled };
  }

  /**
   * Runs a saved flow's steps against one tab.
   *
   * Every step goes through the same primitives the individual tools use, so a
   * flow clicks and types exactly like a person driving the app would. That is
   * the whole reason flows are step lists instead of page scripts.
   *
   * A failed step stops the run and reports where. Continuing would be worse:
   * the remaining steps assume the page reached the state this one was meant to
   * produce, and carrying on from a half-finished form creates real data on the
   * tested system. Steps marked `optional` (a wait that may time out) are the
   * one exception.
   */
  async runFlow(
    tabId: string,
    steps: FlowStep[],
    options: { baseUrl: string; vars: Record<string, string>; timeoutMs: number },
  ): Promise<FlowRunResult> {
    const tab = this.requireTab(tabId);
    const started = Date.now();
    const results: FlowStepResult[] = [];
    const vars = { ...options.vars };

    for (let index = 0; index < steps.length; index += 1) {
      if (Date.now() - started > options.timeoutMs) {
        return {
          ok: false,
          failedAt: index,
          reason: `流程超过 ${Math.round(options.timeoutMs / 1000)} 秒仍未跑完`,
          steps: results,
        };
      }
      const raw = steps[index] as FlowStep;
      const label = `第 ${index + 1} 步（${raw.action}）`;
      let step: FlowStep;
      try {
        step = interpolateStep(raw, vars);
      } catch (error) {
        return {
          ok: false,
          failedAt: index,
          reason: `${label}：${(error as Error).message}`,
          steps: results,
        };
      }

      const target = this.targetOf(step);
      try {
        let detail: string | undefined;
        switch (step.action) {
          case "navigate": {
            const url = this.resolveFlowUrl(step.url ?? "", options.baseUrl);
            await tab.view.webContents.loadURL(url).catch(() => {
              // An error page is the feedback; the navigation itself did happen.
            });
            // The next step starts immediately; on a guest the old document is
            // still the active context until the new one commits.
            if (this.options.guests) await this.whenReady(tab, url);
            this.syncTab(tab);
            detail = url;
            break;
          }
          case "fill": {
            const focus = await tab.cdp.evaluate<{
              ok: boolean;
              reason?: string;
              inputType?: string;
            }>(buildFocusExpression(target));
            if (!focus.ok) throw new Error(`无法输入：${focus.reason ?? "unknown"}`);
            // Some frameworks clear on focus; select-then-insert replaces the
            // old value without leaving a trailing fragment behind. The pointer
            // click inside `typeInto` is what makes a guest accept the input.
            await this.typeInto(tab, target, step.value ?? "", { clear: true });
            detail = focus.inputType === "password" ? "[redacted]" : step.value;
            break;
          }
          case "click": {
            const point = await tab.cdp.elementPoint(buildElementPointExpression(target));
            if (!point.ok || point.x === undefined || point.y === undefined) {
              throw new Error(`无法点击：${point.reason ?? "unknown"}`);
            }
            await tab.cdp.clickAt(point.x, point.y);
            // Same read-back as `click`; it also clears the marker the point
            // lookup left on the element.
            await tab.cdp.evaluate(buildClickHitExpression(point.x, point.y)).catch(() => {});
            detail = point.text;
            break;
          }
          case "select": {
            const selected = await tab.cdp.evaluate<{
              ok: boolean;
              reason?: string;
              available?: string[];
              text?: string;
            }>(buildSelectExpression(target, step.option ?? ""));
            if (!selected.ok) {
              const hint = selected.available?.length
                ? `（可选：${selected.available.join(" / ")}）`
                : "";
              throw new Error(`无法选择「${step.option}」：${selected.reason ?? "unknown"}${hint}`);
            }
            detail = selected.text;
            break;
          }
          case "press": {
            await tab.cdp.pressNamedKey(step.key ?? "");
            detail = step.key;
            break;
          }
          case "login": {
            const filled = await this.fillLogin(tabId);
            if (!filled.ok) throw new Error(`无法填充登录：${filled.reason ?? "unknown"}`);
            detail = filled.missingFields?.length
              ? `已填入账号密码，缺少字段：${filled.missingFields.join("、")}`
              : "已填入账号密码";
            break;
          }
          case "wait": {
            const outcome = await this.wait(tabId, {
              condition: step.condition ?? "visible",
              ...(step.condition === "text" || step.condition === "url" ? {} : { target }),
              ...(step.expect ? { text: step.expect } : {}),
              timeoutMs: step.timeoutMs ?? 5000,
            });
            if (!outcome.ok && !step.optional) {
              throw new Error(`等待超时：${outcome.reason ?? "unknown"}`);
            }
            detail = outcome.ok ? `等了 ${outcome.waitedMs}ms` : "超时，按可选项继续";
            break;
          }
          case "read": {
            const read = await tab.cdp.evaluate<{
              ok: boolean;
              reason?: string;
              value?: string;
            }>(buildReadExpression(target));
            if (!read.ok) throw new Error(`无法读取：${read.reason ?? "unknown"}`);
            if (step.as) vars[step.as] = read.value ?? "";
            detail = step.as ? `${step.as} = ${read.value}` : read.value;
            break;
          }
          default:
            throw new Error(`不认识的动作 ${String(step.action)}`);
        }
        this.syncTab(tab);
        results.push({ index, action: step.action, ok: true, ...(detail ? { detail } : {}) });
      } catch (error) {
        if (step.optional) {
          results.push({
            index,
            action: step.action,
            ok: false,
            optional: true,
            detail: (error as Error).message,
          });
          continue;
        }
        return {
          ok: false,
          failedAt: index,
          reason: `${label}失败：${(error as Error).message}`,
          steps: [
            ...results,
            { index, action: step.action, ok: false, detail: (error as Error).message },
          ],
          vars,
        };
      }
    }
    this.emitState();
    return { ok: true, steps: results, vars };
  }

  /** The element target of a step, or undefined for steps that act on the page. */
  private targetOf(step: FlowStep): TargetInput {
    if (step.selector) return { selector: step.selector };
    return {
      ...(step.label ? { label: step.label } : {}),
      ...(step.text ? { text: step.text } : {}),
      ...(step.role ? { role: step.role } : {}),
      ...(step.exact ? { exact: true } : {}),
    };
  }

  /** A step's url may be absolute or a path relative to the flow's site. */
  private resolveFlowUrl(url: string, baseUrl: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      throw new Error(`无法解析地址：${url}`);
    }
  }

  async evaluate<T>(tabId: string, expression: string): Promise<T> {
    const tab = this.requireTab(tabId);
    return tab.cdp.evaluate<T>(expression, { awaitPromise: true });
  }

  async screenshot(
    tabId: string,
    options: { format?: "png" | "jpeg"; quality?: number } = {},
  ): Promise<{ path: string; bytes: number }> {
    const tab = this.requireTab(tabId);
    // A page the user switched away from, or one in a minimised window, has no
    // compositor frames: the CDP path would stall until its timeout, while the
    // renderer still paints into an offscreen surface (measured: 41ms and a full
    // image against a 5s timeout). Decide before priming — priming captures the
    // *host*, which is exactly the thing that never answers in that state.
    const preferRenderer = !this.isOnScreen(tab);
    if (!preferRenderer) {
      // The embedder has to have painted before its guest can.
      await this.options.guests?.primeForCapture?.();
    }
    const buffer = await tab.cdp.screenshot({ ...options, preferRenderer });
    mkdirSync(this.options.shotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const extension = options.format === "jpeg" ? "jpg" : "png";
    const file = join(this.options.shotDir, `${tab.id.slice(0, 8)}-${stamp}.${extension}`);
    writeFileSync(file, buffer);
    return { path: file, bytes: buffer.length };
  }

  /**
   * Whether this page is currently painting on screen.
   *
   * Reads the three inputs `viewIsOnScreen` needs. The result only decides which
   * screenshot path to take, so a wrong answer costs a fallback, never
   * correctness.
   */
  private isOnScreen(tab: TabRecord): boolean {
    const host = this.host;
    if (!host || host.isDestroyed()) return false;
    if (tab.view.webContents.isDestroyed()) return false;
    return viewIsOnScreen(tab.view.getBounds(), this.hostContentSize(), {
      visible: host.isVisible(),
      minimized: host.isMinimized(),
    });
  }

  /**
   * Checks the tab's session against a protected path: an in-page fetch with
   * cookies (plus the site's localStorage token when configured), so the answer
   * reflects this tab's own partition, not a cached record. Callers use it to
   * decide whether a launch still needs a login.
   */
  async authProbe(
    tabId: string,
    checkPath: string,
    baseUrl: string,
    signedOutMarker?: string,
    token?: AuthTokenSource,
  ): Promise<{ ok: boolean; signedIn?: boolean; reason?: string }> {
    const tab = this.requireTab(tabId);
    let expected = "";
    try {
      expected = new URL(baseUrl).origin;
    } catch {
      return { ok: false, reason: "bad-site" };
    }
    let origin = "";
    try {
      origin = await tab.cdp.evaluate<string>("location.origin");
    } catch {
      return { ok: false, reason: "not-loaded" };
    }
    if (!origin || origin === "null") return { ok: false, reason: "not-loaded" };
    if (origin !== expected) return { ok: false, reason: "cross-origin" };
    let result: { ok?: boolean; body?: string } | undefined;
    try {
      // awaitPromise is mandatory here: the expression is an async IIFE around
      // a fetch, and without it Runtime.evaluate returns the unsettled Promise,
      // which serializes to `{}` — every probe would read as signed out.
      result = await tab.cdp.evaluate<{ ok: boolean; body?: string }>(
        buildAuthCheckExpression(checkPath, token),
        { awaitPromise: true },
      );
    } catch {
      return { ok: false, reason: "probe-failed" };
    }
    if (!result) return { ok: false, reason: "probe-failed" };
    // A 200 envelope that carries the site's signed-out marker is signed out,
    // no matter what the HTTP status says.
    const signedIn = result.ok === true && !bodyMarksSignedOut(result.body, signedOutMarker);
    return { ok: true, signedIn };
  }

  /** Fills the saved credentials of the tab's identity, when it has any. */
  async fillLogin(tabId: string): Promise<{
    ok: boolean;
    reason?: string;
    submitted?: boolean;
    missingFields?: string[];
  }> {
    const tab = this.requireTab(tabId);
    if (!tab.identityId) return { ok: false, reason: "no-identity" };
    const resolved = await this.options.resolveLogin?.(tab.identityId);
    if (!resolved) return { ok: false, reason: "no-password" };
    // The resolver's own words, not a generic "no password": it is the only
    // place that knows whether the account or its site is the one missing it.
    if (!resolved.ok) return { ok: false, reason: resolved.missing };
    const payload = resolved.payload;
    const origin = await tab.cdp.evaluate<string>("location.origin");
    // A tab created with a URL is still on about:blank for a moment, where
    // `location.origin` is the string "null". That is "not there yet", not a
    // cross-origin page: reporting it as cross-origin made the fill scheduler
    // give up on its first attempt and never type anything.
    if (!origin || origin === "null") return { ok: false, reason: "password-field-not-found" };
    let expected = "";
    try {
      expected = new URL(payload.baseUrl).origin;
    } catch {
      return { ok: false, reason: "bad-site" };
    }
    if (origin !== expected) return { ok: false, reason: "cross-origin" };
    return this.runFill(tab, payload);
  }

  private async runFill(
    tab: TabRecord,
    payload: EmbeddedLoginPayload,
  ): Promise<{ ok: boolean; reason?: string; submitted?: boolean; missingFields?: string[] }> {
    const result = await tab.cdp.evaluate<{
      ok: boolean;
      reason?: string;
      submitted: boolean;
      missingExtra: string[];
    }>(
      buildFillExpression({
        username: payload.username,
        password: payload.password,
        submit: payload.submit,
        extraFields: payload.extraFields,
      }),
    );
    if (!result.ok) return { ok: false, reason: result.reason ?? "fill-failed" };
    return {
      ok: true,
      submitted: result.submitted,
      missingFields: result.missingExtra,
    };
  }

  /**
   * In-page search. Chromium does the matching; the host only draws the bar.
   *
   * `findInPage` returns a request id and the result arrives on `found-in-page`,
   * possibly in several updates while the count settles. The first non-empty
   * final update is the answer; a tab with no matches resolves with zero.
   */
  async findInTab(
    tabId: string,
    text: string,
    options: { forward?: boolean; findNext?: boolean } = {},
  ): Promise<{ matches: number; activeMatch: number }> {
    const tab = this.requireTab(tabId);
    const contents = tab.view.webContents;
    if (!text) {
      contents.stopFindInPage("clearSelection");
      return { matches: 0, activeMatch: 0 };
    }
    return new Promise((resolve) => {
      let settled = false;
      let last = { matches: 0, activeMatch: 0 };
      let quietTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (quietTimer) clearTimeout(quietTimer);
        contents.removeListener("found-in-page", listener);
        resolve(last);
      };
      // Chromium reports an initial zero-count update before the real match list,
      // and a renderer that was just restored from minimised can be throttled
      // enough that the second update lands well after the first. A zero is
      // therefore only final once the stream has been quiet for a while.
      const hardTimer = setTimeout(finish, 6_000);
      const listener = (
        _event: unknown,
        result: { finalUpdate: boolean; matches: number; activeMatchOrdinal: number },
      ) => {
        if (!result.finalUpdate) return;
        last = { matches: result.matches, activeMatch: result.activeMatchOrdinal };
        if (quietTimer) clearTimeout(quietTimer);
        if (result.matches > 0) {
          finish();
          return;
        }
        quietTimer = setTimeout(finish, 900);
      };
      contents.on("found-in-page", listener);
      // Passing `findNext: false` explicitly makes Electron 44 emit no
      // `found-in-page` at all — a fresh search has to omit the field entirely.
      // Only a genuine "next match" call carries it.
      const forward = options.forward ?? true;
      if (options.findNext) contents.findInPage(text, { findNext: true, forward });
      else if (!forward) contents.findInPage(text, { forward: false });
      else contents.findInPage(text);
    });
  }

  stopFind(tabId: string): void {
    const tab = this.requireTab(tabId);
    tab.view.webContents.stopFindInPage("clearSelection");
  }

  /**
   * Zooms one page, the Ctrl +/- gesture.
   *
   * The step list mirrors Chrome's: 50/67/75/80/90/100/110/125/150/175/200.
   * Snapping to it means the same two keystrokes land on the same factor as a
   * real browser, instead of drifting through arbitrary percentages.
   */
  zoomBy(tabId: string, direction: "in" | "out" | "reset"): number {
    const tab = this.requireTab(tabId);
    // Ctrl +/- does nothing while a fixed viewport is active: the zoom factor is
    // the fit scale there, and stepping it would silently change the CSS
    // viewport size the mode promised. Reset exits viewport mode too, which is
    // the natural way back from the keyboard.
    const viewport = this.viewportOf(tab);
    if (viewport && direction !== "reset") {
      return Math.round((tab.viewportScale ?? 1) * 100);
    }
    // Reset clears the page's own choice, not the viewport feature as a whole:
    // with a workspace default in effect, "reset" means "back to what everything
    // else uses", which is the only reading that does not silently switch off a
    // global setting from one page's keyboard shortcut.
    if (viewport) this.setViewport(tabId, undefined);
    const current = tab.zoomOverride ?? this.defaultZoom;
    const next =
      direction === "reset"
        ? this.defaultZoom
        : clampZoom(ZOOM_STEPS[neighborZoomStep(current, direction)] ?? current);
    this.applyZoom(tab, next);
    // Reset means "back to the default", which is not an override.
    if (direction === "reset" || next === this.defaultZoom) delete tab.zoomOverride;
    else tab.zoomOverride = next;
    this.emitState();
    return next;
  }

  /**
   * Sets this page's own viewport, or clears the override.
   *
   * `size` pins the page; `null` is an explicit "adaptive even though a default
   * exists"; `undefined` returns it to following the workspace default. Those
   * three answers are the menu's three rows, and the difference between null and
   * undefined is visible in the chrome: "自适应" on this page while others still
   * follow the workspace default.
   *
   * The zoom override survives the trip: while a viewport is active the fit
   * scale owns the zoom factor, and going back to adaptive re-applies whatever
   * the page was zoomed to before, so the mode feels like a lens you put on and
   * take off rather than a setting that resets your zoom.
   */
  setViewport(
    tabId: string,
    size: EmbeddedViewport | null | undefined,
  ): EmbeddedViewport | null | undefined {
    const tab = this.requireTab(tabId);
    if (size === undefined) delete tab.viewportOverride;
    else tab.viewportOverride = size;
    if (!this.viewportOf(tab)) {
      delete tab.viewportScale;
      this.applyZoom(tab, tab.zoomOverride ?? this.defaultZoom);
    }
    this.applyLayout();
    this.emitState();
    return size;
  }

  private applyZoom(tab: TabRecord, percent: number): void {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    // A fixed viewport owns the zoom factor: it *is* the fit scale that keeps
    // the CSS viewport at the requested size. The percent is remembered on the
    // tab (`zoomOverride`) so leaving viewport mode restores it.
    if (this.viewportOf(tab)) {
      contents.setZoomFactor(tab.viewportScale ?? 1);
      return;
    }
    // `setZoomFactor` is per webContents and survives navigations within the
    // page, which is what a browser tab does. It does not leak to other pages:
    // each page has its own contents.
    contents.setZoomFactor(Math.min(2, Math.max(0.5, percent / 100)));
  }

  /**
   * Opens a DevTools panel docked beside the page, inside its own cell.
   *
   * The panel is a `WebContentsView` this manager owns and places; the tools are
   * pointed at it with `setDevToolsWebContents`. Electron's `mode: "right"` is
   * not usable here: under `titleBarOverlay` on Windows it opens a separate
   * window instead of docking (measured), and there is no way to dock tools into
   * a cell of an app-owned stage either way.
   *
   * A panel is per page and survives until it or the page is closed. Opening one
   * that already exists only brings it back to the dock — it is never rebuilt,
   * so console history survives toggling.
   */
  openDevTools(tabId: string): void {
    const tab = this.requireTab(tabId);
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    if (tab.devtools) {
      this.placeDevTools(tab);
      this.emitState();
      return;
    }
    /*
     * The panel gets its own session and no preload of ours.
     *
     * The front-end needs the `devtools://` scheme to resolve, which the page's
     * identity partition would refuse; it also must not inherit the app's
     * preload, since it is not our page. Background throttling is off because
     * the panel's content area is one large tiled layer: throttled, the tiles
     * stop rasterising while the chrome keeps its last frame, which reads as a
     * panel with a black middle.
     */
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#101317");
    const generation = (tab.devtoolsGeneration ?? 0) + 1;
    tab.devtoolsGeneration = generation;
    tab.devtools = { view, width: EMBEDDED_DEVTOOLS_DEFAULT, generation };
    this.host?.contentView.addChildView(view);
    /*
     * The panel owns its rectangle *before* the tools move in.
     *
     * `setDevToolsWebContents` points the front-end at a target while it is
     * still about to load. Given a 0×0 host it starts inside a zero box, and no
     * later resize brings the content layer back: the toolbar draws, Elements
     * stays empty and `DevToolsHost` is never created — a dock that looks alive
     * and inspects nothing. Measured on Electron 45 by reordering these two
     * calls and nothing else.
     */
    this.placeDevTools(tab, true);
    contents.setDevToolsWebContents(view.webContents);
    contents.openDevTools({ mode: "detach" });
    this.watchDevToolsKeys(tab);
    this.emitState();
  }

  /**
   * F12 / Ctrl+Shift+I while the focus sits inside the panel.
   *
   * The page's handler never sees those keys then, and without this the panel
   * would be a one-way door from the keyboard.
   *
   * keyDown only, and no auto-repeat: `before-input-event` fires twice for one
   * physical press (down and up), and this closes the panel on the first — so
   * acting on both would immediately reopen it. Same rule as every other
   * handler of this event in the app.
   */
  private watchDevToolsKeys(tab: TabRecord): void {
    const contents = tab.devtools?.view.webContents;
    if (!contents) return;
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      const key = input.key.toLowerCase();
      const modifier = process.platform === "darwin" ? input.meta : input.control;
      if (key === "f12" || (modifier && input.shift && key === "i")) {
        event.preventDefault();
        if (this.findTab(tab.id)) this.closeDevTools(tab.id);
      }
    });
  }

  closeDevTools(tabId: string): void {
    const tab = this.requireTab(tabId);
    this.dropDevTools(tab);
    this.applyLayout();
    this.emitState();
  }

  /** Tears the panel down: tools first, then the view that hosted them. */
  private dropDevTools(tab: TabRecord): void {
    const devtools = tab.devtools;
    if (!devtools) return;
    delete tab.devtools;
    const contents = tab.view.webContents;
    try {
      if (!contents.isDestroyed()) contents.closeDevTools();
    } catch {
      // The page may be gone already; the panel still has to be released.
    }
    this.host?.contentView.removeChildView(devtools.view);
    if (!devtools.view.webContents.isDestroyed()) devtools.view.webContents.close();
  }

  /**
   * Lays the panel out beside its page, or parks it when the page is off stage.
   *
   * The page and the tools are both native surfaces, so the HTML handle can only
   * be seen and grabbed in a real gap between them: the page gives up the right
   * part of its cell minus half the grip, and the panel starts half a grip later.
   * `applyLayout` has just written the page's full cell, so the two agree on the
   * same rectangle.
   *
   * `forOpening` is set by the one caller that runs before the tools have
   * loaded. It lets the panel fall back to the page's own rectangle when the
   * layout has not decided a cell yet (the stage is reported but this tab has
   * not been staged), because leaving the host at 0×0 there is permanent — see
   * the note in `openDevTools`.
   */
  private placeDevTools(tab: TabRecord, forOpening = false): void {
    const devtools = tab.devtools;
    const host = this.host;
    if (!devtools || !host || host.isDestroyed()) return;
    let rect = this.cellOf(tab);
    if (!rect && forOpening) {
      const reported = tab.view.getBounds();
      if (reported.width > 0 && reported.height > 0) {
        const origin = this.stage ?? { x: 0, y: 0 };
        rect = { ...reported, x: reported.x + origin.x, y: reported.y + origin.y };
      }
    }
    if (!rect) {
      // Off stage: keep the tools alive but out of sight, like any other page.
      this.parkDevTools(tab);
      return;
    }
    const split = Math.round(rect.width * (1 - devtools.width));
    const left = Math.max(1, split - Math.round(EMBEDDED_DEVTOOLS_GRIP / 2));
    tab.view.setBounds({ ...rect, width: left });
    /*
     * The panel gives up a band at its top for the app's own title strip.
     *
     * A native view cannot be covered by HTML, so the close button Edge and
     * Chrome draw inside their tools has no place to live here — the strip is
     * the area beside it instead. `EMBEDDED_DEVTOOLS_HEAD` is shared with the
     * renderer, which draws into exactly this hole.
     */
    const panelTop = rect.y + EMBEDDED_DEVTOOLS_HEAD;
    devtools.view.setBounds({
      x: rect.x + left + EMBEDDED_DEVTOOLS_GRIP,
      y: panelTop,
      width: Math.max(1, rect.width - left - EMBEDDED_DEVTOOLS_GRIP),
      height: Math.max(1, rect.height - EMBEDDED_DEVTOOLS_HEAD),
    });
    // A resize after the first paint has been observed to leave the panel's
    // content area unpainted — the chrome draws, the DOM tree does not — until
    // something asks for a repaint. The panel is resized on every layout pass,
    // so this is not cosmetic here.
    devtools.view.webContents.invalidate();
  }

  /** Keeps a panel out of sight without tearing it down. */
  private parkDevTools(tab: TabRecord): void {
    const devtools = tab.devtools;
    if (!devtools) return;
    devtools.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }

  /**
   * The cell a page occupies right now, in window DIP; undefined when off stage.
   *
   * Mirrors the geometry `applyLayout` places pages into, so a docked panel lands
   * on the same cell its page does — in a grid that is one cell, not the stage.
   */
  private cellOf(tab: TabRecord): StageRect | undefined {
    const stage = this.stage;
    if (!stage) return undefined;
    // A blank page draws nothing — the renderer owns that cell — so a panel must
    // not split a rectangle the page does not occupy.
    if (isBlankTab(tab)) return undefined;
    const view = this.activeView();
    if (!view) {
      if (this.activeTabId !== tab.id) return undefined;
      const active = this.activePageOf(tab.instanceId);
      if (!active || active.id !== tab.id) return undefined;
      return stage;
    }
    const slots = insetSlotRects(
      embeddedSlotRects(view.layoutId, stage, view.slotRects),
      stage,
    );
    const header = stageDrawsSlotHeaders(slots.length) ? EMBEDDED_SLOT_HEADER : 0;
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index];
      if (!slot) continue;
      if (this.pageForSlot(view, index)?.id !== tab.id) continue;
      return embeddedViewRect(slot, header);
    }
    return undefined;
  }

  /**
   * Live drag of the docked split.
   *
   * The pointer spends most of the drag over one of the two native views, so the
   * renderer cannot follow it there — HTML events stop at a native view's edge.
   * The main process polls the cursor and re-splits on every move instead, and
   * the drag ends from a mouse-up seen by either view (`input-event`) or by the
   * renderer's own pointerup when the pointer is back over app chrome.
   */
  beginDevToolsResize(tabId: string): void {
    const tab = this.requireTab(tabId);
    const host = this.host;
    if (!tab.devtools || !host || host.isDestroyed()) return;
    this.endDevToolsResize();
    const rect = this.cellOf(tab);
    if (!rect) return;
    // Publishing on every poll tick runs the renderer's full reactive pass at
    // 60 fps — clicks stop landing and the drag itself feels dead. Twelve
    // frames a second is still visually live for the page, and the release
    // below always publishes the exact landing spot.
    let lastPublish = 0;
    const move = (): void => {
      const live = this.findTab(tabId);
      if (!live?.devtools) {
        this.endDevToolsResize();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const content = host.getContentBounds();
      // Cursor and window bounds are both in screen DIP, so the difference is
      // the position inside the content area — the same space `cellOf` uses.
      const localX = cursor.x - content.x;
      const fraction = (rect.width - (localX - rect.x)) / rect.width;
      const next = Math.min(EMBEDDED_DEVTOOLS_MAX, Math.max(EMBEDDED_DEVTOOLS_MIN, fraction));
      if (Math.abs(next - live.devtools.width) < 0.001) return;
      live.devtools.width = next;
      this.placeDevTools(live);
      // The panel is a native view, so placeDevTools moves it for real; the
      // page is a renderer DOM node whose position follows the state (main's
      // own setBounds only records). Without publishing here the page keeps its
      // old width until mouse-up while the panel slides over it live.
      const now = Date.now();
      if (now - lastPublish >= 80) {
        lastPublish = now;
        this.emitState();
      }
    };
    const timer = setInterval(move, 16);
    const listeners: Array<{ contents: WebContents; handler: (event: ElectronEvent, input: InputEvent) => void }> = [];
    for (const contents of [tab.view.webContents, tab.devtools.view.webContents]) {
      // Only "did the pointer go up" matters here; the rest of the event is
      // ignored, but the signature has to match so the listener can be removed.
      const handler = (_event: ElectronEvent, input: InputEvent): void => {
        if (input.type === "mouseUp") this.endDevToolsResize();
      };
      contents.on("input-event", handler);
      listeners.push({ contents, handler });
    }
    this.devtoolsResize = { timer, listeners };
    move();
  }

  endDevToolsResize(): void {
    const session = this.devtoolsResize;
    if (!session) return;
    this.devtoolsResize = undefined;
    clearInterval(session.timer);
    for (const { contents, handler } of session.listeners) {
      if (!contents.isDestroyed()) contents.removeListener("input-event", handler);
    }
    // One state push for the whole drag: the renderer's handle jumps to where
    // the split actually landed.
    this.emitState();
  }

  /**
   * Toggles DevTools for whichever page the user is looking at.
   *
   * Called when the key never reached a page — the focus sat on the app's own
   * chrome — so "the focused page" is the one the stage is showing: the focused
   * page of the view on stage, or the active flat tab.
   */
  toggleDevToolsForFocusedPage(): void {
    const view = this.activeView();
    const tabId = view?.focusedTabId ?? this.activeTabId;
    const tab = tabId ? this.findTab(tabId) : undefined;
    if (!tab) return;
    if (this.devtoolsOpen(tab)) this.closeDevTools(tab.id);
    else this.openDevTools(tab.id);
  }

  /** Per-slot label height, exported so the chrome and the manager agree. */
  static readonly slotHeaderHeight = EMBEDDED_SLOT_HEADER;

}
