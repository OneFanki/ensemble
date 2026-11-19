#!/usr/bin/env node
/**
 * End-to-end check of the window-level tab strip: drag to reorder, middle-click
 * to close.
 *
 * The stage is single-cell (ADR 0012), so the strip lists exactly one
 * instance's pages — the instance on stage. Three things a click cannot prove
 * are checked here: the order really changes (left half of a tab lands before
 * it, right half after), a page of another instance is never spliced into this
 * strip, and switching the instance on stage swaps the whole strip as a set.
 *
 * Middle-click closes, together with the case that must not close: a
 * right-button `auxclick`, which Chromium fires for every non-primary button.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";
import { openRail } from "./lib/e2e-nav.mjs";

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
    views: [],
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
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
  // The account rail starts collapsed; this suite reads its chips.
  await client.evaluate(openRail());
  await wait(400);
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
    const state = await api.openEmbeddedIdentity('${ids[0]}');
    await new Promise((r) => setTimeout(r, 2400));
    const root = state.tabs.find((t) => t.identityId === '${ids[0]}');
    // Two more pages in this instance, then back to its first page so the
    // strip shows the instance with its root as the current tab.
    await api.openEmbeddedTabInInstance(root.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    await api.openEmbeddedTabInInstance(root.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    await api.activateEmbeddedTab(root.id);
    await new Promise((r) => setTimeout(r, 900));
    const next = await api.getEmbeddedState();
    return {
      root: root.id,
      instanceId: root.instanceId,
      pages: next.tabs.filter((t) => t.instanceId === root.instanceId).map((t) => t.id),
      strip: window.__strip(),
    };
  })()`);
  check(
    "the window strip lists the on-stage instance's three pages in tab order",
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
   * A second instance joins in the background. The strip lists one browser's
   * pages; the new instance's page must not splice itself into the strip, and
   * the single stage shows one of them at a time.
   */
  const second = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const was = window.__strip();
    const state = await api.openEmbeddedIdentity('${ids[1]}');
    await new Promise((r) => setTimeout(r, 2400));
    const other = state.tabs.find((t) => t.identityId === '${ids[1]}');
    const strip = window.__strip();
    return {
      was,
      other: other?.id ?? null,
      strip,
      activeId: state.activeTabId,
      rootInstanceId: '${opened?.instanceId ?? ""}',
      otherInstancePages: other ? state.tabs.filter((t) => t.instanceId === other.instanceId).map((t) => t.id) : [],
      railChips: [...document.querySelectorAll('[data-instance-chip]')].map((el) => el.getAttribute('data-instance-chip')),
    };
  })()`);
  check(
    "the strip swaps as a set when the selection moves to another instance",
    second?.otherInstancePages?.length === 1 &&
      same(second?.strip, second?.otherInstancePages) &&
      second?.activeId === second?.other,
    second,
  );
  check(
    "the instance rail lists both instances",
    Array.isArray(second?.railChips) &&
      second.railChips.includes(second?.rootInstanceId) &&
      second.railChips.includes(second?.otherInstancePages?.[0]),
    second,
  );

  /*
   * The strip is one instance's tab list: whatever is on it, every entry belongs
   * to the same browser window. That is what makes a drag-between-strips
   * impossible — a foreign page has no pill on this strip to drag.
   */
  const foreign = await client.evaluate(`(async () => {
    const beforeState = await window.ensemble.getEmbeddedState();
    const strip = window.__strip();
    const instanceIds = [
      ...new Set(strip.map((id) => beforeState.tabs.find((t) => t.id === id)?.instanceId)),
    ];
    return { strip, instanceIds };
  })()`);
  check(
    "the strip never mixes pages of two instances",
    Array.isArray(foreign?.instanceIds) && foreign.instanceIds.length === 1,
    foreign,
  );

  // Switching back: the strip restores the first instance's page set and order.
  const back = await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.activateEmbeddedTab('${opened?.root ?? ""}');
    await new Promise((r) => setTimeout(r, 900));
    return { strip: window.__strip(), expected: ${JSON.stringify(opened?.pages ?? [])} };
  })()`);
  check(
    "switching the instance on stage restores its own strip",
    same(back?.strip, back?.expected),
    back,
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

  // Middle-click a strip tab that is not the current one.
  const middle = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const current = document.querySelector('.tabstrip .tab.active')?.getAttribute('data-tab-id');
    const id = window.__strip().find((item) => item !== current);
    const tab = document.querySelector('.tabstrip .tab[data-tab-id="' + id + '"]');
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
    tab.dispatchEvent(press);
    tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await new Promise((r) => setTimeout(r, 1200));
    const state = await api.getEmbeddedState();
    return {
      id,
      pressPrevented: press.defaultPrevented,
      alive: state.tabs.some((t) => t.id === id),
      strip: window.__strip(),
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
