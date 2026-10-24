#!/usr/bin/env node
/**
 * End-to-end check of the per-origin AI permission in the daily profile.
 *
 * The claim: an AI client connected to the real endpoint can read a page the
 * user is signed in to, but cannot click or type there until the user allows the
 * origin — and can always operate an identity page, because that is the product.
 *
 * Five things have to hold, and each is a separate assertion:
 *
 * 1. A daily-profile page refuses every input tool, and the refusal is a decision
 *    (the page's own click counter never moves).
 * 2. Reading and screenshotting the same page still works.
 * 3. An identity page is operable without any grant.
 * 4. Granting the origin through the toolbar switch makes the daily page
 *    operable; revoking it closes the door again.
 * 5. An identity-less tab the AI opens itself lands in a clean session, not in
 *    the user's profile.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3991;
const MCP_PORT = 49791;
const DEBUG_PORT = 9791;
const TOKEN = "e2e-ai-policy-token-123456";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-ai-policy-"));

/**
 * A page that records how many times its button was clicked.
 *
 * The click counter is the falsifiable half: a refusal that still delivered the
 * click would show up here, and no amount of error text would hide it.
 */
const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>运营后台</title></head>
<body>
<h1>运营后台</h1>
<p id="hits">0</p>
<button id="publish" type="button" onclick="
  const el = document.getElementById('hits');
  el.textContent = String(Number(el.textContent) + 1);
