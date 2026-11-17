/**
 * Console history, network activity and an idle signal for a page.
 *
 * ## One source per kind of fact
 *
 * **Console** lines come from Electron's `console-message` event in the main
 * process. That is the only source that sees the *first* line of the first
 * document: anything installed from page script can only run after the
 * document exists, which is after a page that failed to boot has already
 * printed why. The event also reports what page script cannot wrap — network
 * failures, CSP violations, blocked mixed content.
 *
 * The page-side collector does *not* keep its own console buffer — it wraps
 * the console methods to format object arguments into one line before the
 * runtime collapses them to `[object Object]`, and that one line then reaches
 * the event as usual. Collection stays single-source; only formatting lives
 * in the page ({@link PAGE_LOG_SERIALIZER_EXPRESSION}).
 *
 * **Network** activity is page-side. Knowing a request is *in flight* requires a
 * hook around `fetch` / `XMLHttpRequest`, and the alternative — a pinned CDP
 * session with `Network.enable` — is exactly what this app refuses to keep: a
 * guest's session is released 1.5 seconds after its last command because a
 * long-lived debugger session is detectable by anti-automation scripts on login
 * pages. That refusal is a product requirement, so the collection moves into
 * the page instead of trading the feature for it.
 *
 * The cost is scope, and it is worth stating plainly: this sees what page
 * JavaScript sees. It cannot report resource loads the parser started before
 * the hook ran (`document.write`, a synchronous script tag), browser-level
 * warnings, or requests from a cross-origin frame. It can report `fetch` and
 * `XMLHttpRequest`, which is what an application's own data loading uses and
 * what "did the save go through" is actually asking about.
 *
 * ## Bounded on purpose
 *
 * A page can send thousands of requests. The buffers keep the last
 * {@link PAGE_NETWORK_LIMIT} settled entries and drop the oldest, so a chatty
 * page cannot grow the app's memory or turn one read into a megabyte.
 */

/** How many console lines the main process keeps per page. */
export const PAGE_LOG_LIMIT = 200;
/** Characters kept per console line; enough for a stack head or a long URL. */
export const PAGE_LOG_TEXT_LIMIT = 1_000;
/** How many settled requests the page keeps for the recent-requests report. */
export const PAGE_NETWORK_LIMIT = 50;

/** Array elements / own properties listed before the rest collapse into a count. */
export const PAGE_LOG_SER_ITEM_LIMIT = 20;
/** Characters kept per serialized value; anything longer is clipped and marked. */
export const PAGE_LOG_SER_TEXT_LIMIT = 200;
/** How many levels of own properties an object argument may expand. */
export const PAGE_LOG_SER_DEPTH = 2;

/**
 * The console-argument serializer, as a self-contained expression.
 *
 * An expression, for the same reason the collector is one: it runs inside an
 * arbitrary page with no imports and no build step. It returns the `serValue`
 * function; {@link PAGE_ACTIVITY_SCRIPT} embeds it to format console arguments
 * before the runtime collapses them, and the unit tests evaluate the *same
 * expression* against a fake console so the rules below are executed, not
 * merely quoted.
 *
 * The rules, and what each is for:
 *
 * - **Strings are quoted** (`"1"` vs `1`): the quote is the only thing that
 *   keeps a type visible in a one-line report.
 * - **Own properties expand one to two levels** (`{seq:1}`, `{a:{b:1}}`);
 *   deeper levels collapse to `{…}` — a preview, not a JSON dump.
 * - **Arrays list their elements**, up to {@link PAGE_LOG_SER_ITEM_LIMIT},
 *   with `…+N more` standing in for the rest.
 * - **Anything over {@link PAGE_LOG_SER_TEXT_LIMIT} characters is clipped**
 *   with a trailing `…` — a 40KB string in one log line is a different bug.
 * - **Cycles become `[Circular]`**, so a self-referencing object cannot hang
 *   or blow the line length.
 * - Errors report `Name: message`, dates ISO — the two cases a stack trace
 *   and a timestamp carry meaning in one line.
 */
