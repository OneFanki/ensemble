#!/usr/bin/env node
/**
 * The AI activity panel follows the tab, and the full log arrives filtered.
 *
 * Three claims, each separately false-able:
 *
 * 1. The panel behind the address row lists the site of the page in front, not
 *    the whole workspace. Seeded with two origins, so "shows one group" is a
 *    real assertion rather than "the list happens to be short".
 * 2. "查看全部" lands on the full log already narrowed to that site — the panel
 *    showed a slice of it, so landing on some other site's newest record answers
 *    a question nobody asked.
 * 3. Clearing the site chip shows every site again.
 *
 * The page itself also has to scroll and its script row has to open. It used to
 * be a plain flex child of `.page`, so everything below the window was clipped
 * with no scrollbar, and rows stored only a one-line summary.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-ai-activity-"));
const now = Date.now();
const detailId = "activity-detail-1";
/** The second origin: present in the log, never on screen. */
const OTHER_ORIGIN = "https://elsewhere.test";

/*
 * A real page, so the panel has a real origin to follow.
 *
 * A seeded log alone cannot test "only the current site": with no page in front
 * every origin is equally absent, and a panel that showed nothing would pass.
 */
const site = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>活动记录</title></head>
<body><h1>活动记录</h1></body></html>`);
});
const sitePort = await freePort();
await new Promise((done) => site.listen(sitePort, "127.0.0.1", done));
const origin = `http://127.0.0.1:${sitePort}`;
const pageUrl = `${origin}/activity`;

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
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
    bookmarkFolders: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "browser",
    guideVersion: GUIDE_SEEN,
  }),
);

const records = Array.from({ length: 34 }, (_, index) => {
  const isDetail = index === 0;
  const at = new Date(now - index * 1000).toISOString();
  return {
    id: isDetail ? detailId : `activity-${index}`,
    at,
    tool: "evaluate_browser_page",
    origin,
    profileId: "default",
    tabId: "tab-activity",
    tabTitle: "活动记录",
    summary: isDetail ? "执行脚本：return document.title" : `执行脚本：step ${index}`,
    ...(isDetail
      ? {
          details: [
            {
              at,
              args: { expression: "return document.title" },
              result: "面板探针",
            },
          ],
        }
      : {}),
    ok: true,
    originAuthorized: true,
    count: 1,
  };
});
// One record from a site the browser is not showing. The panel must not draw it.
records.push({
  id: "activity-other",
  at: new Date(now + 5_000).toISOString(),
  tool: "evaluate_browser_page",
  origin: OTHER_ORIGIN,
  profileId: "default",
  tabId: "tab-other",
  tabTitle: "别处",
  summary: "执行脚本：another site",
  ok: true,
  originAuthorized: true,
  count: 1,
});
writeFileSync(join(userData, "ai-activity.json"), JSON.stringify({ records }));

const messages = Array.from({ length: 40 }, (_, index) => ({
  id: `message-${index}`,
  at: new Date(now - index * 1000).toISOString(),
  kind: "app",
  tone: "info",
  titleKey: "app.about",
  detail: `第 ${index} 条消息`,
  read: true,
}));
writeFileSync(join(userData, "messages.json"), JSON.stringify({ messages }));

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

