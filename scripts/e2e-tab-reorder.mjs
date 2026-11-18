#!/usr/bin/env node
/**
 * Selection must not reorder lists, end to end.
 *
 * The rows this suite used to drag lived in the run dock; the dock and its
 * view blocks are retired with the grid (ADR 0012). The contract the suite
 * guards survives on the two lists the shell still has:
 *
 * - **The instance rail**: rows used to be derived from the slot table, so
 *   focusing an instance wrote a slot entry and that instance jumped to the
 *   front. A click looked like a reshuffle. The rail must inherit the fix,
 *   not the bug.
 * - **The page strip**: activating a page, or leaving the instance and
 *   coming back, must not rewrite the instance's tab order.
 *
 * The drag-reorder itself is covered where the gesture still lives — the
 * strip (e2e-drag-pin, e2e-tab-strip).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-reorder-"));
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
      views: [],
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
      guideVersion: GUIDE_SEEN,
      autoCheckUpdates: false,
    },
    null,
    2,
  ),
);

const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await wait(3000);

  // Launch leaves one blank page on the surface; the assertions below count
  // chips and tabs of this suite's own, so start from nothing.
  await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);

  // Two instances, one stage. The rail order is the order the instances
  // arrived in; nothing below may rewrite it.
  const seeded = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const first = await api.openEmbeddedTab({});
    await new Promise((r) => setTimeout(r, 1000));
    const second = await api.openEmbeddedTab({});
    await new Promise((r) => setTimeout(r, 1000));
    return { first: first.instanceId, second: second.instanceId };
  })()`);
  check("two instances created", Boolean(seeded?.first && seeded?.second), seeded);

  const railOrder = await client.evaluate(`(() =>
    [...document.querySelectorAll('[data-instance-chip]')].map((el) =>
      el.getAttribute('data-instance-chip'),
    )
  )()`);
  check(
    "the rail lists both instances in creation order",
    JSON.stringify(railOrder) === JSON.stringify([seeded?.first, seeded?.second]),
    { railOrder, seeded },
  );

  /*
   * Selecting an instance must not move it to the front.
   *
   * This is the suite's founding bug, read on the list that replaced the
   * dock's rows: click the *last* chip — if selection reordered anything,
   * that is the chip that would have moved.
   */
  const clickLast = await client.evaluate(`(async () => {
    const chips = [...document.querySelectorAll('[data-instance-chip]')];
    chips[chips.length - 1]?.click();
    await new Promise((done) => setTimeout(done, 800));
    const state = await window.ensemble.getEmbeddedState();
    const held = state.tabs.find((t) => t.id === state.activeTabId);
    return {
      heldInstance: held?.instanceId ?? null,
      railAfter: [...document.querySelectorAll('[data-instance-chip]')].map((el) =>
        el.getAttribute('data-instance-chip'),
      ),
    };
  })()`);
  check("clicking a chip focuses that instance", clickLast?.heldInstance === seeded?.second, clickLast);
  check(
    "selecting an instance does not reorder the rail",
    JSON.stringify(clickLast?.railAfter) === JSON.stringify([seeded?.first, seeded?.second]),
    clickLast,
  );

  // Give the held instance two more pages; the strip then lists three.
  await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const held = state.tabs.find((t) => t.id === state.activeTabId);
    await api.openEmbeddedTabInInstance(held.instanceId);
    await new Promise((r) => setTimeout(r, 1100));
    await api.openEmbeddedTabInInstance(held.instanceId);
    await new Promise((r) => setTimeout(r, 1100));
    return true;
  })()`);

  const stripOrder = await client.evaluate(`(() =>
    [...document.querySelectorAll('.tabstrip .tab')].map((el) => el.getAttribute('data-tab-id'))
  )()`);
  check("the held instance's strip lists its three pages", stripOrder?.length === 3, stripOrder);

  // The same contract on the strip: activating the last page must not move it.
  const activateLast = await client.evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    tabs[tabs.length - 1]?.click();
    await new Promise((done) => setTimeout(done, 900));
    return [...document.querySelectorAll('.tabstrip .tab')].map((el) => el.getAttribute('data-tab-id'));
  })()`);
  check(
    "activating a page does not reorder the strip",
    JSON.stringify(activateLast) === JSON.stringify(stripOrder),
    { before: stripOrder, after: activateLast },
  );

  // Leave the instance and come back: the strip returns in the same order.
  // That is what "the instance keeps its tab list" means in a one-stage shell.
  const roundTrip = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const chips = [...document.querySelectorAll('[data-instance-chip]')];
    chips[0]?.click();
    await new Promise((done) => setTimeout(done, 900));
    chips[chips.length - 1]?.click();
    await new Promise((done) => setTimeout(done, 900));
    return [...document.querySelectorAll('.tabstrip .tab')].map((el) => el.getAttribute('data-tab-id'));
  })()`);
  check(
    "leaving and returning keeps the strip order",
    JSON.stringify(roundTrip) === JSON.stringify(stripOrder),
    { before: stripOrder, after: roundTrip },
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
  process.exit(failed.length === 0 ? 0 : 1);
}
