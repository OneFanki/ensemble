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
  /** Site matched by origin, resolved by the main process after `add`. */
  siteId?: string;
  /**
   * Other login fields the form asked for, with the values that were typed.
   *
   * A multi-tenant system signs in with tenant + user + password, and the tenant
   * is part of the account's identity: saving only the username would make
   * `admin@tenant-a` and `admin@tenant-b` the same account. Kept apart from
   * `username` so the existing single-account path is unchanged.
   */
  extraFields?: { label: string; value: string }[];
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
  /** Tenant or other extra fields, so the account form can be pre-filled. */
  extraFields?: { label: string; value: string }[];
}

/**
 * How long an unsaved login stays available to save.
 *
 * Long on purpose. It used to be ten minutes, and that treated the prompt as the
 * only way back to a capture: once it scrolled away, or a second login replaced
 * it, the password was gone and the only recovery was to sign out and in again.
 * A capture now survives until the process exits — the secret is in memory
 * either way, the vault is where it would end up, and making the user re-login to
 * recover a prompt they merely missed is not a security boundary, it is a
 * punishment.
 *
 * It is still bounded rather than unbounded: a session left open for days should
 * not hold every password typed into it, and a capture this old is one the user
 * did not want.
 */
const TTL_MS = 8 * 60 * 60_000;
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
   * prompt per event would be noise. Past that window the same login is captured
   * again on purpose — a second attempt is how a user retries after the first
   * prompt went by unnoticed, and the newest password is the one that works.
   */
  add(input: Omit<CapturedLogin, "token" | "capturedAt">): CapturedLoginNotice | undefined {
    const key = `${input.origin}|${input.username.toLowerCase()}`;
    const now = Date.now();
    const last = this.recent.get(key);
    if (last && now - last < DEDUPE_MS) return undefined;
    this.recent.set(key, now);
    // An earlier capture of the same account is superseded: keeping both would
    // offer the same login twice, and one of the two passwords is stale.
    for (const [token, entry] of this.pending) {
      if (`${entry.origin}|${entry.username.toLowerCase()}` === key) this.pending.delete(token);
    }
    this.prune();

    const token = randomUUID();
    this.pending.set(token, { ...input, token, capturedAt: now });
    return {
      token,
      username: input.username,
      origin: input.origin,
      path: input.path,
      tabId: input.tabId,
      ...(input.extraFields?.length ? { extraFields: input.extraFields } : {}),
    };
  }

  /**
   * Every login waiting to be saved, newest first.
   *
   * This is what makes the prompt recoverable: closing the bar or opening
   * another login no longer loses anything, because the list is the record and
   * the bar is only its most recent entry.
   */
  list(): CapturedLoginNotice[] {
    this.prune();
    // Reversed before a stable sort so two captures made inside the same
    // millisecond still come out newest-first instead of in insertion order.
    return [...this.pending.values()]
      .reverse()
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .map((entry) => ({
        token: entry.token,
        username: entry.username,
        origin: entry.origin,
        path: entry.path,
        tabId: entry.tabId,
        ...(entry.siteId ? { siteId: entry.siteId } : {}),
        ...(entry.extraFields?.length ? { extraFields: entry.extraFields } : {}),
      }));
  }

  /** Attaches the matched site once the main process resolves it by origin. */
  attachSite(token: string, siteId: string): CapturedLoginNotice | undefined {
    const entry = this.pending.get(token);
    if (!entry) return undefined;
    entry.siteId = siteId;
    return {
      token,
      username: entry.username,
      origin: entry.origin,
      path: entry.path,
      tabId: entry.tabId,
      siteId,
      ...(entry.extraFields?.length ? { extraFields: entry.extraFields } : {}),
    };
  }

  /** Returns and removes the secret. Used only when writing the vault. */
  take(token: string): CapturedLogin | undefined {
    const entry = this.pending.get(token);
    if (!entry) return undefined;
    this.pending.delete(token);
    return entry;
  }

  /**
   * Puts a taken entry back after the write that took it failed.
   *
   * The password exists in exactly one place — this map — and the page never
   * sends it again. A failed vault write or a rejected draft would therefore
   * destroy the only copy, leaving "save this login" permanently unable to save
   * that account until the user signs in again. Restoring keeps the retry
   * possible; the original `capturedAt` is kept so the TTL still expires it
   * rather than granting a fresh window.
   */
  restore(entry: CapturedLogin): void {
    if (!this.pending.has(entry.token)) this.pending.set(entry.token, entry);
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
  const lastBeforePassword = (pw) => {
    const scope = pw.form ?? document;
    const candidates = [
      ...scope.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'),
    ].filter(visible);
    let best = null;
    for (const el of candidates) {
      if (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
    }
    return best;
  };
  /*
   * The other text fields above the password box, with what was typed in them.
   *
   * A multi-tenant login asks for tenant + user + password in that order, so the
   * username is the *last* text field and anything before it is a second
   * dimension of the account. Naming them from the page's own wording is what
   * makes the saved account findable later ("租户名: acme"); the placeholder is
   * used because it is often the only label a component library puts on the
   * field.
   */
  const extraFieldsOf = (pw) => {
    const scope = pw.form ?? document;
    const inputs = [
      ...scope.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'),
    ].filter(visible);
    const usernameField = lastBeforePassword(pw);
    const before = inputs.filter(
      (el) =>
        el !== usernameField &&
        (el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
    const out = [];
    for (const el of before) {
      if (!el.value) continue;
      const label =
        (el.getAttribute('placeholder') || '').trim() ||
        (el.getAttribute('aria-label') || '').trim() ||
        el.name ||
        el.id ||
        '';
      out.push({ label: label.slice(0, 40) || 'field', value: String(el.value).slice(0, 200) });
    }
    return out;
  };
  /*
   * The last state a credential form was seen in, per document.
   *
   * Reading the field at the moment of submission is not enough, and both
   * failure modes are ordinary page behaviour:
   *
   *  - A native form submit replaces the document. The handler runs while the
   *    old page is still there, but reading it a tick later (the old
   *    \`setTimeout(capture, 0)\`) can land after the navigation began, when the
   *    fields are already gone.
   *  - Single-page apps often clear the password box on submit, so by the time
   *    anyone looks the value is the empty string.
   *
   * Remembering the filled-in values as they are typed — not the act of
   * submitting — makes both cases read from something that already exists.
   */
  let lastSeen = null;
  const remember = () => {
    const fields = passwordFields();
    if (fields.length !== 1) return;
    const pw = fields[0];
    if (!pw || !pw.value) return;
    const username = usernameOf(pw);
    if (!username) return;
    lastSeen = { username, password: pw.value, extraFields: extraFieldsOf(pw) };
  };
  const emit = (seen) => {
    if (!seen) return;
    try {
      window.__ensembleLoginCaptured(
        JSON.stringify({
          username: seen.username,
          password: seen.password,
          origin: location.origin,
          path: location.pathname,
          ...(seen.extraFields && seen.extraFields.length ? { extraFields: seen.extraFields } : {}),
        }),
      );
    } catch {
      // The binding is missing when capture is off; nothing to do.
    }
  };
  const capture = () => {
    remember();
    emit(lastSeen);
  };
  /*
   * Values are recorded as they are entered, so a submit that clears or replaces
   * the document still has something to report.
   */
  const snapshot = () => {
    remember();
  };
  document.addEventListener('input', snapshot, true);
  document.addEventListener('change', snapshot, true);
  const later = () => setTimeout(capture, 0);
  /*
   * Capture on submit *before* the default action runs: by the time a delegated
   * listener on the bubble phase fires, a native submit may already be tearing
   * the document down.
   */
  document.addEventListener('submit', capture, true);
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      /*
       * Any button inside a credential form counts, not just submit inputs:
       * most login pages today are single-page apps whose button is
       * type="button" with a click handler, and the form may submit itself from
       * script. This is also why the click is read from the *snapshot* — the
       * handler that clears the password field is attached to the same button
       * and often runs first.
       */
      if (!target.closest('button, input[type="submit"], [role="button"]')) return;
      const inCredentialForm = passwordFields().some((pw) => {
        const box = pw.form ?? pw.closest('form');
        return box ? box.contains(target) : true;
      });
      if (!inCredentialForm) return;
      remember();
      later();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter') return;
      if (!event.target || !event.target.matches || !event.target.matches('input')) return;
      // Enter in a password box is the other way a form is submitted, and it
      // runs before the page's own keydown-driven submit.
      remember();
      later();
    },
    true,
  );
})();`;
