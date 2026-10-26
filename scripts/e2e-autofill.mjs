#!/usr/bin/env node
/**
 * End-to-end check that every built-in launch path fills credentials.
 *
 * Reported bug: opening a saved view left the login form empty while clicking
 * a single account filled it. Both paths now go through `scheduleEmbeddedFill`,
 * and so does "open a site as one of its accounts" (the bookmark menu).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3986;
const DEBUG_PORT = 9791;
const SPA_PORT = 3985;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-autofill-"));

/**
 * A login page shaped like a modern single-page app: the button is
 * `type="button"` with a JS handler and the form has no submit listener.
 *
 * This is the shape that broke automatic sign-in. `requestSubmit()` on such a
 * page fires a submit event nobody listens to, so the fill reported success
 * while the page sat there — the user then had to click the button by hand.
 * `submitHits` counts what the page's own handler saw, which is what makes the
 * difference observable: the number only moves if the button was really clicked.
 */
let submitHits = 0;
const spa = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${SPA_PORT}`);
  if (url.pathname === "/api/hit") {
    // POST is the button's own signal; GET is the test reading the count. Keeping
    // them apart means the number only moves when the page's handler ran.
    if (req.method === "POST") submitHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ submitHits }));
    return;
  }
  if (url.pathname === "/done") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>已登录</title></head>
<body><p id="done">signed in</p></body></html>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>SPA 登录</title></head>
<body>
<form id="f">
  <label>账号 <input id="user" name="user" type="text" autocomplete="username" /></label>
  <label>密码 <input id="pass" name="pass" type="password" autocomplete="current-password" /></label>
  <!-- No type="submit": the page drives sign-in from its own click handler. -->
  <button id="go" type="button">登录</button>
  <button id="forgot" type="button">忘记密码</button>
</form>
<script>
  document.getElementById("go").addEventListener("click", () => {
    fetch("/api/hit", { method: "POST" }).then(() => { location.href = "/done"; });
  });
  document.getElementById("forgot").addEventListener("click", () => {
    document.title = "忘记密码";
  });
</script>
</body></html>`);
});

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head>
<body>
<form id="f" action="/console" method="get">
  <label>账号 <input id="user" name="user" type="text" autocomplete="username" /></label>
  <label>密码 <input id="pass" name="pass" type="password" autocomplete="current-password" /></label>
  <button type="submit">登录</button>
</form>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
await new Promise((done) => spa.listen(SPA_PORT, "127.0.0.1", done));

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const viewId = "22222222-2222-4222-8222-222222222222";
const ids = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

function identity(id, name, color) {
  return {
    id,
    siteId,
    name,
    // The username is the marker the checks look for in the page field.
    username: `${name}@example.test`,
    role: "member",
    color,
    passwordMode: "custom",
    status: "unknown",
    startPath: "/login",
    extraFields: [],
    createdAt: now,
    updatedAt: now,
  };
}

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "填充站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [identity(ids.a, "账号甲", "amber"), identity(ids.b, "账号乙", "teal")],
    views: [
      {
        id: viewId,
        siteId,
        name: "填充验证",
        identityIds: [ids.a],
        layoutId: "2x1",
        slotAssignments: { [ids.a]: 0 },
        paths: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "browser",
    onboardingVersion: 1,
    autoFillOnLaunch: true,
  }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

const LOGIN_URL = `http://127.0.0.1:${PAGE_PORT}/login`;

/** Reads the values the embedded login form actually holds. */
async function readLoginFields(timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const target = list.find((item) => item.url.startsWith(LOGIN_URL));
    if (target) {
      const client = await connect(target.webSocketDebuggerUrl);
      try {
        last = await client.evaluate(`(() => ({
          user: document.querySelector('#user')?.value ?? null,
          pass: document.querySelector('#pass')?.value ?? null,
          ready: document.readyState,
        }))()`);
        // Filling is asynchronous and retried; stop as soon as both fields hold
        // something, otherwise keep polling until the deadline.
        if (last?.user && last?.pass) return last;
      } finally {
        client.close();
      }
    }
    await wait(400);
  }
  return last;
}

