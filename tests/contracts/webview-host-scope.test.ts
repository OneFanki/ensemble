import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `webviewTag` is a capability switch, and it sits only on windows that host
 * pages.
 *
 * The built-in browser hosts its pages as `<webview>` nodes inside the main
 * window, and a page popped out into its own window (拆窗) hosts its node in
 * that window. Every other window the app creates — the overlay strip, the
 * focus label, any future surface — does not, and leaving the switch off there
 * is what keeps a stray element from becoming a renderer with a partition the
 * surface never issued.
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

describe("webview hosting is scoped to the windows that host pages", () => {
  it("enables the tag on the window that hosts the browser surface", () => {
    expect(MAIN).toMatch(/webviewTag:\s*true/);
  });

  it("enables the tag only on the main window and the popout container", () => {
    const declared = MAIN.match(/webviewTag:\s*(true|false)/g) ?? [];
    // 主窗口与拆出窗口各一处；overlay、focus label 等其它窗口连开关都没有。
    expect(declared).toEqual(["webviewTag: true", "webviewTag: true"]);
    // 第二处必须在弹窗创建路径上——主窗口之外唯一合法的承载窗口。
    const popoutAt = MAIN.indexOf("function createPopoutWindow");
    expect(popoutAt).toBeGreaterThan(0);
    expect(MAIN.indexOf("webviewTag: true", popoutAt)).toBeGreaterThan(popoutAt);
    // 弹窗的节点同样由 guest manager 接管：install 先于容器页加载。
    const installAt = MAIN.indexOf("guestManager.install(win.webContents)", popoutAt);
    const loadAt = MAIN.indexOf("win.loadFile(", popoutAt);
    expect(installAt).toBeGreaterThan(popoutAt);
    expect(loadAt).toBeGreaterThan(installAt);
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
