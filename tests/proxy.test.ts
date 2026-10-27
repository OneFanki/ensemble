import { describe, expect, it } from "vitest";
import { isProxyUrlUsable, proxyBypassRules, proxyEndpoint, resolveProxyRules } from "@shared/proxy";

/**
 * The proxy mapping is what decides whether a user behind Clash can reach the
 * network at all, and its failure mode is silent: the update bar simply never
 * moves. These tests pin the four cases that matter — follow the system, force
 * direct, a usable manual address, and an unusable one — plus the bypass rule
 * that keeps local test sites off the proxy.
 */

describe("proxy endpoint", () => {
  it("reads host and port off an http address", () => {
    expect(proxyEndpoint("http://127.0.0.1:7890")).toBe("127.0.0.1:7890");
  });

  it("keeps a socks address as given", () => {
    expect(proxyEndpoint("socks5://127.0.0.1:1080")).toBe("127.0.0.1:1080");
  });

  it("keeps an IPv6 literal bracketed, which is what Chromium expects", () => {
    // An IPv6 literal has to be bracketed in a proxy rule; `hostname` gives the
    // bare form back, so the brackets are re-added here.
    expect(proxyEndpoint("http://[::1]:7890")).toBe("[::1]:7890");
  });

  it("refuses an address with no port instead of inventing one", () => {
    // A guessed port would send traffic somewhere the user never named.
    expect(proxyEndpoint("http://127.0.0.1")).toBeUndefined();
    expect(isProxyUrlUsable("http://127.0.0.1")).toBe(false);
  });

  it("refuses a scheme Chromium cannot proxy", () => {
    expect(proxyEndpoint("ftp://127.0.0.1:7890")).toBeUndefined();
    expect(proxyEndpoint("127.0.0.1:7890")).toBeUndefined();
  });

  it("treats an empty value as no address", () => {
    expect(proxyEndpoint("")).toBeUndefined();
    expect(proxyEndpoint("   ")).toBeUndefined();
    expect(proxyEndpoint(undefined)).toBeUndefined();
  });
});

describe("proxy rules", () => {
  const base = { proxyMode: "system" as const, proxyBypass: "" };

  it("lets Chromium read the OS settings when the mode is system", () => {
    // Not "direct": omitting the proxy must mean "use whatever the system says",
    // which is what covers Clash and the Windows proxy panel.
    expect(resolveProxyRules({ ...base, proxyMode: "system" })).toMatchObject({
      rules: "",
      ignoreSystem: false,
    });
  });

  it("forces a direct connection when the mode is off", () => {
    expect(resolveProxyRules({ ...base, proxyMode: "off" })).toMatchObject({
      rules: "",
      ignoreSystem: true,
    });
  });

  it("points both schemes at a usable manual address", () => {
    expect(
      resolveProxyRules({ ...base, proxyMode: "manual", proxyUrl: "http://127.0.0.1:7890" }),
    ).toEqual({
      rules: "http=127.0.0.1:7890;https=127.0.0.1:7890",
      bypass: "localhost,127.0.0.1,::1,<local>",
      ignoreSystem: true,
    });
  });

  it("does not silently fall back to direct when a manual address is unusable", () => {
    // Falling back to direct would look like the proxy setting was ignored, and
    // the user would have no way to tell why the download still hangs.
    const rules = resolveProxyRules({ ...base, proxyMode: "manual", proxyUrl: "nonsense" });
    expect(rules.ignoreSystem).toBe(true);
    expect(rules.rules).not.toBe("");
  });
});

describe("proxy bypass", () => {
  it("always bypasses localhost, whatever the user typed", () => {
    // A test environment on 127.0.0.1 that went through a proxy would fail to
    // load, and the cause would be three screens away.
    expect(proxyBypassRules("")).toContain("127.0.0.1");
    expect(proxyBypassRules("example.test")).toContain("localhost");
  });

  it("adds the user's hosts without duplicating the built-in ones", () => {
    const rules = proxyBypassRules("example.test, 10.0.0.5 ,localhost");
    expect(rules).toBe("localhost,127.0.0.1,::1,<local>,example.test,10.0.0.5");
  });

  it("accepts spaces as separators, since people paste lists", () => {
    expect(proxyBypassRules("a.test  b.test")).toContain("a.test");
    expect(proxyBypassRules("a.test  b.test")).toContain("b.test");
  });
});
