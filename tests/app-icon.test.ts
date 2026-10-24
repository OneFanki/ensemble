import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards against the app showing Electron's own logo.
 *
 * In development the process runs as electron.exe, so any window that does not
 * receive an explicit icon falls back to Electron's bird in the taskbar and in
 * native dialogs. The regression is easy to reintroduce: adding a fourth window
 * (or a bare `dialog.showOpenDialog`) looks correct and only shows up visually.
 *
 * Parsing the source is the cheap way to cover every window at once — Electron
 * exposes no getter for a window's icon, so a runtime assertion is not available.
 */
const source = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");

function windowBlocks(): string[] {
  const blocks: string[] = [];
  const marker = "new BrowserWindow({";
  let index = source.indexOf(marker);
  while (index >= 0) {
    // Walk braces from the opening paren to find the matching close.
    const start = index + "new BrowserWindow(".length;
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(index, end + 1));
    index = source.indexOf(marker, end);
  }
  return blocks;
}

describe("app icon", () => {
  it("finds every BrowserWindow", () => {
    expect(windowBlocks().length).toBeGreaterThanOrEqual(3);
  });

  it("gives every window the app icon", () => {
    const missing = windowBlocks().filter((block) => !block.includes("icon: appIconPath()"));
    expect(missing).toHaveLength(0);
  });

  it("routes native file dialogs through the parented helpers", () => {
    // Every picker must be modal to the main window: a parentless dialog is a
    // separate window that inherits the process icon and can open behind the app.
    const direct = source.match(/dialog\.show(Open|Save)Dialog\(\{/g) ?? [];
    expect(direct).toHaveLength(0);
    expect(source).toContain("function showOpenDialog(");
    expect(source).toContain("function showSaveDialog(");
  });

  it("sets a Windows AppUserModelID so the taskbar groups under Ensemble", () => {
    expect(source).toContain('app.setAppUserModelId("io.github.onefanki.ensemble")');
  });
});
