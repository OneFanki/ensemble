import type { WebContents } from "electron";
import { GuestSessions, type GuestCdpPort, type GuestHandle } from "@core/cdp/guest-sessions";
import { GuestSlots } from "@core/cdp/guest-slots";
import { hardenGuestPreferences } from "@core/cdp/guest-policy";
import { withDeadline } from "@shared/async";
import { EmbeddedCdp } from "./cdp";
import type { GuestCdpTarget } from "./guest-cdp";

/**
 * How long the embedder gets to produce a frame before a capture gives up.
 *
 * Same order as the guest-side deadline (4s) but shorter: this is the window
 * itself, and a window that has not painted in 2s will not paint in 4. Falling
 * back to the renderer path is the normal outcome, not an error.
 */
const HOST_FRAME_TIMEOUT_MS = 2_000;

/**
 * The main-process half of a `<webview>`-hosted page.
 *
 * The renderer owns the node and therefore the process lifetime; main only
 * borrows the guest's `webContents` to drive CDP. That split is why this class
 * exists at all: everything the old `WebContentsView` surface got from owning
 * the view — attaching, session state, popup routing, teardown — has to be
 * rebuilt on top of a target someone else can destroy at any moment.
 *
 * The command surface is not rebuilt: {@link EmbeddedCdp} already works against
 * any `webContents`, so a guest gets exactly the same executor the native view
 * used. `GuestSessions` holds the lifecycle rules (idle release, teardown
 * handshake, generations) as plain logic so they can be tested without
 * Electron; this class is the adapter that wires attach events, hardening and
 * the pending-until-attached handshake.
 */

export interface BrowserGuestManagerOptions {
  /**
   * Called when a guest asks to open a window.
   *
   * The guest never gets a real one: a native window would leave the session
   * isolation this surface exists for. Returning `true` means the URL was
   * routed into an app tab; anything else means it was refused.
   */
  onPopup?: (guestId: string, url: string) => boolean | void;
  /**
   * Called before every CDP command.
   *
   * The built-in surface uses it to wake a page that was put to sleep while
   * parked: the first command of a burst must not land on a frozen page.
   */
  onActivity?: (guestId: string) => Promise<void> | void;
  /**
   * Restores state that lives in the CDP session rather than the target.
   *
   * A session that was released and reopened comes back bare: `Page.enable` is
   * gone, so dialog events stop arriving with no error to show for it. Whatever
   * the surface relies on has to be replayed here, before the triggering
   * command runs.
   */
  onSessionOpen?: (guestId: string, cdp: EmbeddedCdp) => Promise<void>;
  /**
   * How long to keep the session attached after the last command.
   *
   * Anti-automation scripts probe for a debugger session and refuse to
   * continue; a login page is the common one. Releasing on idle keeps the
   * browser indistinguishable from a normal one whenever a human is driving.
   */
  idleDetachMs?: number;
  /** Upper bound on the teardown wait before the session is dropped anyway. */
  teardownTimeoutMs?: number;
  /** Failure report channel; never receives page content. */
  onError?: (message: string) => void;
}

interface GuestRecord {
  handle: GuestHandle;
  contents: WebContents;
  cdp: EmbeddedCdp;
  partition?: string;
  /**
   * A login-capture binding only has to be added once per target: it survives
   * both navigations and session detaches, and adding it twice throws.
   */
}

