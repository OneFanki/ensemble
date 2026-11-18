#!/usr/bin/env node
/**
 * End-to-end checks for the bookmark-bar flyout panels.
 *
 * Each check below was a real defect:
 *
 * 1. A root folder panel with more entries than fit the window ran past the
 *    window's bottom edge — there was no max-height at all. It must cap and
 *    scroll, like the bar's own overflow menu always did.
 * 2. A panel below the root level lives inside its parent panel, which scrolls
 *    (`overflow-y: auto`); an `absolute` child panel is clipped by that overflow
 *    and drifts when the parent scrolls. It is viewport-fixed now, so it must
 *    sit inside the viewport aligned with its row.
 * 3. Scrolling the parent panel must collapse the chain back to it — a fixed
 *    child would otherwise keep pointing at rows that have moved away.
 * 4. The run dock whose collapsed badge this suite once measured is retired
 *    with the grid (ADR 0012); what must hold now is that it stays retired and
 *    the instance rail is the header's first row.
 *
 * Everything runs headless: a real window is parked outside every display so
 * the compositor still produces frames.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-bookmark-flyout-"));

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

const now = new Date().toISOString();
const F_ROOT = uuid(1);
const F_SUB = uuid(2);
/** 24 rows ≈ 632px of content against the 420px cap, so the panel must scroll. */
const folders = [
  { id: F_ROOT, name: "长目录", order: 0, createdAt: now, updatedAt: now },
  { id: F_SUB, name: "子目录", parentId: F_ROOT, order: 0, createdAt: now, updatedAt: now },
];
const bookmarks = [];
for (let i = 0; i < 24; i += 1) {
  bookmarks.push({
    id: uuid(10 + i),
    name: `条目 ${i + 1}`,
    url: `https://example.invalid/${i + 1}`,
    folderId: F_ROOT,
    order: i,
    createdAt: now,
    updatedAt: now,
  });
}
for (let i = 0; i < 8; i += 1) {
  bookmarks.push({
    id: uuid(50 + i),
    name: `子条目 ${i + 1}`,
    url: `https://example.invalid/sub/${i + 1}`,
    folderId: F_SUB,
    order: i,
    createdAt: now,
    updatedAt: now,
  });
}

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({ version: 2, bookmarks, bookmarkFolders: folders }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "browser",
    // The sidebar — and with it the run dock — only exists in bench mode.
    shellMode: "bench",
    guideVersion: GUIDE_SEEN,
  }),
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