">投放</button>
<label>备注 <input id="note" name="note" type="text" /></label>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/ops`;
const ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

const now = new Date().toISOString();
const siteId = uuid(1);
const identityId = uuid(2);

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "运营后台",
        baseUrl: ORIGIN,
        loginPath: "/ops",
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
        name: "运营账号",
        username: "ops@example.test",
        role: "运营",
        color: "teal",
        passwordMode: "inherit",
        status: "unknown",
        startPath: "/ops",
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
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
    aiOrigins: [],
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

/** One MCP call; returns the parsed payload plus whether it was refused. */
async function call(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  const text = json.result?.content?.[0]?.text ?? "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { isError: Boolean(json.result?.isError), payload, text };
}

async function waitForMcp() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // still starting
    }
    await wait(400);
  }
  return false;
}

async function connectRenderer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const target = list.find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools"),
      );
      if (target) return connect(target.webSocketDebuggerUrl);
    } catch {
      // the window has not opened its debugging port yet
    }
  }
  return undefined;
}

try {
  const ready = await waitForMcp();
  check("app started", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP endpoint never came up");

  const client = await connectRenderer();
  check("renderer reachable", Boolean(client));

  /** Reads the click counter inside the embedded page itself. */
  async function hits(tabId) {
    const pageClient = await findPageTarget();
    if (!pageClient) return -1;
    const value = await pageClient.evaluate(
      `Number(document.getElementById('hits')?.textContent ?? -1)`,
    );
    pageClient.close();
    return Number(value);
  }

  async function findPageTarget() {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const target = list.find(
      (item) => item.type === "page" && item.url.startsWith(`${ORIGIN}/`),
    );
    return target ? connect(target.webSocketDebuggerUrl) : undefined;
  }

  // --- A daily-profile page, opened the way a person opens one ---
  const daily = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} });
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.url.includes('/ops') && !item.clean);
    return tab ? { id: tab.id, clean: tab.clean ?? false } : null;
  })()`);
  check("a bookmark-style open lands in the daily profile", Boolean(daily?.id) && !daily?.clean, daily);
  const dailyTabId = daily?.id ?? "";

  const beforeRead = await hits(dailyTabId);
  check("the page is loaded and its counter readable", beforeRead === 0, { beforeRead });

  const clickDenied = await call("click_browser_element", { tabId: dailyTabId, text: "投放" });
  check(
    "clicking a daily-profile page is refused",
    clickDenied.isError && clickDenied.text.includes("只读"),
    clickDenied.text.slice(0, 120),
  );

  const typeDenied = await call("type_browser_text", {
    tabId: dailyTabId,
    label: "备注",
    text: "hello",
  });
  check(
    "typing into a daily-profile page is refused",
    typeDenied.isError && typeDenied.text.includes("只读"),
    typeDenied.text.slice(0, 120),
  );

  await wait(300);
  const afterDenied = await hits(dailyTabId);
  check(
    "the refusal never reached the page",
    afterDenied === beforeRead,
    { beforeRead, afterDenied },
  );

  const readOk = await call("read_browser_page", { tabId: dailyTabId });
  check(
    "reading a daily-profile page still works",
    !readOk.isError && Array.isArray(readOk.payload?.nodes),
    readOk.isError ? readOk.text.slice(0, 120) : { nodes: readOk.payload?.nodes?.length },
  );

  const shotOk = await call("screenshot_browser_tab", { tabId: dailyTabId });
  check(
    "screenshotting a daily-profile page still works",
    !shotOk.isError && Boolean(shotOk.payload?.path),
    shotOk.isError ? shotOk.text.slice(0, 120) : shotOk.payload,
  );

  // --- An identity page: operable with no grant ---
  const identityTab = await call("open_browser_tab", { identityId, url: PAGE_URL });
  check("an identity tab opens", !identityTab.isError, identityTab.text.slice(0, 120));
  const identityTabId = identityTab.payload?.id ?? "";
  await wait(1200);
  const identityClick = await call("click_browser_element", {
    tabId: identityTabId,
    text: "投放",
  });
  check(
    "an identity page can be operated without any grant",
    !identityClick.isError,
    identityClick.isError ? identityClick.text.slice(0, 160) : undefined,
  );

  // --- The AI's own identity-less tab is a clean session ---
  const scratch = await call("open_browser_tab", { url: PAGE_URL });
  check("an AI-opened identity-less tab", !scratch.isError, scratch.text.slice(0, 120));
  const scratchId = scratch.payload?.id ?? "";
  await wait(1200);
  const scratchClick = await call("click_browser_element", { tabId: scratchId, text: "投放" });
  check(
    "an AI-opened identity-less tab is its own clean session, not the daily profile",
    !scratchClick.isError,
    scratchClick.isError ? scratchClick.text.slice(0, 160) : undefined,
  );

  // --- The toolbar switch grants and revokes ---
  // Navigate the existing daily tab to the origin, then drive the real button.
  await client.evaluate(
    `window.ensemble.activateEmbeddedTab(${JSON.stringify(dailyTabId)})`,
  );
  const switchVisible = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // The data attribute, not "any pressed icon": the bookmark star is also a
      // pressed toggle and would be clicked instead.
      const button = document.querySelector('[data-ai-origin-switch]');
      if (button) return { found: true, pressed: button.getAttribute('aria-pressed') };
      await wait(300);
    }
    return { found: false };
  })()`);
  check(
    "the AI permission switch appears for a daily-profile page",
    switchVisible?.found === true && switchVisible?.pressed === "false",
    switchVisible,
  );

  const granted = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    document.querySelector('[data-ai-origin-switch]')?.click();
    await wait(900);
    const status = await window.ensemble.mcpStatus();
    return {
      pressed: document.querySelector('[data-ai-origin-switch]')?.getAttribute('aria-pressed'),
      origins: status.aiOrigins,
    };
  })()`);
  check(
    "the switch grants the page's origin",
    granted?.origins?.includes(ORIGIN) && granted?.pressed === "true",
    granted,
  );

  const afterGrant = await call("click_browser_element", { tabId: dailyTabId, text: "投放" });
  check(
    "a granted origin can be operated",
    !afterGrant.isError,
    afterGrant.isError ? afterGrant.text.slice(0, 160) : undefined,
  );
  await wait(300);
  const hitsAfterGrant = await hits(dailyTabId);
  check(
    "the granted click really reached the page",
    hitsAfterGrant === beforeRead + 1,
    { beforeRead, hitsAfterGrant },
  );

  await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    document.querySelector('[data-ai-origin-switch]')?.click();
    await wait(900);
    return true;
  })()`);
  const revoked = await call("click_browser_element", { tabId: dailyTabId, text: "投放" });
  check(
    "revoking the origin closes the door again",
    revoked.isError && revoked.text.includes("只读"),
    revoked.text.slice(0, 120),
  );

  // --- The audit log names the origin, not just the tool ---
  const audit = readFileSync(join(userData, "mcp-audit.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  const clickLines = audit.filter((line) => line.tool === "click_browser_element");
  check(
    "the audit log records the origin of each AI action",
    clickLines.length > 0 && clickLines.every((line) => line.origin === ORIGIN),
    clickLines.map((line) => ({ origin: line.origin, ok: line.ok })),
  );
  check(
    "the audit log records the refused attempt as refused",
    clickLines.some((line) => line.ok === false && String(line.error ?? "").includes("只读")),
    clickLines.map((line) => line.ok),
  );

  // --- The dock reports the count, so the user sees it without the log ---
  const badge = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const el = document.querySelector('.dock .ai-badge');
      if (el) return { found: true, text: el.textContent.trim(), title: el.getAttribute('title') };
      await wait(300);
    }
    return { found: false };
  })()`);
  check(
    "the dock shows how many AI actions this site has seen",
    badge?.found === true && Number(badge?.text) >= 3,
    badge,
  );

  client?.close();
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
