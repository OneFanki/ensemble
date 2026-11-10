#!/usr/bin/env node
/**
 * End-to-end checks for what a minimised window owes the AI surface.
 *
 * Reported contract from the migration ADR: "minimised window: CDP Input is
 * silently dropped, so input does nothing and reports success". (ADR 0011,
 * "已有明确结论的坑" #6.) That is the worst possible failure shape — an agent
 * believes it typed and the page never saw a keystroke — so it is checked
 * against the real thing rather than reasoned about.
 *
 * The checks drive the MCP tools, not the renderer API, because those are what
 * an agent actually calls: a fix that only makes the internal path work would
 * leave the reported failure in place.
 *
 * Four independent claims:
 *
 * 1. Reading still works (evaluate does not depend on focus).
 * 2. Typing still works. `Emulation.setFocusEmulationEnabled` is what makes
 *    Chromium deliver input to an unfocused renderer.
 * 3. Screenshots still work, and do not wait out the compositor timeout.
 * 4. Restoring brings the page back on screen.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
const INSPECT_PORT = await freePort();
const MCP_PORT = await freePort();
const TOKEN = "minimize-suite-token";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-minimize-"));

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>最小化测试</title>
<style>body{margin:0;font-family:system-ui}h1{padding:12px}
.n-form-item-label{display:block;font-size:12px;color:#555;margin:12px 16px 4px}
input{font-size:16px;padding:8px;margin:0 16px;width:280px}
button{font-size:14px;padding:8px 16px;margin:16px}</style></head>
<body><h1 id="title">最小化测试页</h1>
<div class="n-form-item"><div class="n-form-item-label">备注</div>
<input id="field" aria-label="备注" type="text" /></div>
<button id="counter" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">加一</button>
<span id="count">0</span>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: uuid(1),
        name: "最小化测试站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/",
      },
    ],
    identities: [
      {
        id: uuid(2),
        siteId: uuid(1),
        name: "管理员 · 主账号",
        username: "admin",
        role: "admin",
        color: "amber",
      },
    ],
    views: [],
    flows: [],
    bookmarks: [],
    bookmarkFolders: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
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
  }),
  { mode: 0o600 },
);

const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
// Not headless: the point is a real window that can actually be minimised, and
// a headless run parks the window at opacity 0 where `minimize()` is a no-op.
const app = spawn(
  electron,
  [
    ".",
    `--user-data-dir=${userData}`,
    `--remote-debugging-port=0`,
    `--inspect=${INSPECT_PORT}`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (c) => (appLog += c));
app.stderr.on("data", (c) => (appLog += c));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

let seq = 0;
async function call(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++seq,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  const result = json.result;
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "failed"}`);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message);
    }
  });
  await new Promise((done) => socket.addEventListener("open", done));
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const message = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        includeCommandLineAPI: true,
      });
      if (message.result?.exceptionDetails) {
        throw new Error(message.result.exceptionDetails.exception?.description);
      }
      return message.result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

async function findTarget(port, predicate, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const found = list.find(predicate);
      if (found) return found;
    } catch {
      /* 启动中 */
    }
  }
  return null;
}

