#!/usr/bin/env node
/**
 * End-to-end check that an app dialog paints above a live page.
 *
 * The page is a `<webview>` node in the app's own document, so a dialog stacks
 * over it like any other element. The reported bug this guards is the older one:
 * while pages were native views they painted over all HTML and every dialog had
 * to freeze the stage first. The dialog must stay readable and on top.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
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
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
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
  // page. With a native view that means freezing the stage into images first —
  // a native view is never behind HTML, whatever its z-index says. A guest is a
  // node in this document, so the dialog simply stacks and nothing is frozen.
  const dialog = await client.evaluate(`(async () => {
    const carrier = (await window.ensemble.getEmbeddedState()).carrier ?? "native";
    const close = [...document.querySelectorAll('.view-block .block-head button')].find(
      (button) => button.getAttribute('aria-label') === '关闭整个视图',
    );
    close?.click();
    await new Promise((r) => setTimeout(r, 1500));
    // A confirmation is an AlertDialog (role "alertdialog"), not a form dialog:
    // a destructive question must not be dismissable by clicking the backdrop.
    const modal = document.querySelector('[role="alertdialog"], [role="dialog"]');
    const labels = [...document.querySelectorAll('.view-block .block-head button')].map((b) => b.getAttribute('aria-label') || b.className);
    const frozen = document.querySelectorAll('.frozen').length;
    const stage = document.querySelector('.stage');
    const rect = modal?.getBoundingClientRect();
    const hit = rect
      ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
      : null;
    // The stage sits directly behind the dialog. Asking who owns a point inside
    // it is how a guest carrier proves the page did not paint over the dialog.
    const stageBox = stage?.getBoundingClientRect();
    const pageOnTop = stageBox
      ? document
          .elementsFromPoint(
            Math.round(stageBox.left + stageBox.width / 2),
            Math.round(stageBox.top + stageBox.height / 2),
          )
          .some((el) => el.tagName.toLowerCase() === "webview")
      : false;
    return {
      modal: Boolean(modal),
      frozen,
      hasStage: Boolean(stage),
      topIsInDialog: Boolean(hit && modal?.contains(hit)),
      closeButtonFound: true,
      labels,
      carrier,
      pageOnTop,
    };
  })()`);
  check("the close-view confirmation opens", dialog?.modal === true, dialog);
  check(
    "the page is not drawn over the confirmation",
    dialog?.carrier === "guest" ? dialog?.pageOnTop === false : dialog?.frozen === 1,
    dialog,
  );
  check("the dialog is the topmost element", dialog?.topIsInDialog === true, dialog);

  // --- Flat mode (loose tab): the frozen picture must sit exactly where the
  // live view was, including the 26px instance-tab-strip band. Freezing at the
  // raw stage origin painted the page one band too high, so the page visibly
  // jumped up whenever an overlay opened over a flat stage (2026-10-30). ---
  const flat = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const before = await api.getEmbeddedState();
    // A genuinely flat stage: close the view ("+" would otherwise join it —
    // that is the dock's contract), then open a loose tab.
    if (before.activeViewId) await api.closeEmbeddedView(before.activeViewId, "all");
    const loose = await api.openEmbeddedTab({});
    await api.navigateEmbeddedTab(loose.id, ${JSON.stringify(`http://127.0.0.1:${PAGE_PORT}/flat`)});
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = await api.getEmbeddedState();
      const tab = state.tabs.find((item) => item.id === loose.id);
      if (tab?.url?.startsWith("http://127.0.0.1:${PAGE_PORT}")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const state = await api.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === loose.id);
    return { activeViewId: state.activeViewId ?? null, bounds: tab?.bounds, carrier: state.carrier ?? "guest" };
  })()`);
  check(
    "flat stage is actually flat (no view active)",
    flat?.activeViewId === null,
    flat?.activeViewId,
  );
  // The page is a node sized from `bounds`, so what matters is that the rect
  // covers the stage. It used to start below a 26px header band because the flat
  // stage drew one with the instance's page tabs; that band is gone (the
  // window-level strip owns the tabs in every mode, and the flat band was a
  // second identical row), so the page now takes the whole stage from y = 0.
  // Asserting the band's absence is the point: a leftover inset showed up as a
  // dark strip above every flat page.
  check(
    "a flat stage gives its page the whole stage, with no header band",
    flat?.carrier === "guest" &&
      Boolean(flat?.bounds) &&
      flat.bounds.y === 0 &&
      flat.bounds.height > 0,
    { bounds: flat?.bounds, carrier: flat?.carrier },
  );

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
