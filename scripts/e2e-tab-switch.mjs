#!/usr/bin/env node
/**
 * Switching pages actually switches what is on screen.
 *
 * Reported: "+" opened a new tab, the strip highlighted it and the address bar
 * emptied, but the stage kept showing the previous page. State moved, pixels did
 * not.
 *
 * The cause was that the layout pass only ever *painted* the pages it staged
 * that round; nothing cleared the previous page's rect. So the old page still
 * reported a full-stage box, still counted as "on stage", and the renderer kept
 * it visible — it was in fact still the topmost thing on screen.
 *
 * The assertions therefore look at `bounds`, not at `activeTabId`: the state was
 * always correct, which is exactly why this was easy to miss.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-tabswitch-"));
const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>旧页面</title></head>
<body style="margin:0;background:#1d6f42;color:#fff;font:16px system-ui;padding:24px">旧页面</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [
      { id: uuid(2), name: "管理员 · 主账号", username: "admin", role: "admin", color: "amber" },
    ],
    views: [],
    flows: [],
    bookmarks: [],
    bookmarkFolders: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", onboardingVersion: 1 }),
);

const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(electron, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (c) => (appLog += c));
app.stderr.on("data", (c) => (appLog += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
  if (!ok && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message.result);
    }
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

/** Whether a bounds rect describes a placed page rather than "no placement". */
const placed = (bounds) => Boolean(bounds && bounds.width > 0 && bounds.height > 0);

try {
  let target;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) => item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      /* starting */
    }
  }
  if (!target) throw new Error(`no renderer\n${appLog.slice(-800)}`);
  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3400);

  // A real page on the stage, in the flat list — the state in the report.
  const first = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const tab = await api.openEmbeddedTab({ url: ${JSON.stringify(`http://127.0.0.1:${PAGE_PORT}/`)} });
    return { id: tab.id };
  })()`);
  await wait(2200);

  const beforeSwitch = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === ${JSON.stringify(first.id)});
    return { activeTabId: state.activeTabId, bounds: tab?.bounds ?? null };
  })()`);
  check(
    "the first page is on stage",
    placed(beforeSwitch?.bounds) && beforeSwitch?.activeTabId === first.id,
    beforeSwitch,
  );

  // --- The reported gesture: "+" opens a new tab ---------------------------
  const afterSwitch = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const fresh = await api.openEmbeddedTab({});
    await new Promise((r) => setTimeout(r, 1200));
    const state = await api.getEmbeddedState();
    const old = state.tabs.find((item) => item.id === ${JSON.stringify(first.id)});
    const now = state.tabs.find((item) => item.id === fresh.id);
    return {
      newTabId: fresh.id,
      activeTabId: state.activeTabId ?? null,
      oldBounds: old?.bounds ?? null,
      newBounds: now?.bounds ?? null,
      oldActive: old?.active ?? null,
      newActive: now?.active ?? null,
      // The renderer's own view of the nodes, which is what the user sees.
      nodes: [...document.querySelectorAll('webview')].map((node) => ({
        tabId: node.dataset.tabId,
        left: node.style.left,
        opacity: node.style.opacity,
        width: node.style.width,
      })),
    };
  })()`);

  check(
    "the new tab is the active one",
    afterSwitch?.activeTabId === afterSwitch?.newTabId && afterSwitch?.newActive === true,
    afterSwitch,
  );
  // The heart of the bug: the page that is no longer shown must stop claiming a
  // full-stage rect. It is `bounds` and not `activeTabId` that decides whether a
  // screenshot is taken from the compositor, whether `viewIsOnScreen` says yes,
  // and what the renderer is told to paint — so a stale rect here is a page that
  // keeps painting while the state says it is gone.
  check(
    "the previous page gives up its full-stage rect",
    !placed(afterSwitch?.oldBounds),
    { oldBounds: afterSwitch?.oldBounds },
  );
  // A second, independent path: the renderer hides a node from the store's
  // `isOnStage`, which reads `activeTabId` and ignores bounds. That is why this
  // one passed even with the bug present — it covers the pointer/visibility half
  // of the handover, not the geometry half.
  check(
    "the previous page stops being painted on the stage",
    (afterSwitch?.nodes ?? [])
      .filter((node) => node.tabId === first.id)
      .every((node) => node.opacity === "0" || node.left.startsWith("-")),
    afterSwitch?.nodes,
  );

  // --- The reverse direction, so the fix is not one-way --------------------
  const backAgain = await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.activateEmbeddedTab(${JSON.stringify(first.id)});
    await new Promise((r) => setTimeout(r, 1200));
    const state = await api.getEmbeddedState();
    const old = state.tabs.find((item) => item.id === ${JSON.stringify(first.id)});
    const fresh = state.tabs.find((item) => item.id === ${JSON.stringify(afterSwitch?.newTabId ?? "")});
    return {
      activeTabId: state.activeTabId ?? null,
      oldBounds: old?.bounds ?? null,
      newBounds: fresh?.bounds ?? null,
      nodes: [...document.querySelectorAll('webview')].map((node) => ({
        tabId: node.dataset.tabId,
        left: node.style.left,
        opacity: node.style.opacity,
      })),
    };
  })()`);
  check(
    "switching back puts the first page on stage again",
    placed(backAgain?.oldBounds) &&
      (backAgain?.nodes ?? [])
        .filter((node) => node.tabId === first.id)
        .every((node) => node.opacity === "1" && !node.left.startsWith("-")),
    backAgain,
  );
  // A blank page has no node and no rect (the app draws its own surface), so
  // "no bounds" is correct for it rather than a regression.
  check(
    "the blank tab gives up its rect when it is no longer shown",
    !placed(backAgain?.newBounds),
    { newBounds: backAgain?.newBounds },
  );

  client.close();
} catch (error) {
  check("the suite ran to completion", false, String(error));
  console.error(appLog.slice(-1200));
} finally {
  app.kill();
  page.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n[tab-switch] ${passed}/${results.length} assertions passed`);
process.exit(passed === results.length ? 0 : 1);
