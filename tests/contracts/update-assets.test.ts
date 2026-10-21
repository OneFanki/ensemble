import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickUpdateAsset, type UpdateAsset } from "@shared/update";

/**
 * The update download matches a release asset by name. Those names come from
 * electron-builder's `artifactName` templates, so this file pins the two sides
 * together: if a template changes and this mapping does not, the app would find
 * "an update" with no usable file and the install button would stay disabled.
 */
const builderConfig = readFileSync(join(process.cwd(), "electron-builder.yml"), "utf8");

const assets: UpdateAsset[] = [
  "Ensemble-1.0.0-win-x64-setup.exe",
  "Ensemble-1.0.0-mac-x64.dmg",
  "Ensemble-1.0.0-mac-arm64.dmg",
  "Ensemble-1.0.0-linux-x64.AppImage",
  "Ensemble-1.0.0-linux-x64.deb",
].map((name) => ({ name, url: `https://github.com/x/y/${name}`, size: 1 }));

describe("update asset contract", () => {
  it("matches the Windows installer template", () => {
    // electron-builder.yml: win.artifactName ...-win-${arch}-${target}.${ext}
    // plus nsis.artifactName ...-win-${arch}-setup.${ext}.
    expect(builderConfig).toMatch(/-win-\$\{arch\}-setup\.\$\{ext\}/);
    expect(pickUpdateAsset(assets, "win32", "x64")?.name).toBe(
      "Ensemble-1.0.0-win-x64-setup.exe",
    );
  });

  it("matches the macOS dmg template", () => {
    expect(builderConfig).toMatch(/-mac-\$\{arch\}\.\$\{ext\}/);
    expect(pickUpdateAsset(assets, "darwin", "arm64")?.name).toBe(
      "Ensemble-1.0.0-mac-arm64.dmg",
    );
  });

  it("matches the Linux templates and prefers the in-place replaceable one", () => {
    expect(builderConfig).toMatch(/-linux-\$\{arch\}\.\$\{ext\}/);
    expect(pickUpdateAsset(assets, "linux", "x64")?.name).toBe(
      "Ensemble-1.0.0-linux-x64.AppImage",
    );
  });
});
