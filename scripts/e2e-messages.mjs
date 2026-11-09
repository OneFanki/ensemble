#!/usr/bin/env node
/**
 * End-to-end check of the message centre.
 *
 * The contract under test: things that happen while nobody is looking end up in
 * one list that survives a restart, each row carrying what it can still do —
 * save the captured login, reopen an account that failed, jump to a page the AI
 * touched — and rows whose target is gone say so instead of pretending.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-messages-"));
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const page = createServer((req, res) => {
  if (req.url.startsWith("/console")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body>console</body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录页</title></head>
<body>
<form id="f" action="/console" method="get">
  <label>账号 <input id="user" type="text" /></label>
  <label>密码 <input id="pass" type="password" /></label>
  <button id="submit" type="submit">登录</button>
</form>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const BASE_URL = `http://127.0.0.1:${PAGE_PORT}`;

const now = new Date().toISOString();
const siteId = "22222222-2222-4222-8222-222222222222";
const identityId = "33333333-3333-4333-8333-333333333333";

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "消息站点",
        baseUrl: BASE_URL,
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [
      {
        id: identityId,
        siteId,
        name: "消息账号",
        username: "message@example.test",
        role: "member",
        color: "teal",
        passwordMode: "custom",
        startPath: "/",
        tagIds: [],
        status: "unknown",
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: 1, layout: "free", layoutExplicit: true }),
);

const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"],
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

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) => item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
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

  // 1) A login produces a history row with the capture as its action.
  await client.evaluate(`window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(`${BASE_URL}/login`)} })`);
  await wait(1_500);
  const pageTarget = (await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json()).find(
    (item) => item.url.startsWith(BASE_URL),
  );
  check("login page is a CDP target", Boolean(pageTarget));
  if (pageTarget) {
    const pageClient = await connect(pageTarget.webSocketDebuggerUrl);
    await pageClient.evaluate(`(() => {
      const set = (selector, value) => {
        const el = document.querySelector(selector);
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        descriptor.set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('#user', 'message@example.test');
      set('#pass', 'pw-message');
      return true;
    })()`);
    await wait(250);
    await pageClient.evaluate(`document.querySelector('#submit').click()`);
    await wait(900);
    pageClient.close();
  }

  const afterLogin = await client.evaluate(`window.ensemble.listMessages()`);
  const captureRow = (afterLogin ?? []).find((item) => item.kind === "login-capture");
  check(
    "a captured login is recorded in the history",
    Boolean(captureRow) &&
      captureRow.read === false &&
      captureRow.action?.type === "login-capture" &&
      captureRow.stale !== true,
    captureRow ?? afterLogin,
  );

  // 2) The two entry points agree on the unread count.
  await client.evaluate(`document.querySelector('.layout-btn')?.click()`);
  await wait(900);
  const entryPoints = await client.evaluate(`(() => ({
    navLabel: document.querySelector('[data-nav="messages"] .nav-label')?.textContent?.trim() ?? '',
    navCount: document.querySelector('[data-nav="messages"] .nav-count')?.textContent?.trim() ?? '',
    bell: Boolean(document.querySelector('[data-messages-bell]')),
    bellCount: document.querySelector('.bell-count')?.textContent?.trim() ?? '',
  }))()`);
  check(
    "the rail row and the toolbar bell both show the unread count",
    entryPoints?.navLabel === "消息" &&
      entryPoints?.navCount === "1" &&
      entryPoints?.bell === true &&
      entryPoints?.bellCount === "1",
    entryPoints,
  );

  // 3) The page renders the row with a working action.
  await client.evaluate(`document.querySelector('[data-nav="messages"]')?.click()`);
  await wait(600);
  const rendered = await client.evaluate(`(() => ({
    rows: document.querySelectorAll('[data-message-kind]').length,
    kinds: [...document.querySelectorAll('[data-message-kind]')].map((el) => el.dataset.messageKind),
    actions: document.querySelectorAll('[data-message-action]').length,
    titles: [...document.querySelectorAll('.row .title')].map((el) => el.textContent.trim()),
    filters: [...document.querySelectorAll('[data-message-filter]')].map((el) => el.dataset.messageFilter),
  }))()`);
  check(
    "the message page lists it as a usable row",
    rendered?.rows === 1 &&
      rendered?.kinds?.join(",") === "login-capture" &&
      rendered?.actions === 1 &&
      String(rendered?.titles?.[0]).includes("message@example.test") &&
      !String(rendered?.titles?.[0]).startsWith("app.") &&
      rendered?.filters?.length === 5,
    rendered,
  );

  // 4) Filtering by kind narrows the list without losing the row.
  await client.evaluate(`document.querySelector('[data-message-filter="ai"]')?.click()`);
  await wait(300);
  const filtered = await client.evaluate(`document.querySelectorAll('[data-message-kind]').length`);
  await client.evaluate(`document.querySelector('[data-message-filter="all"]')?.click()`);
  await wait(300);
  const unfiltered = await client.evaluate(`document.querySelectorAll('[data-message-kind]').length`);
  check("filtering by kind hides rows of other kinds", filtered === 0 && unfiltered === 1, {
    filtered,
    unfiltered,
  });

  // 5) Using the action marks the row read, which clears both badges.
  await client.evaluate(`document.querySelector('[data-message-action]')?.click()`);
  await wait(800);
  const afterAct = await client.evaluate(`(async () => {
    const list = await window.ensemble.listMessages();
    return {
      read: list.find((item) => item.kind === 'login-capture')?.read,
      unread: list.filter((item) => !item.read).length,
    };
  })()`);
  check("using a row marks it read", afterAct?.read === true && afterAct?.unread === 0, afterAct);

  // 6) History is on disk, so a later run can still read it.
  const stored = JSON.parse(readFileSync(join(userData, "messages.json"), "utf8"));
  check(
    "the history is written to disk",
    Array.isArray(stored.messages) && stored.messages.length >= 1,
    { count: stored.messages?.length ?? 0 },
  );

  // 7) A row whose capture is gone is reported as stale instead of offering it.
  await client.evaluate(`(async () => {
    // Drop the pending capture directly: the token only lives in this process,
    // which is exactly the situation after a restart.
    for (const item of await window.ensemble.pendingLogins()) {
      await window.ensemble.dismissLoginCapture(item.token);
    }
    return true;
  })()`);
  await wait(400);
  const stale = await client.evaluate(`(async () => {
    const list = await window.ensemble.listMessages();
    return list.find((item) => item.kind === 'login-capture') ?? null;
  })()`);
  check(
    "a row whose target disappeared reports itself as stale",
    stale?.stale === true,
    stale,
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
