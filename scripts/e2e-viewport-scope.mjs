#!/usr/bin/env node
/**
 * End-to-end checks for page resolution: scope, per page.
 *
 * Resolution is a workspace default (the toolbar's monitor button) applied to
 * every page that inherits it, plus a per-page capability that the MCP surface
 * still exposes (`set_browser_viewport` / `reset_browser_viewport`). The tab
 * menu used to carry a third copy of the same control; it no longer does, and
 * this suite pins that the default still reaches the pages that inherit it.
 *
 * The 2x2 splitter this suite used to drive is retired with the grid
 * (ADR 0012); the pages under measurement now sit in two instances behind the
 * one stage, which is exactly the reading that matters: scope is per page,
 * not per cell.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

// OS-assigned: Windows reserves ephemeral ranges after a reboot, which is what
// made a hardcoded port fail with EACCES for an earlier script.
const DEBUG_PORT = "0";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-viewport-"));

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>probe</title><h1>probe</h1>");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
/** Real port the page server got; the seeded site URL has to name it. */
const pagePort = server.address().port;
/** Base URL of the seeded site, and the prefix that identifies its page targets. */
const baseUrl = `http://127.0.0.1:${pagePort}`;

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const ids = ["a", "b", "c", "d"].map(
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
        name: "探针站点",
        baseUrl: `http://127.0.0.1:${pagePort}`,
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [
      identity(ids[0], "账号甲", "amber"),
      identity(ids[1], "账号乙", "teal"),
      identity(ids[2], "账号丙", "violet"),
      identity(ids[3], "账号丁", "rose"),
    ],
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

  // Two instances, each holding one page of this site: everything below reads
  // per-page viewport state, which the single stage carries fine. The 2x2
  // splitter this suite used to drive is retired with the grid (ADR 0012);
  // its retirement is guarded in the chrome-geometry suite.
  await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.openEmbeddedIdentity('${ids[0]}');
    await new Promise((r) => setTimeout(r, 2200));
    await api.openEmbeddedIdentity('${ids[1]}');
    await new Promise((r) => setTimeout(r, 2200));
    return true;
  })()`);

  // --- viewport: inherit -> pin -> inherit -> adaptive -----------------------
  const scope = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const tabA = state.tabs.find((t) => t.label === '账号甲');
    const tabB = state.tabs.find((t) => t.label === '账号乙');
    const read = (s) => s.tabs
      .filter((t) => t.label === '账号甲' || t.label === '账号乙')
      .map((t) => ({
        label: t.label,
        viewport: t.viewport ?? null,
        override: t.viewportOverride === undefined ? 'inherit' : t.viewportOverride,
      }));
    const step1 = read(state);

    await api.setEmbeddedViewport(tabA.id, { width: 390, height: 844 });
    await new Promise((r) => setTimeout(r, 700));
    const step2 = read(await api.getEmbeddedState());

    await api.setEmbeddedViewport(tabA.id, 'inherit');
    await new Promise((r) => setTimeout(r, 700));
    const step3 = read(await api.getEmbeddedState());

    await api.setEmbeddedViewport(tabA.id, 'adaptive');
    await new Promise((r) => setTimeout(r, 700));
    const step4 = read(await api.getEmbeddedState());

    return { tabA: tabA.id, tabB: tabB.id, step1, step2, step3, step4 };
  })()`);
  check(
    "every page starts on inherit",
    scope?.step1?.every((t) => t.override === "inherit" && t.viewport === null),
    scope?.step1,
  );
  check(
    "pinning one page leaves its siblings alone",
    scope?.step2?.find((t) => t.label === "账号甲")?.viewport?.width === 390 &&
      scope?.step2?.find((t) => t.label === "账号乙")?.viewport === null,
    scope?.step2,
  );
  check(
    "inherit clears the page's own choice",
    scope?.step3?.find((t) => t.label === "账号甲")?.override === "inherit",
    scope?.step3,
  );
  check(
    "adaptive is a distinct, explicit choice",
    scope?.step4?.find((t) => t.label === "账号甲")?.override === null &&
      scope?.step4?.find((t) => t.label === "账号甲")?.viewport === null,
    scope?.step4,
  );

  // --- workspace default reaches inheriting pages only ---------------------
  const global = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    // 账号甲 currently opted out (adaptive); 账号乙 inherits.
    await api.saveAppSettings({ browserViewport: { width: 768, height: 1024 } });
    await new Promise((r) => setTimeout(r, 900));
    const after = await api.getEmbeddedState();
    // Now send the opted-out page back to inherit: it must follow immediately.
    const tabA = after.tabs.find((t) => t.label === '账号甲');
    await api.setEmbeddedViewport(tabA.id, 'inherit');
    await new Promise((r) => setTimeout(r, 800));
    const final = await api.getEmbeddedState();
    const pick = (s, label) => {
      const t = s.tabs.find((x) => x.label === label);
      return { viewport: t?.viewport ?? null, override: t?.viewportOverride === undefined ? 'inherit' : t.viewportOverride };
    };
    await api.saveAppSettings({ browserViewport: null });
    return { after: pick(after, '账号乙'), optedOut: pick(after, '账号甲'), rejoined: pick(final, '账号甲') };
  })()`);
  check(
    "the workspace default applies to a page that inherits",
    global?.after?.viewport?.width === 768 && global?.after?.override === "inherit",
    global,
  );
  check(
    "a page that opted out ignores the workspace default",
    global?.optedOut?.viewport === null && global?.optedOut?.override === null,
    global,
  );
  check(
    "sending it back to inherit picks the default up",
    global?.rejoined?.viewport?.width === 768,
    global,
  );

  // Clearing the default must go back to adaptive. This is a regression guard
  // for a silent no-op: settings travel through `JSON.stringify`, which drops
  // `undefined`, so `saveAppSettings({ browserViewport: undefined })` arrived as
  // `{}` and the main process saw no key to act on — the size stayed applied and
  // "自适应" looked broken.
  const cleared = await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.saveAppSettings({ browserViewport: { width: 1280, height: 720 } });
    await new Promise((r) => setTimeout(r, 800));
    const pinned = await api.getEmbeddedState();
    await api.saveAppSettings({ browserViewport: null });
    await new Promise((r) => setTimeout(r, 900));
    const adaptive = await api.getEmbeddedState();
    const settings = await api.getWorkspace();
    const pick = (s) => {
      const t = s.tabs.find((x) => x.label === '账号乙');
      return { viewport: t?.viewport ?? null, override: t?.viewportOverride === undefined ? 'inherit' : t.viewportOverride };
    };
    return { pinned: pick(pinned), adaptive: pick(adaptive), stored: settings.settings.browserViewport ?? null };
  })()`);
  check(
    "a workspace default can be cleared back to adaptive",
    cleared?.adaptive?.viewport === null && cleared?.stored === null,
    cleared,
  );
  check(
    "clearing it does not turn into a per-page override",
    cleared?.adaptive?.override === "inherit",
    cleared,
  );

  /**
   * The rendered size must follow, not just the reported state.
   *
   * While a viewport is active the fit scale owns `webContents` zoom, so a page
   * that simply stops having a fixed size keeps rendering at that scale. The
   * chrome reads `zoomOverride ?? defaultZoom` and would honestly print 100%
   * while the page was still shrunk — reported as "it says 100% but it is not".
   * `innerWidth` is the only reading that cannot lie, so this drives the real
   * page over CDP instead of trusting the state.
   */
  //
  // All four accounts of this suite load the same origin, so a target picked by
  // URL is not necessarily the account under measurement — and comparing one
  // account's rendered width against another account's cell quietly measured the
  // wrong page. The page is identified by what it reports instead: while the
  // default viewport is in effect it is the one whose `innerWidth` is exactly
  // that width, and the same target is re-read after the default is cleared.
  const candidates = async () => {
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    // A page carried by a `<webview>` is reported under its own target type, not
    // `page`, so all three kinds are accepted.
    return list.filter(
      (item) =>
        (item.type === "page" || item.type === "webview" || item.type === "iframe") &&
        item.url.startsWith(baseUrl),
    );
  };
  const readSize = async (target) => {
    const page = await connectToWindow(target.webSocketDebuggerUrl);
    try {
      // `innerWidth` is already the CSS layout width: measured on a guest, a
      // 1280-wide request reports 1280 here while `devicePixelRatio` carries the
      // compensating factor. Dividing by it as well turned every reading into
      // nonsense.
      return await page.evaluate(
        "({ w: window.innerWidth, h: window.innerHeight })",
      );
    } finally {
      page.close();
    }
  };
  /** The target reporting `width` (rounded), or undefined if none does. */
  const targetReporting = async (width) => {
    for (const target of await candidates()) {
      try {
        const size = await readSize(target);
        if (typeof size?.w === "number" && Math.round(size.w) === width) return target;
      } catch {
        // A target that cannot be read is not the one.
      }
    }
    return undefined;
  };

  const zoomReset = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const tab = state.tabs.find((t) => t.label === '账号乙');
    // The measured page has to be the one on stage: off stage there is no
    // rect, and a parked page renders nothing worth measuring.
    await api.activateEmbeddedTab(tab.id);
    await new Promise((r) => setTimeout(r, 700));
    // "inherit", not "adaptive": this page has to follow the workspace default
    // for the measurement below to mean anything. Adaptive is an explicit
    // opt-out, so setting it here and then expecting 1280 contradicted the
    // feature under test.
    await api.setEmbeddedViewport(tab.id, 'inherit');
    await api.saveAppSettings({ browserViewport: { width: 1280, height: 720 } });
    await new Promise((r) => setTimeout(r, 900));
    const pinned = await api.getEmbeddedState();
    const staged = pinned.tabs.find((t) => t.id === pinned.activeTabId);
    return { tabId: tab.id, cellWidth: staged?.bounds?.width ?? null };
  })()`);
  await wait(600);
  const pinnedTarget = await targetReporting(1280);
  const withViewport = pinnedTarget ? await readSize(pinnedTarget) : null;
  // The width to compare against is the one the stage grants *after* the
  // clear: while the default is active the rect is the pinned size (1280),
  // and only clearing it hands the stage's own width back.
  const clearedWidth = await client.evaluate(`(async () => {
    await window.ensemble.saveAppSettings({ browserViewport: null });
    await new Promise((r) => setTimeout(r, 1000));
    const state = await window.ensemble.getEmbeddedState();
    return state.tabs.find((t) => t.id === state.activeTabId)?.bounds?.width ?? null;
  })()`);
  await wait(600);
  const afterClear = pinnedTarget ? await readSize(pinnedTarget) : null;
  check(
    "clearing the default hands the zoom factor back, not just the state",
    withViewport?.w === 1280 &&
      Boolean(afterClear?.w) &&
      Math.abs(afterClear.w - (clearedWidth ?? 0)) <= 4,
    { withViewport, afterClear, clearedWidth },
  );

  // --- the tab menu no longer carries a resolution section ---------------
  //
  // Resolution is a workspace setting (the toolbar's monitor button) and a
  // per-page capability the MCP surface still exposes; what the tab menu used
  // to duplicate here was a second home for the same control. This assertion
  // pins the menu's contract: opening it must not offer page resolution, and
  // the menu must still close on a pick.
  const menu = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const tab = state.tabs.find((t) => t.label === '账号乙');
    await api.activateEmbeddedTab(tab.id);
    await new Promise((r) => setTimeout(r, 900));
    const row = document.querySelector('.tabstrip .tab[data-tab-id="' + tab.id + '"]');
    const box = row?.getBoundingClientRect();
    row?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: Math.round(box.x + 10), clientY: Math.round(box.y + 8),
    }));
    await new Promise((r) => setTimeout(r, 1400));
    const opened = Boolean(document.querySelector('.tab-menu'));
    const labels = [...document.querySelectorAll('.tab-menu-item')].map((el) => el.textContent.trim());
    const hasResolutionRows = labels.some((l) => l.includes('跟随全局') || l.includes('自适应'));
    const popoutRow = [...document.querySelectorAll('.tab-menu-item')].find(
      (el) => el.textContent.includes('拆出到独立窗口') || el.textContent.includes('收回主舞台'),
    );
    popoutRow?.click();
    await new Promise((r) => setTimeout(r, 1400));
    return {
      opened,
      labels,
      hasResolutionRows,
      hasPopoutRow: Boolean(popoutRow),
      stillOpen: Boolean(document.querySelector('.tab-menu')),
    };
  })()`);
  check(
    "the tab menu offers no resolution section",
    menu?.opened === true && menu?.hasResolutionRows === false,
    menu,
  );
  check(
    "the tab menu offers the pop-out row and closes after the click",
    menu?.hasPopoutRow === true && menu?.stillOpen === false,
    menu,
  );

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  server.close();
  await wait(1200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {}
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
