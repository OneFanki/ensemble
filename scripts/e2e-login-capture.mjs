#!/usr/bin/env node
/**
 * End-to-end check of login capture on the built-in surface.
 *
 * The contract under test: a login typed by hand in an embedded page produces a
 * prompt that carries a token and the username but never the password, and
 * accepting it creates the account with that password in the vault.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 9733;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-capture-"));
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录页</title></head>
<body>
<form id="f" action="/console" method="get">
  <label>账号 <input id="user" name="user" type="text" /></label>
  <label>密码 <input id="pass" name="pass" type="password" /></label>
  <button id="submit" type="submit">登录</button>
</form>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/login`;

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "捕获站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
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

const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${9823}`],
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

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch("http://127.0.0.1:9823/json/list")).json();
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

  // Listen before the page types anything, so the event cannot be missed.
  await client.evaluate(`(() => {
    window.__captures = [];
    window.ensemble.onLoginCaptured((notice) => window.__captures.push(notice));
    return true;
  })()`);

  const opened = await client.evaluate(`(async () => {
    const before = (await window.ensemble.getEmbeddedState()).tabs.length;
    const tab = await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await window.ensemble.getEmbeddedState();
    const page = after.tabs.find((item) => item.id === tab.id);
    return {
      id: tab.id,
      // Relative: launch leaves one blank page, which is not the subject here.
      added: after.tabs.length - before,
      url: page?.url ?? "",
      inInstance: Boolean(page?.instanceId),
    };
  })()`);
  check(
    "login page opened in an embedded tab",
    Boolean(opened?.id) &&
      opened?.added === 1 &&
      String(opened?.url).startsWith("http://127.0.0.1"),
    opened,
  );

  // Type into the real page through CDP input events, then submit the form.
  const typed = await client.evaluate(`(async () => {
    const tabId = ${JSON.stringify(opened?.id ?? "")};
    const setValue = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    return Boolean(tabId);
  })()`);
  check("renderer can address the tab", typed === true, typed);

  // The embedded page is a separate target; drive it directly over CDP.
  const list = await (await fetch("http://127.0.0.1:9823/json/list")).json();
  const loginTarget = list.find((item) => item.url.startsWith(PAGE_URL));
  check("login page is a CDP target", Boolean(loginTarget), loginTarget?.url);

  if (loginTarget) {
    const pageClient = await connect(loginTarget.webSocketDebuggerUrl);
    await pageClient.evaluate(`(() => {
      const user = document.querySelector('#user');
      const pass = document.querySelector('#pass');
      user.value = 'admin@example.test';
      pass.value = 'secret-from-form';
      user.dispatchEvent(new Event('input', { bubbles: true }));
      pass.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await wait(300);
    await pageClient.evaluate(`(() => {
      document.querySelector('#f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await wait(900);
    pageClient.close();
  }

  const captured = await client.evaluate(`(async () => {
    const list = window.__captures ?? [];
    const notice = list[0];
    return {
      count: list.length,
      notice: notice ?? null,
      hasPassword: notice ? Object.prototype.hasOwnProperty.call(notice, 'password') : null,
      keys: notice ? Object.keys(notice) : [],
    };
  })()`);
  check("submitting the form produces one capture", captured?.count === 1, captured);
  check(
    "the capture carries a token and username but no password",
    Boolean(captured?.notice?.token) &&
      captured?.notice?.username === "admin@example.test" &&
      captured?.hasPassword === false,
    captured,
  );
  check(
    "the capture is matched to the site by origin",
    captured?.notice?.siteId === siteId,
    captured?.notice,
  );

  const saved = await client.evaluate(`(async () => {
    const notice = (window.__captures ?? [])[0];
    if (!notice) return { error: 'no notice' };
    const snapshot = await window.ensemble.saveIdentity({
      siteId: notice.siteId,
      name: '管理员 · 捕获',
      username: notice.username,
      role: 'admin',
      color: 'amber',
      passwordMode: 'custom',
      startPath: '/',
      captureToken: notice.token,
    });
    const saved = snapshot.identities[0];
    return {
      identities: snapshot.identities.length,
      username: saved?.username,
      passwordSet: snapshot.credentials.identity[saved?.id ?? ''] ?? false,
    };
  })()`);
  check(
    "accepting the capture creates one account",
    saved?.identities === 1 && saved?.username === "admin@example.test",
    saved,
  );
  check("the captured password is written to the vault", saved?.passwordSet === true, saved);

  const reused = await client.evaluate(`(async () => {
    const notice = (window.__captures ?? [])[0];
    if (!notice) return { error: 'no notice' };
    let rejected = false;
    try {
      await window.ensemble.saveIdentity({
        siteId: notice.siteId,
        name: '重复',
        username: 'other@example.test',
        role: 'member',
        color: 'teal',
        passwordMode: 'custom',
        captureToken: notice.token,
      });
    } catch {
      rejected = true;
    }
    return { rejected };
  })()`);
  check("a capture token cannot be used twice", reused?.rejected === true, reused);

  // Signing in as an account the vault already stores must not offer to save a
  // duplicate: that is the normal "open the tab and log in" path, not a capture.
  const known = await client.evaluate(`(async () => {
    await window.ensemble.saveIdentity({
      siteId: ${JSON.stringify(siteId)},
      name: '已保存账号',
      username: 'known@example.test',
      role: 'member',
      color: 'teal',
      passwordMode: 'custom',
      password: 'known-secret',
      startPath: '/',
    });
    return (await window.ensemble.getWorkspace()).identities.length;
  })()`);
  check("a saved account exists before the second login", known === 2, { identities: known });

  const list2 = await (await fetch("http://127.0.0.1:9823/json/list")).json();
  const loginTarget2 = list2.find((item) => item.url.startsWith(PAGE_URL));
  if (loginTarget2) {
    const pageClient = await connect(loginTarget2.webSocketDebuggerUrl);
    await pageClient.evaluate(`(() => {
      const user = document.querySelector('#user');
      const pass = document.querySelector('#pass');
      user.value = 'known@example.test';
      pass.value = 'known-secret';
      user.dispatchEvent(new Event('input', { bubbles: true }));
      pass.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await wait(900);
    pageClient.close();
  }

  const afterKnown = await client.evaluate(`(window.__captures ?? []).length`);
  check("logging in as an already-saved account produces no prompt", afterKnown === 1, {
    captures: afterKnown,
  });

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
