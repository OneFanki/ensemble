import { describe, expect, it } from "vitest";
import {
  bodyMarksSignedOut,
  buildAuthCheckExpression,
  resolveAuthTokenSource,
} from "@core/cdp/login";

describe("auth check signed-out marker", () => {
  it("reads a 200 envelope as signed out when the body carries the marker", () => {
    expect(bodyMarksSignedOut('{"status":2014,"msg":"请先登录"}', "请先登录")).toBe(true);
  });

  it("keeps the status verdict when the body says nothing either way", () => {
    expect(bodyMarksSignedOut('{"status":0,"roles":["member"]}', "请先登录")).toBe(false);
  });

  it("is false without a marker, a body, or both", () => {
    expect(bodyMarksSignedOut('{"status":2014}', undefined)).toBe(false);
    expect(bodyMarksSignedOut(undefined, "请先登录")).toBe(false);
    expect(bodyMarksSignedOut(undefined, undefined)).toBe(false);
  });

  it("only inspects the first 4 KiB of a body", () => {
    const padded = `${"x".repeat(4096)}请先登录`;
    expect(bodyMarksSignedOut(padded, "请先登录")).toBe(false);
  });

  it("the probe expression returns the body so the marker can be matched", () => {
    const expression = buildAuthCheckExpression("/api/me");
    expect(expression).toContain("response.text()");
    expect(expression).toContain("slice(0, 4096)");
  });

  it("reads the token from localStorage and sends it as the configured header", () => {
    const expression = buildAuthCheckExpression("/api/me/permissions", {
      key: "token",
      header: "token",
    });
    expect(expression).toContain('localStorage.getItem("token")');
    expect(expression).toContain('"token": stored');
    // Cookie credentials stay on: a site can use both mechanisms at once.
    expect(expression).toContain('credentials: "include"');
  });

  it("a header-token probe without a stored token sends no header rather than an empty one", () => {
    const expression = buildAuthCheckExpression("/api/me/permissions", {
      key: "session",
      header: "authorization",
    });
    expect(expression).toContain('localStorage.getItem("session")');
    expect(expression).toContain('"authorization": stored');
    // The spread only applies when `stored` is truthy, so a signed-out page
    // does not send an empty header that a strict backend could reject.
    expect(expression).toContain("...(stored ?");
  });

  it("resolves the header default and leaves the source unset without a key", () => {
    expect(resolveAuthTokenSource({ authTokenKey: "token" })).toEqual({
      key: "token",
      header: "token",
    });
    expect(resolveAuthTokenSource({ authTokenKey: "token", authTokenHeader: "x-auth" })).toEqual({
      key: "token",
      header: "x-auth",
    });
    expect(resolveAuthTokenSource({})).toBeUndefined();
  });
});
