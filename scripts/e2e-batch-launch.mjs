#!/usr/bin/env node
/**
 * End-to-end check of batch launch and the auto-login routine.
 *
 * Two contracts are exercised against one mock site:
 *
 * 1. Batch launch lands pages on the accounts' start paths — the renderer only
 *    passes `identityId`, so `IPC.embeddedOpen` derives the URL itself.
 * 2. With a check path configured, the launch pipeline signs the account in by
 *    itself: probe says signed out → navigate to the login page → fill → submit
 *    (the site's `autoSubmit`) → wait for the session → navigate back to the
 *    start path. A second launch of the same account must confirm the session
 *    and go straight to the start path without visiting the login page again.
 * 3. A batch whose default layout is Free (无布局) still creates every page and
 *    leaves them unpinned in the view off stage — the old renderer loop died on
 *    a stale slot count with "槽位不存在".
 * 4. An envelope-style check endpoint (200 even signed out, verdict in the
 *    body) signs in via the site's `authCheckSignedOut` marker.
 *
 * The mock server counts GET /login hits, which is what makes "did not detour
 * through the login page" observable instead of assumed.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 9672;
const MCP_PORT = 49783;
const DEBUG_PORT = 9791;
const TOKEN = "e2e-batch-launch-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-batch-"));

let loginGets = 0;
const requestLog = [];
const page = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PAGE_PORT}`);
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .filter(Boolean)
      .map((item) => {
        const split = item.indexOf("=");
        return [item.slice(0, split).trim(), item.slice(split + 1).trim()];
      }),
  );
  const signedIn = cookies.session === "e2e-session";
  requestLog.push(`${req.method} ${url.pathname} session=${signedIn ? "y" : "n"}`);

  if (url.pathname === "/api/session") {
    res.writeHead(signedIn ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ signedIn }));
    return;
  }
  // Envelope-style session endpoint: like many API backends it answers 200 even
  // when signed out and puts the verdict in the body. Only a body marker can
  // tell the two apart.
  if (url.pathname === "/api/session-envelope") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(signedIn ? JSON.stringify({ status: 0, signedIn: true }) : JSON.stringify({ status: 2014, msg: "mock请先登录" }));
    return;
  }
  if (url.pathname === "/login") {
    if (req.method === "POST") {
      // Any credentials are accepted: the test cares about the pipeline, not
      // the backend. The cookie is what later probes and pages see.
      req.resume();
      res.writeHead(302, {
        "set-cookie": "session=e2e-session; Path=/",
        location: "/community",
      });
      res.end();
      return;
    }
    loginGets += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>/login · 未登录</title></head>
<body><form method="post" action="/login">
<label for="username">账号</label><input id="username" name="username">
<label for="password">密码</label><input id="password" name="password" type="password">
<button type="submit">登录</button>
</form></body></html>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${url.pathname} · ${signedIn ? "已登录" : "未登录"}</title></head>
<body><h1>${url.pathname}</h1></body></html>`);
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

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [join(process.cwd(), "out", "main", "index.js"), `--remote-debugging-port=${DEBUG_PORT}`],
  {
    env: { ...process.env, ENSEMBLE_USER_DATA: userData, ENSEMBLE_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
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
  const result = json.result;
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "failed"}`);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
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

let client;

/** Polls a boolean expression so a slow first paint cannot fail a check. */
async function waitFor(client, expression, timeout = 40_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(250);
  }
  return false;
}

/**
 * Batch launch through the one main-process IPC that owns the whole run.
 * Returns the tab ids in account order, scoped to the view the call created
 * (identityId alone is ambiguous once earlier batches are still open).
 */
async function batchLaunch(client, siteId, accounts) {
  return client.evaluate(`(async () => {
    const state = await window.ensemble.launchEmbeddedIdentities(
      ${JSON.stringify(accounts.map((account) => account.identityId))},
    );
    const viewId = state.activeViewId;
    const wanted = ${JSON.stringify(accounts.map((account) => account.identityId))};
    return wanted.map(
      (identityId) =>
        state.tabs.find((tab) => tab.viewId === viewId && tab.identityId === identityId)?.id,
    );
  })()`);
}