async function waitFor(client, expression, timeout = 4000) {
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
  await wait(3000);
  // No Emulation viewport override here: under `setDeviceMetricsOverride` the
  // engine anchors `position: fixed` to the simulated viewport while
  // `getBoundingClientRect` reports layout coordinates, so fixed panels read
  // ~100px off. Every assertion below reads the real window size instead.

  await waitFor(
    client,
    "Boolean(document.querySelector('.bookmark-bar')) && Boolean(document.querySelector('.blank-slot .new-tab'))",
  );

  // --- 1. The root panel caps at the window instead of running past it -----
  await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('.bookmark-bar .bb-folder.level-root')]
      .find((el) => el.textContent?.includes('长目录'));
    row?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    return Boolean(row);
  })()`);
  await waitFor(client, "Boolean(document.querySelector('.bookmark-bar .bb-folder.level-root > .bb-flyout'))");
  const rootPanel = await client.evaluate(`(() => {
    const panel = document.querySelector('.bookmark-bar .bb-folder.level-root > .bb-flyout');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      inner: window.innerHeight,
      clientHeight: panel.clientHeight,
      scrollHeight: panel.scrollHeight,
      rows: panel.querySelectorAll('.bb-entry').length,
    };
  })()`);
  check(
    "the root panel stays inside the window and scrolls its overflow",
    Boolean(rootPanel) &&
      rootPanel.bottom <= rootPanel.inner &&
      rootPanel.clientHeight <= 420 &&
      rootPanel.scrollHeight > rootPanel.clientHeight &&
      rootPanel.rows === 25,
    rootPanel,
  );

  // --- 2. The sub-panel is fixed, inside the viewport, aligned to its row --
  await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('.bb-flyout .bb-folder:not(.level-root)')]
      .find((el) => el.textContent?.includes('子目录'));
    row?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    return Boolean(row);
  })()`);
  await waitFor(client, "Boolean(document.querySelector('.bb-flyout .bb-flyout'))");
  const subPanel = await client.evaluate(`(() => {
    const panel = document.querySelector('.bb-flyout .bb-flyout');
    const row = [...document.querySelectorAll('.bb-flyout .bb-folder:not(.level-root)')]
      .find((el) => el.textContent?.includes('子目录'));
    if (!panel || !row) return null;
    const rect = panel.getBoundingClientRect();
    const culprits = [];
    let node = panel.parentElement;
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node);
      if (
        s.transform !== "none" ||
        s.filter !== "none" ||
        s.backdropFilter !== "none" ||
        (s.willChange && /transform|filter/.test(s.willChange)) ||
        s.perspective !== "none" ||
        s.contain !== "none"
      ) {
        culprits.push(node.tagName + "." + String(node.className).slice(0, 50));
      }
      node = node.parentElement;
    }
    return {
      // Same-frame read: the viewport metrics override lands on a frame
      // boundary, so positions measured in different evaluate calls can come
      // from two different layouts.
      rowTop: row.getBoundingClientRect().top,
      position: getComputedStyle(panel).position,
      style: panel.getAttribute("style"),
      culprits,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      inner: { w: window.innerWidth, h: window.innerHeight },
      entries: panel.querySelectorAll('.bb-entry').length,
    };
  })()`);
  check(
    "the sub-panel is viewport-fixed and fully inside the window",
    Boolean(subPanel) &&
      subPanel.position === "fixed" &&
      subPanel.top >= 0 &&
      subPanel.bottom <= subPanel.inner.h &&
      subPanel.left >= 0 &&
      subPanel.right <= subPanel.inner.w &&
      subPanel.entries === 8,
    subPanel,
  );
  check(
    "the sub-panel's top tracks its row",
    Math.abs(subPanel.top - (subPanel.rowTop - 4)) < 10,
    { rowTop: subPanel.rowTop, panelTop: subPanel.top },
  );

  // --- 3. Scrolling the parent collapses the chain back to it --------------
  await client.evaluate(`(() => {
    const panel = document.querySelector('.bookmark-bar .bb-folder.level-root > .bb-flyout');
    panel.scrollTop = 200;
    return panel.scrollTop;
  })()`);
  await wait(400);
  const subAfterScroll = await client.evaluate(
    "Boolean(document.querySelector('.bb-flyout .bb-flyout'))",
  );
  const rootStillOpen = await client.evaluate(
    "Boolean(document.querySelector('.bookmark-bar .bb-folder.level-root > .bb-flyout'))",
  );
  check(
    "scrolling the root panel closes deeper panels but keeps itself",
    subAfterScroll === false && rootStillOpen === true,
    { subAfterScroll, rootStillOpen },
  );

  // --- 4. The retired column stays retired; the rail owns the top row -------
  const shell = await client.evaluate(`(() => {
    const rail = document.querySelector('.rail')?.getBoundingClientRect();
    return {
      dock: Boolean(document.querySelector('.dock')),
      layoutBtn: Boolean(document.querySelector('.layout-btn')),
      railTop: rail ? Math.round(rail.top) : null,
      railInsideWindow: rail ? rail.left >= 0 && rail.right <= window.innerWidth : false,
    };
  })()`);
  check(
    "the dock stays retired and the rail spans the window's top",
    shell?.dock === false &&
      shell?.layoutBtn === false &&
      shell?.railTop === 0 &&
      shell?.railInsideWindow === true,
    shell,
  );

  client.close();
} catch (error) {
  check("suite completed without throwing", false, String(error));
} finally {
  app.kill();
  await wait(400);
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