export const PAGE_LOG_SERIALIZER_EXPRESSION = `(function () {
  const SER_ITEM_LIMIT = ${PAGE_LOG_SER_ITEM_LIMIT};
  const SER_TEXT_LIMIT = ${PAGE_LOG_SER_TEXT_LIMIT};
  const SER_DEPTH = ${PAGE_LOG_SER_DEPTH};

  const serClip = (text) => (text.length > SER_TEXT_LIMIT ? text.slice(0, SER_TEXT_LIMIT) + "…" : text);

  const serValue = (value, depth = 0, seen = []) => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    const kind = typeof value;
    if (kind === "string") return serClip(JSON.stringify(value));
    if (kind === "number" || kind === "boolean") return String(value);
    if (kind === "bigint") return String(value) + "n";
    if (kind === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (kind === "symbol") return serClip(value.toString());
    if (value instanceof Error) return serClip(value.name + ": " + value.message);
    if (value instanceof Date) return value.toISOString();
    if (seen.indexOf(value) !== -1) return "[Circular]";
    if (depth >= SER_DEPTH) return Array.isArray(value) ? "[…]" : "{…}";
    const nextSeen = seen.concat([value]);
    const parts = [];
    if (Array.isArray(value)) {
      const shown = Math.min(value.length, SER_ITEM_LIMIT);
      for (let i = 0; i < shown; i += 1) {
        let item;
        try { item = serValue(value[i], depth + 1, nextSeen); } catch { item = "[Unserializable]"; }
        parts.push(item);
      }
      if (value.length > shown) parts.push("…+" + (value.length - shown) + " more");
      return serClip("[" + parts.join(", ") + "]");
    }
    const keys = Object.keys(value);
    const shownKeys = Math.min(keys.length, SER_ITEM_LIMIT);
    for (let i = 0; i < shownKeys; i += 1) {
      let item;
      try { item = serValue(value[keys[i]], depth + 1, nextSeen); } catch { item = "[Unserializable]"; }
      parts.push(keys[i] + ": " + item);
    }
    if (keys.length > shownKeys) parts.push("…+" + (keys.length - shownKeys) + " more");
    return serClip("{" + parts.join(", ") + "}");
  };

  return serValue;
})()`;

export type PageLogLevel = "error" | "warn" | "info" | "debug" | "log";

export interface PageLogEntry {
  /** Wall clock in the page, ISO-8601. */
  at: string;
  level: PageLogLevel;
  text: string;
}

export interface PageNetworkEntry {
  at: string;
  method: string;
  url: string;
  status: number;
  /** Milliseconds from send to settle. */
  ms: number;
  failed: boolean;
}

export interface PageInflightEntry {
  method: string;
  url: string;
  at: string;
  /** How long it has been in flight at read time. */
  ms: number;
}

export interface PageActivity {
  url: string;
  title: string;
  /** Oldest first, so a reader can follow the order things happened in. */
  logs: PageLogEntry[];
  /** Requests that had not settled when this was read, longest-waiting first. */
  inflight: PageInflightEntry[];
  /** Most recent settled requests, newest first. */
  recent: PageNetworkEntry[];
  /** False when the document was never instrumented (a fresh navigation). */
  installed: boolean;
  /** Lines the console buffer dropped since the previous read. */
  dropped: number;
  /**
   * Lines excluded from `logs` this read because the host itself produced them.
   *
   * Zero unless the host was chatty. It is reported rather than hidden so a
   * caller comparing counts (dropped + logs) can still reconcile the read.
   */
  hostHidden: number;
}