function tabInfoExpression(tabIds) {
  return `async () => {
    const state = await window.ensemble.getEmbeddedState();
    return ${JSON.stringify(tabIds)}.map((id) => {
      const tab = state.tabs.find((t) => t.id === id);
      return tab ? { url: tab.url, title: tab.title, loading: tab.loading } : null;
    });
  }`;
}

try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const site = await call("create_site", {
    name: "批量启动站点",
    baseUrl: PAGE_URL,
    loginPath: "/login",
    authCheckPath: "/api/session",
    autoSubmit: true,
    // Both identities inherit this one: the pipeline reads it from the vault.
    password: "e2e-site-password",
  });
  const alpha = await call("create_identity", {
    siteId: site.id,
    name: "账号甲",
    username: "user-alpha",
    role: "成员",
    color: "amber",
    passwordMode: "inherit",
    startPath: "/alpha",
  });
  const beta = await call("create_identity", {
    siteId: site.id,
    name: "账号乙",
    username: "user-beta",
    role: "成员",
    color: "teal",
    passwordMode: "inherit",
    startPath: "/beta",
  });
  check("site and two identities created", Boolean(site?.id && alpha?.id && beta?.id));

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
  client = await connect(target.webSocketDebuggerUrl);
  await wait(2000);

  // --- First launch: signed out, the pipeline signs both accounts in. ---
  const tabs = await batchLaunch(client, site.id, [
    { identityId: alpha.id, label: "账号甲" },
    { identityId: beta.id, label: "账号乙" },
  ]);
  check("batch created two pages", tabs?.length === 2, tabs);

  const settled = await waitFor(
    client,
    `(async () => {
      const infos = await (${tabInfoExpression(tabs)})();
      return (
        infos[0]?.url === "${PAGE_URL}alpha" &&
        infos[1]?.url === "${PAGE_URL}beta" &&
        infos[0]?.title.includes("已登录") &&
        infos[1]?.title.includes("已登录")
      );
    })()`,
  ).then(async (ok) => {
    const infos = await client.evaluate(`(${tabInfoExpression(tabs)})()`);
    if (!ok) {
      console.log("request log:", requestLog.join(" | "));
      console.log(
        "auto-login debug:\n",
        appLog
          .split("\n")
          .filter((line) => line.includes("auto-login-debug") || line.includes("auth-probe-debug"))
          .join("\n"),
      );
    }
    return infos;
  });
  check(
    "batch pages land signed in on their start paths",
    settled?.[0]?.url === `${PAGE_URL}alpha` &&
      settled?.[0]?.title.includes("已登录") &&
      settled?.[1]?.url === `${PAGE_URL}beta` &&
      settled?.[1]?.title.includes("已登录"),
    settled,
  );

  // --- Second launch of the same accounts: sessions persist in the partitions,
  // so the pipeline must confirm them and never touch the login page again. ---
  const loginsBeforeRelaunch = loginGets;
  for (const tabId of tabs) {
    await client.evaluate(`window.ensemble.closeEmbeddedTab(${JSON.stringify(tabId)})`);
  }
  await wait(800);
  const relaunched = await batchLaunch(client, site.id, [
    { identityId: alpha.id, label: "账号甲" },
    { identityId: beta.id, label: "账号乙" },
  ]);
  const quiet = await waitFor(
    client,
    `(async () => {
      const infos = await (${tabInfoExpression(relaunched)})();
      return (
        infos[0]?.url === "${PAGE_URL}alpha" &&
        infos[1]?.url === "${PAGE_URL}beta" &&
        infos[0]?.title.includes("已登录") &&
        infos[1]?.title.includes("已登录")
      );
    })()`,
  ).then(() => loginGets === loginsBeforeRelaunch);
  check(
    "a signed-in relaunch never detours through the login page",
    quiet && loginGets === loginsBeforeRelaunch,
    { before: loginsBeforeRelaunch, after: loginGets },
  );

  // The toolbar "+" and the blank-tab callers pass no identity; a URL derived
  // from an account must not leak into them.
  const blank = await client.evaluate(`(async () => {
    const tab = await window.ensemble.openEmbeddedTab({});
    const state = await window.ensemble.getEmbeddedState();
    return state.tabs.find((t) => t.id === tab.id)?.url;
  })()`);
  check(
    "a tab without an identity is still blank",
    blank === "about:blank" || blank === "" || blank === undefined,
    blank,
  );

  // --- Batch under the Free layout (无布局): the old renderer loop threw
  // "槽位不存在" on stale slot counts and died halfway. The main-process batch
  // re-reads the slot table at pin time, so every page must still be created
  // and stay in the view off stage. ---
  await client.evaluate(
    `window.ensemble.saveAppSettings({ layout: "free" })`,
  );
  await wait(300);
  const freeTabs = await batchLaunch(client, site.id, [
    { identityId: alpha.id, label: "账号甲" },
    { identityId: beta.id, label: "账号乙" },
  ]);
  const freeState = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === state.activeViewId);
    return {
      layoutId: view?.layoutId,
      slotTabs: view?.slotTabs,
      inView: state.tabs.filter((tab) => tab.viewId === state.activeViewId).length,
    };
  })()`);
  check(
    "a batch under the Free layout still creates every page",
    freeTabs?.length === 2 && freeTabs.every(Boolean) && freeState?.inView === 2,
    { freeTabs, freeState },
  );
  // Free counts as ONE full-stage cell: the first page takes the stage, the
  // rest stay in the view off stage. The old loop died on exactly this layout
  // with "槽位不存在" once it tried to pin the second member.
  check(
    "Free-layout batch pins only the first page and throws nowhere",
    freeState?.layoutId === "free" &&
      Array.isArray(freeState?.slotTabs) &&
      freeState.slotTabs.length === 1 &&
      freeState.slotTabs[0] === freeTabs?.[0],
    freeState,
  );

  // --- Envelope-style auth check: the endpoint answers 200 even when signed
  // out and only the body marker tells the truth. The pipeline must read the
  // marker, sign the account in, and land it on its start path. ---
  const envelopeSite = await call("create_site", {
    name: "信封式登录站点",
    baseUrl: PAGE_URL,
    loginPath: "/login",
    authCheckPath: "/api/session-envelope",
    authCheckSignedOut: "mock请先登录",
    autoSubmit: true,
    password: "e2e-site-password",
  });
  const gamma = await call("create_identity", {
    siteId: envelopeSite.id,
    name: "账号丙",
    username: "user-gamma",
    role: "成员",
    color: "rose",
    passwordMode: "inherit",
    startPath: "/gamma",
  });
  const envelopeTab = await client.evaluate(`(async () => {
    const tab = await window.ensemble.openEmbeddedTab({
      identityId: ${JSON.stringify(gamma.id)},
      siteId: ${JSON.stringify(envelopeSite.id)},
      label: "账号丙",
    });
    return tab.id;
  })()`);
  const envelopeInfos = await waitFor(
    client,
    `(async () => {
      const infos = await (${tabInfoExpression([envelopeTab])})();
      return infos[0]?.url === "${PAGE_URL}gamma" && infos[0]?.title.includes("已登录");
    })()`,
  ).then(() => client.evaluate(`(${tabInfoExpression([envelopeTab])})()`));
  check(
    "a 200-envelope check endpoint signs in via the body marker",
    envelopeInfos?.[0]?.url === `${PAGE_URL}gamma` &&
      envelopeInfos?.[0]?.title.includes("已登录"),
    envelopeInfos,
  );
} catch (error) {
  check("run completed", false, String(error));
} finally {
  client?.close();
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