try {
  const mainTarget = await findTarget(INSPECT_PORT, () => true, 60);
  if (!mainTarget) throw new Error(`no main inspector\n${appLog.slice(-800)}`);
  const main = await connect(mainTarget.webSocketDebuggerUrl);

  // Wait for the MCP endpoint, which is the surface this suite drives.
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list" }),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 启动中 */
    }
  }
  if (!ready) throw new Error(`MCP endpoint never came up\n${appLog.slice(-900)}`);

  const opened = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = opened?.tabId ?? opened?.id;
  check("a page is open through MCP", Boolean(tabId), opened);
  if (!tabId) throw new Error(`no tab id in ${JSON.stringify(opened)}`);
  await wait(1800);

  // Baseline before anything is minimised. Without it a typing check could pass
  // on a page that never received input in the first place.
  const baselineRead = await call("read_browser_page", { tabId });
  const baselineType = await call("type_browser_text", {
    tabId,
    label: "备注",
    text: "before",
  });
  const baselineValue = await call("evaluate_browser_page", {
    tabId,
    expression: "document.getElementById('field').value",
  });
  check(
    "reading and typing work while the window is visible",
    (baselineRead?.nodes?.length ?? 0) > 0 && baselineValue === "before",
    { nodes: baselineRead?.nodes?.length, value: baselineValue, baselineType },
  );

  // Minimise the real window through the main process, the way the title bar's
  // own button does.
  const state = await main.evaluate(`(async () => {
    const electron = require("electron");
    const win = electron.BrowserWindow.getAllWindows().find((w) =>
      !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
    if (!win) return { error: "no window" };
    win.minimize();
    await new Promise((r) => setTimeout(r, 1200));
    return { minimized: win.isMinimized(), visible: win.isVisible() };
  })()`);
  check("the window really is minimised", state?.minimized === true, state);

  // 1. Reading does not depend on focus.
  const readWhileMinimized = await call("read_browser_page", { tabId });
  check(
    "a minimised window still answers DOM reads",
    (readWhileMinimized?.nodes?.length ?? 0) > 0,
    { nodes: readWhileMinimized?.nodes?.length },
  );

  // 2. Typing. The field is cleared first so "it was already there" cannot pass.
  await call("evaluate_browser_page", {
    tabId,
    expression: "document.getElementById('field').value = ''",
  });
  const typed = await call("type_browser_text", { tabId, label: "备注", text: "minimized-ok" });
  const valueWhileMinimized = await call("evaluate_browser_page", {
    tabId,
    expression: "document.getElementById('field').value",
  });
  check(
    "a minimised window still receives typed text",
    valueWhileMinimized === "minimized-ok",
    { value: valueWhileMinimized, typed },
  );

  // 3. A click, which needs hit testing in a window with no visible viewport.
  const before = await call("evaluate_browser_page", {
    tabId,
    expression: "document.getElementById('count').textContent",
  });
  const clicked = await call("click_browser_element", { tabId, text: "加一" });
  await wait(500);
  const after = await call("evaluate_browser_page", {
    tabId,
    expression: "document.getElementById('count').textContent",
  });
  check(
    "a minimised window still receives a click",
    after !== before,
    { before, after, clicked },
  );

  // 4. A screenshot must come back, and must not wait out the 4s compositor
  //    deadline. A minimised window produces no frames, so the renderer path is
  //    the only one that can answer — taking it late still stalls every call.
  const shotStart = Date.now();
  let shot = null;
  let shotError = null;
  try {
    shot = await call("screenshot_browser_tab", { tabId });
  } catch (error) {
    shotError = String(error);
  }
  const shotMs = Date.now() - shotStart;
  console.log("[minimize] shot", JSON.stringify({ shot, shotError, shotMs }));
  check(
    "a minimised window still screenshots, without waiting out the timeout",
    (shot?.bytes ?? 0) > 1000 && shotMs < 2500,
    { bytes: shot?.bytes, ms: shotMs },
  );

  // 5. Restoring must bring the page back, not leave a blank stage.
  const restored = await main.evaluate(`(async () => {
    const electron = require("electron");
    const win = electron.BrowserWindow.getAllWindows().find((w) =>
      !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
    win?.restore();
    await new Promise((r) => setTimeout(r, 1500));
    return { minimized: win?.isMinimized() ?? null };
  })()`);
  const afterRestore = await call("evaluate_browser_page", {
    tabId,
    expression: "({ ready: document.readyState, title: document.title })",
  });
  check(
    "restoring leaves the page alive and loaded",
    restored?.minimized === false && afterRestore?.ready === "complete",
    { restored, afterRestore },
  );

  main.close();
} catch (error) {
  check("run completed", false, String(error));
  console.log(appLog.slice(-1500));
} finally {
  app.kill();
  page.close();
  await wait(1200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
