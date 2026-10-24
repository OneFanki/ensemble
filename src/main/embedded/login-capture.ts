import { randomUUID } from "node:crypto";

/**
 * A username and password seen in a login form on the built-in surface.
 *
 * The password never leaves this module except through `take()`, which returns
 * it exactly once to the main process code that writes it into the vault. The
 * renderer only ever receives the token and the username, so a compromised page
 * (or a log line) cannot leak the secret.
 */
export interface CapturedLogin {
  token: string;
  username: string;
  password: string;
  origin: string;
  path: string;
  tabId: string;
  capturedAt: number;
}

/** The renderer-facing half: no password. */
export interface CapturedLoginNotice {
  token: string;
  username: string;
  origin: string;
  path: string;
  tabId: string;
  /** Site whose origin matches, when one exists. */
  siteId?: string;
}

const TTL_MS = 10 * 60_000;
const DEDUPE_MS = 30_000;

/** Name the page calls; the main process listens for `Runtime.bindingCalled`. */
export const LOGIN_CAPTURE_BINDING = "__ensembleLoginCaptured";

export class LoginCaptureStore {
  private readonly pending = new Map<string, CapturedLogin>();
  private readonly recent = new Map<string, number>();

  /**
   * Records a capture and returns the renderer-facing notice.
   *
   * Returns undefined for a duplicate (same origin and username within
   * `DEDUPE_MS`): the page fires submit, click and Enter for one login, and a
   * prompt per event would be noise.
   */
  add(input: Omit<CapturedLogin, "token" | "capturedAt">): CapturedLoginNotice | undefined {
    const key = `${input.origin}|${input.username.toLowerCase()}`;
    const now = Date.now();
    const last = this.recent.get(key);
    if (last && now - last < DEDUPE_MS) return undefined;
    this.recent.set(key, now);
    this.prune();

    const token = randomUUID();
    this.pending.set(token, { ...input, token, capturedAt: now });
    return {
      token,
      username: input.username,
      origin: input.origin,
      path: input.path,
      tabId: input.tabId,
    };
  }

  /** Attaches the matched site once the main process resolves it by origin. */
  attachSite(token: string, siteId: string): CapturedLoginNotice | undefined {
    const entry = this.pending.get(token);
    if (!entry) return undefined;
    return {
      token,
      username: entry.username,
      origin: entry.origin,
      path: entry.path,
      tabId: entry.tabId,
      siteId,
    };
  }

  /** Returns and removes the secret. Used only when writing the vault. */
  take(token: string): CapturedLogin | undefined {
    const entry = this.pending.get(token);
    if (!entry) return undefined;
    this.pending.delete(token);
    return entry;
  }

  discard(token: string): void {
    this.pending.delete(token);
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [token, entry] of this.pending) {
      if (entry.capturedAt < cutoff) this.pending.delete(token);
    }
    for (const [key, at] of this.recent) {
      if (at < cutoff) this.recent.delete(key);
    }
  }
}

/**
 * Runs in every embedded page. It reports the first visible password field and
 * the username field before it, on submit, submit-button click or Enter.
 *
 * Deliberately conservative: two password fields (sign-up, password change) and
 * an empty username or password are ignored, so a registration form never
 * offers to save a half-made account.
 */
export const LOGIN_CAPTURE_SCRIPT = `(() => {
  if (window.__ensembleCaptureInstalled) return;
  window.__ensembleCaptureInstalled = true;
  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const passwordFields = () =>
    [...document.querySelectorAll('input[type="password"]')].filter(visible);
  const usernameOf = (pw) => {
    const scope = pw.form ?? document;
    const candidates = [
      ...scope.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'),
    ].filter(visible);
    let best = null;
    for (const el of candidates) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
    }
    return (best && best.value ? best.value : '').trim();
  };
  const capture = () => {
    const fields = passwordFields();
    if (fields.length !== 1) return;
    const pw = fields[0];
    if (!pw || !pw.value) return;
    const username = usernameOf(pw);
    if (!username) return;
    try {
      window.__ensembleLoginCaptured(
        JSON.stringify({
          username,
          password: pw.value,
          origin: location.origin,
          path: location.pathname,
        }),
      );
    } catch {
      // The binding is missing when capture is off; nothing to do.
    }
  };
  const later = () => setTimeout(capture, 0);
  document.addEventListener('submit', later, true);
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (target && target.closest && target.closest('button, input[type="submit"]')) later();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && event.target && event.target.matches && event.target.matches('input')) later();
    },
    true,
  );
})();`;
