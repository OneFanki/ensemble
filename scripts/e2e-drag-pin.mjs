#!/usr/bin/env node
/**
 * Drag-and-drop of a page tab, end to end.
 *
 * The drag this suite follows used to start at a run-dock row and land in a
 * view cell; both surfaces are retired with the grid (ADR 0012). The drop
 * domain that remains is the page strip: dragging a tab onto another tab of
 * the same instance reorders that instance's tab list. The three questions
 * the old suite separated carry over unchanged:
 *
 * 1. Does the drag palette carry the id the drop handler reads?
 * 2. Does the target accept the drag at all (a dragover that never calls
 *    preventDefault kills the gesture before any drop)?
 * 3. Does the drop actually commit *that* page to that spot, or does it
 *    create something else?
 *
 * The drag is synthesised with a real `DataTransfer` and real drag events, so
 * the same handlers run as for a person dragging with a mouse. A test that
 * called the reorder API directly would pass on a build where the handlers
 * are broken.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

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

try {
  let client;
  try {
    client = await waitForWindow({ userData, waitForDebugPort });
  } catch (error) {
    // The app's own log is the only thing that explains a window that
    // never came up; without it this reads as "the debug port was slow".
    check("app window appeared", false, appLog.slice(-600));
    throw error;
  }
  check("app window appeared", true);
  await wait(3400);

  // One instance with three pages: enough to reorder without touching the
  // list's edges, with the root page back on stage when the gesture runs.
  const setup = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.openEmbeddedIdentity('${uuid(2)}');
    await new Promise((r) => setTimeout(r, 2400));
    const root = state.tabs.find((t) => t.identityId === '${uuid(2)}');
    await api.openEmbeddedTabInInstance(root.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    await api.openEmbeddedTabInInstance(root.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    await api.activateEmbeddedTab(root.id);
    await new Promise((r) => setTimeout(r, 900));
    const after = await api.getEmbeddedState();
    return {
      rootId: root.id,
      instanceId: root.instanceId,
      pages: after.tabs.filter((t) => t.instanceId === root.instanceId).map((t) => t.id),
      allTabs: after.tabs.length,
    };
  })()`);
  check("the instance holds three pages, root on stage", setup?.pages?.length === 3, setup);

  const strip = await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    return {
      tabs: tabs.map((el) => el.getAttribute('data-tab-id')),
      draggable: tabs.map((el) => el.getAttribute('draggable')),
    };
  })()`);
  check(
    "the strip's page tabs are draggable",
    strip?.tabs?.length === 3 && strip?.draggable?.every((v) => v === "true"),
    strip,
  );

  // --- The real gesture -----------------------------------------------------
  // A DataTransfer is created in the page, filled by the dragstart handler,
  // then read back here — the same object flows through the whole gesture, as
  // it does for a mouse drag.
  const gesture = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const ids = () =>
      [...document.querySelectorAll('.tabstrip .tab')].map((el) => el.getAttribute('data-tab-id'));
    const data = new DataTransfer();
    const fire = (el, type, x) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: x, clientY: 10 });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const strip = [...document.querySelectorAll('.tabstrip .tab')];
    if (strip.length < 2) return { error: 'need two page tabs' };
    const source = strip[0];
    const target = strip[1];

    // Idle: with no drag in flight the same dragover must be refused —
    // otherwise a stray dragover could park an insertion hint on the strip.
    const idleRefused = !fire(target, 'dragover', 10);

    const started = fire(source, 'dragstart', 10);
    await wait(60);
    const palette = {
      types: [...data.types],
      pageId: data.getData('application/x-ensemble-page'),
      textId: data.getData('text/plain'),
    };

    // A tab does not accept a drop onto itself.
    const selfOver = fire(source, 'dragover', 10);

    // The real target accepts the drag, and marks the edge the pointer is on.
    const r = target.getBoundingClientRect();
    const overRight = fire(target, 'dragover', r.left + r.width * 0.75);
    await wait(40);
    const hintRight = target.className;
    const overLeft = fire(target, 'dragover', r.left + r.width * 0.25);
    await wait(40);
    const hintLeft = target.className;

    const before = ids();
    // The edge is whatever the last dragover left, so aim the gesture the way
    // a mouse does: a final dragover on the right half, then the drop.
    const overForDrop = fire(target, 'dragover', r.left + r.width * 0.75);
    await wait(40);
    // Drop on the right half: the dragged page lands after its target.
    const dropped = fire(target, 'drop', r.left + r.width * 0.75);
    await wait(60);
    const pool = document.querySelector('.guest-pool');
    const afterDrop = { shielded: pool?.dataset.shielded ?? null };
    fire(source, 'dragend', 10);
    await wait(1400);

    const state = await window.ensemble.getEmbeddedState();
    const after = ids();
    return {
      idleRefused,
      started,
      palette,
      selfOver,
      overRight,
      hintRight,
      overLeft,
      hintLeft,
      before,
      overForDrop,
      dropped,
      afterDrop,
      after,
      tabCount: state.tabs.length,
    };
  })()`);

  check("a dragover with no drag in flight is refused", gesture?.idleRefused === true, gesture);
  check(
    "the drag palette carries the page id",
    gesture?.palette?.pageId === strip?.tabs?.[0] &&
      gesture?.palette?.textId === gesture?.palette?.pageId &&
      gesture?.palette?.types?.includes("application/x-ensemble-page"),
    gesture?.palette,
  );
  check("a tab refuses a drop onto itself", gesture?.selfOver === false, gesture);
  check("the drop target accepts the drag", gesture?.overRight === true && gesture?.overLeft === true, gesture);
  check(
    "the insertion mark follows the pointer's half",
    String(gesture?.hintRight ?? "").includes("drop-after") &&
      !String(gesture?.hintRight ?? "").includes("drop-before") &&
      String(gesture?.hintLeft ?? "").includes("drop-before") &&
      !String(gesture?.hintLeft ?? "").includes("drop-after"),
    { hintRight: gesture?.hintRight, hintLeft: gesture?.hintLeft },
  );
  check("the drop itself is accepted", gesture?.dropped === true, gesture);
  check(
    "the dropped page lands after its target",
    gesture?.after?.[0] === gesture?.before?.[1] &&
      gesture?.after?.[1] === gesture?.before?.[0] &&
      JSON.stringify(gesture?.after?.slice(2)) === JSON.stringify(gesture?.before?.slice(2)),
    { before: gesture?.before, after: gesture?.after },
  );
  check(
    "the reorder adds no page and no blank",
    gesture?.tabCount === setup?.allTabs && gesture?.after?.length === gesture?.before?.length,
    { before: gesture?.before, after: gesture?.after, allTabs: setup?.allTabs, tabCount: gesture?.tabCount },
  );
  check(
    "the drag signal clears when the drop commits",
    gesture?.afterDrop?.shielded === "0",
    gesture?.afterDrop,
  );

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
