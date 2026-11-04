/**
 * Bookkeeping for CDP sessions on `<webview>` guests.
 *
 * A guest is a separate renderer process whose lifetime is owned by the DOM:
 * the renderer creates the node, Chromium attaches the process, and removing
 * the node destroys it. Main only borrows the guest's `webContents` to drive
 * CDP, which creates two hazards this module exists to handle:
 *
 * 1. **Detach while a command is in flight segfaults the process.** Detaching
 *    after `destroyed` is already too late, and detaching while a command is
 *    still waiting for its reply takes the native target out from under the
 *    reply. So teardown is a handshake: stop accepting commands, wait for the
 *    pending count to reach zero, detach, then report back. The renderer may
 *    only remove the node after that report.
 * 2. **A long-lived CDP session is detectable.** Anti-bot scripts (a login
 *    page is the common one) probe for it and refuse to continue, so the
 *    session is released as soon as the command stream goes idle and reopened
 *    on the next command. Reopening costs one attach plus a replay hook, which
 *    is why the hook exists — a fresh session loses every domain that was
 *    enabled, and silently losing `Page.enable` turns dialog events into a
 *    black hole.
 *
 * Generation numbers close the remaining hole: a callback captured for guest A
 * must not act on whatever guest later occupies the same id. Every operation
 * carries the handle it was issued for and compares it against the live one.
 */

/** One guest's CDP session, as the state machine needs to see it. */
export interface GuestCdpPort {
  /** Attach and restore session state. Must be safe to call again after a close. */
  open(): Promise<void>;
  /** Release the session. Must not throw, and must tolerate an already-closed session. */
  close(): void;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/**
 * Identity of one guest incarnation.
 *
 * Kept by callers instead of a bare id so that a command issued against a
 * destroyed guest cannot reach its replacement.
 */
export interface GuestHandle {
  readonly guestId: string;
  readonly generation: number;
}

export interface GuestSessionsOptions {
  /**
   * How long the session stays attached after the last command.
   *
   * Short on purpose: a human browsing, or a login page watching for
   * automation, must see a browser with no debugger attached. A burst of AI
   * commands arrives far faster than this, so it never interrupts one.
   */
  idleDetachMs?: number;
  /**
   * Upper bound on the teardown wait.
   *
   * A command that never settles would otherwise deadlock the handshake and
   * leave the renderer holding a node it is not allowed to remove. Past this
   * point the session is closed anyway and the straggler's reply is dropped —
   * one failed command is better than a wedged tab.
   */
  teardownTimeoutMs?: number;
}

interface Lease {
  handle: GuestHandle;
  port: GuestCdpPort;
  /** CDP session currently up. */
  attached: boolean;
  /** Teardown requested; no new command may start. */
  closing: boolean;
  /** Removed from the table; the handle is dead. */
  closed: boolean;
  /**
   * The session must stay attached even when idle.
   *
   * Set for a page that pushes events to main on its own schedule. Idle release
   * is safe for request/response traffic — the next command reopens — but an
   * event the page emits while nothing is attached is delivered to nobody and
   * is not queued for later. A login form is the case: the submit happens
   * whenever the user presses Enter, not when a command arrives.
   */
  pinned: boolean;
  pending: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  teardown?: Promise<void>;
  /** Resumes the teardown handshake once the last command settles. */
  drained?: () => void;
  teardownTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_IDLE_DETACH_MS = 1_500;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 2_000;

export class GuestSessions {
  private readonly leases = new Map<string, Lease>();
  private generation = 0;

  constructor(private readonly options: GuestSessionsOptions = {}) {}

  /**
   * Registers a guest.
   *
   * Idempotent for a guest that is already live: `did-attach-webview` can fire
   * again for the same node (a reload of the embedder re-attaches it), and that
   * must not invalidate handles callers already hold.
   */
  attach(guestId: string, port: GuestCdpPort): GuestHandle {
    const existing = this.leases.get(guestId);
    if (existing && !existing.closed) return existing.handle;
    this.generation += 1;
    const handle: GuestHandle = { guestId, generation: this.generation };
    this.leases.set(guestId, {
      handle,
      port,
      attached: false,
      closing: false,
      closed: false,
      pinned: false,
      pending: 0,
    });
    return handle;
  }

  /** The live handle for an id, or `undefined` once it was forgotten. */
  current(guestId: string): GuestHandle | undefined {
    const lease = this.leases.get(guestId);
    return lease && !lease.closed ? lease.handle : undefined;
  }

  has(guestId: string): boolean {
    return this.current(guestId) !== undefined;
  }

  /**
   * Keeps the session attached until {@link unpin}, overriding idle release.
   *
   * For a page that emits events on its own schedule: with nothing attached,
   * the event has no listener and is lost — it is not replayed when a session
   * opens later. Callers pin only while such traffic can be expected, so the
   * anti-automation benefit of idle release is given up only where a feature
   * cannot work without it.
   */
  pin(guestId: string): void {
    const lease = this.leases.get(guestId);
    if (!lease || lease.closed) return;
    lease.pinned = true;
  }

