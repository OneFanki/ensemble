#!/usr/bin/env node
/**
 * End-to-end check of the embedded browser, driven entirely through MCP.
 *
 * Launches the built Electron app against a throwaway userData directory, with
 * the MCP endpoint pre-enabled, then runs the same calls an AI client would:
 * create an environment and two identities, open one embedded tab per identity,
 * verify session isolation, read what the page actually renders, click and type,
 * and take a screenshot.
 *
 * The page under test is a local server: a login form plus a control that only
 * an admin would see, which is exactly the shape of the real use case.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_PORT = 9666;
const MCP_PORT = 49777;
const TOKEN = "e2e-embedded-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-embedded-"));

// --- the app under test -------------------------------------------------
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>被测系统</title></head><body>
<h1>控制台</h1>
<label for="user">账号</label><input id="user" name="username">
<label for="pass">密码</label><input id="pass" name="password" type="password">
<button id="login" type="button"
  onclick="document.getElementById('status').textContent='signed-in:'+document.getElementById('user').value">
  登录
</button>
<div id="status">signed-out</div>
<button id="delete-user" style="display:none">删除用户</button>
</body></html>`);
});
await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

// --- pre-seed MCP so the endpoint is up on first launch -----------------
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

let nextId = 1;
async function call(name, args = {}) {
  const json = await rpc({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content[0].text}`);
  const text = json.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

  // Startup opens one blank page, so the browser page is never an empty stage.
  // What this protects is that a *fresh* workspace has nothing beyond it: a
  // restored tab or a stray view would mean the starter logic leaked.
  const starter = await call("list_browser_tabs");
  check(
    "only the starter tab exists",
    starter.tabs.length === 1 && starter.tabs[0].url === "about:blank",
    JSON.stringify(starter.tabs),
  );

  const site = await call("create_site", {
    name: "本地开发站点",
    baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
    loginPath: "/",
    autoSubmit: false,
  });
  await call("set_password", {
    ownerKind: "site",
    ownerId: site.id,
    password: "env-secret-value",
  });

  const admin = await call("create_identity", {
    siteId: site.id,
    name: "管理员 · 主账号",
    username: "admin-user",
    role: "管理员",
    color: "amber",
    passwordMode: "inherit",
  });
  const member = await call("create_identity", {
    siteId: site.id,
    name: "成员 · 子账号",
    username: "member-user",
    role: "成员",
    color: "teal",
    passwordMode: "inherit",
  });

  const adminTab = await call("open_browser_tab", {
    url: PAGE_URL,
    identityId: admin.id,
  });
  const memberTab = await call("open_browser_tab", {
    url: PAGE_URL,
    identityId: member.id,
  });
  check("two tabs opened through MCP", Boolean(adminTab.id && memberTab.id), {
    admin: adminTab.id,
    member: memberTab.id,
  });
  check("tab carries the identity label", adminTab.label === "管理员 · 主账号", adminTab.label);

  // If the chrome window failed to mount, it never reports the stage rectangle
  // and the native views stay at zero size — the page would still be scriptable
  // but invisible. A real viewport proves the chrome rendered and laid them out.
  await wait(800);
  const viewport = await call("evaluate_browser_page", {
    tabId: adminTab.id,
    expression: "({ w: innerWidth, h: innerHeight })",
  });
  check(
    "page view is laid out on screen",
    Number(viewport?.w) > 100 && Number(viewport?.h) > 100,
    viewport,
  );

  // Session isolation is the product guarantee: a cookie in one identity must
  // be invisible to the other.
  await call("evaluate_browser_page", {
    tabId: adminTab.id,
    expression: "document.cookie = 'admin_only=1; path=/'",
  });
  const adminCookie = await call("evaluate_browser_page", {
    tabId: adminTab.id,
    expression: "document.cookie",
  });
  const memberCookie = await call("evaluate_browser_page", {
    tabId: memberTab.id,
    expression: "document.cookie",
  });
  check(
    "identities have isolated sessions",
    String(adminCookie).includes("admin_only") && !String(memberCookie).includes("admin_only"),
    { adminCookie, memberCookie },
  );

  // What the page actually renders.
  const snapshot = await call("read_browser_page", { tabId: memberTab.id });
  const names = (snapshot.nodes ?? []).map((node) => node.name);
  check("page snapshot sees the form", names.some((name) => name.includes("登录")), names.slice(0, 8));
  check(
    "hidden admin control is absent from the snapshot",
    !names.some((name) => name.includes("删除用户")),
    names.slice(0, 8),
  );

  const hidden = await call("check_element_visible", {
    tabId: memberTab.id,
    selector: "#delete-user",
  });
  const visible = await call("check_element_visible", {
    tabId: memberTab.id,
    selector: "#login",
  });
  check(
    "visibility assertion tells hidden from visible",
    hidden.exists === true && hidden.visible === false && visible.visible === true,
    { hidden, visible },
  );

  // Real input events, not script clicks.
  await call("type_browser_text", { tabId: memberTab.id, selector: "#user", text: "typed-via-ai" });
  await call("click_browser_element", { tabId: memberTab.id, selector: "#login" });
  await wait(400);
  const status = await call("evaluate_browser_page", {
    tabId: memberTab.id,
    expression: "document.getElementById('status').textContent",
  });
  check("click and type reached the page", status === "signed-in:typed-via-ai", status);

  // Credential fill: password never appears in the response.
  const fill = await call("fill_browser_login", { tabId: adminTab.id });
  check("credential fill ran", fill.ok === true, fill);
  check("password never returned", !JSON.stringify(fill).includes("env-secret-value"));
  const filledUser = await call("evaluate_browser_page", {
    tabId: adminTab.id,
    expression: "document.getElementById('user').value",
  });
  check("fill wrote the identity's username", filledUser === "admin-user", filledUser);

  // Screenshot lands on disk.
  const shot = await call("screenshot_browser_tab", { tabId: adminTab.id });
  const bytes = shot.bytes ?? 0;
  check("screenshot written", bytes > 1000, shot);

  // A page the user switched away from must still screenshot promptly.
  //
  // The compositor stops producing frames for a view that is not on screen, and
  // `Page.captureScreenshot` does not fail there — it never returns, so the old
  // code waited out its full 4s timeout on every screenshot of a backgrounded
  // page. Reading pixels from the renderer directly avoids that. The bound is
  // deliberately loose (1.5s) so a slow machine is not a false failure, while
  // still failing on the 4s timeout this guards against.
  await call("set_tab_page", { pageId: memberTab.id });
  await new Promise((r) => setTimeout(r, 900));
  const parkedStart = Date.now();
  const parkedShot = await call("screenshot_browser_tab", { tabId: adminTab.id });
  const parkedMs = Date.now() - parkedStart;
  check(
    "a backgrounded page screenshots without waiting out the CDP timeout",
    (parkedShot.bytes ?? 0) > 1000 && parkedMs < 1500,
    { bytes: parkedShot.bytes, ms: parkedMs },
  );
  await call("set_tab_page", { pageId: adminTab.id });
  await new Promise((r) => setTimeout(r, 500));

  // Grid layout. Asking for one while every tab is loose groups them into a
  // view, which is the same result as dragging the tabs together by hand.
  const layout = await call("set_browser_layout", { layoutId: "2x1" });
  const grouped = (layout.views ?? [])[0];
  check(
    "layout switch groups loose tabs into a 2x1 view",
    grouped?.layoutId === "2x1" && grouped.slotTabs.filter(Boolean).length === 2,
    layout.views,
  );

  // Closing one tab leaves the other. Counted relative to what is open: the
  // starter page from launch is still there, so an absolute number would be
  // asserting startup behaviour, not the close.
  const beforeClose = (await call("list_browser_tabs")).tabs.length;
  await call("close_browser_tab", { tabId: memberTab.id });
  const remaining = await call("list_browser_tabs");
  check(
    "closing one tab leaves the other",
    remaining.tabs.length === beforeClose - 1 && !remaining.tabs.some((tab) => tab.id === memberTab.id),
    { before: beforeClose, after: remaining.tabs.length },
  );

  // The audit log records the browser calls with arguments redacted.
  const audit = readFileSync(join(userData, "mcp-audit.log"), "utf8");
  check("audit log records browser calls", audit.includes('"open_browser_tab"'));
  check("audit log holds no password", !audit.includes("env-secret-value"));
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  server.close();
  // Electron needs a moment to release the profile before the directory can go.
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