try {
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
  await wait(3000);

  // Launch leaves one blank page. This suite counts the pages a view creates, so
  // it starts from an empty surface instead of carrying that page along.
  await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);

  // Give both accounts a password; the vault write happens through the same IPC
  // the account form uses, so this exercises the real resolution path.
  const seeded = await client.evaluate(`(async () => {
    for (const [id, password] of [['${ids.a}', 'pw-alpha'], ['${ids.b}', 'pw-bravo']]) {
      await window.ensemble.saveIdentity({
        id,
        siteId: '${siteId}',
        name: id === '${ids.a}' ? '账号甲' : '账号乙',
        username: id === '${ids.a}' ? '账号甲@example.test' : '账号乙@example.test',
        role: 'member',
        color: id === '${ids.a}' ? 'amber' : 'teal',
        passwordMode: 'custom',
        password,
        startPath: '/login',
      });
    }
    const snapshot = await window.ensemble.getWorkspace();
    return {
      passwords: Object.keys(snapshot.credentials.identity).filter(
        (id) => snapshot.credentials.identity[id],
      ).length,
    };
  })()`);
  check("both accounts have a stored password", seeded?.passwords === 2, seeded);

  // --- A saved view: every tab it creates must be filled -------------------
  const opened = await client.evaluate(`(async () => {
    const state = await window.ensemble.openEmbeddedView('${viewId}');
    return { tabs: state.tabs.length, activeView: state.activeViewId ?? null };
  })()`);
  check("the view opens one page", opened?.tabs === 1, opened);

  const viewFields = await readLoginFields();
  check(
    "launching a view fills the account and password",
    viewFields?.user === "账号甲@example.test" && viewFields?.pass === "pw-alpha",
    viewFields,
  );

  // --- Single account click ------------------------------------------------
  const closed = await client.evaluate(`(async () => {
    const state = await window.ensemble.closeEmbeddedView('${opened?.activeView ?? ""}', 'all');
    await window.ensemble.activateEmbeddedView(null);
    return { tabs: state.tabs.length };
  })()`);
  check("the view closes for a clean single-account check", closed?.tabs === 0, closed);

  await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedIdentity('${ids.b}');
    return true;
  })()`);
  const singleFields = await readLoginFields();
  check(
    "clicking an account fills it too",
    singleFields?.user === "账号乙@example.test" && singleFields?.pass === "pw-bravo",
    singleFields,
  );

  // --- Site bookmark opened as an account ---------------------------------
  const state = await client.evaluate(`(async () => {
    const next = await window.ensemble.getEmbeddedState();
    for (const tab of next.tabs) await window.ensemble.closeEmbeddedTab(tab.id);
    await window.ensemble.openEmbeddedTab({
      url: ${JSON.stringify(LOGIN_URL)},
      identityId: '${ids.a}',
      siteId: '${siteId}',
      label: '账号甲',
      viewId: null,
    });
    const after = await window.ensemble.getEmbeddedState();
    return { tabs: after.tabs.length };
  })()`);
  check("the site bookmark opens one page", state?.tabs === 1, state);

  const bookmarkFields = await readLoginFields();
  check(
    "opening a site as one of its accounts fills that account",
    bookmarkFields?.user === "账号甲@example.test" && bookmarkFields?.pass === "pw-alpha",
    bookmarkFields,
  );

  // --- A single-page login form: the button must actually be clicked -------
  // This is the shape that made "it fills but I still have to press login"
  // happen: no submit listener on the form, the button is `type="button"`.
  // `submitHits` only moves when the page's own click handler runs, so a
  // requestSubmit()-based implementation cannot pass this.
  const spaSite = await client.evaluate(`(async () => {
    const snap = await window.ensemble.getWorkspace();
    // Turn auto-submit on through the global setting, which is also what a
    // fresh install gets: this check is about the click, not about the switch.
    await window.ensemble.saveSettings({ autoSubmitLogin: true });
    const site = await window.ensemble.saveSite({
      name: 'SPA 登录站点',
      baseUrl: '${`http://127.0.0.1:${SPA_PORT}`}',
      loginPath: '/login',
      autoSubmit: undefined,
    });
    const identity = await window.ensemble.saveIdentity({
      siteId: site.sites.find((item) => item.name === 'SPA 登录站点').id,
      name: 'SPA 账号',
      username: 'spa@example.test',
      role: 'member',
      color: 'blue',
      passwordMode: 'custom',
      password: 'pw-spa',
      startPath: '/login',
    });
    const saved = site.sites.find((item) => item.name === 'SPA 登录站点');
    const identityId = identity.identities.find((item) => item.name === 'SPA 账号').id;
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    await window.ensemble.openEmbeddedIdentity(identityId);
    await new Promise((r) => setTimeout(r, 6000));
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    return { siteId: saved.id, identityId, url: tab?.url ?? '', title: tab?.title ?? '' };
  })()`);

  let spaProbe = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const info = await (await fetch(`http://127.0.0.1:${SPA_PORT}/api/hit`)).json();
    if (info.submitHits > 0) {
      spaProbe = info;
      break;
    }
    await wait(400);
  }
  check(
    "an SPA login form is submitted by clicking its button, not by requestSubmit",
    spaProbe?.submitHits === 1 && String(spaSite?.url).includes("/done"),
    { spaSite, spaProbe },
  );
  // The "forgot password" affordance sits in the same form and must never be the
  // element that gets clicked.
  check(
    "the wrong button is not the one that gets pressed",
    String(spaSite?.title).includes("已登录") || String(spaSite?.url).includes("/done"),
    spaSite,
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
  spa.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
