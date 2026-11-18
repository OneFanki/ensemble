#!/usr/bin/env node
/**
 * End-to-end check of one instance, several pages, one stage.
 *
 * The gesture this suite used to guard — dragging a page tab onto another cell
 * to show one browser in two cells — is retired (ADR 0012: the stage is
 * single-cell; side-by-side comparison moves to separate windows and the
 * operating system's own split). What the split existed to protect, though, is
 * still the contract worth testing: **pages of one instance share one
 * session**, because the instance is the thing that owns the cookies.
 *
 * So the suite now proves, on the single stage:
 *
 * 1. A second page of the same instance runs in the same session partition —
 *    a cookie the first page's request earned shows up in the second page's
 *    request. A second *instance* would be a second login, which is exactly
 *    what this must not be.
 * 2. The stage shows exactly one page at a time: the active page holds the
 *    whole stage, everything else is parked off window.
 * 3. Switching pages moves the stage, and closing the shown page hands the
 *    stage to a survivor instead of leaving a dead reference.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-split-"));

// The page echoes every cookie it received into its title, so a session shared
// between two pages is visible in the state the chrome already reports.
const page = createServer((req, res) => {
  res.setHeader("set-cookie", "splitprobe=shared-session; path=/");
  const cookie = req.headers.cookie ?? "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>同实例 ${req.url} ${cookie ? `[${cookie}]` : ""}</title><h1>${req.url}</h1>`);
});
await new Promise((done) => page.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${page.address().port}`;

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const ids = ["a"].map(
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
        name: "同实例站点",
        baseUrl,
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [identity(ids[0], "账号甲", "amber")],
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

  const opened = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.openEmbeddedIdentity('${ids[0]}');
    await new Promise((r) => setTimeout(r, 2400));
    const root = state.tabs.find((t) => t.identityId === '${ids[0]}');
    // A second page inside the same instance: one session, two tabs. The "+"
    // opens a blank first; navigate it so its request proves the shared cookie.
    const blank = await api.openEmbeddedTabInInstance(root.instanceId);
    const created = blank.tabs.filter((t) => t.instanceId === root.instanceId).find((t) => t.id !== root.id);
    await api.navigateEmbeddedTab(created.id, '${baseUrl}/second');
    await new Promise((r) => setTimeout(r, 1800));
    const pages = blank.tabs.filter((t) => t.instanceId === root.instanceId);
    return {
      instanceId: root.instanceId,
      pages: pages.map((t) => ({ id: t.id, title: t.title, active: t.active })),
      activeTabId: blank.activeTabId,
      chips: [...document.querySelectorAll('[data-instance-chip]')].map((el) =>
        el.getAttribute('data-instance-chip'),
      ),
    };
  })()`);
  check(
    "the instance gets a second page in the same session",
    opened?.pages?.length === 2 && opened?.chips?.includes(opened?.instanceId),
    opened,
  );

  // The stage is single-cell: exactly one page of the instance is active, and
  // every other page is parked off window (no rect of its own).
  const single = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const onStage = state.tabs.filter((t) => t.active && (t.bounds?.width ?? 0) > 0);
    const blankActive = state.tabs.filter((t) => t.active && !t.bounds);
    const parked = state.tabs.filter((t) => !t.active);
    return {
      onStage: onStage.map((t) => t.id),
      blankActive: blankActive.length,
      parkedWidths: parked.map((t) => t.bounds?.width ?? 0),
      activeCount: state.tabs.filter((t) => t.active).length,
    };
  })()`);
  check(
    "exactly one page holds the stage; the rest are parked off window",
    single?.activeCount === 2 &&
      single?.onStage?.length + single?.blankActive === 1 &&
      single?.parkedWidths?.every((width) => width === 0),
    single,
  );

  // Session sharing: the second request must carry the cookie the first earned.
  const shared = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const pages = state.tabs.filter((t) => t.identityId === '${ids[0]}');
    const navigated = pages.find((t) => (t.title ?? "").includes("/second"));
    return {
      pageTitles: pages.map((t) => t.title),
      shared: Boolean(navigated && (navigated.title ?? "").includes("splitprobe=shared-session")),
    };
  })()`);
  check(
    "pages of one instance share one session (cookie carries across tabs)",
    shared?.shared === true,
    shared,
  );

  // Switching pages moves the whole stage: the target becomes the selected tab
  // and holds the stage (a real rect). `active` is per-instance, so the flat
  // list shows one active tab per instance — the stage answers for the whole
  // surface, which is what activeTabId and bounds describe.
  const switched = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const pages = state.tabs.filter((t) => t.instanceId === '${opened?.instanceId ?? ""}');
    const target = pages.find((t) => (t.bounds?.width ?? 0) === 0);
    await api.activateEmbeddedTab(target.id);
    await new Promise((r) => setTimeout(r, 900));
    const after = await api.getEmbeddedState();
    const onStage = after.tabs.find((t) => t.id === target.id);
    return {
      target: target.id,
      selectedId: after.activeTabId,
      stageWidth: onStage?.bounds?.width ?? 0,
      strip: [...document.querySelectorAll('.tabstrip .tab')].map((el) =>
        el.getAttribute('data-tab-id'),
      ),
    };
  })()`);
  check(
    "switching pages moves the stage, and the strip marks the new page",
    switched?.selectedId === switched?.target &&
      (switched?.stageWidth ?? 0) > 0 &&
      switched?.strip?.includes(switched?.target),
    switched,
  );

  // Closing the shown page hands the stage to the survivor.
  const closed = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const shown = state.tabs.find((t) => t.active);
    await api.closeEmbeddedTab(shown.id);
    await new Promise((r) => setTimeout(r, 1300));
    const after = await api.getEmbeddedState();
    return {
      closed: shown.id,
      alive: after.tabs.some((t) => t.id === shown.id),
      activeNow: after.tabs.filter((t) => t.active).map((t) => t.id),
      remaining: after.tabs.map((t) => t.id),
    };
  })()`);
  check(
    "closing the shown page hands the stage to the survivor",
    closed?.alive === false && closed?.activeNow?.length === 1,
    closed,
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
