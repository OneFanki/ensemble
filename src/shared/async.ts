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
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // Typed as the ambient timer handle, not Node's: this module is shared with
    // the renderer, where the same call returns a number.
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${what}（超过 ${ms}ms）`));
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
