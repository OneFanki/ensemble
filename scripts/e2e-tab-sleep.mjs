#!/usr/bin/env node
/**
 * Background tab sleep, end to end.
 *
 * The feature is only true if it is true in a real page: a parked tab stops
 * running JavaScript after a grace period, waking it by clicking its tab or by
 * an AI command actually resumes it, "never sleep" survives passes of the sweep,
 * and a long AI script counts as activity until it finishes. Those are native
 * lifecycle transitions, so nothing short of a running app can assert them.
 *
 * Timings are shrunk through `ENSEMBLE_SLEEP_TEST`; production keeps a 60s grace
 * and a 10s sweep. The suite is deliberately sequential — each check depends on
 * the state the previous one left behind.
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

const GRACE_MS = 1_500;
const SWEEP_MS = 200;
const MCP_PORT = await freePort();
const TOKEN = "tab-sleep-check-token-0123456789";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-sleep-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>sleep${req.url}</title></head>` +
      `<body><h1 id="head">sleep${req.url}</h1><p>a parked page</p></body></html>`,
  );
});
const pagePort = await freePort();
await new Promise((done) => page.listen(pagePort, "127.0.0.1", done));
const firstUrl = `http://127.0.0.1:${pagePort}/first`;
const secondUrl = `http://127.0.0.1:${pagePort}/second`;

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [],
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
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
    // The long-script check needs a write-tier AI command. Origin gating has its
    // own suite; here the policy is opened so the sleep path is what is measured.
    aiMode: "allow-all",
  }),
  { mode: 0o600 },
);

// `ENSEMBLE_ELECTRON_BIN` lets a machine whose electron dist was not installed
// point the suite at another copy of the same version.
const electron =
  process.env.ENSEMBLE_ELECTRON_BIN ??
  (process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
const app = spawn(electron, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: {
    ...process.env,
    ENSEMBLE_HEADLESS: "1",
    ENSEMBLE_SLEEP_TEST: "1",
    ENSEMBLE_SLEEP_GRACE_MS: String(GRACE_MS),
    ENSEMBLE_SLEEP_SWEEP_MS: String(SWEEP_MS),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function callTool(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++seq,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  const result = json.result;
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "failed"}`);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

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

  // MCP is how an AI drives a page; the sleep feature has to apply to that path
  // too, so the suite talks to the real endpoint rather than to a test hook.
  let mcpReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(250);
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) {
        mcpReady = true;
        break;
      }
    } catch {
      // Starting up.
    }
  }
  check("MCP endpoint came up", mcpReady, mcpReady ? undefined : appLog.slice(-600));
  if (!mcpReady) throw new Error("no MCP endpoint");

  const opened = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const first = await api.openEmbeddedTab({ url: ${JSON.stringify(firstUrl)}, viewId: null });
    await new Promise((r) => setTimeout(r, 1500));
    // A second page in the *same* instance: only then do both appear in the
    // window's tab strip, and only then is one of them parked behind the other.
    const grown = await api.openEmbeddedTabInInstance(first.instanceId);
    const second = grown.tabs.find(
      (t) => t.instanceId === first.instanceId && t.id !== first.id,
    );
    if (!second) return { missing: true, tabs: grown.tabs.map((t) => t.url) };
    await api.navigateEmbeddedTab(second.id, ${JSON.stringify(secondUrl)});
    await new Promise((r) => setTimeout(r, 1500));
    // Park the second page: the first one takes the stage and stays there.
    await api.activateEmbeddedTab(first.id);
    await new Promise((r) => setTimeout(r, 600));
    const state = await api.getEmbeddedState();
    return {
      first: first.id,
      second: second.id,
      urls: state.tabs
        .filter((t) => t.instanceId === first.instanceId)
        .map((t) => ({ id: t.id, url: t.url })),
    };
  })()`);
  check("two real pages open, one of them parked", Boolean(opened?.first && opened?.second), opened);
  if (!opened?.first || !opened?.second) throw new Error("pages did not open");
  const firstId = opened.first;
  const secondId = opened.second;

  const tabState = async (id) =>
    client.evaluate(`(async () => {
      const state = await window.ensemble.getEmbeddedState();
      const tab = state.tabs.find((item) => item.id === ${JSON.stringify(id)});
      return {
        alive: Boolean(tab),
        sleeping: tab?.sleeping === true,
        sleepExempt: tab?.sleepExempt ?? null,
        policy: tab?.sleepPolicy ?? null,
        active: state.activeTabId === ${JSON.stringify(id)},
      };
    })()`);

  /** Polls until the tab reports the wanted sleep state, or gives up. */
  async function waitSleepState(id, want, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await tabState(id);
      if (last.alive && last.sleeping === want) return last;
      await wait(200);
    }
    return last;
  }

  /*
   * S7 regression, forward direction: a page an AI opens through
   * `open_browser_tab` lands in its own instance — no stage cell, no selection,
   * and no "occupies a slot so it never sleeps" exemption. Idle, it freezes
   * like any other parked page; a read wakes it and the next idle freezes it
   * again. The rail chip of a fully sleeping instance carries the freeze mark.
   */
  const aiOpened = await callTool("open_browser_tab", { url: firstUrl });
  const aiTabId = aiOpened?.id ?? aiOpened?.tabId;
  check("an AI-opened page returns its id", Boolean(aiTabId), aiOpened);
  if (!aiTabId || !aiOpened?.instanceId) {
    throw new Error(`no ai tab id in ${JSON.stringify(aiOpened)}`);
  }
  await wait(1500);
  const aiPlacement = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === ${JSON.stringify(aiTabId)});
    return {
      selected: state.activeTabId === ${JSON.stringify(aiTabId)},
      inSlot: state.views.some((v) => (v.slotTabs ?? []).includes(${JSON.stringify(aiTabId)})),
      exempt: tab?.sleepExempt ?? null,
      sleeping: tab?.sleeping === true,
    };
  })()`);
  check(
    "an AI-opened page takes no stage cell and no selection",
    aiPlacement?.selected === false && aiPlacement?.inSlot === false,
    aiPlacement,
  );
  const aiAsleep = await waitSleepState(aiTabId, true);
  check(
    "an AI-opened page falls asleep once idle",
    aiAsleep?.sleeping === true,
    aiAsleep,
  );
  const aiRail = await client.evaluate(`(() => {
    const chip = document.querySelector('[data-instance-chip="${aiOpened.instanceId}"]');
    return {
      chip: Boolean(chip),
      freeze: chip?.querySelector("[data-freeze]")?.getAttribute("data-freeze") ?? null,
    };
  })()`);
  check(
    "a fully sleeping instance shows the freeze mark on its rail chip",
    aiRail?.chip === true && aiRail?.freeze === "full",
    aiRail,
  );
  const aiRead = await callTool("read_browser_page", { tabId: aiTabId });
  check(
    "reading the frozen AI page wakes it and returns its DOM",
    aiRead?.title === "sleep/first" && (aiRead?.nodes?.length ?? 0) > 0,
    { title: aiRead?.title, nodes: aiRead?.nodes?.length },
  );
  const aiWoken = await tabState(aiTabId);
  check("the AI page is marked awake after the read", aiWoken?.sleeping === false, aiWoken);
  const aiSleptAgain = await waitSleepState(aiTabId, true);
  check(
    "the AI page sleeps again once AI traffic stops",
    aiSleptAgain?.sleeping === true,
    aiSleptAgain,
  );

  const secondAsleep = await waitSleepState(secondId, true);
  check(
    "a parked page falls asleep after the grace period",
    secondAsleep?.sleeping === true,
    secondAsleep,
  );

  const firstAwake = await tabState(firstId);
  check(
    "the page on stage never falls asleep",
    firstAwake?.sleeping === false,
    firstAwake,
  );
  check(
    "the page on stage publishes why it stays awake",
    firstAwake?.sleepExempt === "on-stage-visible",
    firstAwake,
  );

  const marks = await client.evaluate(`(async () => {
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    const find = (id) => tabs.find((tab) => tab.getAttribute('data-tab-id') === id) ?? null;
    const first = find(${JSON.stringify(firstId)});
    const second = find(${JSON.stringify(secondId)});
    const closeOpacity = (tab) => {
      const close = tab?.querySelector('.tab-close');
      return close ? Number(getComputedStyle(close).opacity) : null;
    };
    // The tab's label is the app's own hover layer now, not a native title: the
    // native one could not carry the AI state dot and popped up underneath ours.
    second?.dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise((r) => setTimeout(r, 700));
    const tip = document.querySelector('.app-tooltip');
    const out = {
      firstSleep: first?.getAttribute('data-sleep') ?? null,
      secondSleep: second?.getAttribute('data-sleep') ?? null,
      secondSnowflake: Boolean(second?.querySelector('.tab-sleep')),
      secondNativeTitle: second?.getAttribute('title') ?? null,
      secondTip: tip?.classList.contains('visible') ? tip.textContent.trim() : '',
      closeFirst: closeOpacity(first),
      closeSecond: closeOpacity(second),
    };
    second?.dispatchEvent(new PointerEvent('pointerleave'));
    return out;
  })()`);
  check(
    "the sleeping tab shows a snowflake and says so",
    marks?.secondSleep === "sleeping" &&
      marks?.secondSnowflake === true &&
      // The state is in the drawn label, and the native title is gone.
      marks?.secondNativeTitle === null &&
      marks?.secondTip?.includes("已休眠"),
    marks,
  );
  check(
    "every window tab keeps its close button visible",
    (marks?.closeFirst ?? 0) >= 0.5 && (marks?.closeSecond ?? 0) >= 0.5,
    marks,
  );

  // Clicking the parked tab brings it on stage, which wakes it.
  await client.evaluate(`(() => {
    document.querySelector('.tabstrip .tab[data-tab-id="${secondId}"]')?.click();
    return true;
  })()`);
  const secondAwake = await waitSleepState(secondId, false, 4_000);
  check(
    "clicking the tab wakes the page",
    secondAwake?.sleeping === false && secondAwake?.active === true,
    secondAwake,
  );

  /** Right-clicks a window tab and picks a sleep policy from its menu. */
  async function choosePolicy(id, policy) {
    return client.evaluate(`(async () => {
      const tab = document.querySelector('.tabstrip .tab[data-tab-id="${id}"]');
      if (!tab) return { missing: true };
      const rect = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
      await new Promise((r) => setTimeout(r, 250));
      const item = document.querySelector('[data-sleep-policy="${policy}"]');
      item?.click();
      await new Promise((r) => setTimeout(r, 600));
      const state = await window.ensemble.getEmbeddedState();
      const next = state.tabs.find((item) => item.id === ${JSON.stringify(id)});
      const pill = document.querySelector('.tabstrip .tab[data-tab-id="${id}"]');
      return {
        chosen: Boolean(item),
        policy: next?.sleepPolicy ?? null,
        sleeping: next?.sleeping === true,
        pin: Boolean(pill?.querySelector('.tab-keep')),
        mark: pill?.getAttribute('data-sleep') ?? null,
      };
    })()`);
  }

  const never = await choosePolicy(secondId, "never");
  check(
    "\"never sleep\" clears the sleep state and pins the tab",
    never?.chosen === true &&
      never?.policy === "never" &&
      never?.sleeping === false &&
      never?.pin === true &&
      never?.mark === "never",
    never,
  );

  // Park it again: a policy has to survive the sweep, not just the menu click.
  await client.evaluate(`window.ensemble.activateEmbeddedTab(${JSON.stringify(firstId)})`);
  await wait(GRACE_MS + SWEEP_MS * 8);
  const stayedAwake = await tabState(secondId);
  check(
    "a never-sleep tab stays awake in the background",
    stayedAwake?.sleeping === false && stayedAwake?.policy === "never",
    stayedAwake,
  );
  check(
    "the never-sleep tab names its policy as the exemption",
    stayedAwake?.sleepExempt === "policy",
    stayedAwake,
  );

  const auto = await choosePolicy(secondId, "auto");
  check(
    "\"follow default\" clears the policy",
    auto?.chosen === true && auto?.policy === null && auto?.pin === false,
    auto,
  );
  const sleptAgain = await waitSleepState(secondId, true);
  check(
    "the page falls asleep again after the policy is cleared",
    sleptAgain?.sleeping === true,
    sleptAgain,
  );

  // A read is the AI's lightest command. It must wake a frozen page instead of
  // waiting out the command deadline, and then let it go back to sleep.
  const read = await callTool("read_browser_page", { tabId: secondId });
  check(
    "an AI read wakes a sleeping page and returns its DOM",
    read?.title === "sleep/second" && Array.isArray(read?.nodes) && read.nodes.length > 0,
    { title: read?.title, nodes: read?.nodes?.length },
  );
  const woken = await tabState(secondId);
  check("the woken page is marked awake", woken?.sleeping === false, woken);
  const afterRead = await waitSleepState(secondId, true);
  check(
    "the page returns to sleep once AI traffic stops",
    afterRead?.sleeping === true,
    afterRead,
  );

  /*
   * A long script must hold the page awake for as long as it runs. Start it
   * first, then look at the state from the outside while it is still running:
   * the grace window is much shorter than the script, so a sweep that only
   * looked at timestamps would have frozen it mid-execution.
   */
  const longScript = callTool("evaluate_browser_page", {
    tabId: secondId,
    expression: "new Promise((resolve) => setTimeout(() => resolve('done'), 4000))",
    timeoutMs: 15_000,
  });
  await wait(GRACE_MS + SWEEP_MS * 10);
  const duringScript = await tabState(secondId);
  check(
    "a running AI script keeps the page awake past the grace window",
    duringScript?.sleeping === false,
    duringScript,
  );
  const scriptResult = await longScript;
  check("the long script finishes", scriptResult === "done", scriptResult);
  const afterScript = await waitSleepState(secondId, true);
  check(
    "the page sleeps after the script finishes and the grace lapses",
    afterScript?.sleeping === true,
    afterScript,
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
