import vm from "node:vm";
import {
  PAGE_ACTIVITY_SCRIPT,
  PAGE_CONSOLE_SCRIPT,
  PAGE_LOG_SER_ITEM_LIMIT,
  PAGE_LOG_SER_TEXT_LIMIT,
  PAGE_LOG_SERIALIZER_EXPRESSION,
  PAGE_NETWORK_LIMIT,
  PAGE_LOG_TEXT_LIMIT,
  buildNetworkIdleExpression,
  buildWaitResponseExpression,
  looksLikeHostNoise,
} from "@core/cdp/page-log";
import { describe, expect, it } from "vitest";

/**
 * The page-side collector and the idle poller.
 *
 * These are strings that run inside an arbitrary page, so what a unit test can
 * honestly judge is the part that would be a bug regardless of the page: that
 * the limits are actually written into the script, that nothing in the script
 * breaks out of its own template (a backtick or `${` would), and that the idle
 * poller passes the numbers the caller asked for.
 *
 * The collecting itself — that a real `fetch` is seen, that console.error is
 * captured — is exercised against a real page in `scripts/e2e-mcp-tools.mjs`.
 */
describe("page activity collector", () => {
  it("carries the buffer limits into the page script", async () => {
    const { PAGE_ACTIVITY_SCRIPT } = await import("@core/cdp/page-log");
    expect(PAGE_ACTIVITY_SCRIPT).toContain(`const NET_LIMIT = ${PAGE_NETWORK_LIMIT}`);
    expect(PAGE_ACTIVITY_SCRIPT).toContain(`const TEXT_LIMIT = ${PAGE_LOG_TEXT_LIMIT}`);
    // A rolling window that never drops cannot be distinguished from one with
    // no cap at all, so the drop must be present in the source.
    expect(PAGE_ACTIVITY_SCRIPT).toContain("state.recent.pop()");
  });

  /**
   * The wrapper serializes console arguments into one line and hands that line
   * to the runtime — the main process stays the only collector. If this script
   * ever started buffering console lines of its own, every line would be
   * collected twice: once by the wrapper's single call, once by the event that
   * call triggers.
   */
  it("wraps console to format, but never buffers lines itself", async () => {
    const { PAGE_ACTIVITY_SCRIPT } = await import("@core/cdp/page-log");
    // The collector embeds the same wrapper the host registers ahead of every
    // document; the idempotence marker keeps whichever lands first from
    // wrapping twice.
    expect(PAGE_ACTIVITY_SCRIPT).toContain(PAGE_CONSOLE_SCRIPT);
    expect(PAGE_CONSOLE_SCRIPT).toContain("__ensembleConsoleWrapped");
    expect(PAGE_CONSOLE_SCRIPT.startsWith("(() => {\n  if (window.__ensembleConsoleWrapped) return;")).toBe(true);
    expect(PAGE_ACTIVITY_SCRIPT).not.toContain("state.logs");
    expect(PAGE_ACTIVITY_SCRIPT).not.toContain("logs.push");
    expect(PAGE_ACTIVITY_SCRIPT).not.toContain('addEventListener("unhandledrejection"');
  });

  it("stays a self-contained expression", async () => {
    const { PAGE_ACTIVITY_SCRIPT, PAGE_ACTIVITY_READ_SCRIPT } = await import("@core/cdp/page-log");
    for (const script of [PAGE_ACTIVITY_SCRIPT, PAGE_ACTIVITY_READ_SCRIPT]) {
      // Evaluated inside the page: an import or a reference to a build-time
      // binding would throw there, and the failure would look like "no logs".
      // Anchored at line start so prose that quotes a word is not a match.
      expect(script).not.toMatch(/^\s*(import|export)\b/m);
      expect(script).not.toMatch(/\brequire\s*\(/);
      expect(script.startsWith("(() =>")).toBe(true);
      expect(script.endsWith(")()")).toBe(true);
    }
  });

  it("installs only once per document", async () => {
    const { PAGE_ACTIVITY_SCRIPT } = await import("@core/cdp/page-log");
    // A second install must not wrap fetch a second time, or every request
    // would be counted twice and the in-flight count would never reach zero.
    expect(PAGE_ACTIVITY_SCRIPT).toContain("if (window[KEY]) return { installed: true };");
  });

  it("reports settled requests on every read, not just the first", async () => {
    const { PAGE_ACTIVITY_READ_SCRIPT } = await import("@core/cdp/page-log");
    // `recent` is a rolling window: clearing it would make the answer to "did
    // the save go through" depend on whether the caller had already asked.
    expect(PAGE_ACTIVITY_READ_SCRIPT).toContain("recent: state.recent.slice()");
    expect(PAGE_ACTIVITY_READ_SCRIPT).not.toContain("state.recent.length = 0");
  });
});

describe("network idle wait", () => {
  it("carries the quiet window and the deadline", () => {
    const expression = buildNetworkIdleExpression({ timeoutMs: 8000, quietMs: 750 });
    expect(expression).toContain("Date.now() + 8000");
    expect(expression).toContain(">= 750");
  });

  it("defaults to half a second of quiet", () => {
    const expression = buildNetworkIdleExpression({ timeoutMs: 5000 });
    expect(expression).toContain(">= 500");
  });

  /**
   * The distinction the whole condition rests on: with a request outstanding the
   * answer must not be "idle", however long the caller has been waiting.
   */
  it("reports why it timed out instead of claiming idleness", () => {
    const expression = buildNetworkIdleExpression({ timeoutMs: 1000 });
    expect(expression).toContain('reason: lastCount > 0 ? "requests-in-flight" : "no-quiet-window"');
  });

  it("says so when the page was never instrumented", () => {
    const expression = buildNetworkIdleExpression({ timeoutMs: 1000 });
    expect(expression).toContain('reason: "not-instrumented"');
  });
});

describe("wait for a matching response", () => {
  it("carries the needle, the status and the deadline", () => {
    const expression = buildWaitResponseExpression({ expect: "/api/save", status: 200, timeoutMs: 8000 });
    expect(expression).toContain('"/api/save"');
    expect(expression).toContain("const wantedStatus = 200;");
    expect(expression).toContain("Date.now() + 8000");
  });

  /**
   * The condition and `read_browser_requests` answer from the same rolling
   * window. A wait that clears it would erase what the next console read was
   * supposed to report, so the peek shape is part of the contract, not an
   * implementation detail.
   */
  it("reads the rolling window without clearing it", () => {
    const expression = buildWaitResponseExpression({ expect: "/api/save", timeoutMs: 1000 });
    expect(expression).toContain("state.recent.find(");
    expect(expression).not.toContain("recent.length = 0");
    expect(expression).not.toContain("recent.pop()");
  });

  it("says so when the page was never instrumented", () => {
    const expression = buildWaitResponseExpression({ expect: "/x", timeoutMs: 1000 });
    expect(expression).toContain('reason: "not-instrumented"');
  });

  it("lowercases the needle so the match is case-insensitive", () => {
    const expression = buildWaitResponseExpression({ expect: "/API/Save", timeoutMs: 1000 });
    // The caller's text reaches the page already lowercased; the page compares
    // against `String(entry.url).toLowerCase()`.
    expect(expression).toContain('"/api/save"');
    expect(expression).toContain("toLowerCase().indexOf(needle)");
  });

  it("requires no needle when only a status is given", () => {
    const expression = buildWaitResponseExpression({ expect: "", status: 204, timeoutMs: 1000 });
    expect(expression).toContain('const needle = "";');
    expect(expression).toContain("const wantedStatus = 204;");
  });
});

/**
 * The console-argument serializer, executed for real.
 *
 * These rules run inside an arbitrary page, and the failure mode of a broken
 * rule is invisible — the tool would quietly report `[object Object]` again.
 * Running the exact expression the page runs (in a bare VM context, which is
 * all it asks for) pins each rule against inputs and outputs instead of
 * quoting source strings back at the script.
 */
describe("console argument serializer", () => {
  // One context shared by the function and the values it formats: in the page
  // they are the same realm, and `instanceof Error` / `instanceof Date` only
  // hold within it.
  const context = vm.createContext({});
  const serValue = vm.runInContext(PAGE_LOG_SERIALIZER_EXPRESSION, context) as (
    value: unknown,
    depth?: number,
    seen?: unknown[],
  ) => string;
  const inContext = (source: string) => vm.runInContext(source, context) as unknown;

  it("expands one level of own properties", () => {
    expect(serValue({ seq: 1 })).toBe("{seq: 1}");
  });

  it("expands a second level and collapses the third", () => {
    expect(serValue({ a: { b: 1 } })).toBe("{a: {b: 1}}");
    expect(serValue({ a: { b: { c: 1 } } })).toBe("{a: {b: {…}}}");
  });

  it("quotes strings but not numbers, so the type stays visible", () => {
    expect(serValue("1")).toBe('"1"');
    expect(serValue(1)).toBe("1");
    expect(serValue(true)).toBe("true");
    expect(serValue(null)).toBe("null");
    expect(serValue(undefined)).toBe("undefined");
  });

  it("lists array elements and quotes the strings among them", () => {
    expect(serValue([1, "a", 2])).toBe('[1, "a", 2]');
  });

  it("caps array elements with a count of the rest", () => {
    const long = Array.from({ length: PAGE_LOG_SER_ITEM_LIMIT + 5 }, (_, i) => i);
    expect(serValue(long)).toBe(`[${long.slice(0, PAGE_LOG_SER_ITEM_LIMIT).join(", ")}, …+5 more]`);
  });

  it("marks a cycle instead of recursing forever", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(serValue(loop)).toBe('{name: "loop", self: [Circular]}');
  });

  it("clips an over-long string and marks the cut", () => {
    const long = "x".repeat(PAGE_LOG_SER_TEXT_LIMIT + 50);
    const out = serValue(long);
    // JSON.stringify adds the surrounding quotes; the clip keeps the result at
    // the limit plus the ellipsis, whatever the quote overhead.
    expect(out.length).toBeLessThanOrEqual(PAGE_LOG_SER_TEXT_LIMIT + 2);
    expect(out.endsWith("…")).toBe(true);
  });

  it("caps object properties with a count of the rest", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < PAGE_LOG_SER_ITEM_LIMIT + 3; i += 1) wide[`k${i}`] = i;
    const out = serValue(wide) as string;
    expect(out).toContain(`…+3 more}`);
    expect(out).toContain("k0: 0");
    expect(out).not.toContain("k22");
  });

  it("renders an error as name and message, not an empty object", () => {
    // Built in the same realm so `instanceof Error` sees it, as it would in the page.
    const error = inContext("new TypeError('boom')") as Error;
    expect(serValue(error)).toBe("TypeError: boom");
  });

  it("renders a date as ISO text", () => {
    const date = inContext("new Date(0)") as Date;
    expect(serValue(date)).toBe("1970-01-01T00:00:00.000Z");
  });

  /**
   * The end-to-end behaviour the fix exists for: an object argument must reach
   * the runtime as one formatted string, bare string arguments stay bare, and
   * an explicit format string keeps the engine's own formatting.
   */
  describe("when the wrapper runs in a fake document", () => {
    function install() {
      const lines: unknown[][] = [];
      const record = (...args: unknown[]) => void lines.push(args);
      const sandbox: { window: unknown; console: { log: typeof record; warn: typeof record } } = {
        window: null as unknown,
        console: { log: record, warn: record },
      };
      sandbox.window = sandbox;
      vm.runInNewContext(PAGE_CONSOLE_SCRIPT, sandbox);
      return { lines, sandbox };
    }

    it("turns an object argument into structure instead of [object Object]", () => {
      const { lines, sandbox } = install();
      sandbox.console.log("x", { seq: 1 });
      expect(lines).toEqual([["x {seq: 1}"]]);
    });

    it("keeps a lone string argument bare", () => {
      const { lines, sandbox } = install();
      sandbox.console.log("plain message");
      expect(lines).toEqual([["plain message"]]);
    });

    it("leaves an explicit format string to the runtime", () => {
      const { lines, sandbox } = install();
      sandbox.console.log("count=%d", 5, { a: 1 });
      expect(lines).toEqual([["count=%d", 5, { a: 1 }]]);
    });

    it("still calls the original method, so the page's own DevTools sees the line", () => {
      const { lines, sandbox } = install();
      sandbox.console.warn({ payload: "x" });
      expect(lines).toEqual([['{payload: "x"}']]);
    });

    it("stays a no-op when a copy is already installed", () => {
      // Both the init-script copy and the collector's embedded copy run in the
      // same document; the marker must keep the second from wrapping the
      // already-wrapped methods.
      const { lines, sandbox } = install();
      const wrapped = sandbox.console.log;
      vm.runInNewContext(PAGE_CONSOLE_SCRIPT, sandbox);
      expect(sandbox.console.log).toBe(wrapped);
      sandbox.console.log("still once", { a: 1 });
      expect(lines).toEqual([["still once {a: 1}"]]);
    });
  });
});

