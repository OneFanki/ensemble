import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
const headless = readFileSync(join(process.cwd(), "src/core/launch/headless.ts"), "utf8");

describe("platform guards", () => {
  it("waits for the async clipboard write before arming the clear timer", () => {
    // Electron 45's clipboard is promise-based (W3C model); a fire-and-forget
    // write can still be in flight when the 30s clear compares against it.
    expect(main).toContain("await clipboard.writeText(password)");
    expect(main).toContain("clipboard.readText().then((current) =>");
  });

  it("only reaches for taskkill on Windows", () => {
    // Spawning it elsewhere raises an async ENOENT that try/catch cannot see.
    expect(headless).toMatch(/process\.platform === "win32"[\s\S]{0,240}taskkill/);
  });
});
