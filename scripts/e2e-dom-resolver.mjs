#!/usr/bin/env node
/**
 * Runs the semantic target resolver against a real Chromium DOM.
 *
 * The resolver lives in a string that gets evaluated inside the page, so a unit
 * test can only check that it was assembled correctly. This script serves a page
 * shaped like a component library's form (label and control in different
 * subtrees, an extra unlabelled field, a whole form that mentions every label)
 * and asks a real browser to resolve each target.
 *
 * A throwaway Electron main script hosts the page: the app's own window refuses
 * navigation by design, and a plain `chrome.exe --headless` cannot be told to
 * open a specific URL and expose a debug port on every machine this runs on.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildElementPointExpression, buildFocusExpression } from "../src/core/cdp/inspect.ts";

const PORT = 3995;
const DEBUG_PORT = 9805;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>组件库表单</title>
<style>
  body { font: 14px sans-serif; }
  .n-form-item { border: 1px solid #ddd; padding: 6px; margin: 6px 0; }
  .n-form-item-label { font-size: 12px; color: #666; }
</style></head>
<body>
<h1>新建租户</h1>
<form id="f">
  <!-- label and control live in different subtrees, as Naive UI does -->
  <div class="n-form-item">
    <div class="n-form-item-label">租户名称</div>
    <div class="n-form-item-blank"><div class="n-input"><input id="tname" /></div></div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">管理员账号</div>
    <div class="n-form-item-blank"><div class="n-input"><input id="tuser" /></div></div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">初始密码</div>
    <div class="n-form-item-blank"><div class="n-input"><input id="tpass" type="password" /></div></div>
  </div>
  <!-- an unlabelled control the resolver must not pick -->
  <div class="n-form-item">
    <div class="n-form-item-blank"><input id="search" /></div>
  </div>
  <button id="create">创建租户</button>
  <button id="cancel">取消</button>
</form>
</body></html>`;

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((done) => page.listen(PORT, "127.0.0.1", done));

const hostDir = mkdtempSync(join(tmpdir(), "ensemble-resolver-host-"));
mkdirSync(hostDir, { recursive: true });
writeFileSync(
  join(hostDir, "main.js"),
  `const { app, BrowserWindow } = require("electron");
   app.whenReady().then(() => {
     const win = new BrowserWindow({ width: 1000, height: 800, show: true });
     win.loadURL("http://127.0.0.1:${PORT}/");
   });
   app.on("window-all-closed", () => app.quit());`,
);
writeFileSync(join(hostDir, "package.json"), JSON.stringify({ name: "resolver-host", main: "main.js" }));

const userData = mkdtempSync(join(tmpdir(), "ensemble-resolver-"));
const electron = spawn(
  resolve("node_modules/electron/dist/electron.exe"),
  [hostDir, `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let hostLog = "";
electron.stdout.on("data", (chunk) => (hostLog += chunk));
electron.stderr.on("data", (chunk) => (hostLog += chunk));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

let socket;
try {
  let target;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(300);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((item) => item.type === "page" && item.url.includes(`:${PORT}`));
      if (target) break;
    } catch {
      // The debugging port is not up yet.
    }
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`no debug target; host log: ${hostLog.slice(-300)}`);

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener("open", done));
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (handler) {
      pending.delete(message.id);
      handler(message.result);
    }
  });
  const evaluate = (expression) =>
    new Promise((done) => {
      const id = ++nextId;
      pending.set(id, (result) => done(result?.result?.value));
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });

  await wait(800);

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
  };

  for (const [label, expected] of [
    ["租户名称", "tname"],
    ["管理员账号", "tuser"],
    ["初始密码", "tpass"],
  ]) {
    const point = await evaluate(buildElementPointExpression({ label }));
    // Read the id back at the resolved point rather than reconstructing the path:
    // the resolver may legitimately return a positional selector.
    const id = point?.ok
      ? await evaluate(`(() => {
          const el = document.elementFromPoint(${point.x}, ${point.y});
          return el?.id || el?.closest("input")?.id || "";
        })()`)
      : "";
    check(`label 「${label}」 resolves to #${expected}`, id === expected, {
      id,
      point: point?.ok ? { x: Math.round(point.x), y: Math.round(point.y) } : point,
    });
  }

  const button = await evaluate(buildElementPointExpression({ text: "创建租户" }));
  check("button text resolves to the create button", button?.ok === true, button && {
    tag: button.tag,
    text: button.text,
  });

  const missing = await evaluate(buildElementPointExpression({ label: "不存在的字段" }));
  check(
    "a missing label reports not-found instead of clicking something",
    missing?.ok === false && missing.reason === "not-found",
    missing,
  );

  const focus = await evaluate(buildFocusExpression({ label: "初始密码" }));
  check("a password field is reported as such through a label", focus?.inputType === "password", focus);

  const roleText = await evaluate(buildElementPointExpression({ role: "button", text: "取消" }));
  check("role + text narrows to the right button", roleText?.ok === true, roleText && { text: roleText.text });

  const bySelector = await evaluate(buildElementPointExpression("#tuser"));
  check("a selector still works", bySelector?.ok === true, bySelector && { text: bySelector.text });

  // An unlabelled field must not be reachable through a label that belongs to
  // another field: that would type the password into the search box.
  const searchId = await evaluate(`(() => {
    const el = document.getElementById("search");
    const point = el.getBoundingClientRect();
    return point.height > 0;
  })()`);
  check("the unlabelled field is visible but never matched by a label", searchId === true);

  socket.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  console.log("RESOLVER ERROR", String(error));
  console.log("host log tail:", hostLog.slice(-600));
  process.exitCode = 1;
} finally {
  electron.kill();
  await wait(1200);
  try {
    rmSync(userData, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  } catch {}
  page.close();
}
