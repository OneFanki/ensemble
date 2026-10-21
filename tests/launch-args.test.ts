import { describe, expect, it } from "vitest";
import { buildChromiumArgs, buildFirefoxArgs, safeProfileSegment } from "@core/launch/args";
import { desktopUserAgent } from "@core/launch/headless";

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

  it("hides the crash-restore bubble that would offer old tabs", () => {
    expect(args).toContain("--hide-crash-restore-bubble");
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

  it("opens no window when headless is requested", () => {
    const headless = buildChromiumArgs({ ...base, headless: true });
    expect(headless).toContain("--headless=new");
    // Old headless renders a different engine path, which would check the wrong
    // thing; only the "new" mode is acceptable.
    expect(headless).not.toContain("--headless");
  });

  it("keeps the start url last in headless mode", () => {
    const headless = buildChromiumArgs({ ...base, headless: true });
    expect(headless.at(-1)).toBe(base.startUrl);
  });
});

describe("headless session user agent", () => {
  /*
   * A background check should present the same UA the user's own browser sends.
   * The only difference between the two strings is the product token, so the
   * rewrite is exactly that and nothing else.
   */
  it("turns Chromium's headless UA into the visible one", () => {
    const headless =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";
    const desktop =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";
    expect(desktopUserAgent(headless)).toBe(desktop);
  });

  it("leaves a UA that is already desktop-shaped untouched", () => {
    const desktop =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
    expect(desktopUserAgent(desktop)).toBe(desktop);
  });

  it("keeps the engine's own brand suffix", () => {
    const result = desktopUserAgent("HeadlessChrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0");
    expect(result).toContain("Chrome/120.0.0.0");
    expect(result).toContain("OPR/106.0.0.0");
    expect(result).not.toContain("Headless");
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