/**
 * Whether one console line is the host's own development noise.
 *
 * Measured on Electron 45.2.1, unpackaged: the dev-mode security warning
 * ("Electron Security Warning (Insecure Content-Security-Policy) …") carries
 * **the page's own URL as its `sourceId`** — the runtime emits it through the
 * document's console, so there is nothing in the source to tell it apart. The
 * text is the only marker, and it is a distinctive one: it is the host
 * runtime's own wording, naming the host runtime, about the host's own
 * webPreferences. It says nothing about the page under test, which is why it
 * is noise here.
 *
 * A page that deliberately prints this exact wording is quoting the host
 * rather than reporting about itself; matching by text cannot tell those
 * apart, so the line is dropped from the default read and `includeHost` puts
 * everything back. The filter matches a prefix, not a substring, to keep it
 * as narrow as the wording allows.
 */
export function looksLikeHostNoise(entry: { text: string; source?: string }): boolean {
  return (entry.text ?? "").startsWith("Electron Security Warning");
}

/**
 * The page-side collector.
 *
 * A plain expression rather than a module: it is evaluated in an arbitrary page,
 * so no imports, no build step, and nothing beyond standard DOM plus `fetch` /
 * `XMLHttpRequest`. It is idempotent — installing twice keeps the first
 * instance, which matters because a navigation into the same target is
 * indistinguishable from a reload at this layer.
 */
/**
 * The console-argument wrapper, as a self-contained document script.
 *
 * The main process reads console lines from the console-message event, and
 * that event carries one already-formatted string — by the time it arrives, an
 * object argument has collapsed into "[object Object]" and the difference
 * between the string "1" and the number 1 is gone. Wrapping the console
 * methods *in the page* and handing the runtime a single formatted string
 * keeps the structure: the event reports our text verbatim, and the original
 * call still happens, so the page's own DevTools session sees its console
 * exactly as before. The page keeps no console buffer of its own — the event
 * remains the only collector, so nothing is recorded twice.
 *
 * The host registers this as a `Page.addScriptToEvaluateOnNewDocument` script,
 * which is the only way to run ahead of the page's own inline scripts: a
 * wrapper installed after `did-finish-load` misses every log the document
 * printed while parsing. Two properties matter:
 *
 * - **Idempotent** through the `__ensembleConsoleWrapped` marker. The same
 *   script is also embedded in {@link PAGE_ACTIVITY_SCRIPT}, which covers the
 *   document that was already loaded when the collector installed — whichever
 *   copy lands first wraps, the second one leaves.
 * - **No session pin.** A registration lives in the CDP session, and the host
 *   refuses to keep sessions pinned for observation alone (a long-lived
 *   debugger session is detectable). So the registration can disappear with an
 *   idle-released session; the host re-registers it when a session opens, and
 *   until then the console-message event still collects unformatted lines —
 *   degraded formatting, never missing history.
 */
export const PAGE_CONSOLE_SCRIPT = `(() => {
  if (window.__ensembleConsoleWrapped) return;
  window.__ensembleConsoleWrapped = true;

  const serValue = ${PAGE_LOG_SERIALIZER_EXPRESSION};

  // An explicit %placeholder format string is the page author choosing how the
  // runtime formats; leave that call untouched. Everything else is serialized,
  // with bare string arguments kept bare — they are message text, not values.
  const SER_FORMAT = /%[oOdisfkc%]/;
  const names = ["log", "info", "warn", "error", "debug"];
  for (const name of names) {
    const original = console[name];
    if (typeof original !== "function") continue;
    console[name] = function () {
      const args = Array.prototype.slice.call(arguments);
      if (args.length > 1 && typeof args[0] === "string" && SER_FORMAT.test(args[0])) {
        original.apply(console, args);
        return;
      }
      try {
        const text = args
          .map((arg) => (typeof arg === "string" ? arg : serValue(arg, 0, [])))
          .join(" ");
        original.call(console, text);
      } catch {
        original.apply(console, args);
      }
    };
  }
})()`;

