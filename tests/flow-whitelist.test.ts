import { describe, expect, it } from "vitest";
import { checkCdpCommand, cdpTier } from "@core/cdp/flow-whitelist";

/**
 * The tier list is a security boundary, so it is tested by its decisions rather
 * than by its table: what a flow may run, what needs the setting, and what is
 * refused no matter what the setting says.
 *
 * The denied cases are the ones that matter. `Target.*` can attach to a page in
 * another identity's partition, and `Storage.*` / `Network.setCookie` write
 * another partition's cookies — the isolation this app exists to provide. A
 * regression that quietly allowed one of them would not show up anywhere else.
 */
describe("flow CDP whitelist", () => {
  it("allows commands that act on the current page like a person", () => {
    for (const method of [
      "Input.dispatchMouseEvent",
      "Input.insertText",
      "DOM.setFileInputFiles",
      "Page.handleJavaScriptDialog",
      "Page.captureScreenshot",
    ]) {
      expect(checkCdpCommand(method, { gatedAllowed: false })).toEqual({ ok: true });
    }
  });

  it("refuses the optional tier unless the setting is on", () => {
    for (const method of [
      "Network.enable",
      "Emulation.setTimezoneOverride",
      "Fetch.enable",
      "Performance.getMetrics",
    ]) {
      const off = checkCdpCommand(method, { gatedAllowed: false });
      expect(off.ok).toBe(false);
      expect(off.ok === false && off.reason).toMatch(/可选档/);
      expect(checkCdpCommand(method, { gatedAllowed: true })).toEqual({ ok: true });
    }
  });

  it("refuses cross-partition domains even when the setting is on", () => {
    for (const method of [
      "Target.attachToTarget",
      "Target.createBrowserContext",
      "Browser.setDownloadBehavior",
      "Storage.getCookies",
      "Network.setCookie",
      "Network.clearBrowserCookies",
      // Lifecycle and teardown are not a page action: freezing a page would fight
      // the sleep sweep, and closing one would close a tab the user owns.
      "Page.setWebLifecycleState",
      "Page.close",
    ]) {
      for (const gatedAllowed of [false, true]) {
        const verdict = checkCdpCommand(method, { gatedAllowed });
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toMatch(/禁止/);
      }
    }
  });

  it("refuses a command nobody registered, rather than allowing it by default", () => {
    for (const method of ["Tracing.start", "HeapProfiler.startTrackingHeapObjects", "Made.Up"]) {
      expect(cdpTier(method).tier).toBe("deny");
      expect(checkCdpCommand(method, { gatedAllowed: true }).ok).toBe(false);
    }
  });

  it("treats an unknown command under an allowed domain as allowed", () => {
    // `Input.*` is a closed set that only synthesises user input; a new member of
    // it is still an input event, so the domain rule is the right width.
    expect(cdpTier("Input.dispatchTouchEvent").tier).toBe("allow");
  });

  it("keeps the domain-wide rules above the narrow exceptions", () => {
    // `Page.handleJavaScriptDialog` is allowed while the rest of `Page.*` is
    // either denied (`close`, `setWebLifecycleState`) or simply unregistered.
    expect(cdpTier("Page.navigate").tier).toBe("deny");
    expect(cdpTier("Page.handleJavaScriptDialog").tier).toBe("allow");
  });
});
