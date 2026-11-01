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

  it("starts the endpoint before the window, so a stuck renderer load cannot starve it", () => {
    // The two used to be serial the other way round: `await createWindow()` then
    // `await mcpServer.start()`. A renderer whose load never settled left the
    // endpoint unbound for the whole session, with no error to explain it.
    // Comments are stripped first: the comment explaining this fix quotes the old
    // order, and a plain indexOf would match it.
    const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const start = /mcp\s*\.start\(\)/.exec(code);
    const windowIndex = code.indexOf("await createWindow()");
    expect(start).not.toBeNull();
    expect(windowIndex).toBeGreaterThan(-1);
    expect(start?.index ?? -1).toBeLessThan(windowIndex);
    // Started, not awaited: the retry ladder spends ~9 s on a busy port, and
    // awaiting it here would hold the window back for exactly that long.
    expect(code).not.toMatch(/await\s+mcp(Server)?\s*\.start\(\)/);
  });

  it("races the renderer load against a deadline", () => {
    expect(main).toMatch(/RENDERER_LOAD_TIMEOUT_MS/);
    expect(main).toMatch(/Promise\.race\(\[/);
  });

  it("retries a busy MCP port instead of reporting a dead endpoint", () => {
    expect(server).toMatch(/BIND_RETRY_DELAYS_MS/);
    expect(server).toMatch(/EADDRINUSE/);
  });

  it("reports a bind in progress instead of a bare 'not running'", () => {
    expect(server).toMatch(/starting: this\.starting/);
  });
});
