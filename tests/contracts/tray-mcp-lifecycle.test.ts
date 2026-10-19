import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const main = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
const server = readFileSync(join(process.cwd(), "src/main/mcp/server.ts"), "utf8");

function handlerBody(source: string, event: string): string {
  const start = source.indexOf(`app.on("${event}"`);
  expect(start, `app.on("${event}") must exist`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`Unterminated handler for ${event}`);
}

describe("tray and MCP lifecycle contract", () => {
  it("takes a single instance lock so only one process can own the MCP port", () => {
    expect(main).toMatch(/app\.requestSingleInstanceLock\(\)/);
    expect(main).toMatch(/app\.on\("second-instance"/);
  });

  it("hides to the tray instead of quitting when the window is closed", () => {
    const close = main.slice(
      main.indexOf('mainWindow.on("close"'),
      main.indexOf('mainWindow.on("close"') + 900,
    );
    expect(close).toMatch(/settingsCache\?\.closeToTray/);
    expect(close).toMatch(/mainWindow\?\.hide\(\)/);
    expect(close).toContain("event.preventDefault()");
  });

  it("does not quit on window-all-closed while tray mode is on", () => {
    expect(handlerBody(main, "window-all-closed")).toMatch(/settingsCache\?\.closeToTray/);
  });

  it("stops the MCP server before tearing down browsers", () => {
    const shutdown = main.slice(
      main.indexOf("async function shutdownAndQuit"),
      main.indexOf("function applyTheme"),
    );
    const mcpIndex = shutdown.indexOf("mcpServer?.stop()");
    const serviceIndex = shutdown.indexOf("service?.shutdown()");
    expect(mcpIndex).toBeGreaterThan(-1);
    expect(serviceIndex).toBeGreaterThan(-1);
    expect(mcpIndex).toBeLessThan(serviceIndex);
  });

  it("destroys every open connection when the server stops", () => {
    // A client holding the socket open would otherwise keep the process alive and
    // leave the port bound after the UI says it quit.
    expect(server).toContain("closeAllConnections");
  });

  it("routes every quit path through the same teardown", () => {
    expect(handlerBody(main, "before-quit")).toMatch(/shutdownAndQuit\(\)/);
  });
});
