#!/usr/bin/env node
/**
 * Cold-start restore of the built-in browser surface.
 *
 * First run: create a view, open it on the built-in surface, enable restore, quit.
 * Second run: with the same userData, the app must come back with the same
 * container and one tab per member, without any external browser window.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_PORT = 9670;
const MCP_PORT = 49784;
const TOKEN = "e2e-restore-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-restore-"));

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><head><meta charset='utf-8'><title>恢复测试</title></head><body><h1>恢复测试</h1></body></html>");
});
await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

mkdirSync(userData, { recursive: true });
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: true,
  }),
  { mode: 0o600 },
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "browser",
    onboardingVersion: 1,
    // On from the first launch: the check is that a cold start replays the view
    // into the built-in surface, not that the toggle itself saves.
    restoreLastView: true,
  }),
);

const electron = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let log = "";

function launch() {
  log = "";
  child = spawn(electron, [join(process.cwd(), "out", "main", "index.js")], {
    env: { ...process.env, ENSEMBLE_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
}

async function rpc(body) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return response.json();
}
let seq = 0;
async function call(name, args = {}) {
  const json = await rpc({
    jsonrpc: "2.0",
    id: ++seq,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content?.[0]?.text}`);
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

async function waitForMcp() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // Still starting.
    }
    await wait(400);
  }
  return false;
}

/** Waits for the main window's settings write, then stops the app. */
async function stop() {
  await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "quit_app", arguments: {} },
    }),
  }).catch(() => {});
  await wait(1_500);
  child?.kill();
  await wait(1_200);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

try {
  // ---- first run: build the workspace and open the view -------------------
  launch();
  check("first run started", await waitForMcp(), log.slice(-600));
  const site = await call("create_site", {
    name: "恢复测试站点",
    baseUrl: PAGE_URL,
    loginPath: "/",
    autoSubmit: false,
  });
  const people = [];
  for (const [index, name] of ["甲", "乙"].entries()) {
    people.push(
      await call("create_identity", {
        siteId: site.id,
        name: `账号${name}`,
        username: `user-${index}`,
        role: "成员",
        color: index === 0 ? "amber" : "teal",
        passwordMode: "inherit",
        startPath: "/",
      }),
    );
  }
  const view = await call("create_view", {
    siteId: site.id,
    name: "恢复验证",
    identityIds: people.map((item) => item.id),
    layoutId: "2x1",
  });
  const opened = await call("open_browser_view", { viewId: view.id });
  check("first run opened the view", (opened.tabs ?? []).length === 2);
  await stop();

  // ---- second run: the same container must come back ----------------------
  launch();
  check("second run started", await waitForMcp(), log.slice(-600));
  // Restore runs after the MCP server is up, so give it a moment.
  let state;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    state = await call("list_browser_tabs");
    if ((state.tabs ?? []).length >= 2) break;
    await wait(300);
  }
  check("restore reopened one tab per member", (state.tabs ?? []).length === 2, state.tabs?.length);
  const container = (state.views ?? []).find((item) => item.viewDefinitionId === view.id);
  check("restore recreated the container", Boolean(container), state.views);
  check("restore kept the saved layout", container?.layoutId === "2x1", container?.layoutId);
  check(
    "restored tabs belong to the container",
    (state.tabs ?? []).every((tab) => tab.viewId === container?.id),
  );

  const settings = JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
  check("restore preference persisted", settings.restoreLastView === true, settings.restoreLastView);
  await stop();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  child?.kill();
  server.close();
  await wait(1_000);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
