import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_DEFAULT_PORT, defaultMcpSettings, loadMcpSettings } from "../src/main/mcp/server";

/**
 * The MCP endpoint port is part of the same "dev and installed must not collide"
 * rule as the workspace directory: one socket cannot be bound twice, and the
 * retry ladder turns the second bind into a nine-second stall followed by "port
 * busy" in the settings page.
 */
const created: string[] = [];

function settingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-mcp-port-"));
  created.push(dir);
  return join(dir, "mcp.json");
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP default port", () => {
  it("keeps the installed app on its documented port", () => {
    expect(defaultMcpSettings().port).toBe(47_821);
    expect(DEV_DEFAULT_PORT).not.toBe(defaultMcpSettings().port);
  });

  it("gives a development build its own default", () => {
    expect(defaultMcpSettings(DEV_DEFAULT_PORT).port).toBe(DEV_DEFAULT_PORT);
  });

  it("writes the development default for a fresh settings file", () => {
    const path = settingsPath();
    expect(loadMcpSettings(path, DEV_DEFAULT_PORT).port).toBe(DEV_DEFAULT_PORT);
    expect(JSON.parse(readFileSync(path, "utf8")).port).toBe(DEV_DEFAULT_PORT);
  });

  it("honours a port the user chose, in either build", () => {
    // Only the *default* moves. Someone who pinned 50000 in the dev build means
    // it, and the same file copied to another build must keep saying 50000.
    const path = settingsPath();
    loadMcpSettings(path, DEV_DEFAULT_PORT);
    const store = JSON.parse(readFileSync(path, "utf8"));
    expect(
      loadMcpSettings(path, DEV_DEFAULT_PORT).port,
    ).toBe(store.port);
  });

  it("falls back to the caller's default when the stored port is invalid", () => {
    // A hand-edited file with a nonsense port must not leave the server unstartable.
    // Separate files: loading repairs the value and writes it back, so one file
    // cannot answer both calls independently.
    const devSource = settingsPath();
    writeFileSync(devSource, JSON.stringify({ ...defaultMcpSettings(DEV_DEFAULT_PORT), port: 99 }));
    expect(loadMcpSettings(devSource, DEV_DEFAULT_PORT).port).toBe(DEV_DEFAULT_PORT);

    const installedSource = settingsPath();
    writeFileSync(installedSource, JSON.stringify({ ...defaultMcpSettings(), port: 99 }));
    expect(loadMcpSettings(installedSource).port).toBe(47_821);
  });
});
