import { joinUrl, normalizeBaseUrl, sameOrigin } from "@core/util/url";
import { describe, expect, it } from "vitest";

describe("login origin guard", () => {
  it("accepts the configured origin regardless of path", () => {
    expect(sameOrigin("https://app.example.com/login?next=/home", "https://app.example.com")).toBe(
      true,
    );
  });

  it("rejects a redirect to an SSO host", () => {
    expect(
      sameOrigin("https://login.microsoftonline.com/tenant/oauth2", "https://app.example.com"),
    ).toBe(false);
  });

  it("rejects scheme and port changes", () => {
    expect(sameOrigin("http://app.example.com/login", "https://app.example.com")).toBe(false);
    expect(sameOrigin("http://localhost:3001/login", "http://localhost:3000")).toBe(false);
  });

  it("rejects unparsable locations instead of assuming they are safe", () => {
    expect(sameOrigin("about:blank", "https://app.example.com")).toBe(false);
    expect(sameOrigin("not a url", "https://app.example.com")).toBe(false);
  });

  it("joins login paths onto the normalized base url", () => {
    expect(normalizeBaseUrl("https://app.example.com/")).toBe("https://app.example.com");
    expect(joinUrl("https://app.example.com/", "/login")).toBe("https://app.example.com/login");
  });
});
