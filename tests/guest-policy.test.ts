import { describe, expect, it } from "vitest";
import {
  guestPartitionAllowed,
  guestSrcAllowed,
  hardenGuestPreferences,
} from "@core/cdp/guest-policy";

describe("what a webview guest may load", () => {
  it("accepts remote pages and the initial blank document", () => {
    expect(guestSrcAllowed("https://example.com/login")).toBe(true);
    expect(guestSrcAllowed("http://localhost:3000")).toBe(true);
    expect(guestSrcAllowed("about:blank")).toBe(true);
    expect(guestSrcAllowed("")).toBe(true);
  });

  it("refuses every scheme that reads local content or runs script", () => {
    expect(guestSrcAllowed("file:///C:/Windows/win.ini")).toBe(false);
    expect(guestSrcAllowed("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(guestSrcAllowed("javascript:alert(1)")).toBe(false);
    expect(guestSrcAllowed("devtools://devtools/bundled/inspector.html")).toBe(false);
  });
});

describe("which partition a guest may join", () => {
  it("accepts the partitions this surface creates", () => {
    expect(guestPartitionAllowed("persist:embedded-identity-1")).toBe(true);
    expect(guestPartitionAllowed("embedded-clean-abc123")).toBe(true);
    expect(guestPartitionAllowed(undefined)).toBe(true);
  });

  it("refuses a partition that belongs to something else", () => {
    expect(guestPartitionAllowed("persist:other-app")).toBe(false);
    expect(guestPartitionAllowed("")).toBe(false);
    expect(guestPartitionAllowed("persist:")).toBe(false);
  });
});

describe("guest hardening", () => {
  it("forces the privileged preferences off regardless of what was requested", () => {
    const preferences = {
      preload: "/tmp/evil.js",
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      webSecurity: false,
      allowRunningInsecureContent: true,
    };
    const params: Record<string, string> = { src: "https://example.com" };

    const decision = hardenGuestPreferences(preferences, params);

    expect(decision.ok).toBe(true);
    expect(preferences.preload).toBeUndefined();
    expect(preferences.nodeIntegration).toBe(false);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.webviewTag).toBe(false);
    expect(preferences.webSecurity).toBe(true);
    expect(preferences.allowRunningInsecureContent).toBe(false);
  });

  it("drops unknown attributes instead of inspecting known-dangerous ones", () => {
    const params: Record<string, string> = {
      src: "https://example.com",
      partition: "persist:embedded-identity-1",
      allowpopups: "true",
      "some-future-privilege": "yes",
      nodeintegration: "true",
      preload: "/tmp/evil.js",
      disablewebsecurity: "true",
    };

    hardenGuestPreferences({}, params);

    expect(params["src"]).toBe("https://example.com");
    expect(params["partition"]).toBe("persist:embedded-identity-1");
    // Kept so popup requests reach main at all; routing denies the window.
    expect(params["allowpopups"]).toBe("true");
    expect(params["some-future-privilege"]).toBeUndefined();
    expect(params["nodeintegration"]).toBeUndefined();
    expect(params["preload"]).toBeUndefined();
    expect(params["disablewebsecurity"]).toBeUndefined();
  });

  it("refuses to attach a guest that asks for a local file", () => {
    const decision = hardenGuestPreferences({}, { src: "file:///etc/passwd" });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("协议不允许");
  });

  it("refuses to attach a guest pointed at another app's partition", () => {
    const decision = hardenGuestPreferences({}, {
      src: "https://example.com",
      partition: "persist:some-other-product",
    });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("分区不允许");
  });

  it("leaves an already-hardened guest at the same settings", () => {
    const preferences = {
      preload: undefined,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    };
    const decision = hardenGuestPreferences(preferences, {
      src: "https://example.com",
      partition: "persist:embedded-x",
    });
    expect(decision.ok).toBe(true);
    expect(preferences.sandbox).toBe(true);
    expect(preferences.contextIsolation).toBe(true);
  });
});
