import type { WebContents } from "electron";
import { GuestSessions, type GuestCdpPort, type GuestHandle } from "@core/cdp/guest-sessions";
import { GuestSlots } from "@core/cdp/guest-slots";
import { hardenGuestPreferences } from "@core/cdp/guest-policy";
import { EmbeddedCdp } from "./cdp";

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
  captureBinding?: boolean;
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
  private host: WebContents | null = null;
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

    const record: GuestRecord = {
      handle: this.sessions.attach(guestId, this.createPort(guestId, contents)),
      contents,
      cdp: new EmbeddedCdp(contents, () => this.options.onActivity?.(guestId)),
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
   * effect of dropping bookkeeping.
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
   * Marks the login-capture binding as installed for this guest.
   *
   * Returns `true` the first time, so the caller knows whether it still has to
   * add it. Tracked per target rather than per session because the binding is
   * target state and outlives every detach.
   */
  claimCaptureBinding(guestId: string): boolean {
    const record = this.guests.get(guestId);
    if (!record) return false;
    if (record.captureBinding) return false;
    record.captureBinding = true;
    return true;
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
   */
  private createPort(guestId: string, contents: WebContents): GuestCdpPort {
    const cdp = new EmbeddedCdp(contents, () => this.options.onActivity?.(guestId));
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
