#!/usr/bin/env node
/**
 * End-to-end check of tab drag-and-drop in the running dock.
 *
 * Covers the two things a click cannot prove: rows actually reorder (after a
 * synthetic drag), and a view keeps its container when its tabs are dragged
 * out. Driven through the renderer's own DevTools connection, so the real Vue
 * handlers build the drop payload.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-reorder-"));
const port = 9740 + Math.floor(Math.random() * 50);
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const identities = ["甲", "乙", "丙"].map((name, index) => ({
  id: `2222222${index}-2222-4222-8222-222222222222`,
  siteId,
  name: `账号${name}`,
  username: `user-${index}`,
  role: "成员",
  color: ["amber", "teal", "violet"][index],
  passwordMode: "inherit",
  status: "unknown",
  startPath: "/",
  createdAt: now,
  updatedAt: now,
}));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify(
    {
      version: 2,
      tags: [],
      sites: [
        {
          id: siteId,
          name: "排序测试站点",
          baseUrl: "http://127.0.0.1:3998",
          loginPath: "/",
          authCheckPath: null,
          autoSubmit: false,
          tagIds: [],
          extraFields: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      identities,
      views: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          siteId,
          name: "排序验证",
          identityIds: identities.map((identity) => identity.id),
          layoutId: "3x1",
          slotAssignments: {},
          paths: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
      instances: [],
      manualEngines: [],
      layoutPresets: [],
    },
    null,
    2,
  ),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify(
    {
      theme: "dark",
      locale: "zh",
      lastView: "browser",
      layout: "2x1",
      autoFillOnLaunch: false,
      closeToTray: false,
      onboardingVersion: 1,
      autoCheckUpdates: false,
    },
    null,
    2,
  ),
);

const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
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

/**
 * Drags the row at `from` onto the target row's top band.
 *
 * A synthetic DataTransfer plus the real Vue handlers is the closest thing to a
 * user drag that does not need OS-level mouse input over a native view.
 */
const DRAG_SCRIPT = (from, to) => `(async () => {
  const rows = [...document.querySelectorAll('.dock .tab-row')].filter((row) => !row.classList.contains('ext'));
  const source = rows[${from}];
  const target = rows[${to}];
  if (!source || !target) return { error: 'rows missing', count: rows.length };
  const dt = new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const rect = target.getBoundingClientRect();
  const at = { clientX: rect.left + 20, clientY: rect.top + 2 };
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 350));
  return { ok: true };
})()`;

const DETACH_SCRIPT = (index) => `(async () => {
  const rows = [...document.querySelectorAll('.dock .tab-row')].filter((row) => !row.classList.contains('ext'));
  const source = rows[${index}];
  const block = document.querySelector('.dock .view-block.loose');
  if (!source || !block) return { error: 'targets missing', count: rows.length };
  const dt = new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const rect = block.getBoundingClientRect();
  const at = { clientX: rect.left + 10, clientY: rect.top + 10 };
  block.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
  block.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 350));
  return { ok: true };
})()`;

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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

  // Launch leaves one blank page on the surface; the assertions below count rows
  // of this suite's own tabs, so start from nothing.
  await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);

  // Loose tabs first: the view is not on stage, so only the flat strip renders.
  const loose = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const a = await api.openEmbeddedTab({ viewId: null });
    const b = await api.openEmbeddedTab({ viewId: null });
    await new Promise((r) => setTimeout(r, 500));
    return { a: a.id, b: b.id };
  })()`);
  check("two loose tabs created", Boolean(loose?.a && loose?.b), loose);

  const dragLoose = await client.evaluate(DRAG_SCRIPT(1, 0));
  check("loose rows are draggable", dragLoose?.ok === true, dragLoose);

  const looseOrder = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    return state.tabs.filter((tab) => !tab.viewId).map((tab) => tab.id);
  })()`);
  check(
    "dragging the second loose tab above the first reorders them",
    looseOrder?.[0] === loose.b,
    { order: looseOrder, expectedFirst: loose.b },
  );

  // Open the saved view; its three members become rows with slot numbers.
  const opened = await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.openEmbeddedView('33333333-3333-4333-8333-333333333333');
    await new Promise((r) => setTimeout(r, 900));
    const state = await api.getEmbeddedState();
    const view = state.views[0];
    return { container: view.id, slots: view.slotTabs, tabs: state.tabs.map((tab) => tab.id) };
  })()`);
  check("view opened with three members", opened?.slots?.filter(Boolean).length === 3, opened);

  const dragView = await client.evaluate(DRAG_SCRIPT(2, 0));
  check("view rows are draggable", dragView?.ok === true, dragView);

  const afterReorder = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.viewDefinitionId === '33333333-3333-4333-8333-333333333333');
    const rows = [...document.querySelectorAll('.dock .view-block .rows .tab-row')].map(
      (row) => row.querySelector('.tab-label')?.textContent?.trim(),
    );
    return { slots: view.slotTabs, rows };
  })()`);
  check(
    "dragging the last view tab to the top moves it into slot 1",
    afterReorder?.slots?.[0] === opened?.slots?.[2],
    { slots: afterReorder?.slots, before: opened?.slots },
  );

  // Dragging a dock row straight onto a slot must replace that cell. This is the
  // gesture users try first; the dock order must not matter.
  const toSlot = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state0 = await api.getEmbeddedState();
    const view0 = state0.views.find((item) => item.viewDefinitionId === '33333333-3333-4333-8333-333333333333');
    // The row whose page is in slot 3 is dragged onto slot 2's header.
    const lastPageId = view0.slotTabs[2];
    const rows = [...document.querySelectorAll('.dock .view-block .rows .tab-row')];
    const source = rows[2];
    const headers = [...document.querySelectorAll('.stage .slot-header')];
    const target = headers[1];
    if (!source || !target) return { error: 'missing', rows: rows.length, headers: headers.length };
    const dt = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const rect = target.getBoundingClientRect();
    const at = { clientX: rect.left + 10, clientY: rect.top + 8 };
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 800));
    const state1 = await api.getEmbeddedState();
    const view1 = state1.views.find((item) => item.id === view0.id);
    return {
      before: view0.slotTabs,
      after: view1.slotTabs,
      moved: lastPageId,
      stageRestored: document.querySelectorAll('.stage .frozen').length === 0,
    };
  })()`);
  check(
    "dropping a dock row on a slot replaces that cell",
    Array.isArray(toSlot?.after) && toSlot.after[1] === toSlot.moved,
    toSlot,
  );
  check("the stage comes back to life after the drop", toSlot?.stageRestored === true, toSlot);

  // Drag every member out; the container must survive as an empty view.
  for (let index = 0; index < 3; index += 1) {
    await client.evaluate(DETACH_SCRIPT(0));
    await wait(200);
  }
  const emptied = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.viewDefinitionId === '33333333-3333-4333-8333-333333333333');
    return {
      kept: Boolean(view),
      slots: view?.slotTabs,
      loose: state.tabs.filter((tab) => !tab.viewId).length,
    };
  })()`);
  check(
    "dragging every tab out keeps the empty view",
    emptied?.kept === true && emptied?.slots?.every((slot) => slot === null),
    emptied,
  );
  check("all three members are loose now", emptied?.loose === 5, emptied);

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
  process.exit(failed.length === 0 ? 0 : 1);
}
