/**
 * Pending work keyed by a token whose target does not exist yet.
 *
 * The built-in surface asks for a page before the page exists: the renderer
 * creates the `<webview>` node, Chromium attaches the guest, and only then can
 * main drive it. A command issued in that gap must wait rather than fail —
 * "open this URL and read it" is one tool call, not two — while a renderer that
 * never reports must not be able to hang the call forever.
 *
 * Kept as plain logic because the interesting part is the bookkeeping: a
 * duplicate wait, a resolved wait, a cancelled wait, and a timeout all have to
 * leave exactly one outcome per token.
 */

interface Waiter<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GuestSlotsOptions {
  /** How long a wait may block before it gives up. */
  timeoutMs?: number;
  /** Message a timed-out wait rejects with. */
  timeoutMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class GuestSlots<T> {
  private readonly waiters = new Map<string, Waiter<T>>();
  /** Tokens that already resolved, so a later command skips the wait. */
  private readonly settled = new Map<string, T>();

  constructor(private readonly options: GuestSlotsOptions = {}) {}

  /** The resolved value for a token, if it already arrived. */
  peek(token: string): T | undefined {
    return this.settled.get(token);
  }

  /**
   * Waits for `token`, or returns the value if it already arrived.
   *
   * Repeated waits on the same token share one promise: two commands issued in
   * the same gap must both proceed when the guest arrives, and neither may
   * consume the other's signal.
   */
  wait(token: string, timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<T> {
    const ready = this.settled.get(token);
    if (ready !== undefined) return Promise.resolve(ready);
    const existing = this.waiters.get(token);
    if (existing) return existing.promise;

    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timer = setTimeout(() => {
      this.waiters.delete(token);
      reject(new Error(this.options.timeoutMessage ?? "页面没有在预期时间内就绪"));
    }, timeoutMs);
    timer.unref?.();
    this.waiters.set(token, { promise, resolve, reject, timer });
    return promise;
  }

  /** Delivers the value for a token; settles any waiting command. */
  resolve(token: string, value: T): void {
    const waiter = this.waiters.get(token);
    this.settled.set(token, value);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(token);
    waiter.resolve(value);
  }

  /**
   * Fails a pending wait because the thing it waited for will never arrive.
   *
   * Also clears the settled value: the token's target is gone, and a later
   * command must not reuse a stale handle.
   */
  cancel(token: string): void {
    this.settled.delete(token);
    const waiter = this.waiters.get(token);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(token);
    waiter.reject(new Error("页面已关闭"));
  }

  /** How many waits are outstanding; used by teardown to drain cleanly. */
  get pending(): number {
    return this.waiters.size;
  }
}
