#!/usr/bin/env node
/**
 * End-to-end check of the same-account split.
 *
 * The gesture: drag one page tab from a cell's strip onto another cell. The
 * result is one browser instance shown in two cells, each cell displaying a
 * different page — cookies shared because the instance is shared. Opening a
 * second instance would be a second session and a second login, which is exactly
 * what this exists to avoid.
 *
 * It also guards the two ways this breaks silently:
 *
 * 1. Clicking a page in one cell's strip moves the *instance's* active page, so
 *    without pinning the page to the cell the other cell follows along and both
 *    halves show the same picture.
 * 2. `resolveSlotTabs` de-duplicates instances, so a split gets collapsed back to
 *    one cell on the next layout pass unless the repeat is declared deliberate.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const DEBUG_PORT = "0";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-split-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>分屏 ${req.url}</title><h1>${req.url}</h1>`);
});
await new Promise((done) => page.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${page.address().port}`;

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
        name: "分屏站点",
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
        // Two cells, one member: the second cell is the split target.
        id: viewId,
        siteId,
        name: "分屏验证",
        identityIds: [ids[0]],
        layoutId: "2x1",
        slotAssignments: { [ids[0]]: 0 },
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

  const opened = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.openEmbeddedView('${viewId}');
    await new Promise((r) => setTimeout(r, 2400));
    const view = state.views.find((item) => item.id === state.activeViewId);
    const rootId = view.slotTabs.find(Boolean);
    const page = state.tabs.find((t) => t.id === rootId);
    // A second page inside the same instance: this is what gets split off.
    await api.openEmbeddedTabInInstance(page.instanceId);
    await new Promise((r) => setTimeout(r, 1800));
    const next = await api.getEmbeddedState();
    const pages = next.tabs.filter((t) => t.instanceId === page.instanceId);
    return {
      container: view.id,
      slots: view.slotTabs,
      instanceId: page.instanceId,
      pages: pages.map((t) => ({ id: t.id, label: t.label })),
    };
  })()`);
  check(
    "the view opens with one instance in one cell and a spare cell",
    Boolean(opened?.container) &&
      opened?.slots?.filter(Boolean).length === 1 &&
      Boolean(opened?.slots?.[1]) === false,
    opened,
  );
  check(
    "the instance gets a second page to split off",
    opened?.pages?.length === 2,
    opened,
  );

  // The gesture: with the cell showing page A, drag page B's tab onto cell 2.
  const split = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const before = await api.getEmbeddedState();
    const view = before.views.find((v) => v.id === '${opened?.container ?? ""}');
    const pages = before.tabs.filter((t) => t.instanceId === '${opened?.instanceId ?? ""}');
    // Opening the second page made it the instance's active one, which is what
    // any "+" does. Go back to page A first: the scenario is "I am looking at A,
    // and I want B beside it".
    await api.activateEmbeddedTab(pages[0].id);
    await new Promise((r) => setTimeout(r, 600));
    const source = pages[1];
    const drag = new DataTransfer();
    drag.setData('text/plain', source.id);
    drag.setData('application/x-ensemble-page', source.id);
    // The second cell is *empty*, so it draws as a dashed .slot-empty body rather
    // than a header band — a header only exists above a live page.
    const target = [...document.querySelectorAll('.slot-empty')][0];
    target?.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: drag }));
    target?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: drag }));
    await new Promise((r) => setTimeout(r, 1600));
    const after = await api.getEmbeddedState();
    const next = after.views.find((v) => v.id === view.id);
    return {
      pageA: pages[0].id,
      pageB: pages[1].id,
      slots: next.slotTabs,
      slotPages: next.slotPages ?? null,
      sourcePage: source.id,
      firstCellShows: next.slotPages?.[0] ?? null,
      secondCellShows: next.slotPages?.[1] ?? null,
      cellsWithSameInstance: next.slotTabs.filter((id) => id === next.slotTabs[0]).length,
    };
  })()`);
  check(
    "dropping a page tab on another cell puts the instance in both cells",
    split?.cellsWithSameInstance === 2,
    split,
  );
  check(
    "each cell pins its own page",
    split?.secondCellShows === split?.pageB && split?.firstCellShows === split?.pageA,
    split,
  );

  // The picture: two cells, two pages, same instance.
  const shown = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const active = state.views.find((v) => v.id === state.activeViewId);
    const strips = [...document.querySelectorAll('.slot-tabs')];
    return {
      strips: strips.length,
      currentPerStrip: strips.map((strip) =>
        strip.querySelector('.slot-tab.current')?.getAttribute('data-tab-id') ?? null,
      ),
      slotPages: active.slotPages ?? null,
      activePages: state.tabs.filter((t) => t.active).map((t) => t.id),
    };
  })()`);
  check(
    "both cells draw a strip and mark a different page as current",
    shown?.strips === 2 &&
      shown?.currentPerStrip?.[0] &&
      shown?.currentPerStrip?.[1] &&
      shown.currentPerStrip[0] !== shown.currentPerStrip[1],
    shown,
  );

  /**
   * A split cell is pinned to one page, so its strip is a label, not a switcher.
   *
   * The first version of this test clicked "the other page" inside cell 2 — which
   * no longer exists there, by design. That absence *is* the behaviour worth
   * asserting: the way to change what a split cell shows is to un-split it (or
   * drag a different page onto it), and that is what makes the two strips
   * distinguishable at all.
   */
  const pinned = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    const before = { cell0: view.slotPages?.[0] ?? null, cell1: view.slotPages?.[1] ?? null };
    const strips = [...document.querySelectorAll('.slot-tabs')];
    // Cell 2 lists only its own page; the sibling's page is not offered here.
    const offered = [...strips[1].querySelectorAll('.slot-tab')].map(
      (el) => el.getAttribute('data-tab-id'),
    );
    // Clicking the pill that *is* there must not move the cell's pin.
    strips[1].querySelector('.slot-tab')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
    const after = await api.getEmbeddedState();
    const next = after.views.find((v) => v.id === view.id);
    return {
      before,
      offered,
      onlyOwnPage: offered.length === 1 && offered[0] === before.cell1,
      siblingPageOffered: offered.includes(before.cell0),
      after: { cell0: next.slotPages?.[0] ?? null, cell1: next.slotPages?.[1] ?? null },
    };
  })()`);
  check(
    "a split cell offers only its own page, not the sibling's",
    pinned?.onlyOwnPage === true && pinned?.siblingPageOffered === false,
    pinned,
  );
  check(
    "clicking the pill in a split cell leaves both cells where they are",
    pinned?.after?.cell0 === pinned?.before?.cell0 &&
      pinned?.after?.cell1 === pinned?.before?.cell1,
    pinned,
  );

  /**
   * The chrome has to say which cell shows which page.
   *
   * Reported symptom: after a split both cells drew the full page list, so the
   * two strips were identical and neither cell told you what it was showing. And
   * the dock nested the same pages under themselves while the header said 1/2
   * with two full cells — the count and the nesting described different things.
   */
  const chrome = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    const strips = [...document.querySelectorAll('.slot-tabs')];
    // Scope to the active view: the loose tab block shares the view-block
    // class and has its own rows, one of which is off-stage and marked with a dot.
    const dockRows = [...document.querySelectorAll('.view-block.active .rows > .instance')];
    return {
      strips: strips.length,
      pillsPerStrip: strips.map((strip) => strip.querySelectorAll('.slot-tab').length),
      activePerStrip: strips.map(
        (strip) => strip.querySelector('.slot-tab.current')?.getAttribute('data-tab-id') ?? null,
      ),
      unsplitButtons: document.querySelectorAll('.slot-tab-merge').length,
      addButtons: document.querySelectorAll('.slot-tab-add').length,
      dockRows: dockRows.length,
      dockSlots: dockRows.map((row) => row.querySelector('.slot-no')?.textContent?.trim() ?? ''),
      dockNestedPages: dockRows.map((row) => row.querySelectorAll('.page-row').length),
      dockPageBadges: dockRows.map(
        (row) => row.querySelector('.pages-badge')?.textContent?.trim() ?? '',
      ),
      dockCount: document.querySelector('.view-block.active .view-count')?.textContent?.trim() ?? '',
      expected: { cell0: view.slotPages?.[0] ?? null, cell1: view.slotPages?.[1] ?? null },
    };
  })()`);
  check(
    "each split cell's strip lists only its own page",
    chrome?.strips === 2 &&
      chrome?.pillsPerStrip?.every((count) => count === 1) &&
      chrome?.activePerStrip?.[0] !== chrome?.activePerStrip?.[1],
    chrome,
  );
  check(
    "a split cell swaps the new-page button for an unsplit control",
    chrome?.unsplitButtons === 2 && chrome?.addButtons === 0,
    chrome,
  );
  check(
    "the dock draws one row per cell, each with its own slot number",
    chrome?.dockRows === 2 &&
      chrome?.dockSlots?.[0] === "1" &&
      chrome?.dockSlots?.[1] === "2",
    chrome,
  );
  check(
    "no dock row lists a window's internal pages",
    chrome?.dockNestedPages?.every((count) => count === 0),
    chrome,
  );
  check(
    "a row says how many pages its window holds, as a count only",
    chrome?.dockPageBadges?.every((badge) => badge === "2"),
    chrome,
  );
  check(
    "the dock's view count matches the two occupied cells",
    chrome?.dockCount === "2/2",
    chrome,
  );

  // A layout pass must not collapse the split back to one cell.
  const survive = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    // Force a re-layout through a geometry change, the same path a dock resize
    // or a stage report takes.
    const before = view.slotRects ?? null;
    await api.setEmbeddedViewSlots(view.id, [
      { x: 0, y: 0, width: 0.42, height: 1 },
      { x: 0.42, y: 0, width: 0.58, height: 1 },
    ]);
    await new Promise((r) => setTimeout(r, 900));
    const after = await api.getEmbeddedState();
    const next = after.views.find((v) => v.id === view.id);
    return {
      before,
      slots: next.slotTabs,
      slotPages: next.slotPages ?? null,
      duplicates: next.slotTabs.filter((id) => id && id === next.slotTabs[0]).length,
    };
  })()`);
  check(
    "a re-layout keeps both cells on the same instance",
    survive?.duplicates === 2,
    survive,
  );
  check(
    "the page pins survive the re-layout too",
    Boolean(survive?.slotPages?.[1]),
    survive,
  );

  /**
   * Regression: dragging the page a cell is *showing* onto its own sibling.
   *
   * Before the fix both cells ended up naming the dropped page — the freeze
   * pass pinned it into the source cell while the drop pinned it into the
   * target, and one page cannot fill two cells: the second setBounds won, the
   * first cell went dark, and both strips carried the same pill. The sibling
   * must land on the instance's other page instead, which here means the two
   * cells swap pages.
   */
  const draggedBack = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    const cell0 = view.slotPages?.[0] ?? null;
    const cell1 = view.slotPages?.[1] ?? null;
    const drag = new DataTransfer();
    drag.setData('text/plain', cell1);
    drag.setData('application/x-ensemble-page', cell1);
    const header = [...document.querySelectorAll('.slot-header')][0];
    header?.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: drag }));
    header?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: drag }));
    await new Promise((r) => setTimeout(r, 1600));
    const after = await api.getEmbeddedState();
    const next = after.views.find((v) => v.id === view.id);
    return {
      cell0,
      cell1,
      slots: next.slotTabs,
      slotPages: next.slotPages ?? null,
      duplicates: next.slotTabs.filter((id) => id && id === next.slotTabs[0]).length,
    };
  })()`);
  check(
    "dragging a shown page onto its sibling keeps one page per cell",
    draggedBack?.duplicates === 2 &&
      draggedBack?.slotPages?.[0] === draggedBack?.cell1 &&
      draggedBack?.slotPages?.[1] === draggedBack?.cell0,
    draggedBack,
  );

  // Closing the pinned page must not leave the cell pointing at a dead page —
  // nor leave it pointing at the sibling's page, which would be the same picture
  // twice and exactly the duplicate this feature exists to prevent.
  const closed = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    const pinned = view.slotPages?.[1];
    await api.closeEmbeddedTab(pinned);
    await new Promise((r) => setTimeout(r, 1300));
    const after = await api.getEmbeddedState();
    const next = after.views.find((v) => v.id === view.id);
    return {
      closed: pinned,
      slots: next.slotTabs,
      slotPages: next.slotPages ?? null,
      alive: after.tabs.some((t) => t.id === pinned),
    };
  })()`);
  check(
    "closing a pinned page clears the pin instead of leaving a dead reference",
    closed?.alive === false && !closed?.slotPages?.[1],
    closed,
  );
  check(
    "the split cell is released rather than showing its sibling's page twice",
    Boolean(closed?.slots?.[1]) === false,
    closed,
  );

  /**
   * Regression, single-page branch: with nothing else to show, dragging the
   * instance's only page to another cell has to *move* the instance. The old
   * freeze pass pinned the shown page into both cells — impossible to honour,
   * and the loser rendered as an empty cell. Released here means the source
   * cell lets go and the instance now lives where it was dropped.
   */
  const draggedAlone = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const view = state.views.find((v) => v.id === state.activeViewId);
    const pageId = view.slotTabs.find(Boolean);
    const drag = new DataTransfer();
    drag.setData('text/plain', pageId);
    drag.setData('application/x-ensemble-page', pageId);
    const empty = [...document.querySelectorAll('.slot-empty')][0];
    empty?.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: drag }));
    empty?.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: drag }));
    await new Promise((r) => setTimeout(r, 1600));
    const after = await api.getEmbeddedState();
    const next = after.views.find((v) => v.id === view.id);
    return {
      pageId,
      slots: next.slotTabs,
      slotPages: next.slotPages ?? null,
      alive: after.tabs.some((t) => t.id === pageId),
      headers: document.querySelectorAll('.slot-header').length,
    };
  })()`);
  check(
    "dragging an instance's only page to another cell moves it there",
    draggedAlone?.slots?.[0] === null &&
      draggedAlone?.slots?.[1] === draggedAlone?.pageId &&
      draggedAlone?.alive === true,
    draggedAlone,
  );
  check(
    "the vacated cell draws no header band after the move",
    draggedAlone?.headers === 1,
    draggedAlone,
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
