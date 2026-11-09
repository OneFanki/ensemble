/**
 * Console history, network activity and an idle signal for a page.
 *
 * ## One source per kind of fact
 *
 * **Console** lines come from Electron's `console-message` event in the main
 * process. That is the only source that sees the *first* line of the first
 * document: a wrapper installed from page script can only run after the
 * document exists, which is after a page that failed to boot has already
 * printed why. The event also reports what page script cannot wrap — network
 * failures, CSP violations, blocked mixed content.
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
export const PAGE_ACTIVITY_SCRIPT = `(() => {
  const KEY = "__ensembleActivity";
  if (window[KEY]) return { installed: true };
  const LIMIT = ${PAGE_LOG_LIMIT};
  const TEXT_LIMIT = ${PAGE_LOG_TEXT_LIMIT};
  const NET_LIMIT = ${PAGE_NETWORK_LIMIT};

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
      logs: [], inflight: [], recent: [], installed: false, dropped: 0,
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
  };
})()`;

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
export function buildNetworkIdleExpression(input: { timeoutMs: number; quietMs?: number; intervalMs?: number }): string {
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
