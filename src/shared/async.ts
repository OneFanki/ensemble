/**
 * Raised when a deadline passes without the promise settling.
 *
 * A distinct type rather than a plain `Error` because the two outcomes are not
 * the same thing and callers have to be able to tell them apart. "The page did
 * not answer in time" is a fact about *waiting* — the work may still be running,
 * and the right response is often "keep going, I will check later" rather than
 * "this failed". "The page threw" is a fact about the *work*, and retrying it is
 * usually the right response.
 *
 * The MCP layer relies on exactly that distinction: a timed-out `evaluate`
 * returns `{ timedOut: true, stillRunning: true }` as a normal result, while a
 * throwing one stays an `isError`.
 */
export class DeadlineError extends Error {
  readonly timedOut = true;

  constructor(
    readonly what: string,
    readonly ms: number,
  ) {
    super(`${what}（超过 ${ms}ms）`);
    this.name = "DeadlineError";
  }
}

/** Whether a thrown value is a deadline, safely across module copies. */
export function isDeadlineError(error: unknown): error is DeadlineError {
  if (error instanceof DeadlineError) return true;
  // A structural check as well: the shared layer is bundled into both the main
  // and renderer graphs, so under some build shapes the class identity differs
  // while the shape does not. The marker field is what callers switch on.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { timedOut?: unknown }).timedOut === true &&
    typeof (error as { what?: unknown }).what === "string"
  );
}

/**
 * Rejects when `promise` has not settled within `ms`.
 *
 * The case this exists for is not "a slow call" but "a call that will never
 * answer". Chromium's `Page.captureScreenshot` does exactly that against a
 * surface that is not producing frames: it does not fail, it does not time out,
 * it simply never replies. A client waiting on it has no way to tell that from
 * a slow operation, so the deadline has to be imposed here.
 *
 * The original promise is left to settle on its own — it cannot be cancelled,
 * and pretending otherwise would hide a real error if it eventually arrives.
 * Attaching a catch keeps a late rejection from becoming an unhandled rejection.
 * That is also why the error says "timed out" rather than "failed": whatever
 * was running may well still be running.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // Typed as the ambient timer handle, not Node's: this module is shared with
    // the renderer, where the same call returns a number.
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DeadlineError(what, ms));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
