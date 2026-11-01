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

  it("keeps the standard editing and window roles", () => {
    for (const role of ['role: "quit"', 'role: "editMenu"', 'role: "minimize"', 'role: "close"']) {
      expect(main).toContain(role);
    }
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
  });
});
