import { describe, expect, it } from "vitest";
import {
  dedupeEngines,
  materializeEngine,
  parseVersionOutput,
  slugify,
  sortEngines,
  versionFromExecutablePath,
} from "@core/engines/shared";
import { candidateFromManualPath, mergeManualEngines } from "@core/engines";

describe("engine helpers", () => {
  it("slugifies brand names", () => {
    expect(slugify("Microsoft Edge")).toBe("microsoft-edge");
    expect(slugify("Chrome Beta  ")).toBe("chrome-beta");
  });

  it("parses version output from several formats", () => {
    expect(parseVersionOutput("Google Chrome 152.0.7400.4")).toBe("152.0.7400.4");
    expect(parseVersionOutput("Chromium 155.0.8078.4 (Official Build)")).toBe("155.0.8078.4");
    expect(parseVersionOutput("Mozilla Firefox 157.0")).toBe("157.0");
    expect(parseVersionOutput("no version here")).toBeUndefined();
  });

  it("reads the version from a Chromium install directory", () => {
    expect(
      versionFromExecutablePath(
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\155.0.4283.45\\msedge.exe",
      ),
    ).toBe("155.0.4283.45");
    expect(versionFromExecutablePath("/usr/bin/google-chrome")).toBeUndefined();
  });

  it("marks chromium as CDP capable and firefox as external", () => {
    const chromium = materializeEngine({
      family: "chromium",
      brand: "Google Chrome",
      channel: "stable",
      exePath: "/usr/bin/google-chrome",
      source: "path",
    });
    const firefox = materializeEngine({
      family: "firefox",
      brand: "Firefox",
      channel: "stable",
      exePath: "/usr/bin/firefox",
      source: "path",
    });
    expect(chromium.cdp).toBe(true);
    expect(chromium.status).toBe("ready");
    expect(firefox.cdp).toBe(false);
    expect(firefox.status).toBe("ready");
  });

  it("keeps blocked reasons from the scanner", () => {
    const safari = materializeEngine({
      family: "webkit",
      brand: "Safari",
      channel: "stable",
      exePath: "/Applications/Safari.app",
      source: "standard",
      status: "blocked",
      blockReason: "no profile isolation",
    });
    expect(safari.status).toBe("blocked");
    expect(safari.blockReason).toBe("no profile isolation");
  });

  it("dedupes by executable path, keeping manual entries", () => {
    const scanned = materializeEngine({
      family: "chromium",
      brand: "Chromium",
      channel: "stable",
      exePath: "/usr/bin/chromium",
      source: "path",
    });
    const manual = materializeEngine({
      family: "chromium",
      brand: "My Chromium",
      channel: "stable",
      exePath: "/usr/bin/chromium",
      source: "manual",
    });
    const result = dedupeEngines([scanned, manual]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("manual");
  });

  it("sorts chromium before firefox and stable before beta", () => {
    const list = [
      materializeEngine({
        family: "firefox",
        brand: "Firefox",
        channel: "stable",
        exePath: "/ff",
        source: "path",
      }),
      materializeEngine({
        family: "chromium",
        brand: "Google Chrome Beta",
        channel: "beta",
        exePath: "/chrome-beta",
        source: "path",
      }),
      materializeEngine({
        family: "chromium",
        brand: "Google Chrome",
        channel: "stable",
        exePath: "/chrome",
        source: "path",
      }),
    ];
    const sorted = sortEngines(list);
    expect(sorted.map((engine) => engine.brand)).toEqual([
      "Google Chrome",
      "Google Chrome Beta",
      "Firefox",
    ]);
  });

  it("detects families and merges manual paths", () => {
    const manual = candidateFromManualPath("/opt/google/chrome/chrome");
    expect(manual.family).toBe("chromium");
    expect(manual.brand).toBe("Google Chrome");

    const merged = mergeManualEngines([], ["/opt/google/chrome/chrome"]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("manual");
    expect(merged[0]?.cdp).toBe(true);
  });
});