async function waitFor(client, expression, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
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
  await wait(2500);

  /*
   * Open the page the log is about, and make it the tab in front.
   *
   * The panel reads the active tab's origin. Without a page there the panel has
   * nothing to follow, and "shows only this site" degrades into "shows nothing",
   * which is also what a broken filter looks like.
   */
  const opened = await client.evaluate(`(async () => {
    const tab = await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(pageUrl)} });
    const id = tab?.id ?? tab?.tab?.id ?? "";
    if (id) await window.ensemble.activateEmbeddedTab(id);
    return { id, url: tab?.url ?? tab?.tab?.url ?? "" };
  })()`);
  check("a page is open in front", Boolean(opened?.id), opened);
  await wait(1200);

  // The panel is behind the toolbar's AI button; its "view all" opens the whole
  // log in a layer. Opening it first proves the panel is scoped to the page.
  await client.evaluate(`(async () => {
    document.querySelector('[data-ai-panel]')?.click();
    await new Promise((r) => setTimeout(r, 600));
  })()`);
  const panelGroups = await client.evaluate(`(() => {
    const names = [...document.querySelectorAll('[data-ai-group]')].map((el) => ({
      key: el.getAttribute('data-ai-group'),
      text: el.textContent?.trim() ?? "",
    }));
    return { names, hasOther: names.some((item) => item.key === 'origin:${OTHER_ORIGIN}') };
  })()`);
  check(
    "the panel lists the open site's records and no other site's",
    panelGroups?.names?.length === 1 &&
      panelGroups.names[0].key === `origin:${origin}` &&
      panelGroups.hasOther === false,
    panelGroups,
  );

  await client.evaluate(`(async () => {
    document.querySelector('[data-ai-open-console]')?.click();
    await new Promise((r) => setTimeout(r, 900));
  })()`);
  const filtered = await client.evaluate(`(() => {
    const chip = document.querySelector('[data-ai-origin-filter]');
    return {
      chip: chip?.textContent?.trim() ?? "",
      groups: [...document.querySelectorAll('[data-ai-activity-group]')].map((el) =>
        el.getAttribute('data-ai-activity-group'),
      ),
    };
  })()`);
  check(
    "查看全部 lands on this site's log, with the filter visible",
    filtered?.chip?.includes(origin) &&
      filtered.groups?.length === 1 &&
      filtered.groups[0] === `origin:${origin}`,
    filtered,
  );

  // Clearing the chip is the one click that shows the whole workspace.
  await waitFor(client, `Boolean(document.querySelector('[data-ai-origin-filter]'))`);
  await client.evaluate(`document.querySelector('[data-ai-origin-filter]')?.click()`);
  const cleared = await waitFor(
    client,
    `document.querySelectorAll('[data-ai-activity-group]').length === 2`,
  );
  const clearedGroups = await client.evaluate(
    `[...document.querySelectorAll('[data-ai-activity-group]')].map((el) => el.getAttribute('data-ai-activity-group'))`,
  );
  check(
    "clearing the chip shows every site again",
    cleared === true &&
      clearedGroups.includes(`origin:${origin}`) &&
      clearedGroups.includes(`origin:${OTHER_ORIGIN}`),
    { groups: clearedGroups },
  );

  const rendered = await waitFor(
    client,
    `document.querySelectorAll('[data-ai-record]').length >= 30`,
  );
  check("the activity page lists the seeded calls", rendered, {
    rows: await client.evaluate(`document.querySelectorAll('[data-ai-record]').length`),
  });

  const scroller = await client.evaluate(`(() => {
    const el = document.querySelector('[data-ai-activity-scroll]');
    if (!el) return null;
    const before = el.scrollTop;
    el.scrollTop = 300;
    return {
      exists: true,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      before,
      after: el.scrollTop,
    };
  })()`);
  check(
    "the activity page scrolls instead of clipping the history",
    scroller?.exists === true &&
      scroller.scrollHeight > scroller.clientHeight + 20 &&
      scroller.after > scroller.before,
    scroller,
  );

  await client.evaluate(
    `document.querySelector('[data-ai-record="${detailId}"]')?.click()`,
  );
  const detail = await waitFor(
    client,
    `Boolean(document.querySelector('[data-ai-record-detail="${detailId}"]'))`,
  );
  const detailText = await client.evaluate(`(() => {
    const root = document.querySelector('[data-ai-record-detail="${detailId}"]');
    const script = root?.querySelector('[data-ai-detail-script]')?.textContent ?? "";
    const result = root?.querySelector('[data-ai-detail-result]')?.textContent ?? "";
    return { script, result };
  })()`);
  check(
    "expanding a script row shows the script and the result",
    detail === true &&
      String(detailText?.script).includes("document.title") &&
      String(detailText?.result).includes("面板探针"),
    detailText,
  );

  await client.evaluate(openNav("messages"));
  const messagesRendered = await waitFor(
    client,
    `document.querySelectorAll('[data-message-id]').length >= 20`,
  );
  const messageScroll = await client.evaluate(`(() => {
    const el = document.querySelector('[data-message-scroll]');
    if (!el) return null;
    const before = el.scrollTop;
    el.scrollTop = 300;
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      before,
      after: el.scrollTop,
    };
  })()`);
  check(
    "the messages page scrolls through a long list",
    messagesRendered === true &&
      messageScroll?.scrollHeight > messageScroll?.clientHeight + 20 &&
      messageScroll.after > messageScroll.before,
    { rendered: messagesRendered, scroll: messageScroll },
  );

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  site.close();
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
