#!/usr/bin/env node
/**
 * Measures what an MCP client is given before it does anything useful.
 *
 * The question this answers: hand a client the endpoint config and nothing else
 * — how much does it have to read before it knows what Ensemble is and which
 * tool to reach for? `initialize` + `tools/list` is that whole budget, so both
 * are measured here, plus a shape check that the payload actually explains the
 * product rather than only listing verbs.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MCP_PORT = 49793;
const TOKEN = "measure-mcp-context-token-123456";
const userData = mkdtempSync(join(tmpdir(), "ensemble-measure-mcp-"));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [],
    views: [],
    instances: [],
    flows: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", onboardingVersion: 1 }),
);
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
    aiOrigins: [],
  }),
  { mode: 0o600 },
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(electronBinary, [".", `--user-data-dir=${userData}`], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
}

async function waitForMcp() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // still starting
    }
    await wait(400);
  }
  return false;
}

try {
  if (!(await waitForMcp())) throw new Error(`MCP never came up\n${appLog.slice(-800)}`);

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "measure", version: "1.0.0" },
  });
  const list = await rpc("tools/list");

  const initText = JSON.stringify(init.result ?? {});
  const toolsText = JSON.stringify(list.result?.tools ?? []);
  const tools = list.result?.tools ?? [];

  const bytes = (value) => Buffer.byteLength(value, "utf8");
  const perTool = tools
    .map((tool) => ({
      name: tool.name,
      desc: bytes(tool.description ?? ""),
      schema: bytes(JSON.stringify(tool.inputSchema ?? {})),
    }))
    .map((tool) => ({ ...tool, total: tool.desc + tool.schema }))
    .sort((a, b) => b.total - a.total);

  const report = {
    toolCount: tools.length,
    initializeBytes: bytes(initText),
    toolsListBytes: bytes(toolsText),
    instructionsPresent: typeof init.result?.instructions === "string"
      && init.result.instructions.trim().length > 0,
    instructionsChars: init.result?.instructions?.length ?? 0,
    descriptionBytes: perTool.reduce((sum, tool) => sum + tool.desc, 0),
    schemaBytes: perTool.reduce((sum, tool) => sum + tool.schema, 0),
    largest: perTool.slice(0, 8),
    hasReadmeTool: tools.some((tool) => /readme|guide|about|overview/i.test(tool.name)),
    firstCharOfEachDescription: perTool.map((tool) => tool.name.slice(0, 24)),
  };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  app.kill();
  await wait(1500);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    // a held file will clear on reboot; the measurement already happened
  }
}
