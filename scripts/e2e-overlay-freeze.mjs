#!/usr/bin/env node
/**
 * End-to-end check that an app dialog paints above a live page.
 *
 * Native `WebContentsView`s paint over all HTML, so a dialog opened over the
 * browser page has to freeze the stage first. Without it the dialog renders
 * behind a live page and looks broken — the reported bug this guards.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3989;
const DEBUG_PORT = 9761;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-overlay-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>覆盖测试</title></head><body><h1>页面上</h1></body></html>`,
  );
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

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
        name: "覆盖测试站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/",
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

  const opened = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const view = await api.createEmbeddedView({ layoutId: "2x1", name: "覆盖验证" });
    const state = await api.openEmbeddedTabInSlot(view.activeViewId, 0);
    const active = state.views.find((item) => item.id === view.activeViewId);
    const tabId = active?.slotTabs?.[0];
    // A blank page has no native pixels to freeze (the app draws its new-tab
    // surface there), so this check needs a real page on stage. Poll the state
    // instead of sleeping a fixed time: on a slow start the page is still blank
    // when the dialog opens, freeze returns no images, and the assertion fails
    // for a reason that has nothing to do with overlays.
    if (tabId) await api.navigateEmbeddedTab(tabId, ${JSON.stringify(`http://127.0.0.1:${PAGE_PORT}/`)});
    let url = "";
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const next = await api.getEmbeddedState();
      url = next.tabs.find((tab) => tab.id === tabId)?.url ?? "";
      if (url.startsWith("http://127.0.0.1:${PAGE_PORT}")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 600));
    return { viewId: view.activeViewId, tabId, url };
  })()`);
  check(
    "a page is on stage",
    Boolean(opened?.viewId) && String(opened?.url).startsWith(`http://127.0.0.1:${PAGE_PORT}`),
    opened,
  );

  // The view header's × asks for confirmation; that dialog must sit above the
  // page, which means the stage has to be frozen into images first.
  const dialog = await client.evaluate(`(async () => {
    const close = [...document.querySelectorAll('.view-block .block-head button')].find(
      (button) => button.getAttribute('aria-label') === '关闭整个视图',
    );
    close?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const modal = document.querySelector('[role="dialog"]');
    const labels = [...document.querySelectorAll('.view-block .block-head button')].map((b) => b.getAttribute('aria-label') || b.className);
    const frozen = document.querySelectorAll('.frozen').length;
    const stage = document.querySelector('.stage');
    const rect = modal?.getBoundingClientRect();
    const hit = rect
      ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
      : null;
    return {
      modal: Boolean(modal),
      frozen,
      hasStage: Boolean(stage),
      topIsInDialog: Boolean(hit && modal?.contains(hit)),
      closeButtonFound: true,
      labels,
    };
  })()`);
  check("the close-view confirmation opens", dialog?.modal === true, dialog);
  check("the stage is frozen behind it", dialog?.frozen === 1, dialog);
  check("the dialog is the topmost element", dialog?.topIsInDialog === true, dialog);

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  page.close();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
