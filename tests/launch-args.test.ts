import { describe, expect, it } from "vitest";
import { buildChromiumArgs, buildFirefoxArgs, safeProfileSegment } from "@core/launch/args";

const base = {
  profileDir: "C:\\profiles\\env\\identity",
  startUrl: "http://localhost:3000/login",
};

describe("chromium launch args", () => {
  const args = buildChromiumArgs(base);

  it("uses an isolated profile directory", () => {
    expect(args).toContain(`--user-data-dir=${base.profileDir}`);
  });

  it("asks the browser for a dynamic debugging port", () => {
    expect(args).toContain("--remote-debugging-port=0");
  });

  it("disables account sync so a profile never inherits the operator's data", () => {
    expect(args).toContain("--disable-sync");
  });

  it("suppresses first-run and default-browser prompts", () => {
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
  });

  it("keeps background throttling off so manual interaction stays responsive", () => {
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args).toContain("--disable-background-timer-throttling");
  });

  it("does not disable extensions or block downloads", () => {
    expect(args).not.toContain("--disable-extensions");
    expect(args.some((arg) => arg.startsWith("--disable-downloads"))).toBe(false);
  });

  it("places the start url last", () => {
    expect(args.at(-1)).toBe(base.startUrl);
  });

  it("passes window bounds when provided", () => {
    const placed = buildChromiumArgs({
      ...base,
      windowBounds: { x: 10, y: 20, width: 800, height: 600 },
    });
    expect(placed).toContain("--window-position=10,20");
    expect(placed).toContain("--window-size=800,600");
  });
});

describe("firefox launch args", () => {
  it("uses a dedicated profile with a new instance", () => {
    const args = buildFirefoxArgs(base);
    expect(args).toEqual([
      "-profile",
      base.profileDir,
      "-no-remote",
      "-new-instance",
      base.startUrl,
    ]);
  });
});

describe("safeProfileSegment", () => {
  it("keeps safe characters and replaces the rest", () => {
    expect(safeProfileSegment("env-1")).toBe("env-1");
    expect(safeProfileSegment("a/b:c")).toBe("a_b_c");
    expect(safeProfileSegment("")).toBe("profile");
  });

  it("truncates long values", () => {
    expect(safeProfileSegment("x".repeat(200)).length).toBe(64);
  });
});
