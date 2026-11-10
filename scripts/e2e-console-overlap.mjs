#!/usr/bin/env node
/**
 * End-to-end check that the console never shares pixels with a live page.
 *
 * Reported bug: with a page loaded, opening Settings made the page and the panel
 * flicker over each other. The page is a real compositing surface, the console is
 * ordinary in-flow HTML, so whichever one is drawn second wins — and for a frame
 * that was decided by event ordering rather than by intent.
 *
 * Two things are asserted, and they cover the two different failure modes:
 *
 * 1. **Structural** — the console's layer is above the page pool's, so no future
 *    ordering mistake can put a page in front of it.
 * 2. **Timing** — by the time the click handler returns, every page is already
 *    parked. Checking in the same task as the click is the point: the bug was one
 *    frame of lag, and any assertion that waits for a frame would pass on the
 *    broken build too (measured — the DOM is already settled by the first frame).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-console-"));

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>面板覆盖测试</title></head>
<body style="margin:0;background:#eef2f7"><h1 style="margin:0;background:#2563eb;color:#fff;padding:14px">占位页面</h1></body></html>`,
  );
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: uuid(1),
        name: "覆盖测试站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/",
      },
    ],
    identities: [
      {
        id: uuid(2),
        siteId: uuid(1),
        name: "管理员 · 主账号",
        username: "admin",
        role: "admin",
        color: "amber",
      },
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
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
);

const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electron,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
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
      /* 启动中 */
    }
  }
  if (!target) throw new Error(`no renderer\n${appLog.slice(-800)}`);
  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3400);

  await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(`http://127.0.0.1:${PAGE_PORT}/`)} });
    await new Promise((r) => setTimeout(r, 1800));
    return true;
  })()`);
  await wait(1200);

  // 1. The page really is on stage before the click, or the test proves nothing.
  const before = await client.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('webview')];
    return nodes.map((node) => ({
      left: node.style.left,
      opacity: node.style.opacity,
    }));
  })()`);
  check(
    "the page is on stage before the console opens",
    before.some((node) => node.opacity === "1" && !node.left.startsWith("-")),
    before,
  );

  // 2. The click, then a read in the *same* task. Nothing is awaited between the
  //    two, so a park that waits for the browser page to unmount — what the bug
  //    was — would still show the page on stage here.
  //
  //    Vue renders on a microtask, so the console cannot be in the DOM yet.
  //    That is the whole point: the pages have to be parked *before* the render
  //    that draws the console, not as a consequence of it.
  // The menu has to be open first — a row cannot be clicked before Vue has
  // rendered it. Opening the menu does not change the view, so the check below
  // still measures "one click on a navigation row", not a two-step sequence.
  //
  // Bookmarks rather than settings: settings is a page of its own that replaces
  // the whole window, so it cannot serve as the sample for "the pane that covers
  // the stage while the navigation column stays up".
  await client.evaluate(`(async () => {
    document.querySelector('[data-app-menu]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);
  const afterClick = await client.evaluate(`(() => {
    const row = document.querySelector('[data-menu-item="bookmarks"]');
    if (!row) return { error: 'no bookmarks row' };
    row.click();
    const nodes = [...document.querySelectorAll('webview')];
    return {
      clicked: true,
      consoleInDom: Boolean(document.querySelector('.pane-console')),
      nodes: nodes.map((node) => ({
        tabId: node.dataset.tabId,
        left: node.style.left,
        opacity: node.style.opacity,
        pointer: node.style.pointerEvents,
      })),
    };
  })()`);
  check(
    "every page is parked in the same task as the click, not a frame later",
    Array.isArray(afterClick?.nodes) &&
      afterClick.nodes.length > 0 &&
      afterClick.nodes.every(
        (node) => node.opacity === "0" && node.left.startsWith("-") && node.pointer === "none",
      ),
    afterClick,
  );

  // 3. And the console does appear, on the very next frame.
  const settled = await client.evaluate(`(async () => {
    await new Promise((r) => requestAnimationFrame(r));
    return {
      consoleInDom: Boolean(document.querySelector('.pane-console')),
      nodes: [...document.querySelectorAll('webview')].map((node) => ({
        left: node.style.left,
        opacity: node.style.opacity,
      })),
    };
  })()`);
  check(
    "the console is drawn on the next frame, with every page still parked",
    settled?.consoleInDom === true &&
      settled.nodes.every((node) => node.opacity === "0" && node.left.startsWith("-")),
    settled,
  );

  // 4. The layer numbers, so ordering alone can never decide this again.
  const layers = await client.evaluate(`(() => {
    const z = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      return {
        zIndex: getComputedStyle(element).zIndex,
        position: getComputedStyle(element).position,
      };
    };
    return { console: z('.pane-console'), pool: z('.guest-pool') };
  })()`);
  check(
    "the console sits above the page pool by layer number",
    layers?.console?.position !== "static" &&
      Number(layers?.console?.zIndex) > Number(layers?.pool?.zIndex ?? 0),
    layers,
  );

  // 5. Going back must put the page on stage again — parking must not be one-way.
  const back = await client.evaluate(`(async () => {
    const control = document.querySelector('[data-nav="browser"]');
    if (!control) return { error: 'no browser row' };
    control.click();
    await new Promise((r) => setTimeout(r, 900));
    const nodes = [...document.querySelectorAll('webview')];
    const stage = document.querySelector('.stage');
    return {
      onBrowser: Boolean(stage),
      nodes: nodes.map((node) => ({
        left: node.style.left,
        opacity: node.style.opacity,
        width: node.style.width,
      })),
    };
  })()`);
  check(
    "returning to the browser puts the page back on stage",
    back?.onBrowser === true &&
      back.nodes.some((node) => node.opacity === "1" && !node.left.startsWith("-")),
    back,
  );
} catch (error) {
  console.error("[console-overlap] fatal", String(error));
  console.error("[console-overlap] applog", appLog.slice(-1200));
  results.push({ name: "suite ran", ok: false });
} finally {
  app.kill();
  page.close();
  await wait(600);
  const failed = results.filter((result) => !result.ok).length;
  console.log(
    `\n[console-overlap] ${results.length - failed}/${results.length} assertions passed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
