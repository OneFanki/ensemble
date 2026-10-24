#!/usr/bin/env node
/**
 * End-to-end check of what opening an account from the accounts page does.
 *
 * The contract is deliberately narrow: clicking an account card means "give me
 * this account's page". It always creates a new page in the flat tab strip and
 * never touches the view on stage. Moving a page into a view stays an explicit
 * gesture (drag it in, or use the view's own "add tab").
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-placement-"));
const port = 9810 + Math.floor(Math.random() * 60);
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const viewId = "22222222-2222-4222-8222-222222222222";
const ids = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

function identity(id, name, color) {
  return {
    id,
    siteId,
    name,
    username: `${name}@example.test`,
    role: "member",
    color,
    passwordMode: "inherit",
    status: "unknown",
    startPath: "/",
    createdAt: now,
    updatedAt: now,
  };
}

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "落位站点",
        baseUrl: "http://127.0.0.1:3996",
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [
      identity(ids.a, "账号甲", "amber"),
      identity(ids.b, "账号乙", "teal"),
      identity(ids.c, "账号丙", "violet"),
    ],
    views: [
      {
        id: viewId,
        siteId,
        name: "落位验证",
        identityIds: [ids.a],
        layoutId: "2x1",
        slotAssignments: { [ids.a]: 0 },
        paths: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
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

  const opened = await client.evaluate(`(async () => {
    const state = await window.ensemble.openEmbeddedView('${viewId}');
    await new Promise((r) => setTimeout(r, 1200));
    const view = state.views.find((item) => item.id === state.activeViewId);
    return { container: view?.id, slots: view?.slotTabs, focused: view?.focusedTabId, tabs: state.tabs.length };
  })()`);
  check(
    "opening a one-member view leaves the second cell empty",
    Boolean(opened?.container) &&
      opened?.slots?.filter(Boolean).length === 1 &&
      opened?.slots?.[1] === null,
    opened,
  );

  // Accounts page click, with the view on stage. The page must land in the flat
  // strip; the view (and its selected cell) must be untouched.
  const second = await client.evaluate(`(async () => {
    const state = await window.ensemble.openEmbeddedIdentity('${ids.b}');
    await new Promise((r) => setTimeout(r, 900));
    const view = state.views.find((item) => item.id === '${opened?.container ?? ""}');
    const page = state.tabs.find((tab) => tab.label === '账号乙');
    return {
      activeView: state.activeViewId ?? null,
      container: view?.id,
      slots: view?.slotTabs,
      focused: view?.focusedTabId,
      active: state.activeTabId,
      pageView: page?.viewId ?? null,
      pageId: page?.id ?? null,
      tabs: state.tabs.length,
      dockRows: document.querySelectorAll('.dock .view-block .rows .tab-row').length,
    };
  })()`);
  check(
    "clicking an account while a view is on stage opens a flat tab",
    // Relative count: launch leaves one blank page, which this check is not
    // about — what it protects is "exactly one page was added".
    second?.pageView === null &&
      second?.tabs === (opened?.tabs ?? 0) + 1,
    second,
  );
  check(
    "the view on stage is left exactly as it was",
    second?.slots?.[0] === opened?.slots?.[0] &&
      second?.slots?.[1] === null &&
      second?.focused === opened?.focused,
    { before: opened?.slots, after: second?.slots, focused: second?.focused },
  );
  check(
    "the new page becomes the active tab in the flat strip",
    second?.active === second?.pageId,
    { active: second?.active, page: second?.pageId },
  );

  const reopen = await client.evaluate(`(async () => {
    const before = await window.ensemble.getEmbeddedState();
    const state = await window.ensemble.openEmbeddedIdentity('${ids.a}');
    await new Promise((r) => setTimeout(r, 800));
    const pages = state.tabs.filter((tab) => tab.label === '账号甲');
    const view = state.views.find((item) => item.id === '${opened?.container ?? ""}');
    return {
      before: before.tabs.length,
      after: state.tabs.length,
      pages: pages.map((tab) => ({ id: tab.id, viewId: tab.viewId ?? null })),
      slots: view?.slotTabs,
    };
  })()`);
  check(
    "launching an already-open account still creates a new page",
    reopen?.after === reopen?.before + 1 && reopen?.pages?.length === 2,
    reopen,
  );
  check(
    "the extra page is loose, so the view keeps its members",
    reopen?.pages?.some((page) => page.viewId === null) && reopen?.slots?.[1] === null,
    reopen,
  );

  // A left-over view must not be dragged on stage by an account click either.
  const loose = await client.evaluate(`(async () => {
    await window.ensemble.activateEmbeddedView(null);
    const state = await window.ensemble.openEmbeddedIdentity('${ids.c}');
    await new Promise((r) => setTimeout(r, 800));
    const page = state.tabs.find((tab) => tab.label === '账号丙');
    return { viewOnStage: state.activeViewId ?? null, pageView: page?.viewId ?? null, active: state.activeTabId };
  })()`);
  check(
    "with no view on stage an account click is a loose page too",
    loose?.viewOnStage === null && loose?.pageView === null && Boolean(loose?.active),
    loose,
  );

  // --- The toolbar "+" must show what it just created ---------------------
  // Reported: with a view on stage, + created a page but the stage kept showing
  // the old one. Creating a page the user cannot see reads as a broken button.
  const plus = await client.evaluate(`(async () => {
    await window.ensemble.activateEmbeddedView(null);
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    // A single-cell view is the case that used to fail: there is no free cell,
    // so an insertion that does not swap leaves the new page off stage.
    const single = await window.ensemble.createEmbeddedView({ layoutId: "1x1", name: "单格" });
    const singleId = single.activeViewId;
    await window.ensemble.openEmbeddedTabInSlot(singleId, 0);
    const before = await window.ensemble.getEmbeddedState();
    const oldSlot = before.views.find((item) => item.id === singleId)?.slotTabs;
    const tab = await window.ensemble.openEmbeddedTab({});
    const after = await window.ensemble.getEmbeddedState();
    const view = after.views.find((item) => item.id === singleId);
    return {
      oldSlot,
      afterSlots: view?.slotTabs,
      focused: view?.focusedTabId,
      active: after.activeTabId,
      newTab: tab.id,
      newUrl: tab.url,
      viewId: singleId,
    };
  })()`);
  check(
    "the toolbar + puts its new page on stage when the grid is full",
    plus?.afterSlots?.[0] === plus?.newTab && plus?.afterSlots?.length === 1,
    plus,
  );
  check(
    "the new page is the selected cell and the active tab",
    plus?.focused === plus?.newTab && plus?.active === plus?.newTab,
    plus,
  );
  check("the new page starts blank", plus?.newUrl === "about:blank", plus);
  check(
    "the displaced page stays in the view instead of being closed",
    Boolean(plus?.oldSlot?.[0]) && plus?.oldSlot?.[0] !== plus?.newTab,
    plus,
  );

  const fillEmpty = await client.evaluate(`(async () => {
    // Back to the two-cell view; it has a free cell, so + must fill it without
    // evicting the member that is already there.
    await window.ensemble.openEmbeddedView('${viewId}');
    const before = await window.ensemble.getEmbeddedState();
    const viewId = before.activeViewId;
    const kept = before.views.find((item) => item.id === viewId)?.slotTabs?.[0] ?? null;
    const tab = await window.ensemble.openEmbeddedTab({});
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === viewId);
    return { kept, slots: view?.slotTabs, focused: view?.focusedTabId, newTab: tab.id };
  })()`);
  check(
    "with a free cell the new page takes it instead of evicting anyone",
    fillEmpty?.slots?.[0] === fillEmpty?.kept && fillEmpty?.slots?.[1] === fillEmpty?.newTab,
    fillEmpty,
  );
  check(
    "the page in the free cell becomes selected",
    fillEmpty?.focused === fillEmpty?.newTab,
    fillEmpty,
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
