import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
const i18n = readFileSync(join(process.cwd(), "src/core/i18n/translate.ts"), "utf8");

describe("macOS app menu contract", () => {
  it("installs a native menu on macOS and keeps the bare window elsewhere", () => {
    // A menu-less app has no accelerator table: Cmd+, does nothing and Cmd+Q/H/M
    // lose their standard meanings, because those bindings live in the menu.
    expect(main).toMatch(/Menu\.setApplicationMenu\(isMac \? buildMacMenu\(\) : null\)/);
  });

  it("binds Cmd+, to the settings page", () => {
    expect(main).toMatch(/accelerator: "Command\+,"/);
    expect(main).toMatch(/requestOpenSettings\(\)/);
    expect(main).toMatch(/IPC\.appOpenSettings/);
  });

  it("keeps the standard window roles but owns the close bindings", () => {
    for (const role of ['role: "quit"', 'role: "editMenu"', 'role: "minimize"']) {
      expect(main).toContain(role);
    }
    // Cmd+W closes the framed page; only an empty stage falls back to the
    // window. Cmd+Shift+W is the explicit window close.
    expect(main).toContain('accelerator: "Command+W"');
    expect(main).toContain("closeActiveTabOrWindow()");
    expect(main).toContain('accelerator: "Command+Shift+W"');
    expect(main).not.toContain('{ role: "close" }');
  });

  it("does not hand the View menu to the stock role", () => {
    // AppKit consumes these accelerators before `before-input-event`, and the
    // role acts on the shell: Cmd+R reloaded the whole UI and Cmd+± zoomed the
    // chrome instead of the page the user was looking at.
    expect(main).not.toContain('{ role: "viewMenu" }');
    expect(main).toContain("embedded?.reloadActive()");
    expect(main).toContain("embedded?.hardReloadActive()");
    expect(main).toContain("embedded?.toggleDevToolsForFocusedPage()");
    expect(main).toContain('embedded?.zoomActive("in")');
    expect(main).toContain('embedded?.zoomActive("out")');
    expect(main).toContain('embedded?.zoomActive("reset")');
  });

  it("holds the settings request until the page has finished loading", () => {
    // Sending into a renderer that has not mounted yet would drop the request.
    expect(main).toMatch(/isLoading\(\)[\s\S]{0,200}did-finish-load/);
  });

  it("ships the menu labels in both locales", () => {
    expect(i18n).toMatch(/"menu\.settings": "设置…"/);
    expect(i18n).toMatch(/"menu\.settings": "Settings…"/);
    expect(i18n).toMatch(/"menu\.window": "窗口"/);
    expect(i18n).toMatch(/"menu\.window": "Window"/);
    for (const key of [
      "menu.view",
      "menu.reload",
      "menu.forceReload",
      "menu.devtools",
      "menu.zoomIn",
      "menu.zoomOut",
      "menu.zoomReset",
      "menu.closeTab",
      "menu.closeWindow",
    ]) {
      expect(i18n).toMatch(new RegExp(`"${key}":`));
    }
  });
});
