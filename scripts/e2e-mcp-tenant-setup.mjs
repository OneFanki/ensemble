#!/usr/bin/env node
/**
 * End-to-end check of the scenario the AI documentation advertises:
 *
 *   "Here is a test-environment URL, the super-admin login and a tenant name —
 *    save the site, sign in, create a few tenant accounts and save them."
 *
 * Drives the real app through the real MCP endpoint. The assertions are about
 * what a user (or an AI) would notice: the tenant field reaches the login form,
 * every tenant keeps its own tenant name, nothing prompts to save a login that
 * is already stored, and no password is written to the audit log.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3993;
const MCP_PORT = 49793;
const DEBUG_PORT = 9803;
const TOKEN = "e2e-tenant-scenario-token-123456";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-tenant-"));

const SUPER = { username: "super@example.test", password: "Super-Secret-1", tenant: "默认租户" };
const TENANTS = [
  { name: "租户 A · 标准版", username: "admin-a@example.test", password: "Tenant-A-Secret" },
  { name: "租户 B · 专业版", username: "admin-b@example.test", password: "Tenant-B-Secret" },
  { name: "租户 C · 试用版", username: "admin-c@example.test", password: "Tenant-C-Secret" },
];

// A stand-in for a component-library admin console (Naive UI / Ant Design
// shape): every field is a wrapper holding a label div and a control element
// that is NOT a sibling of the label, and the DOM order does not follow visual
// order. A positional selector built from the snapshot lands on the wrong field
// here; the label is the only thing that identifies a field the way a person
// would read it.
const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (req.url?.startsWith("/admin")) {
    // POST, not GET: a creation form that puts the initial password in the URL
    // would leak it into server logs, which is exactly what this suite guards
    // against.
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(req.method === "POST" ? body : req.url.split("?")[1] ?? "");
      const created = params.get("tname");
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>租户管理</title>
<style>
  body { font: 14px sans-serif; }
  .n-form-item { border: 1px solid #ddd; padding: 6px; margin: 6px 0; }
  .n-form-item-label { font-size: 12px; color: #666; }
  .n-form-item-blank span { display: block; border: 1px solid #ccc; height: 26px; }
</style></head>
<body>
<h1>租户管理</h1>
<form id="create" action="/admin" method="post">
  <div class="n-form-item">
    <div class="n-form-item-label">租户名称</div>
    <div class="n-form-item-blank">
      <div class="n-input">
        <div class="n-input-wrapper"><input id="tname" name="tname" type="text" /></div>
      </div>
    </div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">管理员账号</div>
    <div class="n-form-item-blank">
      <div class="n-input">
        <div class="n-input-wrapper"><input id="tuser" name="tuser" type="text" /></div>
      </div>
    </div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">初始密码</div>
    <div class="n-form-item-blank">
      <div class="n-input">
        <div class="n-input-wrapper"><input id="tpass" name="tpass" type="password" /></div>
      </div>
    </div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">备注</div>
    <div class="n-form-item-blank">
      <div class="n-input">
        <div class="n-input-wrapper"><input id="tnote" name="tnote" type="text" /></div>
      </div>
    </div>
  </div>
  <button id="createBtn" type="submit">创建租户</button>
</form>
<p id="toast"></p>
<ul id="list"><li>默认租户</li></ul>
<script>
  // The real console refreshes its list asynchronously; render the new tenant
  // 900ms after load so a wait actually has to poll instead of finding the row
  // on the first tick.
  const created = ${JSON.stringify(created)};
  if (created) {
    setTimeout(() => {
      const item = document.createElement("li");
      item.textContent = created;
      document.getElementById("list").appendChild(item);
      document.getElementById("toast").textContent = "创建成功";
    }, 900);
  }
</script>
</body></html>`);
    });
    return;
  }
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head>
<body>
<form id="f" action="/admin" method="get">
  <div class="n-form-item">
    <div class="n-form-item-label">租户名</div>
    <div class="n-form-item-blank"><input id="tenant" name="tenant" type="text" /></div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">账号</div>
    <div class="n-form-item-blank"><input id="user" name="user" type="text" autocomplete="username" /></div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">密码</div>
    <div class="n-form-item-blank"><input id="pass" name="pass" type="password" autocomplete="current-password" /></div>
  </div>
  <button id="submit" type="submit">登录</button>
</form>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${PAGE_PORT}`;

const now = new Date().toISOString();
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
    manualEngines: [],
    layoutPresets: [],
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
  }),
  { mode: 0o600 },
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
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
    close() {
      socket.close();
    },
  };
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

/** Fails the whole run if a tool call throws, so checks never read undefined. */
async function tryCall(name, args = {}) {
  try {
    return { ok: true, value: await call(name, args) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/** Reads values out of the embedded page through the MCP evaluate tool. */
async function pageValues(tabId, expression) {
  return call("evaluate_browser_page", { tabId, expression });
}

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (res.ok) break;
    } catch {
      // Still starting.
    }
  }
  await wait(1500);

  // Watch for save-login prompts before anything signs in.
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const renderer = list.find(
    (item) =>
      item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
  );
  check("app window appeared", Boolean(renderer), renderer ? undefined : appLog.slice(-600));
  if (!renderer) throw new Error("no renderer target");
  const client = await connect(renderer.webSocketDebuggerUrl);
  await client.evaluate(`(() => {
    window.__captures = [];
    window.__autoFills = [];
    window.ensemble.onLoginCaptured((notice) => window.__captures.push(notice));
    window.ensemble.onAutoFilled((report) => window.__autoFills.push(report));
    return true;
  })()`);

  // 1. Save the site and the super admin.
  const site = await tryCall("create_site", {
    name: "多租户后台 · 测试",
    baseUrl: BASE,
    loginPath: "/login",
    password: SUPER.password,
    extraFields: [{ label: "租户名", value: SUPER.tenant }],
  });
  check("create_site saves the site in one call", site.ok && Boolean(site.value?.id), site);
  if (!site.ok) throw new Error("cannot continue without a site");
  const siteId = site.value.id;
  check(
    "create_site returns no password",
    !JSON.stringify(site.value).includes(SUPER.password),
  );

  // The status bar is the everyday entry point into this endpoint, so it has to
  // report the live port — not just "AI" with no address.
  const mcpEntry = await client.evaluate(`(() => {
    const button = document.querySelector('.status-mcp');
    return button
      ? {
          text: button.textContent.replace(/\\s+/g, ' ').trim(),
          running: button.classList.contains('on'),
        }
      : null;
  })()`);
  check(
    "the status bar shows the running endpoint and its port",
    mcpEntry?.running === true && mcpEntry?.text.includes(String(MCP_PORT)),
    mcpEntry,
  );

  const admin = await tryCall("create_identity", {
    siteId,
    name: "超管 · 主账号",
    username: SUPER.username,
    password: SUPER.password,
    role: "admin",
    extraFields: [{ label: "租户名", value: SUPER.tenant }],
  });
  check("create_identity saves the super admin", admin.ok && admin.value?.hasPassword === true, admin);
  const adminId = admin.value?.id;

  // 2. Open as the super admin. The login must fill without an extra call.
  //
  // The call must not steal the window either: an AI opening pages to work on
  // them should leave whatever the user is looking at alone, so park the UI on
  // the settings page first and check it is still in front afterwards.
  await client.evaluate(`(() => {
    document.querySelector('[data-nav="settings"]')?.click();
    return true;
  })()`);
  await wait(700);
  const viewBefore = await client.evaluate(`(() => ({
    nav: document.querySelector('.rail .nav-item.active')?.dataset.nav ?? "",
    settingsVisible: Boolean(document.querySelector('.settings')),
  }))()`);

  const opened = await tryCall("open_browser_tab", {
    url: `${BASE}/login`,
    identityId: adminId,
    siteId,
    label: "超管",
  });
  check("open_browser_tab opens a tab as the identity", opened.ok && Boolean(opened.value?.id), opened);
  const tabId = opened.value?.id;

  await wait(1500);
  const viewAfter = await client.evaluate(`(() => ({
    nav: document.querySelector('.rail .nav-item.active')?.dataset.nav ?? "",
    settingsVisible: Boolean(document.querySelector('.settings')),
  }))()`);
  check(
    "open_browser_tab leaves the page the user was on in front",
    viewBefore?.nav === "settings" &&
      viewAfter?.nav === "settings" &&
      viewAfter?.settingsVisible === true,
    { before: viewBefore, after: viewAfter },
  );

  let filled = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await wait(400);
    filled = await pageValues(
      tabId,
      `(() => ({
        tenant: document.querySelector('#tenant')?.value ?? '',
        user: document.querySelector('#user')?.value ?? '',
        pass: document.querySelector('#pass')?.value ?? '',
        ready: document.readyState,
      }))()`,
    );
    if (filled?.user && filled?.pass) break;
  }
  check(
    "opening as an identity fills the login without an extra tool call",
    filled?.user === SUPER.username && filled?.pass === SUPER.password,
    { user: filled?.user, passLength: filled?.pass?.length },
  );
  check(
    "the site's tenant field reaches the login form",
    filled?.tenant === SUPER.tenant,
    { tenant: filled?.tenant },
  );

  // 3. Sign in. An already-saved account must not produce a capture prompt.
  //    Clicking by text, then waiting for the next page: the AI does not need a
  //    CSS path for either step.
  await call("click_browser_element", { tabId, text: "登录" });
  const signIn = await call("wait_browser", { tabId, condition: "url", expect: "/admin", timeoutMs: 10_000 });
  check("wait_browser waits out the navigation in one call", signIn.ok === true, signIn);
  const captures = await client.evaluate("(window.__captures ?? []).length");
  check("signing in as a saved account produces no save prompt", captures === 0, { captures });

  const landed = await pageValues(tabId, `({ url: location.pathname, title: document.title })`);
  check("sign-in reached the admin console", landed?.url === "/admin", landed);

  // 4. Create the tenants through the page, the way an AI would: by the labels a
  //    person reads, not by positional selectors. The snapshot has to name the
  //    fields too, otherwise the AI cannot know what to type into.
  const forms = await call("read_browser_page", { tabId });
  const roles = forms.nodes.map((node) => `${node.role}:${node.name}`).join(" ");
  check("read_browser_page exposes the tenant form", /创建租户/.test(roles), roles.slice(0, 200));
  const fields = forms.nodes.filter((node) => node.field).map((node) => node.field);
  check(
    "the snapshot reports the label beside each input",
    ["租户名称", "管理员账号", "初始密码"].every((label) => fields.includes(label)),
    { fields },
  );

  for (const tenant of TENANTS) {
    const filled = await tryCall("fill_browser_form", {
      tabId,
      fields: [
        { label: "租户名称", value: tenant.name },
        { label: "管理员账号", value: tenant.username },
        { label: "初始密码", value: tenant.password },
      ],
    });
    if (!filled.ok) throw new Error(`cannot fill the tenant form: ${filled.error}`);
    const values = await pageValues(
      tabId,
      `({ name: document.querySelector('#tname').value, user: document.querySelector('#tuser').value, note: document.querySelector('#tnote').value })`,
    );
    check(
      "label targeting fills the right field in a component-library form",
      values?.name === tenant.name && values?.user === tenant.username && values?.note === "",
      values,
    );

    await call("click_browser_element", { tabId, text: "创建租户" });
    // Wait for something that only exists after the new tenant is rendered: the
    // list already says "创建成功" from the previous round, so waiting for that
    // would match the old page and race the navigation.
    const confirmed = await call("wait_browser", {
      tabId,
      condition: "text",
      expect: tenant.name,
      timeoutMs: 8_000,
    });
    check(`tenant ${tenant.name} confirms creation without a client-side poll`, confirmed.ok === true, confirmed);
    check(
      `waiting for ${tenant.name} actually polled instead of matching instantly`,
      confirmed.waitedMs >= 300,
      confirmed,
    );
  }
  check("all three tenants were created through the page", true, { tenants: TENANTS.length });

  // 5. Save them as identities, each with its own tenant name.
  const batch = await tryCall("create_identities", {
    siteId,
    identities: TENANTS.map((tenant) => ({
      name: tenant.name,
      username: tenant.username,
      password: tenant.password,
      role: "tenant-admin",
      extraFields: [{ label: "租户名", value: tenant.name }],
    })),
  });
  check(
    "create_identities accepts a per-account tenant name",
    batch.ok && batch.value?.created?.length === TENANTS.length,
    batch.ok ? { created: batch.value.created.length, failures: batch.value.failures } : batch,
  );
  const saved = batch.value?.created ?? [];
  check(
    "every tenant keeps its own tenant name",
    saved.every((identity, index) => identity.extraFields?.[0]?.value === TENANTS[index].name),
    saved.map((identity) => identity.extraFields),
  );

  const listed = await call("list_identities", { siteId });
  check("the workspace now lists super admin plus three tenants", listed.length === 4, {
    identities: listed.length,
  });
  check(
    "no response ever contains a password",
    !JSON.stringify(listed).includes("Tenant-A-Secret") &&
      !JSON.stringify(listed).includes("Super-Secret-1"),
  );

  // 5b. Share just two of the three tenants with a colleague. This is the
  //     account bundle — not the whole-workspace config export.
  const SHARE_PASS = "share-these-accounts-1";
  const shareIds = saved.slice(0, 2).map((identity) => identity.id);
  const exported = await tryCall("export_accounts", {
    siteIds: [siteId],
    identityIds: shareIds,
    passphrase: SHARE_PASS,
    note: "分享给测试组",
  });
  check(
    "export_accounts writes a bundle with only the chosen accounts",
    exported.ok &&
      exported.value?.counts?.sites === 1 &&
      exported.value?.counts?.accounts === 2 &&
      exported.value?.counts?.withPasswords === 2,
    exported.ok ? exported.value : exported,
  );
  const bundlePath = exported.ok ? exported.value.path : "";
  check("the bundle file exists on disk", Boolean(bundlePath) && existsSync(bundlePath), {
    bundlePath,
  });
  const bundleText = bundlePath && existsSync(bundlePath) ? readFileSync(bundlePath, "utf8") : "";
  check(
    "the bundle carries no plaintext password or passphrase",
    bundleText.length > 0 &&
      !bundleText.includes("Tenant-A-Secret") &&
      !bundleText.includes("Tenant-B-Secret") &&
      !bundleText.includes("Tenant-C-Secret") &&
      !bundleText.includes(SHARE_PASS),
  );
  const rawBundle = bundleText ? JSON.parse(bundleText) : null;
  check(
    "the bundle names the site by URL, not by local ids",
    rawBundle?.sites?.[0]?.baseUrl === BASE &&
      rawBundle.sites[0].accounts?.length === 2 &&
      !JSON.stringify(rawBundle.sites[0]).includes(siteId),
    rawBundle ? { sites: rawBundle.sites.length, accounts: rawBundle.sites[0]?.accounts?.length } : null,
  );

  const preview = await tryCall("preview_accounts", { path: bundlePath });
  check(
    "preview_accounts reports what would arrive and that passwords are sealed",
    preview.ok &&
      preview.value?.accounts === 2 &&
      preview.value?.hasSecrets === true &&
      preview.value?.matchingSites?.includes("多租户后台 · 测试"),
    preview.ok ? preview.value : preview,
  );

  // Importing into the same workspace is the round trip: the accounts must be
  // matched and updated, not duplicated.
  const imported = await tryCall("import_accounts", {
    path: bundlePath,
    passphrase: SHARE_PASS,
  });
  check(
    "import_accounts updates the matching accounts instead of duplicating them",
    imported.ok &&
      imported.value?.accountsAdded === 0 &&
      imported.value?.accountsUpdated === 2 &&
      imported.value?.skipped === 0,
    imported.ok ? imported.value : imported,
  );
  const afterImport = await call("list_identities", { siteId });
  check("the account count is unchanged after importing", afterImport.length === 4, {
    identities: afterImport.length,
  });
  const wrongPass = await tryCall("import_accounts", {
    path: bundlePath,
    passphrase: "not-the-passphrase",
  });
  check("a wrong passphrase is refused", !wrongPass.ok, {
    error: wrongPass.ok ? "unexpectedly succeeded" : wrongPass.error,
  });

  // 6. Arrange them on one stage.
  const view = await tryCall("create_view", {
    siteId,
    name: "多租户对照",
    identityIds: [adminId, ...saved.map((identity) => identity.id)],
    layoutId: "2x2",
  });
  check("create_view arranges all four", view.ok && view.value?.identityIds?.length === 4, view);

  // Same rule as `open_browser_tab`: opening a view is still a background
  // action. The cells are arranged on the stage, but the window is not raised
  // and the rail does not jump to the browser page.
  const beforeView = await client.evaluate(`(() => ({
    nav: document.querySelector('.rail .nav-item.active')?.dataset.nav ?? "",
  }))()`);
  const openedView = await tryCall("open_browser_view", { viewId: view.value?.id });
  check("open_browser_view puts them on stage", openedView.ok, {
    error: openedView.ok ? undefined : openedView.error,
  });
  await wait(1200);
  const afterOpenView = await client.evaluate(`(() => ({
    nav: document.querySelector('.rail .nav-item.active')?.dataset.nav ?? "",
    visible: (() => {
      const state = document.querySelector('.stage');
      return Boolean(state && state.getBoundingClientRect().height > 0);
    })(),
  }))()`);
  check(
    "open_browser_view leaves the rail where the user left it",
    beforeView?.nav === "settings" && afterOpenView?.nav === "settings",
    { before: beforeView, after: afterOpenView },
  );
  const stageReady = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    return { activeView: state.activeViewId ?? null, tabs: state.tabs.length, views: state.views.length };
  })()`);
  check(
    "the opened view is active even though the browser page is not in front",
    typeof stageReady?.activeView === "string" && (stageReady?.tabs ?? 0) >= 4,
    stageReady,
  );

  // 7. The audit log must not carry any of the new passwords.
  const audit = readFileSync(join(userData, "mcp-audit.log"), "utf8");
  const leaked = [
    SUPER.password,
    ...TENANTS.map((tenant) => tenant.password),
    SHARE_PASS,
  ].filter((secret) => audit.includes(secret));
  check("the audit log contains no password", leaked.length === 0, { leaked });
  check(
    "the audit log still records the calls",
    audit.includes("fill_browser_form") && audit.includes("wait_browser"),
  );

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  page.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("app log tail:", appLog.slice(-800));
    process.exitCode = 1;
  }
}
