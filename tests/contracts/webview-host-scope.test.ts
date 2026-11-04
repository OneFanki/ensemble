import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `webviewTag` is a capability switch, and it has to sit on exactly one window.
 *
 * The built-in browser hosts its pages as `<webview>` nodes inside the main
 * window, so that window needs the tag enabled. Every other window the app
 * creates — the overlay strip, the focus label, any future surface — does not,
 * and leaving the switch off there is what keeps a stray element from becoming
 * a renderer with a partition the surface never issued.
 *
 * The behavioural half of this rule (what a guest may become) lives in
 * `tests/guest-policy.test.ts`. This file only pins the wiring: the tag is on
 * where the nodes live, off everywhere else, and the manager is installed
 * before the renderer can parse its first `<webview>`.
 */
const MAIN = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("webview hosting is scoped to the main window", () => {
  it("enables the tag on the window that hosts the browser surface", () => {
    expect(MAIN).toMatch(/webviewTag:\s*true/);
  });

  it("leaves every other window with the tag off", () => {
    const declared = MAIN.match(/webviewTag:\s*(true|false)/g) ?? [];
    expect(declared).toEqual(["webviewTag: true"]);
  });

  it("installs the guest manager before the renderer is loaded", () => {
    const installAt = MAIN.indexOf("guestManager.install(mainWindow.webContents)");
    const loadAt = MAIN.indexOf("mainWindow.loadFile(");
    expect(installAt).toBeGreaterThan(0);
    expect(loadAt).toBeGreaterThan(installAt);
  });

  it("closes guest sessions before the app tears its windows down", () => {
    const disposeAt = MAIN.indexOf("await guestManager.dispose()");
    const quitAt = MAIN.indexOf("app.quit()", MAIN.indexOf("async function shutdownAndQuit"));
    expect(disposeAt).toBeGreaterThan(0);
    expect(quitAt).toBeGreaterThan(disposeAt);
  });
});
