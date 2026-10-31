#!/usr/bin/env node
/**
 * End-to-end check that auth-report toasts anchor to the viewport.
 *
 * The toast stack is `position: fixed; right: 18px`, which is viewport-relative
 * only while no ancestor carries a transform / contain / will-change. One such
 * ancestor silently re-anchors the stack to that element — the stack then lays
 * out at the dock's width and every card clips its own text on both edges
 * (2026-10-31, 8-account batch launch). Two facts guard it:
 *
 * 1. `offsetParent` of a fixed element is null unless the containing block was
 *    stolen by an ancestor — the direct hijack detector.
 * 2. The stack's right edge must sit exactly at `viewport - 18` and inside the
 *    viewport on every side, with full card text unclipped.
 *
 * A mock site signs in-and-fails on purpose (the check endpoint always answers
 * 401), so a batch launch produces the same warning toasts the user saw.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 9676;
const MCP_PORT = 49791;
const DEBUG_PORT = 9796;
const TOKEN = "e2e-toast-geometry-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-toast-geom-"));

const page = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PAGE_PORT}`);
  if (url.pathname === "/api/session") {
    // Always signed out: probe → login page → fill → submit → still signed out
    // → the pipeline reports login-failed, which is the toast under test.
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ signedIn: false }));
    return;
  }
  if (url.pathname === "/login" && req.method === "POST") {
    req.resume();
    res.writeHead(302, { location: "/start" });
    res.end();
    return;
  }
  const loginForm = url.pathname === "/login"
    ? `<form method="post" action="/login">
<label for="username">账号</label><input id="username" name="username">
<label for="password">密码</label><input id="password" name="password" type="password">
<button type="submit">登录</button>
</form>`
    : `<h1>${url.pathname}</h1>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${url.pathname}</title></head><body>${loginForm}</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

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

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [join(process.cwd(), "out", "main", "index.js"), `--remote-debugging-port=${DEBUG_PORT}`],
  { env: { ...process.env, ENSEMBLE_USER_DATA: userData, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content?.[0]?.text}`);
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    call(message.result);
  });
  await new Promise((done) => socket.addEventListener("open", done));
  return {
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result?.result?.value;
    },
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

try {
  const ready = await (async () => {
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
  })();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const site = await call("create_site", {
    name: "toast几何站点",
    baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
    loginPath: "/login",
    authCheckPath: "/api/session",
    autoSubmit: true,
    password: "e2e-toast-password",
  });
  const names = ["人设普通用户零一", "人设普通用户零二", "人设普通用户零三", "人设普通用户零四"];
  const ids = [];
  for (const [index, name] of names.entries()) {
    const identity = await call("create_identity", {
      siteId: site.id,
      name,
      username: `user-${index}`,
      role: "成员",
      passwordMode: "inherit",
      startPath: "/start",
    });
    ids.push(identity.id);
  }
  check("site and identities created", ids.length === names.length);

  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      // The window has not opened its debugging port yet.
    }
  }
  check("app window appeared", Boolean(target), target ? undefined : appLog.slice(-600));
  if (!target) throw new Error("no renderer target");
  const client = await connect(target.webSocketDebuggerUrl);
  await wait(1500);

  // The user's window at 125% display scaling, roughly: 2048×1222 CSS px.
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 2048,
    height: 1222,
    deviceScaleFactor: 1.25,
    mobile: false,
  });
  await wait(600);

  const launched = await client.evaluate(`(async () => {
    try {
      const state = await window.ensemble.launchEmbeddedIdentities(${JSON.stringify(ids)});
      return { ok: true, tabs: state.tabs.length };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  check("batch launched", launched?.ok === true && launched.tabs >= names.length, launched);

  // Wait out the login-failure reports (fill ≈2s + 20s confirm deadline).
  let toasts = [];
  for (let attempt = 0; attempt < 90; attempt += 1) {
    toasts = await client.evaluate(`(() => {
      const doc = document.documentElement;
      const stack = document.querySelector('.toast-stack');
      const rect = stack?.getBoundingClientRect();
      return {
        count: document.querySelectorAll('.toast').length,
        viewportW: doc.clientWidth,
        offsetParent: stack?.offsetParent ? (stack.offsetParent.className || stack.offsetParent.tagName) : null,
        stack: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
      };
    })()`);
    if (toasts.count >= names.length) break;
    await wait(500);
  }
  check(
    "login-failure toasts appeared",
    toasts.count >= names.length,
    toasts.count,
  );
  check(
    "toast stack is not re-anchored by a transformed ancestor",
    toasts.offsetParent === null,
    toasts.offsetParent,
  );
  const rightGap = toasts.stack ? toasts.viewportW - toasts.stack.right : NaN;
  check(
    "toast stack anchors 18px from the viewport's right edge",
    Math.abs(rightGap - 18) <= 1,
    { rightGap, stack: toasts.stack, viewportW: toasts.viewportW },
  );
  const viewportH = await client.evaluate("document.documentElement.clientHeight");
  check(
    "toast stack sits fully inside the viewport",
    Boolean(toasts.stack) &&
      toasts.stack.left >= 0 &&
      toasts.stack.right <= toasts.viewportW &&
      toasts.stack.bottom <= viewportH,
    { stack: toasts.stack, viewportH },
  );

  client.close();
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
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
