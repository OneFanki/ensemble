import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_ENGINE_ID,
  enginePreview,
  isValidEngineTemplate,
  looksLikeAddress,
  resolveBrowserInput,
  SEARCH_ENGINES,
} from "../src/shared/search";

const bing = { urlTemplate: "https://www.bing.com/search?q=%s" };

describe("looksLikeAddress", () => {
  it("recognizes schemes, localhost, IPs and dotted hosts", () => {
    for (const value of [
      "https://example.com/a?b=1",
      "http://example.com",
      "localhost",
      "localhost:3000",
      "localhost:3000/login",
      "127.0.0.1",
      "192.168.1.10:8080/login",
      "example.com",
      "example.com/path?q=1",
      "app.internal:8443",
      "[::1]:3000",
      "例子.测试",
    ]) {
      expect(looksLikeAddress(value), value).toBe(true);
    }
  });

  it("treats words, phrases and partial paths as searches", () => {
    for (const value of ["", "后台", "how to test login", "tenant 租户", "/admin", "a b.com"]) {
      expect(looksLikeAddress(value), value).toBe(false);
    }
  });
});

describe("resolveBrowserInput", () => {
  it("adds a scheme when a bare host is typed", () => {
    expect(resolveBrowserInput("localhost:3000", bing)).toBe("http://localhost:3000/");
    expect(resolveBrowserInput("example.com/x", bing)).toBe("http://example.com/x");
  });

  it("keeps an explicit scheme", () => {
    expect(resolveBrowserInput("https://example.com/a", bing)).toBe("https://example.com/a");
  });

  it("searches everything else on the selected engine", () => {
    expect(resolveBrowserInput("租户 管理", bing)).toBe(
      "https://www.bing.com/search?q=%E7%A7%9F%E6%88%B7%20%E7%AE%A1%E7%90%86",
    );
  });

  it("returns undefined for empty input", () => {
    expect(resolveBrowserInput("   ", bing)).toBeUndefined();
  });

  it("never produces a non-http address", () => {
    expect(resolveBrowserInput("file:///etc/passwd", bing)).toBe(
      "https://www.bing.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd",
    );
  });
});

describe("search engines", () => {
  it("ships Bing as the default and every built-in has a %s", () => {
    expect(DEFAULT_SEARCH_ENGINE_ID).toBe("bing");
    expect(SEARCH_ENGINES.find((engine) => engine.id === DEFAULT_SEARCH_ENGINE_ID)).toBeDefined();
    for (const engine of SEARCH_ENGINES) expect(isValidEngineTemplate(engine.urlTemplate)).toBe(true);
  });

  it("validates and previews custom templates", () => {
    expect(isValidEngineTemplate("https://example.com/?q=%s")).toBe(true);
    expect(isValidEngineTemplate("https://example.com/?q=")).toBe(false);
    expect(isValidEngineTemplate("file:///q=%s")).toBe(false);
    expect(enginePreview("https://example.com/?q=%s", "a b")).toBe(
      "https://example.com/?q=a%20b",
    );
  });
});
