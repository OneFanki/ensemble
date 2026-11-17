import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDomSnapshotExpression,
  buildAttributeExpression,
  buildCheckExpression,
  buildClickHitExpression,
  buildDragPointsExpression,
  buildElementInfoExpression,
  buildElementPointExpression,
  buildElementRectExpression,
  buildFileInputExpression,
  buildFindByLocatorExpression,
  buildFocusExpression,
  buildReadExpression,
  buildSelectExpression,
  buildVisibilityExpression,
  buildWaitExpression,
  type DomSnapshot,
  describeTarget,
  locatorErrorText,
  locatorStaleHandleText,
  locatorUnknownHandleText,
  type ElementMatch,
  type ElementTarget,
  type LocatorMatches,
  type TargetInput,
  type VisibilityProbe,
  type WaitCondition,
  type WaitResult,
} from "@core/cdp/inspect";
import {
  PAGE_ACTIVITY_READ_SCRIPT,
  PAGE_ACTIVITY_SCRIPT,
  PAGE_LOG_LIMIT,
  PAGE_LOG_TEXT_LIMIT,
  buildNetworkIdleExpression,
  buildWaitResponseExpression,
  type PageActivity,
  type PageLogLevel,
  type PageNetworkEntry,
} from "@core/cdp/page-log";
import {
  bodyMarksSignedOut,
  buildAuthCheckExpression,
  buildFillExpression,
  type AuthTokenSource,
} from "@core/cdp/login";
import { checkCdpCommand } from "@core/cdp/flow-whitelist";
import {
  type PerfSample,
  type RawMetrics,
  deriveSample,
  pushSample,
} from "@core/cdp/performance";
import { shouldSleepPage } from "@core/cdp/sleep";
import type { MissingCredentialReason } from "@core/credentials/vault";
import { t } from "@core/i18n/translate";
import { primeDevToolsFrontendLanguage } from "./devtools-language";
import { type AiPageContext, aiOriginOf } from "@shared/ai-policy";
import {
  clampZoom,
  desktopUserAgent,
  EMBEDDED_DEVTOOLS_DEFAULT,
  EMBEDDED_DEVTOOLS_GRIP,
  EMBEDDED_DEVTOOLS_HEAD,
  EMBEDDED_DEVTOOLS_MAX,
  EMBEDDED_DEVTOOLS_MIN,
  EMBEDDED_DEFAULT_PROFILE_ID,
  EMBEDDED_PAGE_FRAME_GUTTER,
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
  PERF_SAMPLE_INTERVAL_DEFAULT_MS,
  PERF_WINDOW_DEFAULT_MS,
  normalizePerfSampleInterval,
  normalizePerfWindow,
  PERF_METRICS,
  perfSummarize,
  planTabClick,
  pointerInsidePage,
  resolveSlotPages,
  resolveSlotTabs,
  settleSplitPages,
  type EmbeddedDevice,
  type EmbeddedEmulation,
  type EmbeddedGeolocation,
  type EmbeddedViewport,
  type PerfMetric,
  type PerfMetricSummary,
  type StageRect,
  type TabSleepPolicy,
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
import {
  flowScriptValueToString,
  runFlowScript,
  type FlowScriptActions,
  type FlowScriptTarget,
} from "./flow-script";
import type { AppSettings, LayoutId, RoleColor, SlotRect } from "@shared/types";
import {
  app,
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
import { EmbeddedCdp, KEY_TABLE, MODIFIER_KEYS, type CdpExecutor } from "./cdp";
import { GuestPageSurface, type PageSurface } from "./surface";
import { GuestCdp, type GuestCdpTarget } from "./guest-cdp";
import { LOGIN_CAPTURE_BINDING, LOGIN_CAPTURE_SCRIPT } from "./login-capture";
import { applyProxyToSession } from "../proxy";

/**
 * Defaults for the background sleep: how long CDP traffic keeps a parked page
 * awake, and how often the sweep looks.
 *
 * The grace is generous on purpose: a polling wait or a slow flow re-marks the
 * page on every command, so the window only ever lapses on real idleness — an
 * AI session that stopped talking, a page parked while the user reads the
 * accounts page. The two are constructor options so an e2e can compress them
 * without waiting a minute for every transition.
 */
const SLEEP_GRACE_DEFAULT_MS = 60_000;
const SLEEP_SWEEP_DEFAULT_MS = 10_000;

/**
 * How long a JavaScript dialog may block its page before it is dismissed.
 *
 * A dialog blocks everything: no DOM read, no click, no screenshot. A caller that
 * opened one and then failed, or a person who walked away, would otherwise leave
 * the page unusable until the tab was closed. 30 seconds is long enough for a
 * human to read a confirm and for an AI step to answer it, and short enough that
 * the page comes back on its own.
 */
const DIALOG_AUTO_DISMISS_MS = 30_000;

/**
 * 每个标签页最多同时登记多少个元素句柄。
 *
 * 句柄是轻量定位描述符，但一个失控的循环可以登记到内存爆掉为止；超出就淘汰
 * 最早登记的——被淘汰的 id 此后报「句柄不存在」，重新 find 一次就回来。
 */
const ELEMENT_HANDLE_LIMIT = 64;

/** The sampling knobs in force right now, already range-checked. */
interface PerfConfig {
  intervalMs: number;
  windowMs: number;
}

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
  /**
   * Device this page is impersonating, when it is.
   *
   * Kept separate from `viewportOverride` because it is a different kind of
   * claim: the viewport is where the page lays out, the device is what the page
   * believes it is running on. Applying one means talking to CDP and pinning the
   * session; applying the other is pure geometry.
   */
  device?: EmbeddedDevice;
  /**
   * Per-page background-sleep override.
   *
   * Absent means "follow the default": a page that is off stage sleeps after an
   * idle period. `"never"` keeps this page running for as long as it exists.
   * In-memory like the zoom and viewport overrides — a tab does not survive a
   * restart, so a persisted policy would only apply to a page that is gone.
   */
  sleepPolicy?: TabSleepPolicy;
  /**
   * Output is muted for this page.
   *
   * A tab record field rather than a WebContents property alone: a reload
   * rebuilds the document but the record survives, and the user expects the
   * mute to survive with it.
   */
  muted?: boolean;
  /**
   * The user explicitly asked to hear this tab.
   *
   * Set by the speaker control, never by the AI. `muteForAi` reads it so an
   * automatic AI mute cannot override a person who just unmuted the page.
   */
  userUnmuted?: boolean;
  /**
   * This page has produced sound at least once in its life.
   *
   * Latched on the first audible report and never cleared for the life of the
   * tab record. The chrome gates the speaker control on this rather than on the
   * momentary `audible` flag: a page that never made sound has no audio state
   * worth showing, so it shows no speaker at all — muted or not.
   */
  everAudible?: boolean;
  /**
   * The current mute was applied by `muteForAi`, not by a person or the
   * explicit mute tool.
   *
   * `restoreAfterAi` clears the flag and lifts exactly that mute, so an AI
   * action leaves the page's sound state as it found it. A user touch of the
   * speaker control drops the flag: from then on the mute belongs to whoever
   * is holding the page, and the AI must not undo it.
   */
  aiMuted?: boolean;
  /**
   * Whether mouse input is currently being converted into touch input.
   *
   * Chromium's mouse-to-touch emulation also installs a native touch cursor on
   * the window. Keeping the conversion enabled while the pointer is away is
   * what made that gray dot follow the pointer over the toolbar and DevTools,
   * so the poller turns it on only for the page under the pointer. `undefined`
   * means "not applied yet" and lets a failed command be retried.
   */
  mouseTouchEnabled?: boolean;
  /**
   * The box this page's fixed viewport is fitted into, in window coordinates.
   *
   * Published stage-relative as `cell`. The resize frame needs it to know when
   * a drag would make the page exceed its box: the fit scale would drop and the
   * page would visibly shrink while the pointer keeps moving outwards.
   */
  fitCell?: StageRect;
  /**
   * Which tab of the docked panel is showing.
   *
   * Absent means the native front-end. The other two are ours, drawn by the
   * renderer — mutually exclusive with the front-end, because a native view
   * paints over anything the renderer draws and two owners of one rectangle
   * would fight.
   */
  devtoolsTab?: "front-end" | "device" | "performance";
  /**
   * Performance samples.
   *
   * Present while the performance tab is open, and for a while after an MCP read
   * (see `measurePerformance`): the panel's history is drawn, the agent's is
   * summarised. Not persisted — a history that outlived both readers would
   * describe a page nobody is profiling, and filling it pins the CDP session.
   */
  perf?: {
    history: PerfSample[];
    previous: RawMetrics | undefined;
    startedAt: number;
    /** Wall clock of the first sample, so `t` is an offset from it. */
    firstAt: number;
    timer?: ReturnType<typeof setTimeout>;
    /**
     * Who is sampling.
     *
     * The panel stops its sampler when its tab is hidden — leaving is the
     * signal that nobody is reading. An agent's sampler has no tab to watch, so
     * it stops after a quiet period instead, and the distinction is what keeps
     * the panel from being silently killed by an agent read or vice versa.
     */
    owner: "panel" | "ai";
    /** Last `t` an agent read, so the next read continues from there. */
    aiCursor?: number;
    /** Stops an agent-owned sampler once reads go quiet. */
    aiIdleTimer?: ReturnType<typeof setTimeout>;
  };
  /** Guards a stale sampling closure from writing after a restart. */
  perfGeneration?: number;
  /**
   * Scripts that run before any document loads, keyed by CDP's own id.
   *
   * Kept on the record rather than only in the CDP session for two reasons: the
   * session is released after 1.5s idle (which wipes the registrations), and the
   * renderer can replace a page's node at any moment, which gives a brand-new
   * guest with none of them. This map is the source of truth that both a session
   * reopen and a node replacement replay from.
   *
   * Holds page script, never credentials — a caller can already run anything it
   * likes through `evaluate`, so this grants no capability it did not have.
   */
  initScripts?: Map<string, { source: string; createdAt: string }>;
  /**
   * Environment overrides this page currently wears: timezone, media type,
   * offline and geolocation.
   *
   * The record is the echo a tool reads back — the CDP session itself does not
   * answer "what is overridden" — and it dies with the tab, so nothing here is
   * ever persisted. Any key here pins the CDP session (see `syncSessionHold`):
   * an idle detach would silently drop every override and the page would drift
   * back to reality mid-run.
   */
  emulation?: EmbeddedEmulation;
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
  crashed: boolean;
  /**
   * Console lines this page produced, newest last.
   *
   * Collected from the `console-message` event rather than from page script:
   * the page-side wrapper can only install after `did-finish-load`, which is
   * after the first lines — exactly the ones that explain why a page failed to
   * boot. The event fires for every line from the first document onward, and it
   * also covers messages a page cannot wrap (network errors, CSP violations).
   *
   * Capped at {@link PAGE_LOG_LIMIT}; dropped lines are counted so a reader can
   * say the history is partial instead of silently showing the tail.
   */
  consoleLog?: Array<{ at: string; level: PageLogLevel; text: string; source?: string }>;
  consoleDropped?: number;
  /**
   * The JavaScript dialog this page is showing right now, if any.
   *
   * Kept on the tab rather than inside a promise because the dialog outlives
   * every command: it stays up until somebody answers it, and while it is up the
   * page is blocked — measured on 45.2.1, the `Input.dispatchMouseEvent` that
   * opened it never returns, and neither does any `Runtime.evaluate` issued
   * afterwards. A tool that asks "is something in the way" has to answer from
   * this record alone rather than by asking the page.
   *
   * `autoDismiss` is the escape hatch: a caller that never comes back must not
   * leave the page wedged for the rest of the session.
   */
  dialog?: {
    type: "alert" | "confirm" | "prompt" | "beforeunload";
    message: string;
    defaultPrompt?: string;
    url?: string;
    openedAt: number;
    /** Drops the dialog if nobody answers it; cleared when one is answered. */
    autoDismiss?: ReturnType<typeof setTimeout>;
  };
  /**
   * Unsubscribes the CDP listener that fills in `dialog`.
   *
   * Per tab because the executor is rebuilt with the carrier while the record
   * survives it — closing a page has to unsubscribe, or the listener outlives
   * the page it describes.
   */
  dialogListener?: () => void;
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
  /**
   * 本标签页登记过的元素句柄（`find_browser_element` 的产物），id → 存储的定位
   * 描述符。
   *
   * **句柄是定位描述符的持久化，不是节点身份。** 登记时不保存任何 DOM 引用或
   * backendNodeId——页面一重渲染它们就全部失效。使用时用存储的 locator 在当前
   * 文档里重新解析；定位命中的元素换了 DOM 节点没关系，「同一定位描述的同一
   * 逻辑元素」还在原处。定位命中多个时，按句柄记住的文本特征（登记时或上次
   * 命中时选中那一项的文本，见 `trait`）对齐；对不齐就报「匹配 N 个」，不猜。
   *
   * 只存在内存里，随标签页消亡；跨标签页永不共享——句柄 id 只在本 tab 的这张
   * 表里有效，别的表查不到就报「句柄不存在」。
   */
  elementHandles?: Map<string, { locator: ElementTarget; trait: string | null; createdAt: string }>;
  /** 句柄 id 的页内自增序列，保证 id 单调唯一。 */
  elementHandleSeq?: number;
  /**
   * 导航前存在、导航后失效的句柄 id。
   *
   * 拿它区分「页面已导航，句柄失效，请重新 find」（id 在这里）与「句柄不存在」
   * （哪里都没有）——前者指引重查，后者说明参数就给错了，两种修法不同。
   */
  staleHandleIds?: Set<string>;
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
   * loop with it. The sweep freezes a parked page once its grace has lapsed
   * and no CDP command is in flight; the first CDP command of an AI burst wakes
   * it before the command runs (`GuestCdp`'s activity hook awaits the wake),
   * and re-staging or navigation wakes it too. A page can opt out with
   * `sleepPolicy: "never"`. Headless runs keep this off: their timing
   * assertions assume pages run unthrottled.
   */
  aiIdleFreeze?: boolean;
  /** How long AI traffic keeps a parked page awake; defaults to 60 seconds. */
  sleepGraceMs?: number;
  /** How often the sleep sweep runs; defaults to 10 seconds. */
  sleepSweepMs?: number;
  /**
   * How long a JavaScript dialog may block its page before it is dismissed.
   *
   * An option rather than a constant so an e2e can compress it instead of
   * waiting 30 seconds per case.
   */
  dialogAutoDismissMs?: number;
  /**
   * Whether a flow's raw `cdp` step may use the optional tier.
   *
   * A function, not a boolean: flows run long after the browser was
   * constructed, and the setting can change in between. Reading it per run is
   * what makes "the setting is off now" mean what the user expects.
   */
  flowCdpExtended?: () => boolean;
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
    /** Tenant and any other fields the form asked for, as typed. */
    extraFields?: { label: string; value: string }[];
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
 * 直连定位命中多个时的非致命提醒。
 *
 * 直连路径的历史行为是「取排名第一的元素」，保持不变——把它改成报错会让每一
 * 个组件库页面的常规调用都失败。但静默取第一个正是试运行里点错元素的那类事故：
 * 调用方有权知道「匹配不止一个」。页内 resolveTarget 现在随命中带回 matchCount，
 * count > 1 时把它翻成一句话。句柄路径的严格归属（对齐或报「匹配 N 个」）在
 * resolveActionTarget 里已经完成，解析成功带显式 nth 重新定位；调用方自己给了
 * nth 的同理——两者都不再重复提醒。
 */
function multiMatchWarning(target: TargetInput, count: number | undefined): string | undefined {
  if (typeof count !== "number" || count <= 1) return undefined;
  if (typeof target !== "string" && target.nth !== undefined) return undefined;
  return `${describeTarget(target)} 匹配 ${count} 个元素，已操作第 1 个；要精确请用 find_browser_element 收窄或 nth`;
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
 * Has a navigation landed?
 *
 * Exported because the rule is easy to get subtly wrong and the cost of getting
 * it wrong is invisible: a comparison that only accepted the requested address
 * made every login page (`/` → `/login`, `/login` → `/home`) sit out the whole
 * ten-second deadline. It did not fail, it just felt like the app was slow.
 *
 * Three ways to have arrived:
 *  1. the address we asked for, trailing slash aside;
 *  2. any *other* address, once the document is parsed — the redirect case;
 *  3. when we do not know where we started, only (1) is trustworthy.
 */
export function navigationArrived(input: {
  href: string;
  state: string;
  wanted: string;
  startedFrom?: string;
}): boolean {
  const parsed = input.state === "interactive" || input.state === "complete";
  if (!parsed) return false;
  if (input.href === input.wanted || sameDocumentUrl(input.href, input.wanted)) return true;
  // A redirect: the page is no longer on the document it left, which is enough
  // to say the navigation we asked for has happened.
  return Boolean(input.startedFrom) && input.href !== input.startedFrom;
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
  /** Polls the system pointer while a touch page is on stage. */
  private touchCursorTimer?: ReturnType<typeof setInterval>;

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
  /**
   * Profile each instance was opened under.
   *
   * Also per instance rather than per page, and for the same reason as `clean`:
   * a popup must inherit the profile its opener lives in, or completing an OAuth
   * handshake would drop the resulting cookie into a different jar than the page
   * that started it. Absent means the built-in default profile.
   */
  private instanceProfiles = new Map<string, string>();
  /** Instances whose profile is ephemeral (nothing survives the process). */
  private ephemeralInstances = new Set<string>();
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
  /** True while a stage-covering menu has the docked DevTools panels parked. */
  private devtoolsParked = false;
  /**
   * The DevTools front-end language was seeded in this run.
   *
   * Priming loads the front-end once before the panel exists; doing that for
   * every panel would double the first paint of each new DevTools view.
   */
  private devtoolsLanguagePrimed = false;
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
   * Sampling cadence and chart window, mirrored from settings.
   *
   * Held here rather than read from settings at each tick: the sampler runs in a
   * timer chain on the main thread, and reaching into the settings store from
   * there would make every 200ms tick depend on disk-backed state.
   */
  private perfConfig: PerfConfig = {
    intervalMs: PERF_SAMPLE_INTERVAL_DEFAULT_MS,
    windowMs: PERF_WINDOW_DEFAULT_MS,
  };
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
  /** The two sleep timings, from options so an e2e can compress them. */
  private readonly sleepGraceMs: number;
  private readonly sleepSweepMs: number;
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
    this.sleepGraceMs = options.sleepGraceMs ?? SLEEP_GRACE_DEFAULT_MS;
    this.sleepSweepMs = options.sleepSweepMs ?? SLEEP_SWEEP_DEFAULT_MS;
    // The sweep must exist from construction, not from the first CDP command:
    // it used to be armed lazily inside `markCdpActivity`, so a session with no
    // AI traffic — the common one — never froze anything at all.
    if (options.aiIdleFreeze) {
      this.freezeSweep = setInterval(() => this.sweepFrozenCandidates(), this.sleepSweepMs);
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
   * Applies the sampling settings.
   *
   * Both numbers are read at sampling time rather than captured when a page is
   * created, so a change has to reach the samplers already running. They are
   * restarted rather than re-tuned in place: the interval lives in a `setTimeout`
   * chain and the window decides what history is kept, and a chart drawn half at
   * one cadence and half at another has a subtle lie in its x axis — the gap
   * between two points would not mean what the spacing says.
   *
   * The restart is cheap and only affects pages whose panel is showing the
   * performance tab, because that is the only time a sampler exists for the
   * panel. An AI-owned sampler is left alone: it has its own cursor and the agent
   * is mid-measurement.
   */
  setPerfConfig(config: { intervalMs?: number; windowMs?: number }): void {
    const next: PerfConfig = {
      intervalMs: normalizePerfSampleInterval(config.intervalMs ?? this.perfConfig.intervalMs),
      windowMs: normalizePerfWindow(config.windowMs ?? this.perfConfig.windowMs),
    };
    if (
      next.intervalMs === this.perfConfig.intervalMs &&
      next.windowMs === this.perfConfig.windowMs
    ) {
      return;
    }
    this.perfConfig = next;
    for (const tab of this.tabs) {
      if (tab.perf?.owner !== "panel") continue;
      void this.startPerfSampling(tab, "panel");
    }
  }

  /**
   * The size a page actually renders at.
   *
   * One resolution order for the whole surface: a device wins over everything —
   * it *is* a size, and the page has been told to lay out at exactly that size —
   * then an explicit page choice, then the workspace default, then the cell.
   * Every reader (`describe`, `placePageSurface`, `applyZoom`, `zoomBy`) goes
   * through this so the chrome and the geometry can never disagree.
   */
  private viewportOf(tab: TabRecord): EmbeddedViewport | undefined {
    if (tab.device) return { width: tab.device.width, height: tab.device.height };
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
      this.stopTouchCursorPoller();
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
      this.syncTouchCursorPoller();
    });
    win.on("focus", () => this.syncTouchCursorPoller());
    win.on("blur", () => this.stopTouchCursorPoller());
    win.on("minimize", () => this.stopTouchCursorPoller());
    win.on("restore", () => this.syncTouchCursorPoller());
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
      ...(this.devtoolsParked ? { devtoolsParked: true } : {}),
      carrier: "guest",
    };
  }

  private describe(tab: TabRecord): EmbeddedTab {
    const contents = tab.view?.webContents;
    const effectiveViewport = this.viewportOf(tab);
    const pending = !contents || contents.isDestroyed();
    const audible = Boolean(contents && !contents.isDestroyed() && contents.isCurrentlyAudible());
    const clean = this.cleanInstances.has(tab.instanceId);
    /*
     * The default profile is not a missing value.
     *
     * Leaving `profileId` absent made readers infer the profile from the
     * partition string, whose legacy literal contains "clean". A page that is
     * neither an identity nor a throwaway is the built-in default profile, so
     * say that explicitly.
     */
    const profileId =
      this.instanceProfiles.get(tab.instanceId) ??
      (clean || tab.identityId ? undefined : EMBEDDED_DEFAULT_PROFILE_ID);
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
      ...(clean ? { clean: true } : {}),
      ...(profileId ? { profileId } : {}),
      partition: this.partitionOf(tab),
      active: this.instanceActive.get(tab.instanceId) === tab.id,
      ...(tab.muted ? { muted: true } : {}),
      ...(audible ? { audible: true } : {}),
      ...(tab.everAudible ? { everAudible: true } : {}),
      ...(this.frozenTabs.has(tab.id) ? { sleeping: true } : {}),
      ...(tab.dialog
        ? {
            dialog: {
              type: tab.dialog.type,
              message: tab.dialog.message,
              ...(tab.dialog.defaultPrompt ? { defaultPrompt: tab.dialog.defaultPrompt } : {}),
            },
          }
        : {}),
      ...(tab.sleepPolicy ? { sleepPolicy: tab.sleepPolicy } : {}),
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
      ...(tab.device ? { device: { ...tab.device } } : {}),
      devtoolsOpen: this.devtoolsOpen(tab),
      ...(tab.devtools ? { devtoolsWidth: tab.devtools.width } : {}),
      ...(tab.devtoolsTab ? { devtoolsTab: tab.devtoolsTab } : {}),
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
            /*
             * The cell is published for the resize frame, and only while the
             * page is actually on stage: a parked page keeps the cell it had
             * before it left, which would describe a box nothing is fitted into.
             * Converted to the same stage-relative space as `bounds` so the
             * renderer can compare the two without a second origin.
             */
            ...(tab.fitCell && this.stage && this.stagedTabs.has(tab.id)
              ? {
                  cell: {
                    x: tab.fitCell.x - this.stage.x,
                    y: tab.fitCell.y - this.stage.y,
                    width: tab.fitCell.width,
                    height: tab.fitCell.height,
                  },
                }
              : {}),
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
    if (stage) this.syncTouchCursorPoller();
    else this.stopTouchCursorPoller();
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

  /** Profile an instance was opened under; absent means the built-in default. */
  private profileOfInstance(instanceId: string): string | undefined {
    return this.instanceProfiles.get(instanceId);
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
    /** Start with output muted; AI-created pages pass true. */
    muted?: boolean;
    /**
     * Open with no shared state at all.
     *
     * Only an explicit "clean open" sets this. A page with no identity that
     * omits it lands in the default profile — that is what makes a bookmark and
     * a typed address reuse the login the user already has.
     */
    clean?: boolean;
    /**
     * Profile to open in when the page has no identity. Absent means the
     * default, so every caller that predates profiles keeps its behaviour.
     */
    profileId?: string;
    /** True when the resolved profile is ephemeral (a "clean" profile row). */
    ephemeral?: boolean;
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
    /*
     * The profile a popup belongs to is its opener's, never a fresh default.
     *
     * Same reason as `clean`: a login flow that opens a popup must stay in the
     * profile it started in, or the sign-in completes into a different cookie
     * jar than the page that asked for it.
     */
    const profileId = input.profileId ?? this.profileOfInstance(instanceId);
    const ephemeral = input.ephemeral ?? this.ephemeralInstances.has(instanceId);
    const partition = embeddedTabPartition({
      ...(identityId ? { identityId } : {}),
      clean,
      instanceId,
      ...(profileId ? { profileId } : {}),
      ephemeral,
    });
    // Remembered per instance: neither `clean` nor the profile is part of the tab
    // record, and the next page opened by this instance has to agree with it.
    if (clean || ephemeral) this.cleanInstances.add(instanceId);
    if (profileId) this.instanceProfiles.set(instanceId, profileId);
    if (ephemeral) this.ephemeralInstances.add(instanceId);
    this.configureSession(partition);
    /*
     * Resolve the target before the tab exists.
     *
     * Two reasons. An unusable address should fail before anything is published,
     * so no tab flashes in and out. More importantly, the tab's `url` is what
     * decides whether the stage draws the app's own new-tab surface — and that
     * surface was being shown for the whole load: the record said `about:blank`
     * until `loadURL` resolved, so opening an account showed a new tab, sat
     * there while the site's first byte arrived, and only then switched to the
     * page. A browser shows the page it is loading, not the page it is leaving.
     */
    const target = normalizeEmbeddedUrl(input.url ?? "about:blank");
    if (!target) throw new Error("只支持 http(s) 地址");
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
      // A popup inherits how its opener is being listened to; a fresh tab
      // starts muted only when its creator asked for it (AI-opened pages).
      ...((input.muted ?? parent?.muted) ? { muted: true } : {}),
      ...(parent?.userUnmuted ? { userUnmuted: true } : {}),
      origin: input.origin ?? parent?.origin ?? "manual",
      instanceId,
      ...(input.openerId ? { openerId: input.openerId } : {}),
      // Placeholder until the node attaches; nothing may touch it before
      // `openCarrier` returns, because a guest page has no `webContents` until
      // the renderer creates one.
      view: null as unknown as PageSurface,
      cdp: null as unknown as CdpExecutor,
      // The address it is *going to*, from the first broadcast. A browser's tab
      // says where it is heading while it loads; saying `about:blank` until the
      // load finishes made the stage draw the new-tab surface instead.
      url: target,
      title: "",
      // Set immediately: the tab strip shows a spinner from this, and without
      // it the strip claimed the page was already done while it was loading.
      loading: true,
      crashed: false,
    };
    this.tabs.push(tab);
    /*
     * Claim the stage in the same broadcast that announces the tab.
     *
     * `openCarrier` below waits for the renderer to mount the guest node — a
     * round trip of a few hundred milliseconds, longer on a busy machine. While
     * `activeTabId` still pointed at the previous (blank) page, the stage kept
     * drawing the new-tab surface for that whole window; the user reads it as
     * "clicked an account, got a new tab, waited". Selecting the tab here means
     * the very first state the renderer sees is already the loading page.
     */
    this.activeTabId = id;
    this.setActivePage(tab);
    this.emitState();
    const carrier = await this.openCarrier({ tabId: id, partition, url: target });
    tab.view = carrier.view;
    tab.cdp = carrier.cdp;
    // Before the first document can make noise: a tab created muted has to be
    // muted from its first frame, not after the first state broadcast.
    tab.view.webContents.setAudioMuted(Boolean(tab.muted));
    this.wireTab(tab);
    // A new page starts at the global default; only a deliberate keystroke
    // creates an override, so the setting keeps applying to everything else.
    this.applyZoom(tab, parent ? (parent.zoomOverride ?? this.defaultZoom) : this.defaultZoom);

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
    /*
     * Publish the switch before waiting out the load.
     *
     * `loadURL` resolves on `did-finish-load`, seconds away on a slow site, and
     * the only broadcast so far was the one right after `push` — at which point
     * `activeTabId` still named the previous (blank) page. The renderer
     * therefore kept drawing the new-tab surface for the whole load and the
     * real page appeared only at the end. The tab already carries its
     * destination and `loading: true`; saying so here is what turns "stuck on a
     * new tab" into "loading, address already filled".
     */
    this.emitState();

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
    return new GuestCdp(
      guests.targetFor(tabId),
      tabId,
      (id, visible) => guests.present(id, visible),
      // Every AI-facing command goes through this executor. Waking here is what
      // makes a frozen page usable again without the sweep having to poll.
      () => this.markCdpActivity(tabId),
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
      /*
       * Added on every document, not once per tab.
       *
       * `Runtime.addBinding` looks target-wide, but the function it exposes is
       * installed on each execution context, and a submitted native form is
       * exactly the moment the document is replaced: the page that held the
       * filled-in fields navigates, and the next document comes up without
       * `__ensembleLoginCaptured`. A per-tab "already added" flag therefore
       * dropped the one capture that mattered most — the plain
       * `<form action=...>` login, which is still the common case outside
       * single-page apps. Re-adding is a no-op that throws, so that is caught and
       * ignored; the cost of the redundant call is one CDP command per load.
       */
      await tab.cdp.send("Runtime.addBinding", { name: LOGIN_CAPTURE_BINDING }).catch(() => {});
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
   * Installs the console/network collector in the current document.
   *
   * Same per-document rule as login capture: a navigation replaces `window`, so
   * the script has to run again on every document. Unlike login capture it does
   * not need a held session — it collects into a page-side buffer that a later
   * read picks up, so losing the debugger in between costs nothing.
   *
   * Best-effort: a page that is still loading, or one whose document changed
   * under us, simply has no collector, and a read reports `installed: false`
   * instead of failing the tool call.
   */
  private async installPageActivity(tab: TabRecord): Promise<void> {
    if (tab.view.webContents.isDestroyed()) return;
    try {
      await tab.cdp.evaluate(PAGE_ACTIVITY_SCRIPT);
    } catch {
      // Nothing to instrument yet; the next read installs on demand.
    }
  }

  /**
   * Returns what the page logged and requested since the previous read.
   *
   * Two sources, merged, because neither alone is enough:
   *
   * - **Console** lines come from the `console-message` event in main. That
   *   fires from the first line of the first document; a page-side wrapper only
   *   installs after `did-finish-load` and would miss the boot failure that is
   *   usually the whole answer.
   * - **Network** activity comes from the page-side collector, because knowing
   *   a request is *in flight* needs a hook around `fetch`/XHR, and there is no
   *   event for that without a pinned CDP session.
   *
   * Reading clears both, so the next call answers "what happened since".
   */
  async readPageActivity(tabId: string): Promise<PageActivity> {
    const tab = this.requireTab(tabId);
    await this.installPageActivity(tab);
    const page = await tab.cdp.evaluate<PageActivity>(PAGE_ACTIVITY_READ_SCRIPT, {
      awaitPromise: true,
    });
    const fromMain = tab.consoleLog ?? [];
    const droppedFromMain = tab.consoleDropped ?? 0;
    const hadMainLines = fromMain.length > 0;
    tab.consoleLog = [];
    tab.consoleDropped = 0;
    // Main-side lines are the ones a page-side wrapper could not see (and the
    // ones it could: both channels are real, and a double-reported line is more
    // honest than dropping one). Sorted by time so the order reads right.
    const logs = [...page.logs, ...fromMain].sort((a, b) => a.at.localeCompare(b.at));
    return {
      ...page,
      logs,
      installed: page.installed || hadMainLines,
      dropped: page.dropped + droppedFromMain,
    };
  }

  /**
   * Reads the page's settled requests **without consuming anything**.
   *
   * The collector keeps a rolling window of the last settled `fetch`/XHR
   * entries, and `readPageActivity` already treats it as peekable — the window
   * is only ever trimmed by new traffic, never by a read. This method therefore
   * needs no cursor and no clearing: it runs the same read expression and
   * reports the window (filtered, bounded), and a later `readPageActivity` — the
   * console tool — still sees everything this call saw. The only thing this
   * deliberately does *not* touch is the console log, which remains the console
   * tool's consume-on-read channel.
   *
   * In-flight requests are reported alongside so "the page is calling something
   * and it has not come back yet" is visible instead of reading as silence.
   */
  async readRequests(
    tabId: string,
    options: {
      /** URL substring, case-insensitive. */
      url?: string;
      /** Exact method, case-insensitive ("GET", "POST"). */
      method?: string;
      /** Exact settled status. Failed requests never match a status. */
      status?: number;
      /** Cap on returned entries, oldest dropped. Default all. */
      limit?: number;
    } = {},
  ): Promise<{
    requests: PageNetworkEntry[];
    inflight: Array<{ method: string; url: string; at: string; ms: number }>;
    installed: boolean;
  }> {
    const tab = this.requireTab(tabId);
    await this.installPageActivity(tab);
    const page = await tab.cdp.evaluate<PageActivity>(PAGE_ACTIVITY_READ_SCRIPT, {
      awaitPromise: true,
    });
    const needle = options.url?.trim().toLowerCase() ?? "";
    const method = options.method?.trim().toUpperCase() ?? "";
    const limit =
      Number.isFinite(options.limit) && (options.limit as number) > 0
        ? Math.trunc(options.limit as number)
        : undefined;
    const matched = page.recent.filter((entry) => {
      if (needle && !entry.url.toLowerCase().includes(needle)) return false;
      if (method && entry.method.toUpperCase() !== method) return false;
      if (options.status !== undefined && entry.status !== options.status) return false;
      return true;
    });
    return {
      requests: limit === undefined ? matched : matched.slice(-limit),
      inflight: page.inflight,
      installed: page.installed,
    };
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
    const profileId = this.instanceProfiles.get(tab.instanceId);
    return embeddedTabPartition({
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      clean: this.cleanInstances.has(tab.instanceId),
      instanceId: tab.instanceId,
      ...(profileId ? { profileId } : {}),
      ephemeral: this.ephemeralInstances.has(tab.instanceId),
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
    /*
     * Console history, straight from the renderer.
     *
     * This event fires from the first line of the first document, which is why
     * it is the primary source rather than a page-side wrapper: a wrapper can
     * only install after `did-finish-load`, and by then a page that failed to
     * boot has already printed the reason. It also reports things page script
     * cannot wrap — network failures, CSP violations, blocked mixed content.
     */
    contents.on("console-message", (details) => {
      // The first argument is the structured record; the positional `level` /
      // `message` that follow it are the deprecated form kept for old callers.
      const level: PageLogLevel =
        details.level === "error"
          ? "error"
          : details.level === "warning"
            ? "warn"
            : details.level === "info"
              ? "info"
              : "debug";
      const log = (tab.consoleLog ??= []);
      if (log.length >= PAGE_LOG_LIMIT) {
        log.shift();
        tab.consoleDropped = (tab.consoleDropped ?? 0) + 1;
      }
      const text = String(details.message ?? "").slice(0, PAGE_LOG_TEXT_LIMIT);
      if (!text) return;
      log.push({
        at: new Date().toISOString(),
        level,
        text,
        ...(details.sourceId ? { source: details.sourceId } : {}),
      });
    });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title;
      update();
    });
    // A page that starts or stops making sound changes which icon the strip
    // should draw; without this event the speaker would wait for an unrelated
    // title/navigation update. The first audible report also latches
    // `everAudible`: the icon gate reads "has made sound", not "is making
    // sound", so a page that has gone quiet again keeps its speaker control.
    contents.on("audio-state-changed", () => {
      if (contents.isCurrentlyAudible()) tab.everAudible = true;
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
      /*
       * 元素句柄挂在文档上：跨文档导航（含刷新）之后，定位描述符描述的页面已经
       * 不存在，整体失效。旧 id 记入 staleHandleIds，此后使用报「页面已导航，
       * 句柄失效，请重新 find」而不是「句柄不存在」——两种情况该做的事不同。
       * 页内导航（did-navigate-in-page）不换文档，描述符仍然成立，不清空。
       */
      if (tab.elementHandles?.size) {
        const stale = tab.staleHandleIds ?? new Set<string>();
        for (const id of tab.elementHandles.keys()) stale.add(id);
        tab.staleHandleIds = stale;
      }
      tab.elementHandles = new Map();
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
      const extra = Array.isArray((parsed as { extraFields?: unknown }).extraFields)
        ? ((parsed as { extraFields: unknown[] }).extraFields
            .filter(
              (item): item is { label: string; value: string } =>
                Boolean(item) &&
                typeof item === "object" &&
                typeof (item as { label?: unknown }).label === "string" &&
                typeof (item as { value?: unknown }).value === "string",
            )
            .map((item) => ({ label: item.label.slice(0, 40), value: item.value.slice(0, 200) })))
        : [];
      this.options.onLoginCaptured?.({
        tabId: tab.id,
        username: parsed.username.trim().slice(0, 200),
        password: parsed.password.slice(0, 500),
        origin: parsed.origin,
        path: typeof parsed.path === "string" ? parsed.path : "/",
        ...(extra.length ? { extraFields: extra } : {}),
      });
    });
    contents.on("did-finish-load", () => {
      void this.installLoginCapture(tab);
      // A reload keeps the tab record, so the mute has to be put back on the
      // new document; a page the user muted must not come back talking.
      contents.setAudioMuted(Boolean(tab.muted));
      // Started at load, not only at first read: a caller asking "why did the
      // page break" wants the errors that happened before it thought to look.
      void this.installPageActivity(tab);
      /*
       * Re-apply a device after every navigation.
       *
       * A cross-document navigation replaces the renderer's view of the world,
       * and the metrics override does not follow it. Without this, clicking any
       * link on a page being tested as a phone dropped the page back to a
       * desktop viewport mid-flow — the exact moment the emulation matters.
       * `applyDevice` is a no-op when the device has not changed, so this costs
       * nothing on pages that are not being emulated.
       */
      if (tab.device) void this.applyDevice(tab, tab.device, { reapply: true });
    });
    /*
     * JS 弹窗会卡死页面，所以从页面一创建就盯着。
     *
     * 实测（Electron 45.2.1）：`confirm()` 打开后，**触发它的
     * `Input.dispatchMouseEvent` 永远不返回**，之后的 `Runtime.evaluate` 也一样
     * ——页面被阻塞在弹窗上。默认的 30 秒单命令上限会把一次 click 变成一次超时，
     * 调用方看到的却是「点了没反应」。而 `Page.handleJavaScriptDialog` 在弹窗
     * 打开期间仍能正常应答，所以只要知道有弹窗，就能把页面解开。
     *
     * 监听必须在这里注册，不能等到某个工具调用时：事件不重放，等工具跑起来时
     * 事件早就过去了。`Page.enable` 由 guest manager 的会话建立钩子保证（会话
     * 空闲释放后重开时会重放），所以订阅本身跟着 executor 走，不跟着会话走。
     */
    this.trackDialogs(tab);
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
    /*
     * Ctrl + wheel, which is how most people zoom.
     *
     * Electron does not bind it, and without this handler the gesture reaches
     * the page and is either ignored or — worse — scrolls the page diagonally,
     * because Chromium treats ctrl+wheel as a pinch on some platforms. Routing
     * it through `zoomBy` also means the overlay and the clamp behave exactly
     * like the keyboard.
     */
    contents.on("zoom-changed", (_event, direction) => {
      this.zoomBy(tab.id, direction === "in" ? "in" : "out");
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
   *
   * A redirect to a *different path* is the normal shape of a login page
   * (`/` → `/login`, `/login` → `/home`), so a URL comparison against the
   * requested address is not a reliable arrival test on its own: matching only
   * the requested path made every such navigation wait out the whole deadline.
   * A ten-second stall did not read as "a redirect happened", it read as the app
   * being slow. Arrival is therefore either "the URL we asked for" or "any URL
   * other than the one we started from, fully parsed" — both mean the document
   * that is now loaded is the new one.
   */
  private async whenReady(
    tab: TabRecord,
    url: string,
    startedFrom?: string,
    timeoutMs = 10_000,
  ): Promise<void> {
    const startedAt = Date.now();
    const wanted = normalizeEmbeddedUrl(url) ?? url;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const ready = await tab.cdp.evaluate<{ href: string; state: string }>(
          "({ href: location.href, state: document.readyState })",
        );
        if (navigationArrived({ ...ready, wanted, startedFrom })) return;
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
    // Where the page is before we ask it to move. A redirect off this address is
    // arrival too, and the only way to tell "redirected" from "not yet moved" is
    // to remember what was on screen.
    const before = (() => {
      try {
        return tab.view.webContents.getURL();
      } catch {
        return "";
      }
    })();
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
      await this.whenReady(tab, target, before);
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
   * Zooms whatever page the chrome is currently framing (app-level Cmd+±/0).
   *
   * The menu accelerator is the only path left for these keys once the native
   * View menu stops using Electron's `viewMenu` role, so the active page has to
   * be addressable without the renderer naming a tab id.
   */
  zoomActive(direction: "in" | "out" | "reset"): number | undefined {
    if (!this.activeTabId) return undefined;
    return this.zoomBy(this.activeTabId, direction);
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

  /**
   * Closes whatever page the chrome is currently framing.
   *
   * Returns false when nothing is open, so the caller can fall back to the
   * window: on a settings page Cmd+W must still close the window, not do
   * nothing.
   */
  closeActiveTab(): boolean {
    if (!this.activeTabId) return false;
    this.closeTab(this.activeTabId);
    return true;
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
    if (!root) throw new Error(`浏览器不存在：${instanceId}`);
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
    /*
     * The panel goes with its page.
     *
     * `dropDevTools` used to be reachable only from the explicit close paths —
     * the key, the toolbar row, the title band's button. Closing the *tab* is
     * not one of them, so the panel's `WebContentsView` survived: the tab was
     * gone from the strip while a full DevTools front-end stayed alive and kept
     * painting wherever it had last been placed. Nothing would ever close it,
     * because every path that could find it looked up a tab that no longer
     * existed.
     */
    this.dropDevTools(tab);
    this.aiActiveUntil.delete(tab.id);
    this.frozenTabs.delete(tab.id);
    this.stagedTabs.delete(tab.id);
    // A dialog's timers belong to the page that opened them; a closed tab must
    // not keep a timer alive that would then try to answer a dialog on a page
    // nobody can reach.
    this.clearDialog(tab);
    // The last page of an instance carries the instance with it; drop the
    // clean-session marker with it so the set does not grow forever.
    if (!this.tabs.some((item) => item.instanceId === tab.instanceId)) {
      this.cleanInstances.delete(tab.instanceId);
      this.instanceProfiles.delete(tab.instanceId);
      this.ephemeralInstances.delete(tab.instanceId);
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
    this.stopTouchCursorPoller();
    for (const tab of [...this.tabs]) this.discardTab(tab);
    this.tabs = [];
    this.views = [];
    this.cleanInstances.clear();
    this.instanceProfiles.clear();
    this.ephemeralInstances.clear();
    this.activeTabId = undefined;
    this.activeViewId = undefined;
  }

  /** Closes the surface entirely; used on app shutdown. */
  dispose(): void {
    this.stopTouchCursorPoller();
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
      /*
       * Leaving a fixed viewport hands the zoom factor back.
       *
       * The fit scale owns `webContents` zoom while a viewport is active. Every
       * caller that clears a viewport is supposed to reset it, but layout is the
       * one place that runs for every path — doing it here means a page cannot
       * stay shrunk at an old fit factor just because one caller forgot. The
       * page would otherwise report a desktop viewport while rendering at 36%.
       */
      delete tab.viewportScale;
      delete tab.fitCell;
      this.applyZoom(tab, tab.zoomOverride ?? this.defaultZoom);
      return cell;
    }
    const { rect, scale } = viewportFitRect(cell, viewport);
    tab.viewportScale = scale;
    tab.fitCell = cell;
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
      // A page with a fixed viewport keeps the box that viewport asks for
      // instead of being zeroed. Clearing it made `set_browser_viewport` a no-op
      // for any page the user was not looking at: the call returned the size it
      // had stored while `innerWidth` still read the old value, and the page only
      // picked the size up if it was later brought on stage. The box is placed
      // just off the window, so the page is still culled from the compositor and
      // still unreachable by the pointer.
      const viewport = this.viewportOf(tab);
      if (viewport && this.stage) {
        const { rect, scale } = viewportFitRect(this.stage, viewport);
        tab.viewportScale = scale;
        contents.setZoomFactor(scale);
        tab.view.setBounds({ x: -rect.width, y: rect.y, width: rect.width, height: rect.height });
        continue;
      }
      const bounds = tab.view.getBounds();
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      tab.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    this.stagedTabs = staged;
  }

  /**
   * Records CDP traffic and wakes the page if the sweep put it to sleep.
   *
   * Called by `GuestCdp` before every AI-facing command, so the first command
   * of a burst — a screenshot, a click — never lands on a frozen page: a frozen
   * page suspends JavaScript entirely, and an evaluate against it would never
   * return. The wake is awaited (not fired and forgotten) so the ordering holds
   * without relying on CDP pipelining. `lifecycle()` deliberately bypasses this
   * hook, or the freeze sweep would keep every page awake by marking its own
   * freeze as activity.
   */
  private async markCdpActivity(tabId: string): Promise<void> {
    if (!this.options.aiIdleFreeze) return;
    this.aiActiveUntil.set(tabId, Date.now() + this.sleepGraceMs);
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
    } finally {
      // The chrome's snowflake follows this flag, and a wake can happen while
      // the page is on screen — the user clicked its tab.
      this.sendState();
    }
  }

  /**
   * Sets a page's background-sleep policy.
   *
   * `"auto"` restores the default. `"never"` wakes a page that is already
   * asleep, so the policy is true from the moment it is chosen rather than from
   * the next command that happens to reach the page.
   */
  async setSleepPolicy(tabId: string, policy: "auto" | TabSleepPolicy): Promise<EmbeddedTab> {
    const tab = this.requireTab(tabId);
    if (policy === "never") {
      tab.sleepPolicy = "never";
      await this.wakeTab(tab.id);
    } else {
      delete tab.sleepPolicy;
    }
    this.sendState();
    return this.describe(tab);
  }

  /**
   * Mutes or unmutes one page's output.
   *
   * `setAudioMuted` only affects the output path: the page's media element,
   * Web Audio graph and timers keep running, so an AI testing a sound-related
   * interface sees exactly the same page state with or without this.
   *
   * A user click records their intent (`userUnmuted`), which is what stops a
   * later AI operation from silently re-muting the tab they just unmuted. It
   * also drops `aiMuted`: once a person has touched the control, the mute —
   * or its absence — is theirs, and `restoreAfterAi` must not undo it.
   */
  setMuted(tabId: string, muted: boolean, options: { byUser?: boolean } = {}): EmbeddedTab {
    const tab = this.requireTab(tabId);
    if (muted) tab.muted = true;
    else delete tab.muted;
    if (options.byUser) {
      if (muted) delete tab.userUnmuted;
      else tab.userUnmuted = true;
      delete tab.aiMuted;
    }
    const contents = tab.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.setAudioMuted(muted);
    this.sendState();
    return this.describe(tab);
  }

  /**
   * Mutes before an AI page operation, but only a page that is making sound
   * right now.
   *
   * A silent page is left completely alone: muting it could not be heard and
   * would only plant a muted state the tab strip would eventually show. A page
   * that is audible gets a temporary mute tagged `aiMuted`, which
   * `restoreAfterAi` lifts when the action finishes — unless the person asked
   * to hear the page (`userUnmuted`), in which case nothing is touched.
   * Idempotent; called once per tool call.
   */
  muteForAi(tabId: string): void {
    const tab = this.requireTab(tabId);
    if (tab.userUnmuted || tab.muted) return;
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed() || !contents.isCurrentlyAudible()) return;
    tab.aiMuted = true;
    this.setMuted(tab.id, true);
  }

  /**
   * Lifts the mute `muteForAi` applied once the AI action is over.
   *
   * Only a mute the AI applied is lifted (`aiMuted` guards it), so a page the
   * user muted themselves, or one `muteForAi` never touched, comes out exactly
   * as it went in. A page that vanished during the action has nothing to
   * restore; a page whose mute the user took over mid-action lost the flag in
   * `setMuted`, so their choice stands.
   */
  restoreAfterAi(tabId: string): void {
    const tab = this.findTab(tabId);
    if (!tab || !tab.aiMuted) return;
    delete tab.aiMuted;
    if (tab.muted) this.setMuted(tab.id, false);
  }

  /**
   * Freezes parked pages whose sleep grace has lapsed.
   *
   * `shouldSleepPage` owns the rules; this method only gathers the facts. A
   * page with a CDP command in flight is never a candidate, and each pass
   * refreshes its AI window so the grace starts after the command finishes
   * rather than when it started — a five-minute evaluate must not hand the
   * sweep a page that is still executing. A page that refuses the lifecycle
   * command simply stays awake: the feature degrades to "no sleeping" instead
   * of breaking automation.
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
      // A page is published before its carrier exists so the renderer can be
      // asked to host it; the sweep runs on a timer and can land in that window.
      const contents = tab.view?.webContents;
      if (!contents || contents.isDestroyed()) continue;
      // While a command is in flight the page is not idle, whatever the clock
      // says. Refresh the window so the full grace follows its completion.
      const busy = tab.cdp.busy();
      if (busy) this.aiActiveUntil.set(tab.id, now + this.sleepGraceMs);
      const candidate = {
        staged: this.stagedTabs.has(tab.id),
        frozen: this.frozenTabs.has(tab.id),
        available: true,
        loading: contents.isLoading(),
        crashed: tab.crashed,
        blank: isBlankTab(tab),
        devtoolsOpen: this.devtoolsOpen(tab),
        audible: contents.isCurrentlyAudible(),
        policy: tab.sleepPolicy,
        aiActiveUntil: this.aiActiveUntil.get(tab.id),
        busy,
      };
      if (!shouldSleepPage(candidate, now)) continue;
      this.frozenTabs.add(tab.id);
      void tab.cdp.lifecycle("frozen").then(
        () => this.sendState(),
        () => {
          this.frozenTabs.delete(tab.id);
          this.sendState();
        },
      );
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

  /**
   * The page facts an activity record needs, which the gate does not.
   *
   * Kept apart from {@link aiPageContext} on purpose: the policy answers "may
   * this happen" from three facts, and widening that shape every time the log
   * wants one more field would blur which fields the decision is allowed to
   * depend on. The site and the profile are context for a reader afterwards —
   * `site` and `clean` live on different levels (the tab and the instance), so
   * this is also the one place that knows how to join them.
   */
  actionFacts(tabId: string): {
    origin: string;
    title: string;
    identityId?: string;
    siteId?: string;
    clean?: boolean;
    profileId?: string;
  } {
    const tab = this.requireTab(tabId);
    const clean = this.cleanInstances.has(tab.instanceId);
    const profileId =
      this.profileOfInstance(tab.instanceId) ??
      (clean || tab.identityId ? undefined : EMBEDDED_DEFAULT_PROFILE_ID);
    return {
      origin: aiOriginOf(tab.url),
      title: tab.title,
      ...(tab.identityId ? { identityId: tab.identityId } : {}),
      ...(tab.siteId ? { siteId: tab.siteId } : {}),
      ...(clean ? { clean: true } : {}),
      ...(profileId ? { profileId } : {}),
    };
  }

  async snapshotDom(tabId: string, options: { maxNodes?: number } = {}): Promise<DomSnapshot> {
    const tab = this.requireTab(tabId);
    // Hinted like the actions: reading the page is the first thing a caller does
    // when an action stalls, and a bare evaluate timeout there reads as "the
    // selector is wrong" when the real answer is "a dialog is waiting".
    return this.withDialogHint(tab, () => tab.cdp.snapshotDom(buildDomSnapshotExpression(options)));
  }

  async visibility(tabId: string, target: TargetInput): Promise<VisibilityProbe> {
    const tab = this.requireTab(tabId);
    // 观察与动作共用同一条句柄路径：句柄失效/找不到的报错照常冒出，不降级成
    // exists: false——句柄是调用方显式登记的定位，静默换答案比报错更误导。
    const effective = await this.resolveActionTarget(tab, target);
    return this.withDialogHint(tab, () => tab.cdp.visibility(buildVisibilityExpression(effective)));
  }

  /**
   * 按定位描述符查找元素并登记句柄，返回句柄 id 与全部匹配预览。
   *
   * 先按 timeoutMs 等待至少一个匹配（与 `wait` 同一套页内轮询思路：导航销毁
   * 执行上下文时用剩余时间重试，新文档可能已经满足条件），然后登记句柄。登记
   * 阶段允许多个匹配——「我看到三个按钮」正是调用方问的事实，收窄由调用方接着做；
   * 只有 `nth` 越界和选择器无效这种「给了也白给」的错误在这里就报。
   *
   * 句柄是定位描述符的持久化（见 {@link TabRecord.elementHandles}）：页面重渲染
   * 后同一句柄仍指向同一逻辑元素；命中多个时靠文本特征对齐，特征存进记录、
   * 每次成功解析后更新为最近一次实际命中的那一项。
   */
  async findElements(
    tabId: string,
    locator: TargetInput,
    options: { timeoutMs?: number } = {},
  ): Promise<{
    ok: true;
    handleId: string;
    count: number;
    /** 登记时选中的匹配下标（nth 或 0），预览里可对号。 */
    index: number;
    /**
     * 登记时是否已唯一确定元素（恰有一个匹配，或显式给了 nth）。未唯一确定的
     * 句柄在动作里必须先解决归属：给 nth 或加收窄，否则报「匹配 N 个」。
     */
    resolved: boolean;
    matches: ElementMatch[];
  }> {
    const tab = this.requireTab(tabId);
    const spec = typeof locator === "string" ? { selector: locator } : locator;
    if (!spec.selector && !spec.label && !spec.text && !spec.role) {
      throw new Error("需要 selector、label、text 或 role 之一来定位元素（收窄字段只能配合定位字段使用）");
    }
    const timeoutMs = Math.min(60_000, Math.max(100, Math.trunc(options.timeoutMs ?? 5_000)));
    const started = Date.now();
    let found: LocatorMatches | undefined;
    while (Date.now() - started < timeoutMs) {
      const remaining = Math.max(200, timeoutMs - (Date.now() - started));
      try {
        found = await tab.cdp.evaluate<LocatorMatches>(
          buildFindByLocatorExpression(locator, {
            first: true,
            ...(spec.nth !== undefined ? { nth: spec.nth } : {}),
          }),
          { timeoutMs: remaining + 2_000 },
        );
      } catch {
        // Navigation destroyed the execution context mid-poll; the same retry
        // `wait` does — the fresh document may already satisfy the locator.
        found = undefined;
      }
      if (found && (found.count > 0 || found.reason === "invalid-selector" || found.reason === "nth-out-of-range")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!found) {
      throw new Error(
        `找不到匹配 ${describeTarget(locator)} 的元素：等待 ${timeoutMs}ms 内没有出现任何匹配（text 匹配的是可交互元素和有自身文字的可见元素）`,
      );
    }
    if (found.reason === "invalid-selector" || found.reason === "nth-out-of-range") {
      throw new Error(locatorErrorText(found.reason, describeTarget(locator), found.count, spec.nth));
    }
    if (!found.count || found.index === undefined) {
      throw new Error(
        `找不到匹配 ${describeTarget(locator)} 的元素：等待 ${timeoutMs}ms 内没有出现任何匹配（text 匹配的是可交互元素和有自身文字的可见元素）`,
      );
    }
    /*
     * 登记句柄。id 形如 `el-<页内自增>-<4位随机>`：自增位保证唯一，随机位防止
     * 猜测他人句柄。每页上限 64 个，超出淘汰最早的——句柄是轻量描述符，重查
     * 一次就回来，不值得为失控的调用方无限兜底。
     */
    if (!tab.elementHandles) tab.elementHandles = new Map();
    while (tab.elementHandles.size >= ELEMENT_HANDLE_LIMIT) {
      const oldest = tab.elementHandles.keys().next().value;
      if (oldest === undefined) break;
      tab.elementHandles.delete(oldest);
    }
    const seq = (tab.elementHandleSeq ?? 0) + 1;
    tab.elementHandleSeq = seq;
    const handleId = `el-${seq}-${randomBytes(2).toString("hex")}`;
    const resolved = found.count === 1 || spec.nth !== undefined;
    tab.elementHandles.set(handleId, {
      locator: { ...spec },
      trait: resolved ? (found.matches[found.index]?.text ?? null) : null,
      createdAt: new Date().toISOString(),
    });
    return {
      ok: true,
      handleId,
      count: found.count,
      index: found.index,
      resolved,
      matches: found.matches,
    };
  }

  /**
   * 把可能带句柄的目标解析成「当前文档里的定位 + nth」。
   *
   * 句柄路径是严格解析，与直接定位的宽容排名不同：先查本标签页的句柄表（查不到
   * 按失效/不存在分别报错，绝不跨标签页找），再在页内重跑定位，然后决定取哪个——
   * 显式 nth 按位置；唯一命中直接取；句柄记住的文本特征能唯一对齐时取它；仍然
   * 多个就报「匹配 N 个，给 nth 或加收窄」。不猜。
   *
   * 解析成功即更新句柄特征为本次命中的元素：句柄从此跟随调用方最近一次实际
   * 操作的那个元素，重排之后继续命中它。
   */
  private async resolveActionTarget(tab: TabRecord, target: TargetInput): Promise<TargetInput> {
    if (typeof target === "string" || !target.handle) return target;
    const handleId = target.handle;
    const stored = tab.elementHandles?.get(handleId);
    if (!stored) {
      if (tab.staleHandleIds?.has(handleId)) throw new Error(locatorStaleHandleText(handleId));
      throw new Error(locatorUnknownHandleText(handleId));
    }
    const found = await tab.cdp.evaluate<LocatorMatches>(
      buildFindByLocatorExpression(stored.locator, {
        ...(target.nth !== undefined ? { nth: target.nth } : {}),
        ...(stored.trait ? { trait: stored.trait } : {}),
      }),
    );
    if (!found.ok || found.index === undefined) {
      const reason = found.reason ?? "not-found";
      throw new Error(locatorErrorText(reason, describeTarget(stored.locator), found.count, target.nth));
    }
    const trait = found.matches[found.index]?.text ?? null;
    tab.elementHandles?.set(handleId, { ...stored, trait });
    return { ...stored.locator, nth: found.index };
  }

  async click(
    tabId: string,
    target: TargetInput,
  ): Promise<{
    ok: true;
    tag?: string;
    text?: string;
    selector?: string;
    /** 直连定位命中多个时的非致命提醒；句柄与显式 nth 路径不产生。 */
    warning?: string;
    /** Where the events actually landed; `onTarget: false` means they missed. */
    hit?: { onTarget: boolean; tag?: string; text?: string };
  }> {
    const tab = this.requireTab(tabId);
    const effective = await this.resolveActionTarget(tab, target);
    // Wrapped too: with a dialog up, the *first* thing that stalls is this
    // evaluate, not the input dispatch below it — so a hint on the dispatch alone
    // never fires and the caller still gets a bare CDP timeout.
    const point = await this.withDialogHint(tab, () =>
      tab.cdp.elementPoint(buildElementPointExpression(effective)),
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      throw new Error(`无法点击 ${describeTarget(effective)}：${point.reason ?? "unknown"}`);
    }
    const px = point.x;
    const py = point.y;
    await this.withDialogHint(tab, () => tab.cdp.clickAt(px, py));
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
    const warning = multiMatchWarning(effective, point.matchCount);
    return {
      ok: true,
      ...(point.tag ? { tag: point.tag } : {}),
      ...(point.text ? { text: point.text } : {}),
      ...(point.selector ? { selector: point.selector } : {}),
      ...(warning ? { warning } : {}),
      ...(hit ? { hit } : {}),
    };
  }

  /**
   * Moves the pointer over an element.
   *
   * The element is resolved to a point with the same expression `click` uses, so
   * a hover and a click on the same target land on the same pixel — which is
   * what a hover-then-click flow depends on.
   *
   * Returns the element it found, so a caller can tell "hovered the wrong thing"
   * from "hovered nothing". A silent void would make a menu that never opened
   * look like a flow bug rather than a selector bug.
   */
  async hover(
    tabId: string,
    target: TargetInput,
  ): Promise<{ ok: true; tag?: string; text?: string; selector?: string; warning?: string }> {
    const tab = this.requireTab(tabId);
    const effective = await this.resolveActionTarget(tab, target);
    const point = await this.withDialogHint(tab, () =>
      tab.cdp.elementPoint(buildElementPointExpression(effective)),
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      throw new Error(`无法悬停 ${describeTarget(effective)}：${point.reason ?? "unknown"}`);
    }
    const hx = point.x;
    const hy = point.y;
    await this.withDialogHint(tab, () => tab.cdp.hoverAt(hx, hy));
    const warning = multiMatchWarning(effective, point.matchCount);
    return {
      ok: true,
      ...(point.tag ? { tag: point.tag } : {}),
      ...(point.text ? { text: point.text } : {}),
      ...(point.selector ? { selector: point.selector } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Scrolls a page, or the container the target sits in.
   *
   * Two ways to ask, because they are different questions. With a target, the
   * wheel lands on that element's centre, so a nested scroll container moves
   * instead of the page. Without one, the viewport scrolls. `deltaY` is positive
   * downwards.
   *
   * The reported `scrolled` is read back after the wheel event: a page that is
   * already at its end moves nowhere, and a flow that then looks for new content
   * would be waiting on a scroll that never happened.
   */
  async scroll(
    tabId: string,
    options: {
      target?: TargetInput;
      deltaX?: number;
      deltaY?: number;
    } = {},
  ): Promise<{ ok: true; scrolled: { x: number; y: number }; moved: boolean; warning?: string }> {
    const tab = this.requireTab(tabId);
    /*
     * Which element actually scrolls is not knowable from the call.
     *
     * `scrollTop` on the document is one answer; a nested container is another,
     * and a wheel event over that container moves *it*, not the page. Reading only
     * `window.scrollY` therefore reported `moved: false` for the exact case this
     * tool exists for. So the observer is injected first: it walks up from
     * whatever sits under the point and records the scroll position of the first
     * scrollable ancestor (or the document), then reports the change.
     */
    const observer = `
      (() => {
        if (window.__ensembleScrollProbe) return window.__ensembleScrollProbe.read();
        const read = () => {
          const target = window.__ensembleScrollProbe?.element;
          if (target && target !== document.scrollingElement) {
            return { x: target.scrollLeft, y: target.scrollTop };
          }
          const root = document.scrollingElement || document.documentElement;
          return { x: root.scrollLeft, y: root.scrollTop };
        };
        const probe = { element: null, read };
        window.__ensembleScrollProbe = probe;
        return read();
      })()
    `;

    let x: number;
    let y: number;
    let warning: string | undefined;
    if (options.target) {
      const scrollTarget = options.target;
      const point = await this.withDialogHint(tab, () =>
        tab.cdp.elementPoint(buildElementPointExpression(scrollTarget)),
      );
      if (!point.ok || point.x === undefined || point.y === undefined) {
        throw new Error(`无法滚动 ${describeTarget(options.target)}：${point.reason ?? "unknown"}`);
      }
      x = point.x;
      y = point.y;
      warning = multiMatchWarning(scrollTarget, point.matchCount);
      // Point the probe at the scrollable ancestor of the target the caller named,
      // so the before/after reading is about the thing they asked to move.
      await tab.cdp.evaluate(`
        (() => {
          ${observer};
          const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
          let node = el;
          while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
              window.__ensembleScrollProbe.element = node;
              return true;
            }
            node = node.parentElement;
          }
          window.__ensembleScrollProbe.element = null;
          return false;
        })()
      `);
    } else {
      // The viewport's centre: a wheel at a corner can land on a scrollbar or
      // outside the content area of a page that pads its body.
      const size = await tab.cdp.evaluate<{ width: number; height: number }>(
        `({ width: window.innerWidth, height: window.innerHeight })`,
      );
      x = Math.round(size.width / 2);
      y = Math.round(size.height / 2);
      await tab.cdp.evaluate(`(() => { ${observer}; window.__ensembleScrollProbe.element = null; return true; })()`);
    }
    const before = await tab.cdp.evaluate<{ x: number; y: number }>(
      `window.__ensembleScrollProbe.read()`,
    );
    await this.withDialogHint(tab, () => tab.cdp.scrollAt(x, y, options.deltaX ?? 0, options.deltaY ?? 0));
    // A wheel event is queued against the compositor, not applied synchronously.
    // Reading in the same tick measured the pre-scroll position and reported
    // `moved: false` for a scroll that had in fact happened.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = await tab.cdp.evaluate<{ x: number; y: number }>(
      `window.__ensembleScrollProbe.read()`,
    );
    return {
      ok: true,
      scrolled: after,
      moved: after.x !== before.x || after.y !== before.y,
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Presses a key combination.
   *
   * `keys` is written the way the shortcut reads: `"Control+a"`, `"Control+Shift+s"`,
   * `"Meta+Enter"`. That spelling is what makes the call self-explanatory; the
   * bit mask Chromium wants is derived from it here rather than asked of the
   * caller, who would have to look up that Alt is 1 and Ctrl is 2.
   */
  async pressKeys(
    tabId: string,
    keys: string,
  ): Promise<{ ok: true; keys: string; modifiers: number }> {
    const tab = this.requireTab(tabId);
    const parts = keys
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) throw new Error("按键组合不能为空");
    const target = parts[parts.length - 1] as string;
    const modifierNames = parts.slice(0, -1);
    let modifiers = 0;
    for (const name of modifierNames) {
      const entry = MODIFIER_KEYS.find(
        (item) => item.key.toLowerCase() === name.toLowerCase() ||
          (name.toLowerCase() === "ctrl" && item.key === "Control") ||
          (name.toLowerCase() === "cmd" && item.key === "Meta") ||
          (name.toLowerCase() === "option" && item.key === "Alt"),
      );
      if (!entry) throw new Error(`不认识的修饰键：${name}`);
      modifiers |= entry.mask;
    }
    const keyEntry = KEY_TABLE[target] ?? KEY_TABLE[target.charAt(0).toUpperCase() + target.slice(1)];
    if (!keyEntry) {
      // A single character is a legitimate shortcut target ("Control+a"); it has
      // no entry in the named-key table because its code is derived, not listed.
      if (target.length === 1) {
        const upper = target.toUpperCase();
        await tab.cdp.pressWithModifiers(target, `Key${upper}`, upper.charCodeAt(0), modifiers);
        return { ok: true, keys, modifiers };
      }
      throw new Error(`不支持的按键：${target}`);
    }
    await tab.cdp.pressWithModifiers(keyEntry.key, keyEntry.code, keyEntry.keyCode, modifiers);
    return { ok: true, keys, modifiers };
  }

  /**
   * Puts files into a file input.
   *
   * The element is resolved first so the caller learns *why* nothing happened:
   * "that is not a file input", "it is disabled", "it accepts one file but you
   * passed five" are all answers a bare command cannot give. Paths must be
   * absolute and exist — the browser reads them, not the page.
   *
   * `multiple: false` with more than one path is refused rather than silently
   * truncated: a form that received one of five files reports success, and the
   * caller would go on to assert against a half-uploaded record.
   */
  async setFiles(
    tabId: string,
    target: TargetInput,
    paths: string[],
  ): Promise<{
    ok: true;
    count: number;
    multiple: boolean;
    selector?: string;
    warning?: string;
  }> {
    const tab = this.requireTab(tabId);
    if (paths.length === 0) throw new Error("至少要给一个文件路径");
    const probe = await this.withDialogHint(tab, () =>
      tab.cdp.evaluate<{
        ok: boolean;
        reason?: string;
        multiple?: boolean;
        accept?: string;
        selector?: string;
        tag?: string;
        matchCount?: number;
      }>(buildFileInputExpression(target)),
    );
    if (!probe.ok) {
      throw new Error(`无法上传到 ${describeTarget(target)}：${probe.reason ?? "unknown"}`);
    }
    if (probe.multiple !== true && paths.length > 1) {
      throw new Error(
        `这个文件框只能收一个文件（给了 ${paths.length} 个）：${describeTarget(target)}`,
      );
    }
    // A selector is needed because `DOM.setFileInputFiles` takes a node, and the
    // expression resolves one from CSS. The same page, milliseconds later: the
    // probe above ran in the same document, so this cannot drift to another node.
    const selector = probe.selector;
    if (!selector) throw new Error(`无法定位文件框：${describeTarget(target)}`);
    await this.withDialogHint(tab, () => tab.cdp.setFiles(selector, paths));
    const warning = multiMatchWarning(target, probe.matchCount);
    return {
      ok: true,
      count: paths.length,
      multiple: probe.multiple === true,
      selector,
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Drags one element onto another.
   *
   * Both ends resolve in one page call so they describe the same layout: a
   * re-render between two round trips could move the target and the press would
   * start from a stale coordinate. `moved: false` reports a page whose drag
   * handler never fired, which is the difference between "the drop did nothing"
   * and "the drag never started".
   */
  async drag(
    tabId: string,
    from: TargetInput,
    to: TargetInput,
  ): Promise<{
    ok: true;
    fromTag?: string;
    toTag?: string;
    fromText?: string;
    toText?: string;
    warning?: string;
  }> {
    const tab = this.requireTab(tabId);
    const points = await this.withDialogHint(tab, () =>
      tab.cdp.evaluate<{
        ok: boolean;
        reason?: string;
        from?: { x: number; y: number };
        to?: { x: number; y: number };
        fromTag?: string;
        toTag?: string;
        fromText?: string;
        toText?: string;
        fromMatchCount?: number;
        toMatchCount?: number;
      }>(buildDragPointsExpression(from, to)),
    );
    if (!points.ok || !points.from || !points.to) {
      throw new Error(`无法拖拽：${points.reason ?? "unknown"}`);
    }
    await this.withDialogHint(tab, () => tab.cdp.dragFromTo(points.from!, points.to!));
    // 两端都可能多匹配：各自生成提醒，都有时拼成一条，保持返回值只有 warning 一个附加字段。
    const warnings = [
      multiMatchWarning(from, points.fromMatchCount),
      multiMatchWarning(to, points.toMatchCount),
    ].filter((item): item is string => Boolean(item));
    return {
      ok: true,
      ...(points.fromTag ? { fromTag: points.fromTag } : {}),
      ...(points.toTag ? { toTag: points.toTag } : {}),
      ...(points.fromText ? { fromText: points.fromText } : {}),
      ...(points.toText ? { toText: points.toText } : {}),
      ...(warnings.length ? { warning: warnings.join("；") } : {}),
    };
  }

  /**
   * Sets a checkbox or radio to a chosen state.
   *
   * Idempotent by design: the state is read in the page and the box is clicked
   * only on a mismatch. A caller that says `check` twice must not end up with an
   * unchecked box, which is exactly what blind clicking produces.
   *
   * `changed: false` with `checked` matching the request is the "it was already
   * like that" answer; `stuckAt` means the click did not move it (a disabled
   * wrapper, a handler calling `preventDefault`) and the caller should stop rather
   * than retry.
   */
  async setChecked(
    tabId: string,
    target: TargetInput,
    desired: boolean,
  ): Promise<{
    ok: true;
    checked: boolean;
    changed: boolean;
    selector?: string;
    stuckAt?: boolean;
    warning?: string;
  }> {
    const tab = this.requireTab(tabId);
    const effective = await this.resolveActionTarget(tab, target);
    const result = await this.withDialogHint(tab, () =>
      tab.cdp.evaluate<{
        ok: boolean;
        reason?: string;
        checked?: boolean;
        changed?: boolean;
        selector?: string;
        tag?: string;
        type?: string;
        stuckAt?: boolean;
        matchCount?: number;
      }>(buildCheckExpression(effective, desired)),
    );
    if (!result.ok) {
      throw new Error(`无法设置 ${describeTarget(effective)}：${result.reason ?? "unknown"}`);
    }
    const warning = multiMatchWarning(effective, result.matchCount);
    return {
      ok: true,
      checked: result.checked === true,
      changed: result.changed === true,
      ...(result.selector ? { selector: result.selector } : {}),
      ...(result.stuckAt !== undefined ? { stuckAt: result.stuckAt } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Everything about one element that a caller can act on.
   *
   * The alternative was for callers to write DOM code through
   * `evaluate_browser_page`, which is the part that goes stale the first time the
   * page's markup changes. This answers "what is this element, is it enabled,
   * what is in it, what does its aria say" in one call.
   */
  async elementInfo(tabId: string, target: TargetInput): Promise<unknown> {
    const tab = this.requireTab(tabId);
    const effective = await this.resolveActionTarget(tab, target);
    const info = await this.withDialogHint(tab, () =>
      tab.cdp.evaluate<{ ok: boolean; reason?: string }>(buildElementInfoExpression(effective)),
    );
    if (!info.ok) {
      throw new Error(`找不到 ${describeTarget(effective)}：${info.reason ?? "unknown"}`);
    }
    return info;
  }

  /**
   * Reads attributes, or the element's text/value when no name is given.
   *
   * Attribute reads are the polling question ("did this become aria-disabled"),
   * so this answers just that rather than the full element picture. A missing
   * attribute comes back as `null`, which is different from the element not
   * existing — the latter throws.
   */
  async attributes(
    tabId: string,
    target: TargetInput,
    names?: string[],
  ): Promise<unknown> {
    const tab = this.requireTab(tabId);
    const result = await this.withDialogHint(tab, () =>
      tab.cdp.evaluate<{ ok: boolean; reason?: string }>(buildAttributeExpression(target, names)),
    );
    if (!result.ok) {
      throw new Error(`找不到 ${describeTarget(target)}：${result.reason ?? "unknown"}`);
    }
    return result;
  }

  /**
   * The JavaScript dialog this page is showing, if any.
   *
   * A read, not a poll: the record is filled by the CDP listener installed when
   * the page was created, so the answer works even while the page is blocked —
   * which is precisely when a caller needs to ask.
   */
  dialogStatus(tabId: string): {
    dialog: { type: string; message: string; defaultPrompt?: string; url?: string; msOpen: number } | null;
  } {
    const tab = this.findTab(tabId);
    if (!tab?.dialog) return { dialog: null };
    return {
      dialog: {
        type: tab.dialog.type,
        message: tab.dialog.message,
        ...(tab.dialog.defaultPrompt ? { defaultPrompt: tab.dialog.defaultPrompt } : {}),
        ...(tab.dialog.url ? { url: tab.dialog.url } : {}),
        msOpen: Date.now() - tab.dialog.openedAt,
      },
    };
  }

  /**
   * Answers the page's JavaScript dialog.
   *
   * `accept: false` dismisses (the browser's "取消"); `true` confirms. For a
   * prompt, `promptText` is what gets typed into it — omitted means the field's
   * default value, which is what pressing OK without editing does.
   *
   * **Why this exists at all**, measured on Electron 45.2.1: while a dialog is
   * open the page is blocked, and the `Input.dispatchMouseEvent` that opened it
   * never replies. A click tool therefore reports a 30-second timeout on a page
   * that is merely waiting for an answer, and every later read fails the same
   * way. Answering the dialog is the only thing that unblocks it.
   *
   * Answers even when no event was seen — a dialog can open while the session was
   * released, and Chromium's own `Page.handleJavaScriptDialog` works regardless.
   * In that case the record is cleared from this side and the answer is reported
   * as `handled: true`; the page's own behaviour is the evidence either way.
   *
   * **Never reports success it did not have.** The command shares one session
   * queue with the input dispatch the dialog is holding, so it can queue behind
   * that straggler and time out. When it does, the dialog is still up and saying
   * otherwise would send the caller to retry a page that is still blocked — the
   * record is left in place and the failure is reported.
   */
  async handleDialog(
    tabId: string,
    options: { accept: boolean; promptText?: string },
  ): Promise<{ ok: true; handled: boolean; type?: string }> {
    const tab = this.requireTab(tabId);
    const type = tab.dialog?.type;
    try {
      await tab.cdp.handleDialog(options.accept, options.promptText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "No dialog is showing" is a fact, not a failure: the caller raced a page
      // that closed its own dialog, or the record is stale. Reporting an error
      // would make an idempotent answer look broken.
      if (/no dialog is showing|No dialog/i.test(message)) {
        this.clearDialog(tab);
        return { ok: true, handled: false, ...(type ? { type } : {}) };
      }
      // Anything else — a timeout behind the stalled click, a dead session — means
      // the dialog is still there. Keep the record so the next attempt can find it.
      throw error;
    }
    this.clearDialog(tab);
    // The page resumes on the next task; reporting success before that would let
    // a caller's very next command race the unblock.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { ok: true, handled: true, ...(type ? { type } : {}) };
  }

  /**
   * Subscribes a page's dialog events into its own record.
   *
   * The subscription is on the executor (per page) rather than on the CDP
   * session, because the session is released on idle and reopened later — a
   * listener that died with it would miss the dialog that made a page look
   * frozen. `Page.enable` is restored by the guest manager on every session open,
   * so the events keep arriving across those reopens.
   */
  private trackDialogs(tab: TabRecord): void {
    tab.dialogListener?.();
    tab.dialogListener = tab.cdp.onEvent((method, params) => {
      if (method === "Page.javascriptDialogOpening") {
        const type = String(params["type"] ?? "");
        const known = type === "alert" || type === "confirm" || type === "prompt" || type === "beforeunload";
        this.clearDialog(tab);
        tab.dialog = {
          type: known ? type : "alert",
          message: String(params["message"] ?? ""),
          ...(typeof params["defaultPrompt"] === "string" && params["defaultPrompt"]
            ? { defaultPrompt: params["defaultPrompt"] }
            : {}),
          ...(typeof params["url"] === "string" && params["url"] ? { url: params["url"] } : {}),
          openedAt: Date.now(),
        };
        /*
         * A dialog nobody answers blocks the page for the rest of the session —
         * no read, no click, no screenshot. The auto-dismiss is what makes that
         * bounded: the caller that opened it usually answers within a step or
         * two, and a person who walked away costs one dismissed confirm rather
         * than a page that has to be closed.
         */
        const budget = this.options.dialogAutoDismissMs ?? DIALOG_AUTO_DISMISS_MS;
        tab.dialog.autoDismiss = setTimeout(() => {
          const open = tab.dialog;
          if (!open) return;
          delete open.autoDismiss;
          void tab.cdp.handleDialog(false).catch(() => undefined);
          this.clearDialog(tab);
          this.emitState();
        }, budget);
        tab.dialog.autoDismiss.unref?.();
        this.emitState();
        return;
      }
      if (method === "Page.javascriptDialogClosed") {
        // Fires when the page's own code or the browser closes it — including the
        // case where our auto-dismiss fired first. Clearing here keeps the record
        // from outliving the dialog.
        this.clearDialog(tab);
        this.emitState();
      }
    });
  }

  /** Drops the dialog record and its timer, without answering anything. */
  private clearDialog(tab: TabRecord): void {
    const dialog = tab.dialog;
    if (!dialog) return;
    if (dialog.autoDismiss) clearTimeout(dialog.autoDismiss);
    delete tab.dialog;
  }

  /**
   * Names a dialog as the reason a page command stalled.
   *
   * Measured on 45.2.1: while a dialog is up, the `Input.dispatch*` that opened
   * it never returns and neither does any `Runtime.evaluate`. Both therefore
   * surface as `CDP <method> 没有响应` — a message that blames the command, sends
   * the caller looking at selectors, and says nothing about the page waiting on a
   * `confirm()`. Rewriting the error here is what turns a 30-second mystery into
   * one instruction: read the dialog, answer it, retry.
   *
   * Only wraps commands that a dialog can block. `Page.handleJavaScriptDialog`
   * itself is deliberately not wrapped — it is the way out.
   */
  private async withDialogHint<T>(tab: TabRecord, run: () => Promise<T>): Promise<T> {
    /*
     * Refuse before sending, not after the ceiling.
     *
     * Checking up front is the difference between an error in milliseconds and a
     * 30-second timeout followed by an error: while a dialog is up no command
     * reaches the page at all, so sending one can only wait. The record is
     * authoritative — it is filled from the browser's own event, and nothing
     * clears it except answering the dialog.
     */
    if (tab.dialog) this.throwIfDialogOpen(tab);
    try {
      return await run();
    } catch (error) {
      // A dialog can open *during* the command — a click that triggers a confirm
      // is exactly that. The event fills the record, so by the time the command
      // stalls it is already there.
      if (!tab.dialog) throw error;
      this.throwIfDialogOpen(tab, error);
    }
  }

  /** The one message for "a dialog is in the way"; always throws. */
  private throwIfDialogOpen(tab: TabRecord, cause?: unknown): never {
    const dialog = tab.dialog;
    if (!dialog) throw cause instanceof Error ? cause : new Error(String(cause));
    const message = dialog.message.replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(
      `页面被一个 ${dialog.type} 弹窗挡住，这条命令没有做完：「${message}」。` +
        `用 read_browser_dialog 看它，用 handle_browser_dialog 回答（accept: true 为确定），然后再重试。`,
    );
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
  ): Promise<{ ok: true; secret?: true; selector?: string; warning?: string }> {
    const tab = this.requireTab(tabId);
    const effective = await this.resolveActionTarget(tab, target);
    const focus = await tab.cdp.evaluate<{
      ok: boolean;
      reason?: string;
      inputType?: string;
      selector?: string;
      matchCount?: number;
    }>(buildFocusExpression(effective));
    if (!focus.ok)
      throw new Error(`无法输入到 ${describeTarget(effective)}：${focus.reason ?? "unknown"}`);
    await this.typeInto(tab, effective, text, options);
    // Reported so the MCP layer can keep the value out of its audit log; a
    // password field can be a brand-new credential (creating a tenant), so it
    // cannot always go through `fill_browser_login`.
    const warning = multiMatchWarning(effective, focus.matchCount);
    return {
      ok: true,
      ...(focus.selector ? { selector: focus.selector } : {}),
      ...(focus.inputType === "password" ? { secret: true as const } : {}),
      ...(warning ? { warning } : {}),
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
      /** For `network-idle`: how long the page must stay quiet. Default 500ms. */
      quietMs?: number;
      /** For `response`: exact status to require on the matching request. */
      status?: number;
    },
  ): Promise<WaitResult> {
    const tab = this.requireTab(tabId);
    // 句柄解析一次进轮询：页内轮询吃的是解析后的普通定位，不必每轮重新解析
    // （与动作工具同粒度）。解析失败（句柄失效/找不到）照常抛出，而不是被当成
    // 「条件未满足」磨到超时。
    const target =
      input.target === undefined ? undefined : await this.resolveActionTarget(tab, input.target);
    const started = Date.now();
    const deadline = started + input.timeoutMs;
    let last: WaitResult | undefined;
    while (Date.now() < deadline) {
      const remaining = Math.max(200, deadline - Date.now());
      /*
       * Idle and response are measured inside the page against its own
       * collector, so they need the collector to be there. Installing on demand
       * keeps `wait` working on a page opened before this feature existed, and
       * the install is idempotent on every later call.
       */
      if (input.condition === "network-idle" || input.condition === "response") {
        await tab.cdp.evaluate(PAGE_ACTIVITY_SCRIPT).catch(() => undefined);
      }
      const expression =
        input.condition === "network-idle"
          ? buildNetworkIdleExpression({
              timeoutMs: remaining,
              ...(input.quietMs === undefined ? {} : { quietMs: input.quietMs }),
            })
          : input.condition === "response"
            ? buildWaitResponseExpression({
                expect: input.text ?? "",
                ...(input.status === undefined ? {} : { status: input.status }),
                timeoutMs: remaining,
              })
            : buildWaitExpression({ ...input, target, timeoutMs: remaining });
      try {
        const result = await Promise.race([
          /*
           * The command's own ceiling is raised to the poll's deadline, not left
           * at the default 30 seconds. The page-side loop already stops at
           * `remaining`, so the only thing a lower transport ceiling does is
           * pre-empt it — and the caller then gets `CDP Runtime.evaluate 没有响应
           * （超过 30000ms）` from a wait that was given ten minutes to run.
           */
          tab.cdp.evaluate<WaitResult>(expression, {
            awaitPromise: true,
            timeoutMs: remaining + 2_000,
          }),
          new Promise<WaitResult>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: false,
                  waitedMs: remaining,
                  timedOut: true,
                  /*
                   * `bridge-timeout`, not `evaluate-timeout`.
                   *
                   * This timer is the *transport's* deadline: it fires when the
                   * page has not answered the poll loop at all. The page's own
                   * loop has its own deadline and reports a concrete reason
                   * (`url-mismatch`, `text-absent`), so the two outcomes are
                   * different facts and used to arrive under one name. A guest
                   * that is backgrounded has its timers throttled to roughly a
                   * second, which is enough to make this side win regularly —
                   * reporting that as "the condition was not met" was actively
                   * misleading.
                   */
                  timedOutAt: "bridge" as const,
                  reason: "bridge-timeout",
                }),
              remaining + 400,
            ),
          ),
        ]);
        // A bridge timeout is retried with whatever time is left: the page may
        // simply have been slow to answer once, and a navigation may have
        // replaced its execution context in the meantime. The "reason" that
        // comes back from a successful retry is the page's own.
        if (result.ok || !result.timedOut || result.reason !== "bridge-timeout") return result;
        last = result;
      } catch (error) {
        // Context destroyed by a navigation, or the tab went away mid-poll.
        last = {
          ok: false,
          waitedMs: Date.now() - started,
          timedOut: true,
          timedOutAt: "bridge",
          reason: String((error as Error)?.message ?? error).slice(0, 200),
        };
      }
    }
    return (
      last ?? {
        ok: false,
        waitedMs: Date.now() - started,
        timedOut: true,
        timedOutAt: "page",
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
    filled: Array<{ field: string; selector?: string; secret?: true; warning?: string }>;
  }> {
    const tab = this.requireTab(tabId);
    const filled: Array<{ field: string; selector?: string; secret?: true; warning?: string }> = [];
    for (const field of fields) {
      const name = describeTarget(field.target);
      const focus = await tab.cdp.evaluate<{
        ok: boolean;
        reason?: string;
        inputType?: string;
        selector?: string;
        matchCount?: number;
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
      const warning = multiMatchWarning(field.target, focus.matchCount);
      filled.push({
        field: name,
        ...(focus.selector ? { selector: focus.selector } : {}),
        // The MCP layer masks every value whose field reported `secret`, so one
        // password in the middle of a form must not leak the rest of the call.
        ...(focus.inputType === "password" ? { secret: true as const } : {}),
        ...(warning ? { warning } : {}),
      });
    }
    return { ok: true, filled };
  }

  /**
   * Runs a saved flow's steps against one tab.
   *
   * Every step goes through the same primitives the individual tools use, so a
   * flow clicks and types exactly like a person driving the app would. 动作层
   * 始终如此；编排层（script 步骤）能调用的也是这同一条单步实现路径——
   * 能力边界就是原语集合，没有第二套动作代码。
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
    // script 步骤上下文里的 params 用这个起点快照：调用方给的输入在运行中
    // 不变，vars 才是 read 与 as 不断写入的那份。
    const flowParams = { ...vars };
    /**
     * Every raw command this run used.
     *
     * Reported at the end because the count is the signal: a flow that needs
     * more than two raw commands is a flow where an action is missing from the
     * wrappers, and the caller should hear that from the result rather than from
     * a reviewer reading the steps.
     */
    const rawCdpSteps: string[] = [];

    /**
     * 一个已插值步骤的实现路径。script 步骤的动作原语构造回这里调用：
     * 脚本里 `await fill(...)` 与直接排一个 fill 步骤走的是同一段代码，
     * fill 的清空重输、wait 的预算截断、read 的 vars 写入都只有这一份。
     *
     * `value` 只有 read（和 script 自己）会带：原语要把读到的字符串交回
     * 脚本，detail 是给人看的日志，两者形状不同。
     */
    const runStepAction = async (step: FlowStep): Promise<FlowStepOutcome> => {
      const target = this.targetOf(step);
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
          return { detail: url };
        }
        case "fill": {
          // Same reasoning as `click`: `type` already resolves the field,
          // reports a password input for redaction, and does the
          // pointer-then-select-then-insert dance a guest needs. The copy that
          // was here duplicated all of it, minus the redaction.
          const typed = await this.type(tabId, target, step.value ?? "", { clear: true });
          return { detail: typed.secret ? "[redacted]" : step.value };
        }
        case "click": {
          // The tool's own `click`, not a second copy of it: that one reads the
          // hit back and reports `onTarget`, which is how a flow tells "the
          // page ignored me" from "an overlay ate the click". The copy that
          // used to live here dispatched the same three events and then threw
          // the read-back away, so a flow could only ever say "clicked".
          const clicked = await this.click(tabId, target);
          return { detail: clicked.text };
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
          return { detail: selected.text };
        }
        case "press": {
          await tab.cdp.pressNamedKey(step.key ?? "");
          return { detail: step.key };
        }
        case "login": {
          const filled = await this.fillLogin(tabId);
          if (!filled.ok) throw new Error(`无法填充登录：${filled.reason ?? "unknown"}`);
          return {
            detail: filled.missingFields?.length
              ? `已填入账号密码，缺少字段：${filled.missingFields.join("、")}`
              : "已填入账号密码",
          };
        }
        case "wait": {
          /*
           * A wait may not outlive the flow's own budget.
           *
           * The check at the top of the loop only runs *between* steps, so a
           * 30-second wait inside a flow given one second waited the full 30 —
           * and the caller then saw "wait timed out" when what had actually
           * happened is that the whole run was out of time. The earlier of the
           * two budgets is the honest one. The script step's `wait` 原语也走
           * 这里，所以脚本里的等待同样被截断，不用第二份预算逻辑。
           */
          const remaining = Math.max(200, options.timeoutMs - (Date.now() - started));
          const stepBudget = step.timeoutMs ?? 5000;
          const outcome = await this.wait(tabId, {
            condition: step.condition ?? "visible",
            ...(step.condition === "text" || step.condition === "url" ? {} : { target }),
            ...(step.expect ? { text: step.expect } : {}),
            timeoutMs: Math.min(stepBudget, remaining),
          });
          if (!outcome.ok && !step.optional) {
            // Blame the flow budget when that is what ran out: the difference
            // matters — "this condition never held" is a step bug, "you did not
            // give the run enough time" is a call-site one.
            if (remaining < stepBudget) {
              // 原语路径没有步骤序号可报：把流程预算耗尽的原样抛出，让
              // 上层（循环或脚本竞速）按自己的语境包装。
              throw new FlowBudgetExhaustedError();
            }
            throw new Error(`等待超时：${outcome.reason ?? "unknown"}`);
          }
          return { detail: outcome.ok ? `等了 ${outcome.waitedMs}ms` : "超时，按可选项继续" };
        }
        case "read": {
          const read = await tab.cdp.evaluate<{
            ok: boolean;
            reason?: string;
            value?: string;
          }>(buildReadExpression(target));
          if (!read.ok) throw new Error(`无法读取：${read.reason ?? "unknown"}`);
          if (step.as) vars[step.as] = read.value ?? "";
          return {
            detail: step.as ? `${step.as} = ${read.value}` : read.value,
            value: read.value ?? "",
          };
        }
        case "script": {
          /*
           * 编排层。脚本只做循环、条件与推导；每个动作调用都在上面找到
           * 自己的 case。`login` 不在原语集合里（它走凭据路径，编排脚本
           * 不得触碰），`cdp` 也不在（逃生口有自己的白名单与闸门，不经过
           * 脚本）——能力边界就是这里的原语集合。
           *
           * 预算与 wait 同一思路：步骤之间才有预算检查，脚本内部没有，
           * 所以整个脚本吃的是 min(步骤 timeoutMs, 流程剩余)。
           */
          const remaining = Math.max(200, options.timeoutMs - (Date.now() - started));
          const budget = Math.min(step.timeoutMs ?? remaining, remaining);
          const outcome = await runFlowScript({
            script: step.value ?? "",
            vars,
            params: flowParams,
            budgetMs: budget,
            actions: this.buildScriptActions(tabId, runStepAction),
          });
          const value = flowScriptValueToString(outcome.value);
          if (step.as) vars[step.as] = value;
          const parts: string[] = [];
          if (outcome.logs.length > 0) {
            parts.push(`console ${outcome.logs.length} 行`);
          }
          if (step.as) parts.push(`${step.as} = ${value.slice(0, 120)}`);
          return { detail: parts.length > 0 ? parts.join("；") : undefined, value };
        }
        case "cdp": {
          /*
           * The escape hatch, checked before anything is sent.
           *
           * The tier list decides whether this command may run at all: the
           * allowed tier acts on this page the way a person would, the optional
           * tier sits behind a setting, and the forbidden tier can reach another
           * identity's partition — the one thing this app exists to keep
           * separate. See `core/cdp/flow-whitelist.ts`.
           */
          const method = (step.method ?? "").trim();
          const verdict = checkCdpCommand(method, {
            gatedAllowed: this.options.flowCdpExtended?.() === true,
          });
          if (!verdict.ok) throw new Error(verdict.reason);
          const response = await tab.cdp.send<unknown>(method, step.params ?? {}, {
            timeoutMs: step.timeoutMs ?? 30_000,
          });
          rawCdpSteps.push(method);
          // The reply is summarised, not returned whole: a `Runtime.evaluate`
          // result carries a remote object id that means nothing outside this
          // call, and printing it costs tokens without answering anything.
          return { detail: `${method} ${summarizeCdpResult(response)}` };
        }
        default:
          throw new Error(`不认识的动作 ${String(step.action)}`);
      }
    };

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

      try {
        const outcome = await runStepAction(step);
        this.syncTab(tab);
        results.push({
          index,
          action: step.action,
          ok: true,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        });
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
        if (error instanceof FlowBudgetExhaustedError) {
          // wait 原语路径报告的「流程预算耗尽」：措辞与 steps 的形状都和
          // 改造前的直接 return 一致（当前步骤不在 steps 里），对调用方
          // 来说这是同一件事，不该因为重构换了形状。
          return {
            ok: false,
            failedAt: index,
            reason: `流程超过 ${Math.round(options.timeoutMs / 1000)} 秒仍未跑完`,
            steps: results,
            vars,
          };
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
    return {
      ok: true,
      steps: results,
      vars,
      ...(rawCdpSteps.length > 0 ? { rawCdp: rawCdpSteps } : {}),
      ...(rawCdpSteps.length > 2
        ? {
            note: `这一趟用了 ${rawCdpSteps.length} 次原始 CDP 命令。超过两次通常说明缺一个封装动作，把常见用法做成动作会稳得多`,
          }
        : {}),
    };
  }

  /**
   * script 步骤的动作原语：编排脚本能调用的全部「页面动作」。
   *
   * 对应流程步骤的原语（navigate/click/fill/select/press/wait/read）构造回
   * runStepAction 走同一个 case；hover/scroll/check/setFiles/drag 还不是流程
   * 步骤，直接调 BrowserManager 上的同名方法——那是工具自己的唯一实现，不是
   * 第二份。`login` 与 `cdp` 刻意不在返回值里：凭据路径与协议逃生口不经过
   * 编排脚本，这是 script 步骤能力边界的一半，另一半（无 require/网络）在
   * `flow-script.ts` 的 context 里。
   */
  private buildScriptActions(
    tabId: string,
    runStep: (step: FlowStep) => Promise<FlowStepOutcome>,
  ): FlowScriptActions {
    // 字符串目标按 CSS selector 处理（与工具层「selector 兜底」一致）；
    // 对象目标就是 FlowTarget 的字段。转成步骤形状是为了复用 targetOf。
    const asStep = (input: FlowScriptTarget): FlowStep => {
      if (typeof input === "string") return { action: "click", selector: input };
      return { action: "click", ...input };
    };
    return {
      navigate: (url) => runStep({ action: "navigate", url }),
      click: (target) => runStep(asStep(target)),
      fill: (target, value) => runStep({ ...asStep(target), action: "fill", value }),
      select: (target, option) => runStep({ ...asStep(target), action: "select", option }),
      press: (key) => runStep({ action: "press", key }),
      hover: (target) => this.hover(tabId, this.targetOf(asStep(target))),
      scroll: (options = {}) =>
        this.scroll(tabId, {
          ...(options.target ? { target: this.targetOf(asStep(options.target)) } : {}),
          ...(options.deltaX !== undefined ? { deltaX: options.deltaX } : {}),
          ...(options.deltaY !== undefined ? { deltaY: options.deltaY } : {}),
        }),
      check: (target, desired) => this.setChecked(tabId, this.targetOf(asStep(target)), desired),
      setFiles: (target, paths) => this.setFiles(tabId, this.targetOf(asStep(target)), paths),
      drag: (from, to) =>
        this.drag(tabId, this.targetOf(asStep(from)), this.targetOf(asStep(to))),
      wait: (condition, expect, timeoutMs, target) =>
        runStep({
          ...(target ? asStep(target) : { action: "wait" }),
          action: "wait",
          condition,
          ...(expect !== undefined ? { expect } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
      read: async (target, as) => {
        const outcome = await runStep({
          ...asStep(target),
          action: "read",
          ...(as ? { as } : {}),
        });
        return outcome.value ?? "";
      },
    };
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

  /**
   * Runs an expression in the page and returns its value.
   *
   * `timeoutMs` is the caller's own budget for their script, not a ceiling on
   * the transport. A long scrape and a hung page look identical from here, so
   * the deadline is whichever the caller asked for and the error says which —
   * `DeadlineError` means "we stopped waiting", not "the page failed".
   */
  async evaluate<T>(
    tabId: string,
    expression: string,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const tab = this.requireTab(tabId);
    return tab.cdp.evaluate<T>(expression, {
      awaitPromise: true,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  /**
   * Registers a script that runs before every document from now on.
   *
   * `Page.addScriptToEvaluateOnNewDocument` is the only way to get code in ahead
   * of the page's own: by the time `evaluate` runs, the site's bundle has already
   * installed whatever the caller wanted to wrap. Patching `VideoDecoder`, a
   * `window` property a framework reads at module scope, or a timer a script
   * starts on load all need to be there first.
   *
   * **Not applied to the current document.** A registration affects the next
   * navigation, and saying so in the result is the difference between a caller
   * that reloads and one that concludes the feature is broken.
   *
   * Sessions do not survive: the guest manager detaches after 1.5s idle, which
   * wipes every session-level registration. So the map on the tab is the source
   * of truth and the session is (re)populated from it — see {@link syncSessionHold}
   * for the pin that stops the detach from happening in the first place.
   */
  async addInitScript(tabId: string, source: string): Promise<{ scriptId: string }> {
    const tab = this.requireTab(tabId);
    const text = source.trim();
    if (!text) throw new Error("script 不能为空");
    const response = await tab.cdp.send<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: text },
    );
    const scriptId = response?.identifier;
    if (!scriptId) throw new Error("页面没有返回脚本 id");
    if (!tab.initScripts) tab.initScripts = new Map();
    tab.initScripts.set(scriptId, { source: text, createdAt: new Date().toISOString() });
    this.syncSessionHold(tab);
    return { scriptId };
  }

  /**
   * The scripts registered on one page.
   *
   * Ordered by registration, which is also the order they run in — the page sees
   * them in the order they were added, and a caller that adds a wrapper and then
   * a config value depends on that.
   */
  listInitScripts(
    tabId: string,
  ): Array<{ scriptId: string; createdAt: string; preview: string }> {
    const tab = this.findTab(tabId);
    if (!tab?.initScripts) return [];
    return [...tab.initScripts.entries()].map(([scriptId, entry]) => ({
      scriptId,
      createdAt: entry.createdAt,
      // Enough to recognise the script in a list, not enough to hide a long one
      // behind an unreadable wall of text.
      preview: entry.source.replace(/\s+/g, " ").slice(0, 120),
    }));
  }

  /** Drops a registration; the next navigation stops running it. */
  async removeInitScript(tabId: string, scriptId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    if (!tab.initScripts?.has(scriptId)) throw new Error(`没有这个脚本：${scriptId}`);
    tab.initScripts.delete(scriptId);
    // Best effort: the id belongs to the current session, and a session that was
    // already released has forgotten it. The map is what a replay reads, so the
    // script stays gone either way.
    await tab.cdp
      .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId })
      .catch(() => undefined);
    this.syncSessionHold(tab);
  }

  /**
   * Re-installs this tab's init scripts into a freshly opened CDP session.
   *
   * Called from the guest manager's session-open hook. Returns the number of
   * scripts replayed so the caller can log a real value rather than a guess.
   *
   * The new session issues fresh identifiers, so the caller-visible ids from
   * before the replay no longer refer to anything. The map is therefore rebuilt
   * keyed by the new ids, keeping each script's original `createdAt` so a list
   * read after a replay does not look like everything was just added.
   */
  async replayInitScripts(tabId: string, cdp: CdpExecutor): Promise<number> {
    const tab = this.findTab(tabId);
    if (!tab?.initScripts?.size) return 0;
    const previous = [...tab.initScripts.values()];
    const rebuilt = new Map<string, { source: string; createdAt: string }>();
    for (const entry of previous) {
      try {
        const response = await cdp.send<{ identifier: string }>(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: entry.source },
        );
        if (response?.identifier) {
          rebuilt.set(response.identifier, { source: entry.source, createdAt: entry.createdAt });
        }
      } catch {
        // A session that cannot take the registration loses that script; the
        // others still go in, and the caller sees the count.
      }
    }
    tab.initScripts = rebuilt;
    return rebuilt.size;
  }

  /**
   * Stops whatever the page is executing right now.
   *
   * `Runtime.terminateExecution` unwinds the running stack, which is the only
   * thing that can rescue a caller whose script is in a busy loop. It is honest
   * about its limit: a script parked on a Promise is not executing, so it
   * resumes when the Promise settles. That is why the tool description offers it
   * as a brake rather than a guarantee.
   */
  async cancelScript(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    await tab.cdp.send("Runtime.terminateExecution", {});
  }

  async screenshot(
    tabId: string,
    options: {
      format?: "png" | "jpeg";
      quality?: number;
      inline?: boolean;
      timeoutMs?: number;
      target?: TargetInput;
    } = {},
  ): Promise<{ path: string; bytes: number; data?: string; mimeType?: string }> {
    const tab = this.requireTab(tabId);
    /*
     * An element target becomes a clip rectangle in the page.
     *
     * Resolved before the capture path is chosen, so a target that is not there
     * fails here with a reason — rather than producing a screenshot of the whole
     * viewport that looks like the answer. The rectangle is intersected with the
     * viewport because `clip` past the edge yields transparent pixels, not an
     * error.
     */
    let clip: { x: number; y: number; width: number; height: number; scale?: number } | undefined;
    if (options.target) {
      const spec = options.target;
      const box = await this.withDialogHint(tab, () =>
        tab.cdp.evaluate<{
          clip: { x: number; y: number; width: number; height: number } | null;
          devicePixelRatio: number;
        }>(buildElementRectExpression(spec)),
      );
      // A null answer means the element is not on screen *or* not in the page;
      // the two are told apart here so the message says which.
      if (!box) throw new Error(`找不到要截取的元素：${describeTarget(spec)}`);
      if (!box.clip) {
        throw new Error(`元素不在可视区域内，无法截取：${describeTarget(spec)}`);
      }
      /*
       * `scale` is the reciprocal of the device pixel ratio, and it is not
       * cosmetic: with `scale: 1` Chromium emits one image pixel per *device*
       * pixel, so a 200×80 CSS box came back as 300×120 on a 1.5× display. The
       * caller asked for the element's size, so that is what it gets.
       */
      clip = {
        ...box.clip,
        scale: 1 / (box.devicePixelRatio > 0 ? box.devicePixelRatio : 1),
      };
    }
    // A page the user switched away from, or one in a minimised window, has no
    // compositor frames: the CDP path would stall until its timeout, while the
    // renderer still paints into an offscreen surface (measured: 41ms and a full
    // image against a 5s timeout). Decide before priming — priming captures the
    // *host*, which is exactly the thing that never answers in that state.
    //
    // A clip makes this moot: the executor forces the compositor path for a
    // clipped capture, because the renderer path cannot take a rectangle.
    const preferRenderer = !this.isOnScreen(tab) && !clip;
    if (!preferRenderer) {
      // The embedder has to have painted before its guest can.
      await this.options.guests?.primeForCapture?.();
    }
    const buffer = await tab.cdp.screenshot({
      format: options.format,
      quality: options.quality,
      preferRenderer,
      ...(clip ? { clip } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    mkdirSync(this.options.shotDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const extension = options.format === "jpeg" ? "jpg" : "png";
    const file = join(this.options.shotDir, `${tab.id.slice(0, 8)}-${stamp}.${extension}`);
    writeFileSync(file, buffer);
    // The image also travels inline when asked. The file is still written: it is
    // what a person opens afterwards, and one write costs nothing next to the
    // capture. Only the inline copy is optional, because base64 in a tool result
    // is paid for in tokens.
    return {
      path: file,
      bytes: buffer.length,
      ...(options.inline
        ? { data: buffer.toString("base64"), mimeType: extension === "jpg" ? "image/jpeg" : "image/png" }
        : {}),
    };
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
      // Still answer the gesture. With no toolbar readout, a keystroke that
      // changes nothing and says nothing reads as a dead shortcut; the same
      // overlay as a real zoom at least names the state the page is in.
      const percent = Math.round((tab.viewportScale ?? 1) * 100);
      this.announceZoom(tab, percent);
      return percent;
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
    this.announceZoom(tab, next);
    this.emitState();
    return next;
  }

  /**
   * Tells the chrome what a zoom gesture landed on.
   *
   * The toolbar used to show this number permanently, so a keyboard user could
   * look up and see the result. With the stepper gone the gesture needs its own
   * feedback — a short overlay, exactly like the one every browser draws — and
   * only the main process knows a gesture happened, because Ctrl +/- and
   * Ctrl+wheel are consumed inside the page.
   */
  private announceZoom(tab: TabRecord, percent: number): void {
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    host.webContents.send("embedded:zoom-notice", {
      tabId: tab.id,
      zoom: Math.round(percent),
    });
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
    /*
     * Choosing a size replaces the device rather than layering under it.
     *
     * A device already carries a size; keeping both would leave two sources
     * disagreeing about how wide the page is, and the menu would show a tick on
     * a device the page is not actually wearing. Moving from "iPhone" to a plain
     * 390×844 viewport means "keep the size, stop pretending to be a phone",
     * which is the direction people debug in.
     */
    if (tab.device) {
      void this.applyDevice(tab, undefined);
    }
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

  /**
   * Applies, replaces or clears a page's device emulation.
   *
   * Three things have to move together and they live in different places:
   *
   * - **Geometry** (`setDeviceMetricsOverride`) changes the layout viewport, the
   *   DPR the page reads and whether it believes it is mobile, which is what
   *   media queries and `innerWidth` see.
   * - **Touch** is a separate switch. Without it a page that feature-detects
   *   `maxTouchPoints` serves its desktop UI at a phone width, which looks like
   *   the emulation half-failed.
   * - **UA** is a third switch again. Sites that branch on it (a `/m` redirect,
   *   "open our app" banners) only react to this one.
   *
   * All of it is applied through CDP, and CDP overrides do **not** survive the
   * session being released: the guest manager detaches after 1.5 seconds idle
   * (deliberately — a long-lived debugger session is detectable), and a reopened
   * session comes back at the real viewport, desktop DPR, no touch. Measured, not
   * assumed. So a page wearing a device pins its session for as long as it wears
   * it; that is the one page the user has explicitly asked to treat as a
   * test target, which is the right place to spend the detectability.
   */
  async setDevice(tabId: string, device: EmbeddedDevice | null): Promise<EmbeddedDevice | null> {
    const tab = this.requireTab(tabId);
    /*
     * Clearing keeps the size as a plain viewport.
     *
     * The alternative — snapping back to the cell — throws away the layout the
     * user was looking at, and "stop pretending to be a phone" is not the same
     * request as "stop being 390 wide". A device is a superset; dropping back
     * down keeps the part that still applies.
     */
    const keepSize = device ? undefined : tab.device;
    await this.applyDevice(tab, device ?? undefined);
    if (keepSize) tab.viewportOverride = { width: keepSize.width, height: keepSize.height };
    this.applyLayout();
    this.emitState();
    return device;
  }

  /** Pushes one device (or none) into the page over CDP. */
  private async applyDevice(
    tab: TabRecord,
    device: EmbeddedDevice | undefined,
    options: { reapply?: boolean } = {},
  ): Promise<void> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    const before = tab.device;
    if (device) tab.device = device;
    else delete tab.device;
    // `reapply` is for a fresh document: the record did not change, but the page
    // forgot everything, so the overrides have to be sent again.
    const changed =
      options.reapply === true ||
      !before !== !device ||
      (device && before && JSON.stringify(before) !== JSON.stringify(device));
    if (!changed) return;
    if (options.reapply) {
      // A fresh document starts with no mouse-to-touch conversion.
      delete tab.mouseTouchEnabled;
    } else {
      // Do not carry the native touch cursor into the next device state; the
      // poller turns it back on if the pointer is over this page.
      this.setMouseTouch(tab, false);
    }
    try {
      if (device) {
        await tab.cdp.send("Emulation.setDeviceMetricsOverride", {
          width: device.width,
          height: device.height,
          deviceScaleFactor: device.dpr,
          /*
           * Mobile viewport behaviour is not the touch switch.
           *
           * It used to be `device.touch`. Turning touch off on a phone then
           * switched the metrics override into desktop mode, where the page's
           * fit-to-cell zoom is applied a second time: a 393×852 iPhone
           * reported `innerWidth` 427 and `devicePixelRatio` 2.76. The device
           * is still a phone without touch, and its DPR/UA say so — only a
           * plain desktop size (the viewport path) is non-mobile.
           */
          mobile: device.touch || device.dpr > 1 || Boolean(device.userAgent),
        });
        await tab.cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: device.touch,
          maxTouchPoints: device.touch ? 5 : 1,
        });
        /*
         * Capability is not behaviour.
         *
         * `setTouchEmulationEnabled` only raises `maxTouchPoints`: a real mouse
         * still produces mouse events, so a drag selects text instead of
         * scrolling and the page never sees a finger. The second command —
         * mouse-to-touch conversion — is deliberately not sent here: it also
         * installs Chromium's native touch cursor on the whole window, so the
         * pointer poller turns it on only while the pointer is over this page.
         */
        if (!device.touch) this.setMouseTouch(tab, false);
        if (device.userAgent) {
          await tab.cdp.send("Emulation.setUserAgentOverride", {
            userAgent: device.userAgent,
          });
        } else {
          await tab.cdp.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
        }
      } else {
        await tab.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
        await tab.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(
          () => undefined,
        );
        await tab.cdp
          .send("Emulation.setEmitTouchEventsForMouse", { enabled: false })
          .catch(() => undefined);
        await tab.cdp.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(
          () => undefined,
        );
      }
    } catch {
      // A page that navigated mid-call has nothing to emulate. The device stays
      // on the record so the next load re-applies it.
    }
    // Pinned while wearing a device: idle release would silently drop all three
    // overrides, and the page would quietly become a desktop browser again.
    this.syncSessionHold(tab);
    this.syncTouchCursorPoller();
  }

  /**
   * Applies, replaces or clears one page's environment overrides.
   *
   * Four independent dials, each with its own protocol story:
   *
   * - **Timezone** has no explicit clear command: an empty `timezoneId` is how
   *   Chromium itself unsets the override, and that is what DevTools sends.
   * - **Media type** is the same shape — an empty string means "stop pretending".
   * - **Offline** rides `Network.emulateNetworkConditions`. Restoring goes back
   *   to unlimited throughput (`-1`), which is the protocol's "no cap" marker,
   *   not zero: zero would be a link that exists but never moves a byte.
   * - **Geolocation** is the one domain with a real clear command
   *   (`clearGeolocationOverride`).
   *
   * A key that is present in `patch` — even as `undefined`/`null` — is applied
   * or cleared; a key left out entirely is untouched. The returned object is
   * what is in force afterwards, read back from the tab record rather than from
   * CDP, which has no "what is overridden" query. Any override pins the CDP
   * session the same way device emulation does: the idle detach would silently
   * drop every one of these and the page would drift back to reality mid-run.
   *
   * Known limit, stated rather than papered over: overriding coordinates does
   * not grant the page the *permission* to call the geolocation API. A page the
   * user has not granted will fail at its permission check and never see the
   * coordinates — permission grants sit in the forbidden CDP tier on purpose.
   */
  async setEmulation(
    tabId: string,
    patch: {
      timezone?: string | null;
      mediaType?: string | null;
      offline?: boolean | null;
      geolocation?: EmbeddedGeolocation | null;
    },
  ): Promise<EmbeddedEmulation> {
    const tab = this.requireTab(tabId);
    const next: EmbeddedEmulation = { ...(tab.emulation ?? {}) };
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) throw new Error("页面已关闭");

    if ("timezone" in patch) {
      const value = typeof patch.timezone === "string" ? patch.timezone.trim() : "";
      if (value) {
        // Reject a name the page's own Intl would reject, so the tool call says
        // "Asia/Tokyo is misspelled" instead of a silent no-op override.
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: value });
        } catch {
          throw new Error(`不是有效的 IANA 时区名：${value}`);
        }
        await tab.cdp.send("Emulation.setTimezoneOverride", { timezoneId: value });
        next.timezone = value;
      } else {
        await tab.cdp.send("Emulation.setTimezoneOverride", { timezoneId: "" });
        delete next.timezone;
      }
    }

    if ("mediaType" in patch) {
      const value = typeof patch.mediaType === "string" ? patch.mediaType.trim() : "";
      await tab.cdp.send("Emulation.setEmulatedMedia", { media: value });
      if (value) next.mediaType = value;
      else delete next.mediaType;
    }

    if ("offline" in patch) {
      const offline = patch.offline === true;
      /*
       * `emulateNetworkConditions` lives in the Network domain, and a domain
       * that was never enabled accepts the command but applies nothing —
       * measured, not guessed: without this the page's own fetch sails through
       * an "offline" override. The frontend always enables first, so that is
       * what this does too. Enabling starts an event stream, but the override
       * pins the session anyway, so the cost is already being paid.
       */
      await tab.cdp.send("Network.enable").catch(() => undefined);
      await tab.cdp.send("Network.emulateNetworkConditions", offline
        ? { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
        : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      if (offline) next.offline = true;
      else delete next.offline;
    }

    if ("geolocation" in patch) {
      const value = patch.geolocation;
      if (
        value &&
        Number.isFinite(value.latitude) &&
        Number.isFinite(value.longitude)
      ) {
        const params = {
          latitude: value.latitude,
          longitude: value.longitude,
          accuracy: Number.isFinite(value.accuracy) && (value.accuracy as number) > 0
            ? (value.accuracy as number)
            : 1,
        };
        await tab.cdp.send("Emulation.setGeolocationOverride", params);
        next.geolocation = params;
      } else {
        await tab.cdp.send("Emulation.clearGeolocationOverride");
        delete next.geolocation;
      }
    }

    if (Object.keys(next).length === 0) delete tab.emulation;
    else tab.emulation = next;
    this.syncSessionHold(tab);
    return { ...next };
  }

  /**
   * Turns mouse-to-touch conversion on or off for one page.
   *
   * Chromium's conversion comes with a native touch cursor image. Leaving it
   * enabled while the pointer is away is what painted that gray dot over the
   * toolbar and DevTools. The capability (`setTouchEmulationEnabled`) stays on
   * for the whole document so `maxTouchPoints` never flickers; only the mouse
   * conversion follows the pointer.
   */
  private setMouseTouch(tab: TabRecord, enabled: boolean): void {
    if (tab.view?.webContents.isDestroyed()) {
      delete tab.mouseTouchEnabled;
      return;
    }
    // Disabling after a device was cleared still has to reach the page.
    if (enabled && !tab.device?.touch) return;
    if (tab.mouseTouchEnabled === enabled) return;
    if (!enabled && tab.mouseTouchEnabled === undefined) return;
    tab.mouseTouchEnabled = enabled;
    void tab.cdp
      .send("Emulation.setEmitTouchEventsForMouse", { enabled, configuration: "mobile" })
      .catch(() => {
        // A page that navigated mid-call has no state to correct. Mark the
        // command as outstanding in the direction that makes the next tick
        // retry: an enable retries as "unknown", a disable as "still on".
        if (tab.mouseTouchEnabled === enabled) {
          tab.mouseTouchEnabled = enabled ? undefined : true;
        }
      });
  }

  /**
   * Starts or stops the pointer feed that scopes mouse-to-touch conversion.
   *
   * Chromium's conversion installs a native cursor image on the window, so it
   * must only run while the pointer is actually over a touch page. Main polls
   * the system pointer, enables conversion for the page under it, and disables
   * it everywhere else. The interval runs only while a touch page is on stage
   * and the window has focus.
   */
  private syncTouchCursorPoller(): void {
    const host = this.host;
    const active =
      Boolean(host && !host.isDestroyed() && host.isFocused() && !host.isMinimized()) &&
      Boolean(this.stage) &&
      this.tabs.some(
        (tab) => tab.device?.touch && tab.view && !tab.view.webContents.isDestroyed(),
      );
    if (!active) {
      this.stopTouchCursorPoller();
      return;
    }
    if (this.touchCursorTimer) return;
    this.touchCursorTimer = setInterval(() => this.tickTouchCursor(), 16);
    this.tickTouchCursor();
  }

  private stopTouchCursorPoller(): void {
    if (this.touchCursorTimer) {
      clearInterval(this.touchCursorTimer);
      this.touchCursorTimer = undefined;
    }
    for (const tab of this.tabs) {
      if (tab.mouseTouchEnabled) this.setMouseTouch(tab, false);
    }
  }

  private tickTouchCursor(): void {
    const host = this.host;
    const stage = this.stage;
    if (
      !host ||
      host.isDestroyed() ||
      !host.isFocused() ||
      host.isMinimized() ||
      !stage ||
      !this.tabs.some(
        (tab) => tab.device?.touch && tab.view && !tab.view.webContents.isDestroyed(),
      )
    ) {
      this.stopTouchCursorPoller();
      return;
    }
    const point = screen.getCursorScreenPoint();
    const content = host.getContentBounds();
    for (const tab of this.tabs) {
      const inside = Boolean(
        tab.device?.touch &&
          this.stagedTabs.has(tab.id) &&
          pointerInsidePage(point, content, stage, tab.view.getBounds()),
      );
      if (tab.device?.touch) this.setMouseTouch(tab, inside);
    }
  }

  /**
   * Whether this page's CDP session has to stay attached, and why.
   *
   * Four features live in session state rather than in the target — device
   * emulation overrides, the performance counters, the environment overrides
   * (timezone / media / offline / geolocation), and pre-document scripts —
   * and all of them are wiped by the idle detach. They are also independent: a
   * page can be wearing a phone while a script registration is added and removed
   * around it, and unpinning on the last removal used to be the kind of bug that
   * silently turns the emulated phone back into a desktop mid-run.
   *
   * One predicate, one call site, so "nothing needs the session" is decided in
   * exactly one place.
   */
  private syncSessionHold(tab: TabRecord): void {
    const needed = Boolean(
      tab.device || tab.perf || tab.emulation || (tab.initScripts?.size ?? 0) > 0,
    );
    this.options.guests?.holdSession?.(tab.id, needed);
  }

  /**
   * Switches which tab of the docked panel owns its rectangle.
   *
   * Three tabs, one rectangle. The native front-end cannot share: it is a
   * `WebContentsView`, so it paints over anything the renderer draws and hiding
   * it is the only way our own panels can be seen. So the front-end is parked
   * (zero-sized, not closed — its console history has to survive a trip to
   * another tab and back) while one of ours is showing.
   */
  showDevtoolsTab(tabId: string, tab: "front-end" | "device" | "performance"): void {
    const record = this.requireTab(tabId);
    if (!record.devtools) throw new Error("开发者工具面板没有打开");
    record.devtoolsTab = tab === "front-end" ? undefined : tab;
    if (tab === "front-end") this.placeDevTools(record);
    else record.devtools.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    /*
     * Sampled only while its tab is showing.
     *
     * The sampler pins the CDP session, and a pinned session is detectable by
     * the page. Keeping it running after the user looks away would pay that
     * cost for numbers nobody is reading — so leaving the tab stops it.
     */
    if (tab === "performance") void this.startPerfSampling(record);
    else this.stopPerfSampling(record);
    this.emitState();
  }

  /** Samples this page's performance metrics, replacing any earlier history. */
  private async startPerfSampling(tab: TabRecord, owner: "panel" | "ai" = "panel"): Promise<void> {
    this.stopPerfSampling(tab);
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    tab.perf = {
      history: [],
      previous: undefined,
      startedAt: Date.now(),
      firstAt: Date.now(),
      owner,
    };
    try {
      await tab.cdp.send("Performance.enable");
    } catch {
      // A page that cannot be sampled reports an empty series rather than an
      // error: the panel is still useful for reading the device tab.
      return;
    }
    const generation = (tab.perfGeneration ?? 0) + 1;
    tab.perfGeneration = generation;
    const { intervalMs, windowMs } = this.perfConfig;
    /** Last time the renderer was told about new samples; see the note below. */
    let lastPublish = 0;
    const tick = async (): Promise<void> => {
      // A newer start (or a stop) invalidates this closure: without the check a
      // second start would leave the first timer writing into its own record.
      if (tab.perfGeneration !== generation || !tab.perf) return;
      const now = Date.now();
      // The rate for *this* sample is the gap since the previous reading. Using
      // the total elapsed time averaged every spike into the whole run, which is
      // why the first version drew near-flat lines on a page that was visibly
      // busy.
      const interval = now - tab.perf.firstAt;
      tab.perf.firstAt = now;
      try {
        const response = await tab.cdp.send<{ metrics?: Array<{ name: string; value: number }> }>(
          "Performance.getMetrics",
        );
        const raw: RawMetrics = {};
        for (const item of response?.metrics ?? []) {
          (raw as Record<string, number>)[item.name] = item.value;
        }
        const sample = deriveSample(tab.perf.previous, raw, interval, tab.perf.startedAt);
        tab.perf.history = pushSample(tab.perf.history, sample, { windowMs, intervalMs });
        tab.perf.previous = raw;
        /*
         * Publish at most once a second.
         *
         * Sampling runs at 5 Hz so a 200ms freeze is visible, but every publish
         * runs the renderer's whole reactive pass; doing that 5×/s would make
         * the panel itself the thing your are measuring. The panel polls, so it
         * still refreshes five times a second — it just reads the array instead
         * of being pushed a full workspace state each time.
         */
        if (now - lastPublish >= 1_000) {
          lastPublish = now;
          this.emitState();
        }
      } catch {
        // The page navigated or went away mid-sample; the next tick either
        // recovers or the tab is gone.
      }
      if (tab.perfGeneration !== generation || !tab.perf) return;
      tab.perf.timer = setTimeout(() => void tick(), intervalMs);
      tab.perf.timer.unref?.();
    };
    tab.perf.timer = setTimeout(() => void tick(), intervalMs);
    tab.perf.timer.unref?.();
    // Same reason as the device overrides: the counters reset with a new
    // document, so the series has to restart rather than draw a cliff.
    this.syncSessionHold(tab);
  }

  private stopPerfSampling(tab: TabRecord): void {
    if (tab.perf?.timer) clearTimeout(tab.perf.timer);
    if (tab.perf?.aiIdleTimer) clearTimeout(tab.perf.aiIdleTimer);
    delete tab.perf;
    tab.perfGeneration = (tab.perfGeneration ?? 0) + 1;
    // A device or a script registration still needs the session; the predicate
    // knows about all of them.
    this.syncSessionHold(tab);
  }

  /** The samples taken so far, for the panel to draw. */
  perfHistory(tabId: string): PerfSample[] {
    return this.findTab(tabId)?.perf?.history ?? [];
  }

  /**
   * Raw samples for an agent, trimmed to something a model can actually read.
   *
   * Starts the sampler if nobody is measuring, so a model that only wants the
   * series does not have to call `measurePerformance` first and throw its
   * numbers away. What it gets is the history as configured — the sampler has
   * already trimmed it to one window, so a request never returns more than the
   * chart is showing.
   */
  async readPerfHistory(tabId: string, idleMs = 15_000): Promise<PerfSample[]> {
    const tab = this.requireTab(tabId);
    if (!tab.perf) await this.startPerfSampling(tab, "ai");
    const perf = this.findTab(tabId)?.perf;
    if (!perf) throw new Error("这一页无法读取性能指标");
    if (perf.owner === "ai") {
      if (perf.aiIdleTimer) clearTimeout(perf.aiIdleTimer);
      perf.aiIdleTimer = setTimeout(() => {
        const record = this.findTab(tabId);
        if (record?.perf?.owner === "ai") this.stopPerfSampling(record);
      }, Math.max(0, idleMs));
      perf.aiIdleTimer.unref?.();
    }
    return perf.history;
  }

  /**
   * Samples for a while and reports what the page did, as numbers an agent can
   * act on.
   *
   * Why this exists at all: an agent asked "is this page slow" can already read
   * the console and take screenshots, and neither answers it. It could call
   * `evaluate_browser_page` with a `performance.now()` loop of its own, but that
   * measures its own script rather than the page's rendering and GC work — the
   * numbers would be worse than no numbers. CDP's `Performance.getMetrics` is
   * the same source Chrome's own monitor reads, so the tool hands back facts
   * with a known provenance instead of a home-grown approximation.
   *
   * The shape is a summary, not a series. A model cannot read a sparkline, and
   * a hundred raw points make it average in prose and get it wrong; `max` and
   * `maxAt` answer "did it stutter, and when" directly. `maxAt` is milliseconds
   * from the window's start, which pairs with the `at` timestamps of the console
   * lines it already reads — that pairing is the point.
   *
   * Consecutive reads continue rather than restart, and sampling keeps running
   * between them for a short idle period. That is what makes "measure, click,
   * measure again" see the click: the second call reports what happened while
   * the first call was still fresh, not an empty window after it.
   */
  async measurePerformance(
    tabId: string,
    options: { durationMs: number; idleMs: number },
  ): Promise<{
    tabId: string;
    url: string;
    title: string;
    /** Wall clock of the window this summary covers. */
    from: string;
    to: string;
    /** How long this call waited, as asked. */
    durationMs: number;
    /** The configured chart window, so a caller knows what the series holds. */
    windowMs: number;
    /** The configured sampling interval. */
    intervalMs: number;
    samples: number;
    metrics: Record<PerfMetric, PerfMetricSummary>;
  }> {
    const tab = this.requireTab(tabId);
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) throw new Error("页面已关闭");
    /*
     * Take over only when nothing is sampling.
     *
     * The panel owns its sampler while its tab is showing, and restarting it
     * here would wipe the history a person is watching — an agent read must not
     * blank someone's chart. Sharing the running sampler is also what makes the
     * numbers agree: one reader, one series.
     */
    if (!tab.perf) await this.startPerfSampling(tab, "ai");
    const perf = tab.perf;
    if (!perf) {
      // `Performance.enable` failed: the page refuses to be measured.
      throw new Error("这一页无法读取性能指标");
    }
    if (perf.owner === "ai" && perf.aiIdleTimer) {
      clearTimeout(perf.aiIdleTimer);
      delete perf.aiIdleTimer;
    }
    const startedAt = Date.now();
    await new Promise((done) => setTimeout(done, Math.max(0, options.durationMs)));
    // Re-read: the page may have closed, or the panel may have taken over while
    // this call was waiting out its window.
    const live = this.findTab(tabId)?.perf;
    if (!live) throw new Error("采样在测量期间被停止");
    /*
     * Only what an agent has not seen yet.
     *
     * The first read reports its whole window; a later one continues from the
     * previous cursor. Without the cursor the second call would repeat numbers
     * the model already acted on, and a series that repeats itself is a series a
     * model reasons about twice.
     */
    const from = live.aiCursor ?? 0;
    const fresh = live.history.filter((sample) => sample.t > from);
    const metrics = {} as Record<PerfMetric, PerfMetricSummary>;
    for (const metric of PERF_METRICS) {
      const summary = perfSummarize(fresh, metric);
      /*
       * A metric with no usable reading still needs a row, but it must not read
       * as "zero". `samples: 0` is the honest answer for a rate whose window held
       * only the warmup reading — callers are told to treat it as "not measured
       * yet" rather than "the page was idle".
       */
      metrics[metric] = summary ?? { avg: 0, max: 0, maxAt: 0, last: 0, samples: 0 };
    }
    const newest = fresh[fresh.length - 1] ?? live.history[live.history.length - 1];
    if (newest) live.aiCursor = newest.t;
    /*
     * Keep sampling for a quiet period, then let go.
     *
     * An agent's next call usually follows an action, and the action's cost
     * happens *between* calls. Sampling only inside the call would miss exactly
     * what the agent wanted to measure. The pin is bounded either way: this
     * timer releases it, and the panel taking over releases it immediately.
     */
    if (live.owner === "ai") {
      live.aiIdleTimer = setTimeout(() => {
        const record = this.findTab(tabId);
        if (record?.perf?.owner === "ai") this.stopPerfSampling(record);
      }, Math.max(0, options.idleMs));
      live.aiIdleTimer.unref?.();
    }
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      from: new Date(live.startedAt + from).toISOString(),
      to: new Date(live.startedAt + (newest?.t ?? from)).toISOString(),
      durationMs: Date.now() - startedAt,
      windowMs: this.perfConfig.windowMs,
      intervalMs: this.perfConfig.intervalMs,
      samples: fresh.length,
      metrics,
    };
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
  async openDevTools(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;
    // A frozen page must not be inspected before its script is running again:
    // the first evaluate from the panel would otherwise never return.
    this.wakeTab(tabId);
    if (tab.devtools) {
      this.placeDevTools(tab);
      this.emitState();
      return;
    }
    /*
     * Prime the language before the real front-end exists.
     *
     * The preference lives in the `devtools://` session's localStorage, so it
     * has to be written by some front-end document. Doing that in the view that
     * will host the tools was the obvious shortcut and it broke the panel: the
     * front-end initialised once without a host, and `setDevToolsWebContents`
     * afterwards left it a shell — toolbar and tabs drawn, Elements empty.
     * A throwaway view writes the same storage without ever initialising the
     * front-end that is about to be attached.
     */
    await this.primeDevToolsLanguage(contents);
    // The page may have been closed while the priming document loaded.
    if (!this.tabs.includes(tab) || contents.isDestroyed()) return;
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
    /*
     * DevTools gets an explicit default cursor too.
     *
     * A touch page hides the system pointer while it is under it; DevTools is a
     * separate native surface and its own `auto` subtree can keep the last
     * cursor Chromium applied when the pointer crosses the split. A concrete
     * default on its root makes the crossing hand the arrow back. Controls that
     * name their own cursor (links, resize handles) still win.
     */
    view.webContents.on("did-finish-load", () => {
      void view.webContents
        .insertCSS("html, body { cursor: default; }", { cssOrigin: "user" })
        .catch(() => undefined);
    });
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
   * Puts the DevTools language preference in place before the visible panel
   * opens. The write itself lives in `devtools-language.ts`: it needs a real,
   * host-bound front-end, so it runs in a throwaway view rather than in the one
   * that becomes the panel.
   */
  private async primeDevToolsLanguage(contents: WebContents): Promise<void> {
    if (this.devtoolsLanguagePrimed) return;
    const host = this.host;
    if (!host || host.isDestroyed()) return;
    const language = app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en";
    if (await primeDevToolsFrontendLanguage({ host, contents, language })) {
      this.devtoolsLanguagePrimed = true;
    }
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
    // Closing a tab can arrive while the page's already going away, so every
    // step here tolerates a dead surface: the panel still has to be released.
    try {
      const contents = tab.view?.webContents;
      if (contents && !contents.isDestroyed()) contents.closeDevTools();
    } catch {
      // The page is gone; the panel below is what still needs tearing down.
    }
    try {
      this.host?.contentView.removeChildView(devtools.view);
    } catch {
      // The window may be closing; the front-end is closed next either way.
    }
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
    // A stage-covering menu is up: stay parked until the cover ends (see
    // `setDevtoolsParked`), or the next layout pass would resurface the panel
    // right through the menu.
    if (this.devtoolsParked) {
      this.parkDevTools(tab, true);
      return;
    }
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
    /*
     * Split the *cell*, then fit the viewport into the area that is left.
     *
     * Splitting the page's already-fitted box looked equivalent and is not: a
     * 393×852 device in a wide cell is fitted to a tall, narrow box, and taking
     * 42% of *that* left the panel about 150px wide — one click on "iPhone 15"
     * collapsed the very panel being used to pick it. The panel's width belongs
     * to the cell, not to the page's aspect ratio.
     *
     * The page side still gets a freshly fitted rect (below), which is what the
     * earlier fix was really about: the split area is not the page's bounds,
     * the fit inside the split area is.
     */
    const left = this.splitWidth(rect, devtools.width);
    this.fitPageBesidePanel(tab, rect, left);
    /*
     * Only the native front-end owns this rectangle, and only while it is the
     * tab showing.
     *
     * `placeDevTools` runs on every layout pass — a resize of the page, a split
     * drag, a re-stage. Writing the panel's bounds unconditionally brought the
     * native view back over our own Device/Performance panel mid-drag, where
     * being a native view it naturally painted on top of the HTML. The user saw
     * "dragging the split teleports me back to DevTools".
     */
    if (tab.devtoolsTab) {
      devtools.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      return;
    }
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

  /**
   * The width the page keeps when its panel is docked beside it.
   *
   * Shared by `placeDevTools` (which splits the cell) and `parkDevTools` (which
   * hides the panel but must leave the page where it is), so the two can never
   * disagree about where the split falls.
   */
  private splitWidth(rect: StageRect, width: number): number {
    const split = Math.round(rect.width * (1 - width));
    return Math.max(1, split - Math.round(EMBEDDED_DEVTOOLS_GRIP / 2));
  }

  /**
   * Fits a page into the width left beside its panel.
   *
   * Shared by the docked and the parked states. `parkDevTools` used to write the
   * raw split rectangle, which ignored a fixed viewport: opening any floating
   * layer (the address bar's suggestions, a menu) parked the panel and grew the
   * page to the split width while emulation still laid out at 390px. The page
   * then sat at the top-left with the rest of its node empty, and the touch
   * cursor covered that empty area too.
   */
  private fitPageBesidePanel(tab: TabRecord, cell: StageRect, left: number): void {
    const area = { ...cell, width: left };
    const viewport = this.viewportOf(tab);
    if (!viewport) {
      delete tab.viewportScale;
      delete tab.fitCell;
      tab.view.setBounds(area);
      return;
    }
    /*
     * A fixed page keeps a margin of host space around it.
     *
     * The frame's resize handles sit just outside the page, but a handle that
     * overlaps the guest loses the pointer (and its cursor) to the page — and
     * under touch emulation the page paints a dot there. The margin is what
     * makes the edge of the viewport draggable, instead of just looking like an
     * edge. Adaptive pages have no frame, so they still fill their box.
     */
    const framed = {
      x: area.x + EMBEDDED_PAGE_FRAME_GUTTER,
      y: area.y + EMBEDDED_PAGE_FRAME_GUTTER,
      width: Math.max(1, area.width - EMBEDDED_PAGE_FRAME_GUTTER * 2),
      height: Math.max(1, area.height - EMBEDDED_PAGE_FRAME_GUTTER * 2),
    };
    const { rect, scale } = viewportFitRect(framed, viewport);
    tab.viewportScale = scale;
    tab.fitCell = framed;
    tab.view.webContents.setZoomFactor(scale);
    tab.view.setBounds(rect);
  }

  /**
   * Keeps a panel out of sight without tearing it down.
   *
   * `holdPage` keeps the page at its docked width instead of letting it grow
   * back over the space the panel still owns. Without that, opening any floating
   * layer (a menu, the downloads panel) made the page visibly jump wider and the
   * panel blink out — which reads as "DevTools disappeared", not as "a menu
   * opened". The panel is still hidden, because a native view cannot be covered
   * by renderer HTML; what changes is that the layout holds still while it is.
   */
  private parkDevTools(tab: TabRecord, holdPage = false): void {
    const devtools = tab.devtools;
    if (!devtools) return;
    devtools.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    if (!holdPage) return;
    const rect = this.cellOf(tab);
    if (!rect) return;
    this.fitPageBesidePanel(tab, rect, this.splitWidth(rect, devtools.width));
  }

  /**
   * Steps every docked panel aside while a menu that reaches the stage is up.
   *
   * The panel is a native `WebContentsView`: it stacks over everything the
   * renderer draws, so a dropdown opening across it is buried mid-list no
   * matter what z-index the menu claims (the same physics that once required
   * the page surface itself to yield). Parked panels come back with the next
   * layout pass, which is why the flag is checked inside `placeDevTools`.
   */
  setDevtoolsParked(parked: boolean): void {
    if (this.devtoolsParked === parked) return;
    this.devtoolsParked = parked;
    for (const tab of this.tabs) {
      if (!tab.devtools) continue;
      // Holding the page at its docked width while parked is what makes the
      // panel read as "stepped aside" rather than "vanished and took the split
      // with it": the layer covers the panel's old spot while the page stays put.
      if (parked) this.parkDevTools(tab, true);
      else this.placeDevTools(tab);
    }
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

/**
 * One line describing a raw CDP reply.
 *
 * The point is to be useful in a flow's step list without dumping a protocol
 * object. A `Runtime.evaluate` reply is reduced to the value it produced (the
 * remote object id is meaningless outside the call), an empty reply is "完成",
 * and anything else falls back to a bounded JSON preview.
 */
function summarizeCdpResult(response: unknown): string {
  if (response === undefined || response === null) return "完成";
  if (typeof response === "string" || typeof response === "number" || typeof response === "boolean") {
    return String(response).slice(0, 200);
  }
  const record = response as Record<string, unknown>;
  const evaluated = record["result"];
  if (evaluated && typeof evaluated === "object") {
    const value = (evaluated as Record<string, unknown>)["value"];
    if (value !== undefined) return String(value).slice(0, 200);
  }
  try {
    const text = JSON.stringify(response);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "完成";
  }
}

/** runFlow 单步执行的结果：detail 进日志，value 由 read/script 产出供原语取值。 */
interface FlowStepOutcome {
  detail?: string;
  value?: string;
}

/**
 * wait 的「流程预算耗尽」信号。
 *
 * wait 原来直接在 case 里 return 整个失败结果；单步执行被抽成函数后，
 * 这个结果要穿过原语路径（脚本里的 `await wait(...)`）回到循环才能上报，
 * 用一个专门的错误类型携带它——循环按原来的形状（reason、不含当前步骤的
 * steps）转成 FlowRunResult，调用方看到的东西不变。
 */
class FlowBudgetExhaustedError extends Error {
  constructor() {
    super("流程预算已用完");
    this.name = "FlowBudgetExhaustedError";
  }
}
