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
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-autofill-"));

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
  process.exit(failed.length > 0 ? 1 : 0);
}