export const PAGE_ACTIVITY_SCRIPT = `(() => {
  const KEY = "__ensembleActivity";
  if (window[KEY]) return { installed: true };
  const LIMIT = ${PAGE_LOG_LIMIT};
  const TEXT_LIMIT = ${PAGE_LOG_TEXT_LIMIT};
  const NET_LIMIT = ${PAGE_NETWORK_LIMIT};

  // Same wrapper the host registers ahead of every document (see
  // PAGE_CONSOLE_SCRIPT); embedded here so the document that was already
  // loaded when this collector installs is covered too. The idempotence
  // marker keeps whichever copy landed first from wrapping twice.

  ${PAGE_CONSOLE_SCRIPT}

  // Truncating a URL is all the clipping this side needs: console text is
  // collected in main, where the event carries it already formatted.
  const clipUrl = (value) => {
    const text = String(value || "");
    return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) + "…" : text;
  };

  const state = {
    installed: true,
    inflight: new Map(),
    recent: [],
    // When the last request finished, or 0 if none ever has. The idle check
    // reads this; it is separate from "recent" because that list is capped and
    // can be emptied without the page having been busy.
    lastSettle: 0,
  };

  const begin = (method, url) => {
    const key = method + " " + url + " " + Math.random().toString(36).slice(2);
    state.inflight.set(key, { method, url: clipUrl(url), at: new Date().toISOString(), started: Date.now() });
    return key;
  };
  const settle = (key, status, failed) => {
    const entry = state.inflight.get(key);
    state.inflight.delete(key);
    state.lastSettle = Date.now();
    if (!entry) return;
    if (state.recent.length >= NET_LIMIT) state.recent.pop();
    state.recent.unshift({
      at: entry.at,
      method: entry.method,
      url: entry.url,
      status,
      ms: state.lastSettle - entry.started,
      failed,
    });
  };

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      let url = "";
      let method = "GET";
      try {
        url = typeof input === "string" ? input : (input && input.url) || String(input);
        method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      } catch {}
      const key = begin(method, url);
      let promise;
      try {
        promise = originalFetch.apply(this, arguments);
      } catch (error) {
        settle(key, 0, true);
        throw error;
      }
      return promise.then(
        (response) => { settle(key, response.status, false); return response; },
        (error) => { settle(key, 0, true); throw error; },
      );
    };
  }

  const XHR = window.XMLHttpRequest;
  if (typeof XHR === "function") {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__ensembleRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const request = this.__ensembleRequest || { method: "GET", url: "" };
      const key = begin(request.method, request.url);
      this.addEventListener("loadend", () => {
        try { settle(key, this.status, this.status === 0); } catch {}
      });
      return send.apply(this, arguments);
    };
  }

  window[KEY] = state;
  return { installed: true };
})()`;

/**
 * Reads the page's network buffer.
 *
 * The request lists are rolling windows, not one-shot: a caller asking "did the
 * save go through" needs the settled request even on the read after the one
 * that happened to be first, so `recent` is returned as-is and only the
 * in-flight map naturally empties as requests complete.
 */
export const PAGE_ACTIVITY_READ_SCRIPT = `(() => {
  const state = window.__ensembleActivity;
  if (!state) {
    return {
      url: location.href, title: document.title,
      logs: [], inflight: [], recent: [], installed: false, dropped: 0, hostHidden: 0,
    };
  }
  const now = Date.now();
  const inflight = Array.from(state.inflight.values())
    .map((entry) => ({ method: entry.method, url: entry.url, at: entry.at, ms: now - entry.started }))
    .sort((a, b) => b.ms - a.ms);
  return {
    url: location.href,
    title: document.title,
    // Console lines are not this side's to report: they are read from the main
    // process, which sees them from the first line of the document. The field
    // stays in the shape so a caller has one result type either way.
    logs: [],
    inflight,
    recent: state.recent.slice(),
    installed: true,
    dropped: 0,
    hostHidden: 0,
  };
})()`;

