#!/usr/bin/env node
/**
 * End-to-end check of drag-to-reorder on the management pages.
 *
 * Unit tests prove the service reorders an array; only a real drag proves the
 * page sends the right index. The interesting cases are the ones a click test
 * cannot see:
 *
 * 1. Tags and sites are drawn inside groups, so the drop index has to be
 *    translated back to the stored array. A wrong translation still looks like
 *    a successful drag.
 * 2. A bookmark folder row has two meanings: the middle files into the folder,
 *    the top/bottom edge reorders among siblings. Only the edge is asserted
 *    here — filing is covered by `e2e-bookmarks.mjs`.
 * 3. Flow steps reorder a draft array that is saved as a whole.
 *
 * Runs headless like the other e2e scripts: the window is parked outside every
 * display, so nothing pops up on screen.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-sort-"));
const port = await freePort();
const now = new Date().toISOString();
const PAGE_URL = "http://127.0.0.1:3997";

const tags = ["甲", "乙", "丙"].map((name, index) => ({
  id: `tag-${index}`,
  name,
  color: ["amber", "teal", "violet"][index],
  createdAt: now,
}));
const sites = ["甲", "乙", "丙"].map((name, index) => ({
  id: `site-${index}`,
  name: `站点${name}`,
  baseUrl: PAGE_URL,
  loginPath: "/",
  authCheckPath: null,
  autoSubmit: false,
  tagIds: [],
  createdAt: now,
  updatedAt: now,
}));
const bookmarkFolders = ["甲", "乙", "丙"].map((name, index) => ({
  id: `folder-${index}`,
  name: `文件夹${name}`,
  order: index,
  createdAt: now,
  updatedAt: now,
}));
const flow = {
  id: "flow-0",
  siteId: "site-0",
  name: "排序流程",
  description: "",
  params: [],
  steps: [
    { action: "navigate", url: `${PAGE_URL}/a` },
    { action: "navigate", url: `${PAGE_URL}/b` },
    { action: "navigate", url: `${PAGE_URL}/c` },
  ],
  createdAt: now,
  updatedAt: now,
};

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags,
    sites,
    identities: [],
    views: [],
    flows: [flow],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
    bookmarkFolders,
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "sites", guideVersion: GUIDE_SEEN }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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

async function waitFor(client, expression, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

/**
 * Drags one row onto another with a synthetic `DragEvent`.
 *
 * `ratio` is where in the target's height the pointer lands, which is what the
 * folder rows read to tell "insert above" from "file into".
 */
async function dragRow(client, itemSelector, sourceIndex, targetIndex, options = {}) {
  const { sourceSub = null, ratio = 0.5 } = options;
  return client.evaluate(`(async () => {
    const rows = [...document.querySelectorAll(${JSON.stringify(itemSelector)})];
    const source = ${sourceSub ? `rows[${sourceIndex}]?.querySelector(${JSON.stringify(sourceSub)})` : `rows[${sourceIndex}]`};
    const target = rows[${targetIndex}];
    if (!source || !target) return { ok: false, rows: rows.length };
    const dt = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const rect = target.getBoundingClientRect();
    const at = { clientX: rect.left + 20, clientY: rect.top + rect.height * ${ratio} };
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    await new Promise((done) => setTimeout(done, 80));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await new Promise((done) => setTimeout(done, 600));
    return { ok: true };
  })()`);
}

async function go(client, view) {
  await client.evaluate(openNav(view));
  await wait(350);
}

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
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

  // --- Tags -----------------------------------------------------------------
  await go(client, "tags");
  check(
    "tags page rendered",
    await waitFor(client, `document.querySelectorAll('.tags .row').length === 3`),
  );
  const tagDrag = await dragRow(client, ".tags .row", 0, 2, { sourceSub: ".grip" });
  const tagOrder = await client.evaluate(
    `(async () => (await window.ensemble.getWorkspace()).tags.map((tag) => tag.name))()`,
  );
  check("tag row dragged from the grip", tagDrag?.ok === true, tagDrag);
  check("tags reorder through the store", JSON.stringify(tagOrder) === JSON.stringify(["乙", "丙", "甲"]), tagOrder);

  // --- Sites (grouped by tag: one untagged group) ---------------------------
  await go(client, "sites");
  check(
    "sites page rendered",
    await waitFor(client, `document.querySelectorAll('.sites .env-card').length === 3`),
  );
  const siteDrag = await dragRow(client, ".sites .env-card", 0, 2, { sourceSub: ".site-grip" });
  const siteOrder = await client.evaluate(
    `(async () => (await window.ensemble.getWorkspace()).sites.map((site) => site.name))()`,
  );
  check("site card dragged from the grip", siteDrag?.ok === true, siteDrag);
  check(
    "sites reorder through the store",
    JSON.stringify(siteOrder) === JSON.stringify(["站点乙", "站点丙", "站点甲"]),
    siteOrder,
  );

  // --- Bookmark folders: top edge means "insert before" ---------------------
  await go(client, "bookmarks");
  check(
    "bookmark folders rendered",
    await waitFor(client, `document.querySelectorAll('.bookmarks-page .rows .row.folder').length === 3`),
  );
  const folderDrag = await dragRow(client, ".bookmarks-page .rows .row.folder", 0, 2, {
    ratio: 0.05,
  });
  const folderOrder = await client.evaluate(
    `(async () => (await window.ensemble.getWorkspace()).bookmarkFolders.map((folder) => folder.name))()`,
  );
  check("folder row dragged onto the target's top edge", folderDrag?.ok === true, folderDrag);
  check(
    "a folder edge drop reorders siblings instead of filing",
    JSON.stringify(folderOrder) === JSON.stringify(["文件夹乙", "文件夹甲", "文件夹丙"]),
    folderOrder,
  );

  // --- Flow steps -----------------------------------------------------------
  await go(client, "flows");
  check(
    "flows page rendered",
    await waitFor(client, `document.querySelectorAll('.flows .flow-row').length === 1`),
  );
  await client.evaluate(`(() => {
    const edit = [...document.querySelectorAll('.flows .detail-actions button')].find(
      (button) => button.getAttribute('aria-label') === '编辑',
    );
    edit?.click();
  })()`);
  check(
    "flow editor opened",
    await waitFor(client, `document.querySelectorAll('.content .step-editor').length === 3`),
  );
  const stepDrag = await dragRow(client, ".content .step-editor", 0, 2, { sourceSub: ".step-grip" });
  await client.evaluate(`(() => {
    const save = [...document.querySelectorAll('.content button')].find(
      (button) => button.textContent.trim() === '保存',
    );
    save?.click();
  })()`);
  await wait(800);
  const stepOrder = await client.evaluate(
    `(async () => (await window.ensemble.getWorkspace()).flows[0].steps.map((step) => step.url))()`,
  );
  check("flow step dragged from the grip", stepDrag?.ok === true, stepDrag);
  check(
    "the saved flow keeps the dragged step order",
    JSON.stringify(stepOrder) ===
      JSON.stringify([`${PAGE_URL}/b`, `${PAGE_URL}/c`, `${PAGE_URL}/a`]),
    stepOrder,
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
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
