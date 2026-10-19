import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const builderConfig = readFileSync(join(root, "electron-builder.yml"), "utf8");

const allDeps = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};

describe("no bundled browser contract", () => {
  it("does not depend on playwright for the product runtime", () => {
    expect(allDeps["playwright"]).toBeUndefined();
    expect(allDeps["playwright-core"]).toBeUndefined();
    expect(allDeps["@playwright/test"]).toBeUndefined();
  });

  it("does not ship browser binaries in the installer", () => {
    const forbidden = [/ms-playwright/i, /chrome-win/i, /chromium/i, /firefox/i];
    for (const pattern of forbidden) {
      expect(builderConfig).not.toMatch(pattern);
    }
  });

  it("declares the published identity of the app", () => {
    expect(builderConfig).toContain("appId: io.github.onefanki.ensemble");
  });
});
