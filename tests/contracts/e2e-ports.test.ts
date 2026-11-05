import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards how the automated suites pick their ports.
 *
 * Two failure modes used to be indistinguishable from real bugs:
 *
 * 1. A fixed page/MCP port that Windows has since reserved. The listener fails
 *    before the app starts and the output reads as "the window never appeared".
 * 2. A fixed debug port that a previous killed run still holds, or that two
 *    suites both chose. Chromium reports `EADDRINUSE` internally and the suite
 *    times out waiting for a target that can never be published.
 *
 * The rules here are source-level because the numbers only exist at runtime:
 * every listener asks the OS (`freePort()`), and every debug port is delegated
 * to Chromium (`--remote-debugging-port=0`) and read back from
 * `DevToolsActivePort` (`waitForDebugPort`).
 */
const scriptsDir = join(process.cwd(), "scripts");
const read = (name: string) => readFileSync(join(scriptsDir, name), "utf8");

/**
 * The suites this rule covers: everything automated that can run unattended.
 * `preview-site.mjs` is deliberately outside it — it is a server a person opens
 * in a browser, where a predictable URL is the feature, and `SITE_PORT` is
 * already the escape hatch.
 */
const automated = readdirSync(scriptsDir)
  .filter((name) => name.startsWith("e2e-") && name.endsWith(".mjs"))
  .concat(["capture-screenshots.mjs"])
  .map((name) => ({ name, text: read(name) }));

const sources = readdirSync(scriptsDir)
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => ({ name, text: read(name) }));

/** Scripts that start the app; each one needs a debug port decision. */
const launching = sources.filter((script) => script.text.includes("spawn("));

describe("e2e port allocation", () => {
  it("never listens on a hardcoded port", () => {
    // `listen(<number>)` is the shape that breaks; `listen(0)` asks the kernel
    // and is exactly what the rule wants, so only nonzero literals count.
    const offenders = automated
      .filter((script) => /\.listen\(\s*[1-9]\d*\s*,/.test(script.text))
      .map((script) => script.name);
    expect(offenders).toEqual([]);
  });

  it("asks the OS for every port it hands to something else", () => {
    // `freePort()` is the only sanctioned source. A script that passes a port
    // through without importing it is either still hardcoding or has invented a
    // third source, and both reintroduce the collision.
    const offenders = automated
      .filter((script) => /\.listen\(/.test(script.text))
      .filter((script) => !script.text.includes("freePort"))
      .map((script) => script.name);
    expect(offenders).toEqual([]);
  });

  it("delegates the debug port to Chromium", () => {
    // `--remote-debugging-port=0` closes the probe-then-bind race by making
    // Chromium pick the number at the moment it binds.
    const offenders = launching
      .filter((script) => /--remote-debugging-port=/.test(script.text))
      .filter((script) => !script.text.includes("--remote-debugging-port=0"))
      .map((script) => script.name);
    expect(offenders).toEqual([]);
  });

  it("reads the debug port back from DevToolsActivePort", () => {
    // A suite that spawns with `=0` but never reads the file cannot connect, so
    // the two halves are asserted together rather than as a style preference.
    const offenders = launching
      .filter((script) => script.text.includes("--remote-debugging-port=0"))
      .filter((script) => !script.text.includes("waitForDebugPort"))
      .map((script) => script.name);
    expect(offenders).toEqual([]);
  });

  it("keeps the shared helper free of app assumptions", () => {
    // The helper is imported by the suites *and* by the screenshot pass. If it
    // grew an Electron dependency or read from `out/`, a unit test could no
    // longer exercise it.
    const text = readFileSync(join(scriptsDir, "lib", "e2e-ports.mjs"), "utf8");
    expect(text).not.toContain("electron");
    expect(text).not.toContain("out/");
    expect(text).toContain("export function freePort");
    expect(text).toContain("export async function waitForDebugPort");
  });
});