/**
 * The host-noise filter, and the line it refuses to cross.
 *
 * The exclusion is the narrow one: it takes the host's warning text *and* a
 * source inside the host. Either alone would guess — a page printing the same
 * words from its own document keeps its line.
 */
describe("host noise filter", () => {
  it("matches the host's security warning by its text", () => {
    // Measured shape on Electron 45.2.1: the warning arrives with the page's
    // own URL as its source — the runtime prints it through the document's
    // console — so the text is the only usable marker.
    expect(
      looksLikeHostNoise({
        text:
          "Electron Security Warning (Insecure Content-Security-Policy) This renderer process has either no Content Security\n  Policy set or a policy with \"unsafe-eval\" enabled.",
        source: "http://127.0.0.1:4173/",
      }),
    ).toBe(true);
    expect(looksLikeHostNoise({ text: "Electron Security Warning (Disabled Web Security)" })).toBe(
      true,
    );
  });

  it("keeps the page's own CSP refusals, which name the page, not the host", () => {
    expect(
      looksLikeHostNoise({
        text:
          "Refused to load the script because it violates the following Content Security Policy directive",
        source: "http://127.0.0.1:4173/under-test.js",
      }),
    ).toBe(false);
  });

  it("keeps everything that does not carry the host's wording", () => {
    expect(looksLikeHostNoise({ text: "TypeError: x is not a function", source: "app.js" })).toBe(
      false,
    );
    expect(looksLikeHostNoise({ text: "", source: "electron/js2c/renderer_init.js" })).toBe(false);
    expect(looksLikeHostNoise({ text: undefined as unknown as string })).toBe(false);
  });

  it("matches the wording as a prefix, not a substring", () => {
    // A page writing "… see https://www.electronjs.org/docs/tutorial/security" —
    // a line that merely mentions the warning's docs URL — is content.
    expect(
      looksLikeHostNoise({
        text: "For more information see https://www.electronjs.org/docs/latest/tutorial/security",
        source: "http://127.0.0.1:4173/",
      }),
    ).toBe(false);
  });
});
