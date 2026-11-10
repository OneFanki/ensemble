#!/usr/bin/env node
/**
 * Drag-and-drop of a page into a view cell, end to end.
 *
 * Reported: dragging a page from the run dock onto a cell did not land — the
 * cell stayed empty and a blank tab appeared in the view instead. The three
 * questions that separates:
 *
 * 1. Does the palette carry the id the drop handler reads?
 * 2. Does the drop reach the cell at all (a live page takes the pointer, but a
 *    drop is dispatched by the HTML drag protocol, not by hit-testing)?
 * 3. Does the main process's pin actually put *that* page in the cell, or does it
 *    create something else?
 *
 * The drag is synthesised with a real `DataTransfer` and real drag events, so
 * the same handlers run as for a person dragging with a mouse. A test that
 * called `pinEmbeddedTab` directly would pass on a build where the drop handler
 * is broken.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-dragpin-"));
const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [
      { id: uuid(2), name: "管理员 · 主账号", username: "admin", role: "admin", color: "amber" },
      { id: uuid(3), name: "成员 · 子账号", username: "member", role: "member", color: "teal" },
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

  // One view with two cells. Cell 1 holds a real page (a blank page would hide
  // the bug: the drop cover only matters where a live page is under the pointer).
  const setup = await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.createEmbeddedView({ layoutId: "2x1", name: "落点" });
    const state = await api.getEmbeddedState();
    const viewId = state.activeViewId;
    const tab = await api.openEmbeddedTabInSlot(viewId, 0, { url: "https://example.test/first" });
    return { viewId, pageId: tab.id };
  })()`);
  await wait(2400);

  // The dock row for the page that is running.
  const before = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.dock .view-block .rows .tab-row')];
    const row = rows[0];
    const empty = document.querySelector('.slot-empty');
    const header = document.querySelector('.slot-header');
    return {
      rows: rows.length,
      rowTabId: row?.dataset.tabId ?? null,
      draggable: row?.getAttribute('draggable') ?? null,
      emptySlot: Boolean(empty),
      slotHeaders: document.querySelectorAll('.slot-header').length,
      headerRect: header ? (() => {
        const r = header.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })() : null,
    };
  })()`);
  check("the dock has a draggable row", before?.rows >= 1 && before?.draggable === "true", before);
  check("the view has an empty cell to drop into", before?.emptySlot === true, before);

  // --- The real gesture -----------------------------------------------------
  // A DataTransfer is created in the page, filled by the dragstart handler, then
  // read by the drop handler — the same object flows through both, as it does
  // for a mouse drag.
  const dropped = await client.evaluate(`(async () => {
    const row = document.querySelector('.dock .view-block .rows .tab-row');
    if (!row) return { error: 'missing row' };

    // Start the drag first: the cover only exists while a drag is in flight,
    // which is exactly the ordering the real gesture has.
    const data = new DataTransfer();
    const fire = (el, type) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };

    const dragStartPrevented = fire(row, 'dragstart');
    await new Promise((r) => requestAnimationFrame(r));

    const covers = document.querySelectorAll('.slot-drop-cover');
    const empties = document.querySelectorAll('.slot-empty');
    const target = covers[1] ?? empties[0] ?? null;
    if (!target) return { error: 'no drop target', covers: covers.length, empties: empties.length };

    const palette = [...data.types];
    const textId = data.getData('text/plain');
    const pageId = data.getData('application/x-ensemble-page');

    fire(target, 'dragenter');
    const overPrevented = fire(target, 'dragover');
    fire(target, 'drop');
    fire(row, 'dragend');

    await new Promise((r) => setTimeout(r, 1800));
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === ${JSON.stringify(setup.viewId)});
    return {
      dragStartPrevented,
      overPrevented,
      covers: covers.length,
      palette,
      textId,
      pageId,
      slotTabs: view?.slotTabs ?? null,
      viewPages: state.tabs.filter((t) => t.viewId === view?.id).map((t) => ({ id: t.id, url: t.url, blank: !t.url || t.url === 'about:blank' })),
    };
  })()`);

  check("the drag palette carries the page id", Boolean(dropped?.textId), dropped);
  check("occupied cells grow a drop cover while dragging", (dropped?.covers ?? 0) >= 1, dropped);
  check("the drop target accepted the drag", dropped?.overPrevented === true, dropped);
  check(
    "the dropped page occupies the second cell",
    dropped?.slotTabs?.[1] === dropped?.textId,
    dropped,
  );
  check(
    "no blank page was added to the view",
    (dropped?.viewPages ?? []).every((page) => page.blank === false),
    dropped?.viewPages,
  );

  // --- The reported shape: aim at the *page area*, not the 26px band ---------
  //
  // This is what a person actually does — the cell is a large rectangle and the
  // band is a sliver at its top. The cover has to span the whole cell, because a
  // drop that only lands on the band is a drop that mostly misses.
  //
  // The drag stays in flight for the measurement: the cover exists only while a
  // drag is happening, so it has to be read between `dragstart` and `dragend`.
  const aimed = await client.evaluate(`(async () => {
    const row = document.querySelector('.dock .view-block .rows .tab-row');
    if (!row) return { error: 'no dock row' };

    // Any occupied cell will do — the previous drop moved the page into the
    // second one, and the cover exists over occupied cells.
    const data = new DataTransfer();
    const fire = (el, type) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fire(row, 'dragstart');
    await new Promise((r) => requestAnimationFrame(r));

    const covers = [...document.querySelectorAll('.slot-drop-cover')];
    if (!covers.length) {
      fire(row, 'dragend');
      return { error: 'no cover while dragging' };
    }
    const cover = covers[0];
    const rect = cover.getBoundingClientRect();
    const header = document.querySelector('.slot-header')?.getBoundingClientRect();

    // The element a hit test sees at a point deep inside the cell's page area.
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height * 0.75);
    const atPoint = document.elementFromPoint(cx, cy);

    const accepted = fire(atPoint ?? cover, 'dragover');
    fire(row, 'dragend');

    return {
      covers: covers.length,
      cover: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      header: header ? { y: Math.round(header.y), h: Math.round(header.height) } : null,
      spansCell: header ? rect.height > header.height * 3 : false,
      coveredBy: atPoint?.className ?? null,
      accepted,
      point: { cx, cy },
    };
  })()`);
  check(
    "the drop cover spans the whole cell, not just its header band",
    aimed?.spansCell === true && (aimed?.cover?.h ?? 0) > 100,
    aimed,
  );
  check(
    "a drop aimed at the page area is received by the cell, not the page",
    String(aimed?.coveredBy ?? "").includes("slot-drop-cover"),
    aimed,
  );
  check("that target accepts the drag", aimed?.accepted === true, aimed);

  client.close();
} catch (error) {
  check("the suite ran to completion", false, String(error));
  console.error(appLog.slice(-1200));
} finally {
  app.kill();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n[drag-pin] ${passed}/${results.length} assertions passed`);
process.exit(passed === results.length ? 0 : 1);
