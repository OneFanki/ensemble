import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");

describe("macOS activation policy contract", () => {
  it("never lets setVisibleOnAllWorkspaces transform the process into an accessory app", () => {
    // Electron transforms the process to UIElementApplication unless asked not
    // to, and never transforms it back: the Dock icon, the app menu and Cmd+Tab
    // all disappear the first time the strip or the focus label is created.
    const calls = main.match(/setVisibleOnAllWorkspaces\([\s\S]{0,200}?\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain("skipTransformProcessType: true");
    }
  });

  it("does not hide the Dock icon anywhere", () => {
    // A menu-bar-only mode would have to be an explicit product switch; nothing
    // in the default startup path may demote the app behind the user's back.
    expect(main).not.toMatch(/app\.dock\.hide\(/);
    expect(main).not.toMatch(/setActivationPolicy\(/);
  });
});
