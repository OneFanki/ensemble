#!/usr/bin/env node
/**
 * End-to-end check of the empty stage's "new tab" answer.
 *
 * The empty slot's dashed "add a page here" cell is retired with the multi-cell
 * stage (ADR 0012). What it existed to guarantee, though, is still the contract:
 * with nothing running, the stage has to look like a place a page belongs and
 * put the new page there, focused — so the follow-up ("type an address") starts
 * from the right tab.
 *
 * The single stage answers this with its own empty state (a "new tab" action on
 * the stage) plus the toolbar's "+" and the address bar, which navigates the
 * page it opens.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-slot-"));
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

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
        name: "空槽位站点",
        baseUrl: "http://127.0.0.1:3997",
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
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
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

  const empty = await client.evaluate(`(async () => {
    const api = window.ensemble;
    // Close the tab a fresh start opens, so the stage is genuinely empty —
    // the state the old dashed cells and the new empty state both answer.
    const state = await api.getEmbeddedState();
    for (const tab of state.tabs) await api.closeEmbeddedTab(tab.id);
    await new Promise((r) => setTimeout(r, 900));
    return {
      emptyState: document.querySelectorAll('.stage-empty').length,
      newTabAction: document.querySelector('.stage-empty-action')?.textContent?.trim() ?? null,
      launch: Boolean(document.querySelector('[data-launch-btn]')),
      railEntries: document.querySelectorAll('[data-rail-entry]').length,
      address: document.querySelector('.address input')?.value ?? null,
      cells: document.querySelectorAll('.slot-empty').length,
    };
  })()`);
  check("a workspace with nothing running shows the stage's empty state", empty?.emptyState === 1, empty);
  check("the empty state offers the new-tab action", Boolean(empty?.newTabAction), empty);
  check(
    "the rail keeps its launching and management entrances available",
    // One management entry now: sites and groups are configured inside the
    // accounts pane, and everything else moved to settings.
    empty?.launch === true && empty?.railEntries === 1,
    empty,
  );
  check("a blank page leaves the address bar empty", empty?.address === "", empty?.address);
  check("no dashed empty cell is drawn on the single stage", empty?.cells === 0, empty);

  // The stage's own action creates one page, on the stage, focused.
  const clicked = await client.evaluate(`(async () => {
    const before = await window.ensemble.getEmbeddedState();
    document.querySelector('.stage-empty-action')?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const state = await window.ensemble.getEmbeddedState();
    return {
      // Relative to the empty stage: exactly one page appears.
      tabs: state.tabs.length - before.tabs.length,
      active: state.activeTabId,
      stageTab: Boolean(document.querySelector('.stage-empty')),
      address: document.querySelector('.address input')?.value ?? null,
      strip: [...document.querySelectorAll('.tabstrip .tab')].map((el) =>
        el.getAttribute('data-tab-id'),
      ),
    };
  })()`);
  check("clicking the empty stage's action creates one page", clicked?.tabs === 1, clicked);
  check(
    "the new page takes the stage and the strip lists it",
    clicked?.active === clicked?.strip?.[0] && clicked?.stageTab === false,
    clicked,
  );
  check("the new page starts with an empty address bar", clicked?.address === "", clicked?.address);

  const titles = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const row = document.querySelector('.tabstrip .tab .tab-label')?.textContent?.trim();
    return { row, label: state.tabs[0]?.label, title: state.tabs[0]?.title };
  })()`);
  check(
    "the strip falls back to the tab label until the page reports a title",
    titles?.row === "新标签页" && titles?.row === titles?.label,
    titles,
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
