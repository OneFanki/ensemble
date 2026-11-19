#!/usr/bin/env node
/**
 * End-to-end check that a management layer never takes the page away.
 *
 * This suite used to guard the opposite contract: opening the console replaced
 * the browser page, the page surface painted above ordinary HTML, so the pages
 * had to be parked in the very task that switched the view or the panel and the
 * page swapped places for a frame.
 *
 * Management is a layer now (ADR 0012): the browser stays mounted, the page stays
 * on the stage at the same rectangle, and the layer draws over part of it. What
 * has to hold, and what this suite asserts:
 *
 * 1. **The page is not parked.** Opening a layer leaves every page node where it
 *    was, opaque, and still sized to the stage — the person can read the page
 *    beside the layer.
 * 2. **The layer is above the pool by layer number.** The layer is a real
 *    element over a guest; ordering must come from `z-index`, not from mount
 *    order.
 * 3. **Docked DevTools still step aside.** The panel is a native view that no
 *    HTML can stack over, so an open layer must report `devtoolsParked` and the
 *    flag must clear when the layer closes. That flag is the one piece of the old
 *    "the page gets out of the way" machinery that still has a job.
 * 4. **Closing gives the stage back unchanged.** Nothing was torn down, so the
 *    page never leaves its rectangle — not even for a frame.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";
import { openRail } from "./lib/e2e-nav.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-console-"));

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>面板覆盖测试</title></head>
<body style="margin:0;background:#eef2f7"><h1 style="margin:0;background:#2563eb;color:#fff;padding:14px">占位页面</h1></body></html>`,
  );
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: uuid(1),
        name: "覆盖测试站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/",
      },
    ],
    identities: [
      {
        id: uuid(2),
        siteId: uuid(1),
        name: "管理员 · 主账号",
        username: "admin",
        role: "admin",
        color: "amber",
      },
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
const app = spawn(
  electron,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
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
  // The account rail starts collapsed; this suite reads its chips.
  await client.evaluate(openRail());
  await wait(400);
  await wait(3400);

  await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(`http://127.0.0.1:${PAGE_PORT}/`)} });
    await new Promise((r) => setTimeout(r, 1800));
    return true;
  })()`);
  await wait(1200);

  // 1. The page really is on stage before the click, or the test proves nothing.
  const before = await client.evaluate(`(() => {
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('webview')];
    return {
      stage: stage ? { x: Math.round(stage.x), y: Math.round(stage.y), w: Math.round(stage.width) } : null,
      nodes: nodes.map((node) => ({
        left: node.style.left,
        top: node.style.top,
        width: node.style.width,
        opacity: node.style.opacity,
        pointer: node.style.pointerEvents,
      })),
    };
  })()`);
  check(
    "the page is on stage before the layer opens",
    before?.nodes?.some((node) => node.opacity === "1" && !node.left.startsWith("-")),
    before,
  );

  // 2. One click on the rail entry, then a read. A layer is a render away, so
  //    the pane is not in the DOM yet — the point is that the page never left.
  const afterClick = await client.evaluate(`(() => {
    const btn = document.querySelector('[data-rail-entry="identities"]');
    if (!btn) return { error: 'no sites entry on the account rail' };
    btn.click();
    const nodes = [...document.querySelectorAll('webview')];
    return {
      clicked: true,
      paneInDom: Boolean(document.querySelector('[data-floating-pane]')),
      nodes: nodes.map((node) => ({
        tabId: node.dataset.tabId,
        left: node.style.left,
        top: node.style.top,
        width: node.style.width,
        opacity: node.style.opacity,
        pointer: node.style.pointerEvents,
      })),
    };
  })()`);
  check(
    "opening a layer leaves every page exactly where it was",
    Array.isArray(afterClick?.nodes) &&
      afterClick.nodes.length === before?.nodes?.length &&
      afterClick.nodes.every(
        (node, index) =>
          node.left === before?.nodes?.[index]?.left &&
          node.top === before?.nodes?.[index]?.top &&
          node.width === before?.nodes?.[index]?.width &&
          node.opacity === before?.nodes?.[index]?.opacity,
      ) &&
      afterClick.nodes.some((node) => node.opacity === "1" && !node.left.startsWith("-")),
    { afterClick, before },
  );

  // 3. And the layer does appear, on the very next frame. Landing after the
  //    entry animation is a separate read: on the first frame the pane still
  //    carries its opening transform.
  const settled = await client.evaluate(`(async () => {
    await new Promise((r) => requestAnimationFrame(r));
    return {
      paneInDom: Boolean(document.querySelector('[data-floating-pane]')),
      nodes: [...document.querySelectorAll('webview')].map((node) => ({
        left: node.style.left,
        opacity: node.style.opacity,
      })),
    };
  })()`);
  check(
    "the layer is drawn on the next frame, with the page still on stage",
    settled?.paneInDom === true &&
      settled.nodes.some((node) => node.opacity === "1" && !node.left.startsWith("-")),
    settled,
  );

  await wait(700);
  // A headless run never composites, so the pane's opening animation stays at
  // its first keyframe (a translate of a few pixels) and every geometry read
  // would land mid-animation. Switching animations off makes the target values
  // observable.
  const placed = await client.evaluate(`(() => {
    const style = document.createElement('style');
    style.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(style);
    const pane = document.querySelector('[data-floating-pane]')?.getBoundingClientRect();
    const scrim = document.querySelector('[data-floating-scrim]')?.getBoundingClientRect();
    const rail = document.querySelector('[data-account-rail]')?.getBoundingClientRect();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    const result = {
      pane: pane ? { x: Math.round(pane.x), right: Math.round(pane.right) } : null,
      scrim: scrim ? { x: Math.round(scrim.x), right: Math.round(scrim.right) } : null,
      railRight: rail ? Math.round(rail.right) : null,
      stage: stage ? { x: Math.round(stage.x), right: Math.round(stage.right) } : null,
      windowWidth: window.innerWidth,
    };
    style.remove();
    return result;
  })()`);
  check(
    "the layer starts at the account column and leaves the stage readable beside it",
    Boolean(placed?.pane && placed?.railRight && placed?.stage) &&
      placed.pane.x === placed.railRight &&
      placed.pane.right < placed.stage.right &&
      placed.pane.right <= placed.windowWidth,
    placed,
  );

  // 4. The layer numbers, so ordering alone can never decide this again.
  const layers = await client.evaluate(`(() => {
    const z = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      return {
        zIndex: getComputedStyle(element).zIndex,
        position: getComputedStyle(element).position,
      };
    };
    return { layer: z('[data-floating-pane-layer]'), pane: z('[data-floating-pane]'), pool: z('.guest-pool') };
  })()`);
  check(
    "the layer sits above the page pool by layer number",
    layers?.layer?.position !== "static" &&
      Number(layers?.pane?.zIndex) > Number(layers?.layer?.zIndex ?? 0) &&
      Number(layers?.layer?.zIndex) > Number(layers?.pool?.zIndex ?? 0),
    layers,
  );

  // 5. Docked DevTools still step aside for an open layer. The panel is a
  //    native view, so this is the one piece of parking that must survive.
  const parked = await client.evaluate(`(async () => {
    const open = await window.ensemble.getEmbeddedState();
    return {
      flag: open.devtoolsParked === true,
      floatingAttr: document.documentElement.dataset.floating ?? null,
    };
  })()`);
  check(
    "an open layer reports the docked DevTools as parked and suspends dragging",
    parked?.flag === true && parked?.floatingAttr === "1",
    parked,
  );

  // 6. Closing must clear both, and the page must still be on stage — there was
  //    nothing to bring back.
  const back = await client.evaluate(`(async () => {
    document.querySelector('[data-floating-pane] [data-pane-close]')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const state = await window.ensemble.getEmbeddedState();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    return {
      paneGone: !document.querySelector('[data-floating-pane]'),
      parked: state.devtoolsParked === true,
      floatingAttr: document.documentElement.dataset.floating ?? null,
      stage: stage ? { x: Math.round(stage.x), y: Math.round(stage.y), w: Math.round(stage.width) } : null,
      nodes: [...document.querySelectorAll('webview')].map((node) => ({
        left: node.style.left,
        top: node.style.top,
        opacity: node.style.opacity,
      })),
    };
  })()`);
  check(
    "closing the layer clears the DevTools park and the drag suspension",
    back?.paneGone === true && back?.parked === false && back?.floatingAttr === null,
    back,
  );
  check(
    "the page is still on the stage it never left",
    back?.stage?.x === before?.stage?.x &&
      back?.stage?.w === before?.stage?.w &&
      back.nodes.some((node) => node.opacity === "1" && !node.left.startsWith("-")),
    back,
  );

  // 7. The user's two other ways out: Esc and a press on the scrim. Both are
  //    the pane's own contract, and both have to leave the browser intact.
  const escClose = await client.evaluate(`(async () => {
    document.querySelector('[data-rail-entry="identities"]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const opened = Boolean(document.querySelector('[data-floating-pane]'));
    const pane = document.querySelector('[data-floating-pane]');
    pane?.focus?.();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return { opened, closed: !document.querySelector('[data-floating-pane]') };
  })()`);
  check("Esc closes an open layer", escClose?.opened === true && escClose?.closed === true, escClose);

  const scrimClose = await client.evaluate(`(async () => {
    document.querySelector('[data-rail-entry="identities"]')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const opened = Boolean(document.querySelector('[data-floating-pane]'));
    document.querySelector('[data-floating-scrim]')?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 500));
    return {
      opened,
      closed: !document.querySelector('[data-floating-pane]'),
      staged: [...document.querySelectorAll('webview')].some(
        (node) => node.style.opacity === "1" && !node.style.left.startsWith("-"),
      ),
    };
  })()`);
  check(
    "a press on the scrim closes the layer and leaves the page on stage",
    scrimClose?.opened === true && scrimClose?.closed === true && scrimClose?.staged === true,
    scrimClose,
  );
} catch (error) {
  console.error("[console-overlap] fatal", String(error));
  console.error("[console-overlap] applog", appLog.slice(-1200));
  results.push({ name: "suite ran", ok: false });
} finally {
  app.kill();
  page.close();
  await wait(600);
  const failed = results.filter((result) => !result.ok).length;
  console.log(
    `\n[console-overlap] ${results.length - failed}/${results.length} assertions passed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