/**
 * Polls inside the page until a settled request matches, without consuming.
 *
 * `response` reads the same rolling window `PAGE_ACTIVITY_READ_SCRIPT` reads,
 * and reads it exactly as peekably: `recent` is never emptied on a read, so a
 * wait that matched does not erase the answer the next `read_browser_console`
 * would have given. The poll runs page-side for the same reason the idle one
 * does — one round trip instead of "sleep, read, sleep, read" — and the match
 * is returned so the caller can tell *which* request ended the wait.
 */
export function buildWaitResponseExpression(input: {
  /** URL substring, compared case-insensitively. Empty matches any URL. */
  expect: string;
  /** Exact status code to require, when the caller names one. */
  status?: number;
  timeoutMs: number;
  intervalMs?: number;
}): string {
  const interval = Math.max(50, Math.trunc(input.intervalMs ?? 150));
  const needle = JSON.stringify(input.expect.toLowerCase());
  const status = input.status === undefined ? "null" : String(Math.trunc(input.status));
  return `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const state = window.__ensembleActivity;
    if (!state) {
      return { ok: false, waitedMs: 0, reason: "not-instrumented" };
    }
    const needle = ${needle};
    const wantedStatus = ${status};
    const deadline = Date.now() + ${Math.max(100, Math.trunc(input.timeoutMs))};
    const started = Date.now();
    while (Date.now() < deadline) {
      const hit = state.recent.find((entry) => {
        if (needle && String(entry.url).toLowerCase().indexOf(needle) === -1) return false;
        if (wantedStatus !== null && entry.status !== wantedStatus) return false;
        return true;
      });
      if (hit) {
        return {
          ok: true,
          waitedMs: Date.now() - started,
          matched: hit.method + " " + hit.status + " " + hit.url,
        };
      }
      await wait(${interval});
    }
    return {
      ok: false,
      waitedMs: Date.now() - started,
      timedOut: true,
      timedOutAt: "page",
      reason: "no-matching-response",
    };
  })()`;
}

/**
 * Polls inside the page until no request has been in flight for `quietMs`.
 *
 * Idle is defined narrowly and the narrower definition is the point: no
 * `fetch` / XHR outstanding. It says nothing about layout, animation or an open
 * websocket, so a page with a live SSE stream is "idle" here and still moving.
 * That is why the caller gets the numbers — how many requests, how long quiet —
 * instead of a bare true. A long-poll endpoint that never settles will make this
 * time out, correctly: the page really is never quiet in that sense, and the
 * caller should wait for content instead.
 */
export function buildNetworkIdleExpression(input: {
  timeoutMs: number;
  quietMs?: number;
  intervalMs?: number;
}): string {
  const quiet = Math.max(0, Math.trunc(input.quietMs ?? 500));
  const interval = Math.max(50, Math.trunc(input.intervalMs ?? 150));
  return `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const state = window.__ensembleActivity;
    if (!state) {
      return { ok: false, waitedMs: 0, reason: "not-instrumented" };
    }
    const deadline = Date.now() + ${Math.max(100, Math.trunc(input.timeoutMs))};
    const started = Date.now();
    let lastCount = -1;
    while (Date.now() < deadline) {
      const count = state.inflight.size;
      const quietFor = state.lastSettle ? Date.now() - state.lastSettle : null;
      // Quiet from the start (nothing has ever been sent) counts as idle only
      // after the requested window: the page may be about to send its first
      // request one frame later.
      const quietIdle = quietFor === null ? Date.now() - started >= ${quiet} : quietFor >= ${quiet};
      if (count === 0 && quietIdle) {
        return {
          ok: true,
          waitedMs: Date.now() - started,
          ...(quietFor === null ? {} : { matched: "quiet " + quietFor + "ms" }),
        };
      }
      lastCount = count;
      await wait(${interval});
    }
    return {
      ok: false,
      waitedMs: Date.now() - started,
      timedOut: true,
      reason: lastCount > 0 ? "requests-in-flight" : "no-quiet-window",
    };
  })()`;
}
