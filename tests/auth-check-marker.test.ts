import { describe, expect, it } from "vitest";
import { bodyMarksSignedOut, buildAuthCheckExpression } from "@core/cdp/login";

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
});
