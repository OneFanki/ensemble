import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the headless contract of automated runs.
 *
 * The e2e suites and the screenshot pass drive a real app, and a real app window
 * keeps surfacing in front of whoever is working at the machine — a full pass
 * spawns it dozens of times, so the window kept jumping over unrelated work.
 * `ENSEMBLE_HEADLESS=1` is the switch every script now sets.
 *
 * Two things are easy to break and invisible in a passing suite:
 *
 * 1. A window created with `show: false` and never shown stops producing
 *    compositor frames, so `Page.captureScreenshot` hangs instead of returning
 *    pixels — every screenshot and every frozen overlay silently stops working.
 *    The window therefore has to be shown off-screen, not left hidden.
 * 2. Any new always-on-top surface (overlay, focus label, detached DevTools) has
 *    to respect the switch, or it appears on the user's desktop even though the
 *    main window is parked.
 *
 * Parsing the source is the cheap way to cover all of them at once; there is no
 * runtime getter for "was this window ever shown".
 */
const mainSource = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
const browserSource = readFileSync(
  join(process.cwd(), "src/main/embedded/browser.ts"),
  "utf8",
);

describe("headless runs", () => {
  it("reads the switch from the environment", () => {
    expect(mainSource).toContain('process.env["ENSEMBLE_HEADLESS"]');
    expect(mainSource).toMatch(/const headless = /);
  });

  it("parks the main window off every display instead of hiding it", () => {
    // Hidden-and-never-shown is the tempting implementation and it breaks every
    // screenshot; the parking helper is what keeps the compositor running.
    expect(mainSource).toContain("function parkWindowOffscreen");
    expect(mainSource).toMatch(/parkWindowOffscreen\(mainWindow\)/);
    expect(mainSource).toContain("setSkipTaskbar(true)");
    expect(mainSource).toContain("showInactive()");
  });

  it("suppresses every surface that would appear on the desktop", () => {
    // The overlay (always on top), the focus label (flashes over a window) and
    // the tray icon are all visible artifacts of a run nobody is watching.
    expect(mainSource).toMatch(/function syncOverlay[\s\S]{0,300}?if \(headless\) return/);
    expect(mainSource).toMatch(/function flashFocusLabel[\s\S]{0,300}?if \(headless\) return/);
    expect(mainSource).toMatch(/if \(!headless\) createTray\(\)/);
    expect(mainSource).toMatch(/function showMainWindow[\s\S]{0,200}?if \(headless\) return/);
  });

  it("keeps the renderer told which page to show", () => {
    // `focusPage` is the only path that both raises the window and asks the
    // renderer to switch to the browser page. Skipping the raise must not skip
    // the second half, or a headless run would drive pages the UI never shows.
    expect(browserSource).toMatch(/if \(this\.options\.headless\) \{\s*this\.options\.onShowPage\?\.\(\);\s*return;/);
  });

  it("does not paint a detached DevTools window", () => {
    expect(browserSource).toMatch(/show: !this\.options\.headless/);
    expect(browserSource).toMatch(/if \(!this\.options\.headless\) win\.show\(\)/);
  });
});

describe("automation scripts", () => {
  // Listed, not discovered: a discovered list would include whatever happens to
  // be in the folder, and the point is that no script may forget the switch.
  const scripts = [
    "capture-screenshots.mjs",
    "smoke-packaged-mcp.mjs",
    "e2e-autofill.mjs",
    "e2e-batch-launch.mjs",
    "e2e-browser-views.mjs",
    "e2e-dom-resolver.mjs",
    "e2e-embedded.mjs",
    "e2e-empty-slot.mjs",
    "e2e-flows.mjs",
    "e2e-instances.mjs",
    "e2e-login-capture.mjs",
    "e2e-mcp-tenant-setup.mjs",
    "e2e-overlay-freeze.mjs",
    "e2e-placement.mjs",
    "e2e-restore-surface.mjs",
    "e2e-site-tags.mjs",
    "e2e-tab-reorder.mjs",
    "e2e-ui-regressions.mjs",
    "e2e-v1-upgrade.mjs",
    "e2e-zoom-devtools.mjs",
  ];

  it("every script that starts the app asks for a headless run", () => {
    for (const name of scripts) {
      const text = readFileSync(join(process.cwd(), "scripts", name), "utf8");
      expect(text.includes("spawn("), `${name} is expected to start the app`).toBe(true);
      expect(text, `${name} must pass ENSEMBLE_HEADLESS`).toContain("ENSEMBLE_HEADLESS");
    }
  });
});