interface Waiter {
  resolve: (handle: GuestHandle) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserGuestManager {
  private readonly sessions: GuestSessions;
  private readonly guests = new Map<string, GuestRecord>();
  /** Correlation tokens (tab ids) → the guest id they resolved to. */
  private readonly keyToGuest = new Map<string, string>();
  /** Commands waiting for a guest that has not attached yet. */
  private readonly slots = new GuestSlots<GuestHandle>();
  /** Pages whose node the renderer has laid out at least once. */
  private readonly laidOut = new Set<string>();
  /** Commands waiting for that layout. */
  private readonly layoutWaiters = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  private host: WebContents | null = null;
  /** Whether the embedder has been made to produce a frame (see {@link primeHost}). */
  private hostPrimed = false;
  private readonly onWillAttach: (
    event: Electron.Event,
    preferences: Electron.WebPreferences,
    params: Record<string, string>,
  ) => void;
  private readonly onDidAttach: (event: Electron.Event, contents: WebContents) => void;

  constructor(private readonly options: BrowserGuestManagerOptions = {}) {
    this.sessions = new GuestSessions({
      ...(options.idleDetachMs !== undefined ? { idleDetachMs: options.idleDetachMs } : {}),
      ...(options.teardownTimeoutMs !== undefined
        ? { teardownTimeoutMs: options.teardownTimeoutMs }
        : {}),
    });
    this.onWillAttach = (event, preferences, params) => {
      const decision = hardenGuestPreferences(preferences, params);
      if (decision.ok) return;
      // Refusing here destroys the guest before it ever loads. The page wrote
      // something the surface never allows, so there is nothing to preserve.
      this.options.onError?.(`拒绝挂载页面：${decision.reason ?? "未通过校验"}`);
      event.preventDefault();
    };
    // Guests that attach without a waiter are still registered: the renderer
    // reports a node as soon as it exists, but a reload of the embedder can
    // re-attach one before that report arrives.
    this.onDidAttach = (_event, contents) => {
      this.register(contents);
      // Not awaited: the guest is usable for everything except screenshots
      // until the frame lands, and blocking the attach event would stall the
      // renderer's own `dom-ready` handling.
      void this.primeHost();
    };
  }

  /**
   * Binds the manager to the window that will host the `<webview>` nodes.
   *
   * Idempotent: the window can be recreated (the app lives in the tray), and
   * re-binding the same `webContents` would double every listener.
   */
  install(host: WebContents): void {
    if (this.host === host) return;
    this.uninstall();
    this.host = host;
    // A new window has never produced a frame; the next guest has to prime it
    // again, or every screenshot of a background tab waits out its timeout.
    this.hostPrimed = false;
    host.on("will-attach-webview", this.onWillAttach);
    host.on("did-attach-webview", this.onDidAttach);
  }

  uninstall(): void {
    const host = this.host;
    this.host = null;
    if (!host || host.isDestroyed()) return;
    host.off("will-attach-webview", this.onWillAttach);
    host.off("did-attach-webview", this.onDidAttach);
  }

  /** Number of guests currently attached; the surface uses it for diagnostics. */
  get size(): number {
    return this.guests.size;
  }

  /**
   * Makes the embedder produce a frame, so guests can be captured.
   *
   * A guest's compositor produces nothing until the page embedding it has
   * produced a frame of its own: `Page.captureScreenshot` on a guest does not
   * fail in that state, it never returns. Screenshots of background tabs are
   * the main use, so this runs once when the first guest attaches rather than
   * lazily per call — one 150ms prime instead of a 4s timeout per screenshot.
   *
   * Deliberately a CDP capture of the *host*: `capturePage()` on a window whose
   * page contains a webview throws `UnknownVizError`, and attaching without
   * capturing does not produce the frame.
   *
   * "Once" is per host frame, not per window: a window that is moved off every
   * display after its first frame (a headless run parks itself) stops producing
   * them, and the flag would then claim a prime that no longer holds. {@link
   * primeForCapture} is what callers use when a real capture is about to happen.
   */
  private async primeHost(): Promise<void> {
    const host = this.host;
    if (!host || host.isDestroyed() || this.hostPrimed) return;
    this.hostPrimed = true;
    await this.captureHost();
  }

  private async captureHost(): Promise<boolean> {
    const host = this.host;
    if (!host || host.isDestroyed()) return false;
    try {
      if (!host.debugger.isAttached()) host.debugger.attach("1.3");
      // Bounded, and the bound is not defensive padding: a window that is not
      // producing frames answers `Page.captureScreenshot` by never replying —
      // the same trap the guest path documents. Unbounded, that turns one
      // screenshot into a call that never returns, which a client reports as a
      // timeout minutes later with no clue where it hung.
      await withDeadline(
        host.debugger.sendCommand("Page.captureScreenshot", { format: "png" }),
        HOST_FRAME_TIMEOUT_MS,
        "embedder produced no frame",
      );
      return true;
    } catch {
      // A window that cannot be captured still works for everything except
      // guest screenshots; retrying on every command would be worse.
      return false;
    } finally {
      try {
        if (!host.isDestroyed() && host.debugger.isAttached()) host.debugger.detach();
      } catch {
        // The host died under the session; nothing to release.
      }
    }
  }

  /**
   * Primes the embedder right before a guest capture.
   *
   * Cheap when the window is already painting — the point is that "already
   * primed" cannot be remembered: a parked window, a minimised one and one that
   * was just moved produce no frames, and a guest whose embedder is not
   * producing frames waits out the whole screenshot deadline.
   */
  async primeForCapture(): Promise<boolean> {
    this.hostPrimed = true;
    return this.captureHost();
  }

  /**
   * Registers an attached guest and starts watching it.
   *
   * `did-attach-webview` is the normal entry point; the renderer's report goes
   * through here too, so a guest that attaches before the renderer could report
   * it is not registered twice. `host` is the embedding window, when the caller
   * can name it: it makes "a guest of this window" checkable instead of "some
   * guest somewhere in the app".
   */
  register(contents: WebContents, host?: WebContents): GuestHandle {
    if (host && contents.hostWebContents && contents.hostWebContents !== host) {
      throw new Error("页面不属于此窗口");
    }
    const guestId = String(contents.id);
    const existing = this.guests.get(guestId);
    if (existing) return existing.handle;

    const cdp = new EmbeddedCdp(contents, () => this.options.onActivity?.(guestId));
    const record: GuestRecord = {
      handle: this.sessions.attach(guestId, this.createPort(guestId, contents, cdp)),
      contents,
      cdp,
    };
    this.guests.set(guestId, record);
    this.routeWindowOpen(record);

    // `destroyed` is the only signal that the node is gone; the renderer may
    // remove it without telling us first (a reload of the embedder, a crash).
    contents.once("destroyed", () => {
      this.guests.delete(guestId);
      this.sessions.forget(guestId);
    });
    return record.handle;
  }

  /**
   * Keeps a guest's session attached, or releases it on the next idle turn.
   *
   * Set while a page can emit events nobody asked for — a login form pushing a
   * captured credential is the case. Idle release would drop those events on
   * the floor, since they are not replayed to a later session.
   */
  pinSession(guestId: string, pinned: boolean): void {
    if (pinned) this.sessions.pin(guestId);
    else this.sessions.unpin(guestId);
  }

  /** The CDP executor for a guest, or `undefined` once it is gone. */
  cdpFor(guestId: string): EmbeddedCdp | undefined {
    return this.guests.get(guestId)?.cdp;
  }

  /**
   * Waits for a guest that is expected but not attached yet.
   *
   * The renderer creates the node, so there is always a window between "open a
   * page" and "here is its guest". Commands issued in that window must queue
   * rather than fail: the caller asked for a page, and the page is coming.
   * The deadline exists so a renderer that never reports cannot hang a tool
   * call forever.
   *
   * `key` is the caller's correlation token — the tab id in practice — not the
   * guest id, which is exactly what the caller does not know yet.
   */
  awaitGuest(key: string, timeoutMs = 10_000): Promise<GuestHandle> {
    const known = this.guestIdFor(key);
    if (known) {
      const record = this.guests.get(known);
      if (record) return Promise.resolve(record.handle);
    }
    return this.slots.wait(key, timeoutMs);
  }

  /** Abandons a pending wait, for a tab that was closed before it attached. */
  cancelWait(key: string): void {
    this.slots.cancel(key);
  }

  /**
   * Registers a guest under the token callers are waiting on.
   *
   * Separate from {@link register} because the correlation key is the renderer's
   * own bookkeeping: main knows the tab it asked for, the renderer knows the
   * guest it created, and this is where the two are joined.
   */
  attachByKey(key: string, contents: WebContents, host?: WebContents): GuestHandle {
    const handle = this.register(contents, host);
    this.keyToGuest.set(key, handle.guestId);
    this.slots.resolve(key, handle);
    return handle;
  }

  /** The guest a correlation token resolved to, if it is still alive. */
  guestIdFor(key: string): string | undefined {
    const guestId = this.keyToGuest.get(key);
    if (!guestId) return undefined;
    return this.guests.has(guestId) ? guestId : undefined;
  }

  /**
   * Forgets a correlation token without touching the guest.
   *
   * Closing the session is a separate, explicit step ({@link teardown}): the
   * renderer has to await it before removing the node, so it cannot be a side
   * effect of dropping bookkeeping. A pending wait is failed on purpose —
   * whoever asked for the page has to learn it is not coming.
   */
  releaseKey(key: string): void {
    this.keyToGuest.delete(key);
    this.slots.cancel(key);
  }

  /**
   * Records the partition the renderer created the node with.
   *
   * Main cannot see the attribute directly — it only arrives in the attach
   * params — so the renderer reports it alongside the id and it is kept for
   * diagnostics.
   */
  describe(guestId: string, partition?: string): void {
    const record = this.guests.get(guestId);
    if (!record) return;
    if (partition) record.partition = partition;
  }

  partitionOf(guestId: string): string | undefined {
    return this.guests.get(guestId)?.partition;
  }

  has(guestId: string): boolean {
    return this.guests.has(guestId);
  }

  contentsOf(guestId: string): WebContents | undefined {
    return this.guests.get(guestId)?.contents;
  }

  /**
   * Runs a command against a guest through the shared executor.
   *
   * Everything that talks to a page goes through here, and not through the
   * `EmbeddedCdp` instance directly: this is where the command is counted, so a
   * teardown can wait for it. A command that bypassed this would be invisible
   * to that accounting, and detaching with it in flight crashes the process.
   */
  async withGuest<T>(guestId: string, fn: (cdp: EmbeddedCdp) => Promise<T>): Promise<T> {
    const record = this.requireRecord(guestId);
    return this.sessions.run(record.handle, () => fn(record.cdp));
  }

  /** Runs one CDP command, opening the session if it was released. */
  async send<T = unknown>(
    guestId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.withGuest(guestId, (cdp) => cdp.send<T>(method, params));
  }

  /** Evaluates an expression in the guest and returns its value. */
  async evaluate<T = unknown>(
    guestId: string,
    expression: string,
    options: { awaitPromise?: boolean } = {},
  ): Promise<T> {
    return this.withGuest(guestId, (cdp) => cdp.evaluate<T>(expression, options));
  }

  /**
   * Closes the CDP session before the node is removed.
   *
   * The caller must wait for this before unmounting: detaching after the guest
   * is destroyed takes the native target out from under a pending command,
   * which is a process-level crash rather than an exception.
   */
  async teardown(guestId: string): Promise<void> {
    await this.sessions.teardown(guestId);
    this.guests.delete(guestId);
  }

  /** Drops every guest; used when the window goes away or the app quits. */
  async dispose(): Promise<void> {
    for (const key of [...this.keyToGuest.keys()]) this.cancelWait(key);
    this.uninstall();
    await this.sessions.closeAll();
    this.guests.clear();
    this.keyToGuest.clear();
  }

  /**
   * The command target for a page, keyed by the token the renderer knows.
   *
   * The page id is the only thing stable across a node being replaced; the
   * guest id changes with it, so every command re-resolves it.
   */
  targetFor(tabId: string): GuestCdpTarget {
    return {
      guestId: () => this.guestIdFor(tabId),
      send: (guestId, method, params) => this.send(guestId, method, params),
      evaluate: (guestId, expression, options) =>
        this.evaluate(guestId, expression, options ?? {}),
      has: (guestId) => this.has(guestId),
      waitLaidOut: (timeoutMs) => this.waitLaidOut(tabId, timeoutMs),
      contents: (guestId) => {
        const record = this.guests.get(guestId);
        if (!record || record.contents.isDestroyed()) return undefined;
        return record.contents;
      },
    };
  }

  /**
   * Records that a page's node has a real box.
   *
   * Reported by the renderer the first time it lays the node out. Until then
   * every command that depends on the page's own geometry answers wrongly.
   */
  confirmLaidOut(tabId: string): void {
    this.laidOut.add(tabId);
    const waiter = this.layoutWaiters.get(tabId);
    if (!waiter) return;
    this.layoutWaiters.delete(tabId);
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  /** Forgets a page's layout state when its node goes away. */
  forgetLaidOut(tabId: string): void {
    this.laidOut.delete(tabId);
    const waiter = this.layoutWaiters.get(tabId);
    if (!waiter) return;
    this.layoutWaiters.delete(tabId);
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  /**
   * Waits until a page's node has a real box.
   *
   * `dom-ready` says the guest exists; it does not say the node was sized yet.
   * A command that runs in that gap sees a 0×0 viewport, and every visibility
   * check inside the page answers false — which reads as "the element does not
   * exist" rather than "the page is not laid out".
   */
  waitLaidOut(tabId: string, timeoutMs = 2_000): Promise<void> {
    if (this.laidOut.has(tabId)) return Promise.resolve();
    const existing = this.layoutWaiters.get(tabId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => {
      this.layoutWaiters.delete(tabId);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    this.layoutWaiters.set(tabId, { promise, resolve, timer });
    return promise;
  }

  private resolveWaiter(key: string, handle: GuestHandle): void {
    this.slots.resolve(key, handle);
  }

  private requireRecord(guestId: string): GuestRecord {
    const record = this.guests.get(guestId);
    if (!record) throw new Error("页面已关闭");
    return record;
  }

  /**
   * The CDP port for one guest.
   *
   * `open` has to restore session state, not just attach: Chromium gives a
   * reopened session a clean slate, and a missing `Page.enable` is the kind of
   * loss that produces no error anywhere — events simply stop.
   *
   * Shares the record's executor rather than building a second one: two
   * clients over the same `webContents` disagree about whether the session is
   * attached — the idle release would detach one and leave the other believing
   * it is connected, so its next command would fail on a detached debugger.
   */
  private createPort(guestId: string, contents: WebContents, cdp: EmbeddedCdp): GuestCdpPort {
    return {
      open: async () => {
        // `prepare` attaches and turns on focus emulation, and is safe to call
        // when the session is already up.
        await cdp.prepare();
        // Dialogs and lifecycle both hang off Page domain events, and a
        // reopened session has to be told again.
        await cdp.send("Page.enable").catch(() => undefined);
        await this.options.onSessionOpen?.(guestId, cdp);
      },
      close: () => cdp.detach(),
      send: (method, params) => cdp.send(method, params),
    };
  }

  /**
   * Routes a guest's window-open request back into the surface.
   *
   * Must be installed before the guest loads anything: the handler is what
   * decides whether a popup becomes an app tab, and a `javascript:` or `data:`
   * URL has to be refused here rather than handed onward.
   */
  private routeWindowOpen(record: GuestRecord): void {
    const guestId = record.handle.guestId;
    record.contents.setWindowOpenHandler(({ url }) => {
      if (!/^https?:\/\//i.test(url)) return { action: "deny" };
      this.options.onPopup?.(guestId, url);
      // Always deny the native window: the surface opens its own page instead,
      // and a real window would escape the partition this guest lives in.
      return { action: "deny" };
    });
  }
}
