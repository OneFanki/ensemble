#!/usr/bin/env node
/**
 * End-to-end check of the window-level tab strip: drag to reorder, middle-click
 * to close.
 *
 * Reordering is the dock's `dropTab` reorder arriving through the strip. Three
 * things a click cannot prove are checked here: the order really changes (left
 * half of a tab lands before it, right half after), a page of another window is
 * refused instead of being spliced into this window's tabs, and a split view
 * keeps both of its cells — the reorder used to rebuild the slot table from the
 * tab order, which collapsed the deliberate duplicate and dropped the page pins.
 *
 * Middle-click is checked on both strips (the window strip and a cell's strip),
 * together with the case that must not close: a right-button `auxclick`, which
 * Chromium fires for every non-primary button.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-strip-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>标签 ${req.url}</title><h1>${req.url}</h1>`);
});
const pagePort = await freePort();
await new Promise((done) => page.listen(pagePort, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${pagePort}`;

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const viewId = "22222222-2222-4222-8222-222222222222";
const ids = ["a", "b"].map(
  (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);

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
        name: "标签条站点",
        baseUrl,
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [identity(ids[0], "账号甲", "amber"), identity(ids[1], "账号乙", "teal")],
    views: [
      {
        // Two windows and a spare cell: the spare cell is the split target, the
        // second window is where a foreign page comes from.
        id: viewId,
        siteId,
        name: "标签条验证",
        identityIds: [ids[0], ids[1]],
        layoutId: "3x1",
        slotAssignments: { [ids[0]]: 0, [ids[1]]: 1 },
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
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

  /*
   * One synthetic drag, driven through the real Vue handlers: dragstart on the
   * source fills the payload and raises the drag signal, dragover on the target
   * picks the edge from the pointer, drop commits. The insertion mark is read
   * between dragover and drop, after Vue has patched the class.
   */
  const opened = await client.evaluate(`(async () => {
    window.__stripDrag = async (source, target, side) => {
      const drag = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: drag }));
      const r = target.getBoundingClientRect();
      const x = side === 'before' ? r.left + r.width * 0.25 : r.left + r.width * 0.75;
      const y = r.top + r.height / 2;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: drag, clientX: x, clientY: y }));
      await new Promise((done) => setTimeout(done, 40));
      const hinted = target.classList.contains('drop-' + side);
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drag, clientX: x, clientY: y }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: drag }));
      return { hinted, width: r.width };
    };
    window.__strip = () =>
      [...document.querySelectorAll('.tabstrip .tab')].map((el) => el.getAttribute('data-tab-id'));

    const api = window.ensemble;
    const state = await api.openEmbeddedView('${viewId}');
    await new Promise((r) => setTimeout(r, 2400));
    const view = state.views.find((v) => v.id === state.activeViewId);
    const root = state.tabs.find((t) => t.id === view.slotTabs[0]);
    // Two more pages in the first window, then back to its first page so the
    // strip shows this window and the cell shows its root.
    await api.openEmbeddedTabInInstance(root.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    await api.openEmbeddedTabInInstance(root.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    await api.activateEmbeddedTab(root.id);
    await new Promise((r) => setTimeout(r, 900));
    const next = await api.getEmbeddedState();
    return {
      slots: view.slotTabs,
      root: root.id,
      instanceId: root.instanceId,
      other: view.slotTabs[1] ?? null,
      pages: next.tabs.filter((t) => t.instanceId === root.instanceId).map((t) => t.id),
      strip: window.__strip(),
    };
  })()`);
  check(
    "the view opens with two windows and a spare cell",
    opened?.slots?.filter(Boolean).length === 2 && !opened?.slots?.[2],
    opened,
  );
  check(
    "the window strip lists the focused window's three pages in tab order",
    opened?.pages?.length === 3 && same(opened?.strip, opened?.pages),
    opened,
  );

  // Left half of the first tab: the last tab moves to the front.
  const before = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const was = window.__strip();
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    const drag = await window.__stripDrag(tabs[2], tabs[0], 'before');
    await new Promise((r) => setTimeout(r, 900));
    const state = await api.getEmbeddedState();
    return {
      was,
      drag,
      strip: window.__strip(),
      order: state.tabs.filter((t) => t.instanceId === '${opened?.instanceId ?? ""}').map((t) => t.id),
    };
  })()`);
  check(
    "a drag over a tab's left half marks the insertion on that edge",
    before?.drag?.hinted === true,
    before,
  );
  check(
    "dropping on the left half moves the tab in front of the target",
    same(before?.strip, [before?.was?.[2], before?.was?.[0], before?.was?.[1]]) &&
      same(before?.order, before?.strip),
    before,
  );

  // Right half of the last tab: the first tab moves to the end.
  const after = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const was = window.__strip();
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    const drag = await window.__stripDrag(tabs[0], tabs[2], 'after');
    await new Promise((r) => setTimeout(r, 900));
    const state = await api.getEmbeddedState();
    return {
      was,
      drag,
      strip: window.__strip(),
      order: state.tabs.filter((t) => t.instanceId === '${opened?.instanceId ?? ""}').map((t) => t.id),
    };
  })()`);
  check(
    "dropping on the right half moves the tab behind the target",
    after?.drag?.hinted === true &&
      same(after?.strip, [after?.was?.[1], after?.was?.[2], after?.was?.[0]]) &&
      same(after?.order, after?.strip),
    after,
  );

  /*
   * A page of the other window, dragged from its cell's strip onto this strip.
   * The strip lists one browser's pages; accepting it would splice two windows'
   * tab lists together and pull the page into this window's view slot.
   */
  const foreign = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const was = window.__strip();
    const beforeState = await api.getEmbeddedState();
    const slotsBefore = beforeState.views.find((v) => v.id === beforeState.activeViewId).slotTabs;
    const source = document.querySelector('.slot-tab[data-tab-id="${opened?.other ?? ""}"]');
    const target = document.querySelectorAll('.tabstrip .tab')[0];
    const drag = source ? await window.__stripDrag(source, target, 'before') : null;
    await new Promise((r) => setTimeout(r, 900));
    const state = await api.getEmbeddedState();
    return {
      found: Boolean(source),
      drag,
      was,
      strip: window.__strip(),
      slotsBefore,
      slotsAfter: state.views.find((v) => v.id === state.activeViewId).slotTabs,
    };
  })()`);
  check(
    "a page of another window gets no insertion mark and changes nothing",
    foreign?.found === true &&
      foreign?.drag?.hinted === false &&
      same(foreign?.strip, foreign?.was) &&
      same(foreign?.slotsAfter, foreign?.slotsBefore),
    foreign,
  );

  /*
   * Split, then reorder. Dragging a page of the focused window onto the spare
   * cell puts that window in two cells with a page pinned to each; a reorder in
   * the strip afterwards must leave both cells and both pins alone.
   */
  const split = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const strip = window.__strip();
    const source = document.querySelector('.tabstrip .tab[data-tab-id="' + strip[1] + '"]');
    const drag = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: drag }));
    const empty = document.querySelector('.slot-empty');
    empty?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: drag }));
    empty?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drag }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: drag }));
    await new Promise((r) => setTimeout(r, 1600));
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    return { strip: window.__strip(), slots: view.slotTabs, pins: view.slotPages ?? null };
  })()`);
  check(
    "dropping a strip tab on the spare cell splits the window into two cells",
    split?.slots?.[0] === opened?.root && split?.slots?.[2] === opened?.root,
    split,
  );

  const reorderSplit = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const was = window.__strip();
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    const drag = await window.__stripDrag(tabs[2], tabs[0], 'before');
    await new Promise((r) => setTimeout(r, 900));
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    return {
      was,
      drag,
      strip: window.__strip(),
      slots: view.slotTabs,
      pins: view.slotPages ?? null,
    };
  })()`);
  check(
    "reordering a split window's tabs moves the tab",
    same(reorderSplit?.strip, [reorderSplit?.was?.[2], reorderSplit?.was?.[0], reorderSplit?.was?.[1]]),
    reorderSplit,
  );
  check(
    "reordering a split window's tabs keeps both cells and both pins",
    same(reorderSplit?.slots, split?.slots) && same(reorderSplit?.pins, split?.pins),
    { split, reorderSplit },
  );

  // A right-button auxclick must not close: Chromium fires auxclick for it too.
  const rightClick = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const id = window.__strip()[0];
    const tab = document.querySelector('.tabstrip .tab[data-tab-id="' + id + '"]');
    tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    await new Promise((r) => setTimeout(r, 900));
    const state = await api.getEmbeddedState();
    return { id, alive: state.tabs.some((t) => t.id === id) };
  })()`);
  check("a right-button auxclick leaves the tab open", rightClick?.alive === true, rightClick);

  // Middle-click a strip tab that is neither current nor pinned to a cell.
  const middle = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const beforeState = await api.getEmbeddedState();
    const view = beforeState.views.find((v) => v.id === beforeState.activeViewId);
    const pinned = new Set((view.slotPages ?? []).filter(Boolean));
    const current = document.querySelector('.tabstrip .tab.active')?.getAttribute('data-tab-id');
    const id = window.__strip().find((item) => item !== current && !pinned.has(item));
    const tab = document.querySelector('.tabstrip .tab[data-tab-id="' + id + '"]');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
    tab.dispatchEvent(press);
    tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await new Promise((r) => setTimeout(r, 1200));
    const state = await api.getEmbeddedState();
    const next = state.views.find((v) => v.id === state.activeViewId);
    return {
      id,
      pressPrevented: press.defaultPrevented,
      alive: state.tabs.some((t) => t.id === id),
      strip: window.__strip(),
      slotsBefore: view.slotTabs,
      slotsAfter: next.slotTabs,
    };
  })()`);
  check(
    "a middle press on a tab is kept from starting an autoscroll",
    middle?.pressPrevented === true,
    middle,
  );
  check(
    "middle-clicking a tab in the window strip closes it",
    Boolean(middle?.id) && middle?.alive === false && !middle?.strip?.includes(middle?.id),
    middle,
  );
  check(
    "closing an unpinned page leaves the split cells as they were",
    same(middle?.slotsAfter, middle?.slotsBefore),
    middle,
  );

  // Middle-click the other window's only page, in its cell's strip.
  const cellMiddle = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const id = '${opened?.other ?? ""}';
    const pill = document.querySelector('.slot-tab[data-tab-id="' + id + '"]');
    pill?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 }));
    pill?.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await new Promise((r) => setTimeout(r, 1200));
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    return {
      found: Boolean(pill),
      alive: state.tabs.some((t) => t.id === id),
      slots: view.slotTabs,
    };
  })()`);
  check(
    "middle-clicking a page in a cell's strip closes it",
    cellMiddle?.found === true &&
      cellMiddle?.alive === false &&
      !cellMiddle?.slots?.includes(opened?.other),
    cellMiddle,
  );

  client.close();
} catch (error) {
  check("run completed", false, error?.stack ?? String(error));
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
