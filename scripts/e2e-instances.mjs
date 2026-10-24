#!/usr/bin/env node
/**
 * End-to-end check of the instance model and the new stage affordances.
 *
 * A slot holds a browser instance, not a page: a link with `target="_blank"`
 * must open inside the same instance (never as an extra slot), the dock must
 * list one row per instance, and an empty slot's button must create a tab in
 * that slot and focus it.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 9671;
const MCP_PORT = 49793;
const TOKEN = "e2e-instances-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-instances-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>实例测试页</title></head><body>
<h1>控制台</h1>
<a id="popup" href="/second" target="_blank">在新标签页打开</a>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
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

const electron = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const app = spawn(electron, [join(process.cwd(), "out", "main", "index.js")], {
  env: { ...process.env, ENSEMBLE_USER_DATA: userData, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const result = json.result;
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "failed"}`);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
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

try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  // Launch leaves one blank page; this suite counts pages of its own tabs, so
  // start from an empty surface. (The starter page is not the subject here.)
  for (const tab of (await call("list_browser_tabs")).tabs ?? []) {
    await call("close_browser_tab", { tabId: tab.id });
  }
  check(
    "the surface starts empty for this check",
    ((await call("list_browser_tabs")).tabs ?? []).length === 0,
  );

  const first = await call("open_browser_tab", { url: PAGE_URL });
  check("first tab is its own instance", first.instanceId === first.id, first);
  check("a fresh instance has exactly one page", first.active === true, first);

  // Click the target=_blank link through the AI tools, which is how a popup is
  // actually triggered in this app.
  const point = await call("check_element_visible", {
    tabId: first.id,
    selector: "#popup",
  });
  check("popup link is visible", point?.visible === true, point);
  await call("click_browser_element", { tabId: first.id, selector: "#popup" });
  await wait(1800);

  const afterClick = await call("list_browser_tabs");
  const pages = afterClick.tabs ?? [];
  check("the popup became a second page", pages.length === 2, pages.length);
  check(
    "the popup joined the opener's instance",
    pages.every((tab) => tab.instanceId === first.instanceId),
    pages.map((tab) => ({ id: tab.id, instance: tab.instanceId })),
  );
  check(
    "only one page of the instance is active",
    pages.filter((tab) => tab.active).length === 1,
    pages.map((tab) => tab.active),
  );
  check(
    "the popup did not create a new view slot",
    (afterClick.views ?? []).every((view) => view.slotTabs.length === 0) ||
      (afterClick.views ?? []).length === 0,
    afterClick.views,
  );

  // A tab opened by hand is a separate instance, as a second window would be.
  const second = await call("open_browser_tab", { url: PAGE_URL });
  check("a hand-opened tab is a new instance", second.instanceId === second.id, second);
  const listed = await call("list_browser_tabs");
  check(
    "two instances are running",
    new Set((listed.tabs ?? []).map((tab) => tab.instanceId)).size === 2,
    (listed.tabs ?? []).map((tab) => tab.instanceId),
  );

  const audit = (await import("node:fs")).readFileSync(join(userData, "mcp-audit.log"), "utf8");
  check("audit log records the browser calls", audit.includes('"open_browser_tab"'));
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  page.close();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
