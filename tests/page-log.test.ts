import {
  PAGE_LOG_TEXT_LIMIT,
  PAGE_NETWORK_LIMIT,
  buildNetworkIdleExpression,
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
   * Console collection lives in the main process (`console-message`) precisely
   * because a page-side wrapper cannot see the first line of the document. If
   * this script ever starts wrapping console again, every line would be
   * collected twice — once here and once from the event.
   */
  it("leaves console alone, so lines are not collected twice", async () => {
    const { PAGE_ACTIVITY_SCRIPT } = await import("@core/cdp/page-log");
    expect(PAGE_ACTIVITY_SCRIPT).not.toContain("console[level]");
    expect(PAGE_ACTIVITY_SCRIPT).not.toContain("addEventListener(\"unhandledrejection\"");
  });

  it("stays a self-contained expression", async () => {
    const { PAGE_ACTIVITY_SCRIPT, PAGE_ACTIVITY_READ_SCRIPT } = await import(
      "@core/cdp/page-log"
    );
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