  /** Ends a pin; the session is released on the next idle turn. */
  unpin(guestId: string): void {
    const lease = this.leases.get(guestId);
    if (!lease || lease.closed) return;
    lease.pinned = false;
    if (lease.attached && !lease.closing && lease.pending === 0) this.scheduleIdle(lease);
  }

  /** Runs one command against a guest, opening the session first if needed. */
  async run<T>(handle: GuestHandle, fn: (port: GuestCdpPort) => Promise<T> | T): Promise<T> {
    const lease = this.require(handle);
    if (lease.closing) throw new Error("页面正在关闭，命令已取消");
    lease.pending += 1;
    // Any command restarts the idle clock, including one that only reads.
    this.cancelIdle(lease);
    try {
      if (!lease.attached) {
        await lease.port.open();
        lease.attached = true;
      }
      // A teardown may have been requested while the attach was in flight. The
      // session must not run the command in that case: the node is about to be
      // removed and the reply would never reach anybody.
      if (lease.closing) throw new Error("页面正在关闭，命令已取消");
      return await fn(lease.port);
    } finally {
      lease.pending -= 1;
      if (lease.pending === 0) {
        const drained = lease.drained;
        lease.drained = undefined;
        drained?.();
        if (lease.attached && !lease.closing) this.scheduleIdle(lease);
      }
    }
  }

  /**
   * Teardown handshake: stop accepting commands, wait, detach.
   *
   * Resolves once the session is closed, which is the signal the renderer waits
   * for before removing the `<webview>` node. Concurrent calls share one promise
   * — a double close (user closes the tab while the view is switching) must not
   * run two detaches against the same native target.
   */
  async teardown(guestId: string): Promise<void> {
    const lease = this.leases.get(guestId);
    if (!lease || lease.closed) return;
    if (lease.teardown) return lease.teardown;
    lease.closing = true;
    this.cancelIdle(lease);
    lease.teardown = new Promise<void>((resolve) => {
      const finish = (): void => {
        if (lease.pending > 0) {
          lease.drained = finish;
          return;
        }
        const timer = lease.teardownTimer;
        lease.teardownTimer = undefined;
        if (timer) clearTimeout(timer);
        this.closeLease(lease);
        resolve();
      };
      const timeout = this.options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
      lease.teardownTimer = setTimeout(() => {
        lease.teardownTimer = undefined;
        lease.drained = undefined;
        this.closeLease(lease);
        resolve();
      }, timeout);
      finish();
    });
    return lease.teardown;
  }

  /**
   * Drops a guest that is already gone.
   *
   * Called from `destroyed`, where closing the session would be both pointless
   * and unsafe — the native target is the thing that just died. No handshake is
   * needed because there is nothing left to protect.
   */
  forget(guestId: string): void {
    const lease = this.leases.get(guestId);
    if (!lease) return;
    this.cancelIdle(lease);
    if (lease.teardownTimer) clearTimeout(lease.teardownTimer);
    lease.teardownTimer = undefined;
    lease.drained = undefined;
    lease.closed = true;
    lease.attached = false;
    this.leases.delete(guestId);
  }

  /** Tears every guest down; used when the window or the app goes away. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.leases.keys()].map((id) => this.teardown(id)));
  }

  private require(handle: GuestHandle): Lease {
    const lease = this.leases.get(handle.guestId);
    if (!lease || lease.closed) throw new Error("页面已关闭");
    if (lease.handle.generation !== handle.generation) throw new Error("页面已关闭");
    return lease;
  }

  private closeLease(lease: Lease): void {
    if (lease.closed) return;
    lease.closed = true;
    const wasAttached = lease.attached;
    lease.attached = false;
    this.leases.delete(lease.handle.guestId);
    if (wasAttached) {
      try {
        lease.port.close();
      } catch {
        // Closing a session that died underneath us is a no-op, not a failure.
      }
    }
  }

  private scheduleIdle(lease: Lease): void {
    if (lease.pinned) return;
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    const delay = this.options.idleDetachMs ?? DEFAULT_IDLE_DETACH_MS;
    lease.idleTimer = setTimeout(() => {
      lease.idleTimer = undefined;
      if (lease.closed || lease.closing || lease.pending > 0 || !lease.attached) return;
      // A pin set while the timer was already running wins over it.
      if (lease.pinned) return;
      lease.attached = false;
      try {
        lease.port.close();
      } catch {
        // Best effort: the next command reopens the session either way.
      }
    }, delay);
    // An idle timer must never hold the process open on quit.
    lease.idleTimer.unref?.();
  }

  private cancelIdle(lease: Lease): void {
    if (!lease.idleTimer) return;
    clearTimeout(lease.idleTimer);
    lease.idleTimer = undefined;
  }
}
