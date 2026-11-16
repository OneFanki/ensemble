#!/usr/bin/env node
/**
 * The AI activity page: it has to scroll, and a script row has to open.
 *
 * The page used to be a plain flex child of `.page`, so everything below the
 * window was clipped with no scrollbar. Rows also stored only a one-line
 * summary, which made every `evaluate_browser_page` row indistinguishable. This
 * seeds a long log plus one detailed script and drives both.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-ai-activity-"));
const now = Date.now();
const origin = "https://activity.test";
const detailId = "activity-detail-1";

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

  await client.evaluate(openNav("ai"));
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
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
