import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readMacBundleVersion } from "@core/engines/macos";

const root = mkdtempSync(join(tmpdir(), "ensemble-macos-engine-"));
const bundle = join(root, "Google Chrome.app");
const executable = join(bundle, "Contents", "MacOS", "Google Chrome");
mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
writeFileSync(executable, "");
writeFileSync(
  join(bundle, "Contents", "Info.plist"),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>CFBundleShortVersionString</key><string>152.0.7400.4</string>",
    "</dict></plist>",
  ].join(""),
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

// plutil only exists on macOS; the path shape is still asserted below.
describe.skipIf(process.platform !== "darwin")("macOS bundle version", () => {
  it("reads the version from Contents/Info.plist", async () => {
    await expect(readMacBundleVersion(executable)).resolves.toBe("152.0.7400.4");
  });

  it("returns undefined when the path is not inside a bundle", async () => {
    await expect(readMacBundleVersion(join(root, "elsewhere"))).resolves.toBeUndefined();
  });
});
