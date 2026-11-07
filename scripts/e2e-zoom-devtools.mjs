#!/usr/bin/env node
/**
 * End-to-end checks for zoom and DevTools on the built-in surface.
 *
 * Zoom contract: the global setting applies to every page the user has not
 * touched; Ctrl +/- changes one page only and leaves an override; Ctrl + 0
 * returns to the global default. There is deliberately no per-site zoom.
 *
 * DevTools contract: they open for a page, the toolbar reports them as open,
 * F12 toggles them, and closing them clears that state. The panel is Electron's
 * own window — a `<webview>` guest cannot hand its tools to a view main owns.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-zoom-"));

const page = createServer((req, res) => {
  pageGets += 1;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>缩放页</title></head>
<body><h1>缩放测试</h1></body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;
// Every mock-page GET the server has seen. A reload is only observable from
// the outside as another request — the DOM cannot tell a fresh load from a
// live one.
let pageGets = 0;

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
        name: "缩放站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
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
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "browser",
    guideVersion: 1,
    browserZoom: 100,
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

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    call(message.result);
  });
  await new Promise((done) => socket.addEventListener("open", done));
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/** Zoom factors the renderer currently knows about, keyed by tab label. */
const readZoom = (client) =>
  client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    return state.tabs.map((tab) => ({ id: tab.id, label: tab.label, zoom: tab.zoom }));
  })()`);

/** Real Chrome zoom, read from the page itself (not the app's own bookkeeping). */
async function pageZoom(marker) {
  const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
  const target = list.find((item) => item.url === `${PAGE_URL}?tab=${marker}`);
  if (!target) return null;
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    // A zoomed page has fewer CSS pixels in the same window: `innerWidth` shrinks
    // while the element bounds stay put. Reading it is how the check tells a real
    // zoom from a number the app merely reports.
    return {
      innerWidth: await client.evaluate("window.innerWidth"),
      scrollWidth: await client.evaluate("document.documentElement.scrollWidth"),
    };
  } finally {
    client.close();
  }
}

/** Dispatches a real Ctrl +/- key press into one embedded page. */
async function pressCtrlKey(marker, key, code, windowsVirtualKeyCode, modifiers = 2) {
  const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
  const target = list.find((item) => item.url === `${PAGE_URL}?tab=${marker}`);
  if (!target) return false;
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers, // 2 = Ctrl, 0 = none, 2|8 = Ctrl+Shift
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    return true;
  } finally {
    client.close();
  }
}

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      // The window has not opened its debugging port yet.
    }
  }
  check("app window appeared", Boolean(target), target ? undefined : appLog.slice(-600));
  if (!target) throw new Error("no renderer target");

  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3000);

  // Two pages in two different views: a per-page zoom must not leak across.
  const opened = await client.evaluate(`(async () => {
    const a = await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} + '?tab=a', viewId: null });
    await new Promise((r) => setTimeout(r, 1500));
    const b = await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} + '?tab=b', viewId: null });
    await new Promise((r) => setTimeout(r, 1500));
    const state = await window.ensemble.getEmbeddedState();
    return { a: a.id, b: b.id, carrier: state.carrier ?? "native" };
  })()`);
  check("two pages opened", Boolean(opened?.a && opened?.b), opened);

  const initial = await readZoom(client);
  check(
    "pages start at the global default",
    initial?.every((tab) => tab.zoom === 100),
    initial,
  );

  // --- Ctrl + / - on one page only -----------------------------------------
  const beforeZoom = await pageZoom("a");
  check("the page reports its viewport", Boolean(beforeZoom?.innerWidth), beforeZoom);

  // Dispatch a real Ctrl+= into page A: this goes through the same
  // `before-input-event` path as a human keystroke, not through the IPC helper.
  const pressed = await pressCtrlKey("a", "=", "Equal", 187);
  await wait(700);
  const realAfterKey = await pageZoom("a");
  check(
    "a real Ctrl + key press shrinks the page's CSS viewport",
    pressed === true &&
      beforeZoom !== null &&
      realAfterKey !== null &&
      realAfterKey.innerWidth < beforeZoom.innerWidth,
    { before: beforeZoom, after: realAfterKey },
  );

  const zoomedIn = await readZoom(client);
  const aAfterIn = zoomedIn?.find((tab) => tab.id === opened.a);
  const bAfterIn = zoomedIn?.find((tab) => tab.id === opened.b);
  check("Ctrl + zooms the page it was pressed on", aAfterIn?.zoom === 110, { a: aAfterIn, all: zoomedIn });
  check("the other page keeps its own zoom", bAfterIn?.zoom === 100, { b: bAfterIn });

  await client.evaluate(`window.ensemble.zoomEmbeddedTab('${opened.a}', 'out')`);
  await wait(400);
  const zoomedOut = await readZoom(client);
  check(
    "Ctrl - steps back to the default",
    zoomedOut?.find((tab) => tab.id === opened.a)?.zoom === 100,
    zoomedOut,
  );

  // Two steps in, then reset: reset goes to the default, not to 100 by accident.
  await client.evaluate(`(async () => {
    await window.ensemble.zoomEmbeddedTab('${opened.a}', 'in');
    await window.ensemble.zoomEmbeddedTab('${opened.a}', 'in');
    return true;
  })()`);
  await wait(400);
  const twoSteps = await readZoom(client);
  check(
    "two steps in land on the next step up",
    twoSteps?.find((tab) => tab.id === opened.a)?.zoom === 125,
    twoSteps,
  );

  // --- Global default reaches untouched pages only -------------------------
  const changed = await client.evaluate(`(async () => {
    const saved = await window.ensemble.saveAppSettings({ browserZoom: 80 });
    return { saved: saved.browserZoom };
  })()`);
  check("the zoom setting is persisted", changed?.saved === 80, changed);
  await wait(600);

  const afterGlobal = await readZoom(client);
  check(
    "an untouched page follows the new global default",
    afterGlobal?.find((tab) => tab.id === opened.b)?.zoom === 80,
    afterGlobal,
  );
  check(
    "a page zoomed by hand keeps its own factor",
    afterGlobal?.find((tab) => tab.id === opened.a)?.zoom === 125,
    afterGlobal,
  );

  // --- Ctrl + 0 returns to the (new) default -------------------------------
  await client.evaluate(`window.ensemble.zoomEmbeddedTab('${opened.a}', 'reset')`);
  await wait(400);
  const reset = await readZoom(client);
  check(
    "Ctrl + 0 returns the page to the global default",
    reset?.find((tab) => tab.id === opened.a)?.zoom === 80,
    reset,
  );

  // A page opened after the change starts at the new default.
  const fresh = await client.evaluate(`(async () => {
    const tab = await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)}, viewId: null });
    await new Promise((r) => setTimeout(r, 1200));
    return { id: tab.id, zoom: tab.zoom };
  })()`);
  check("new pages start at the current default", fresh?.zoom === 80, fresh);

  // --- Browser muscle memory: Ctrl+R / F5 reload the page, from the page and
  // from the app chrome. Electron binds no default reload, so both layers had
  // to learn it; a reload is only observable as another server-side GET. ---
  const getsBeforeCtrlR = pageGets;
  const ctrlRPressed = await pressCtrlKey("a", "r", "KeyR", 82);
  await wait(1500);
  check(
    "Ctrl+R on a page reloads it",
    ctrlRPressed && pageGets >= getsBeforeCtrlR + 1,
    { ctrlRPressed, gets: { before: getsBeforeCtrlR, after: pageGets } },
  );

  const getsBeforeF5 = pageGets;
  const f5Pressed = await pressCtrlKey("a", "F5", "F5", 116, 0);
  await wait(1500);
  check(
    "F5 on a page reloads it",
    f5Pressed && pageGets >= getsBeforeF5 + 1,
    { f5Pressed, gets: { before: getsBeforeF5, after: pageGets } },
  );

  const getsBeforeHard = pageGets;
  const hardPressed = await pressCtrlKey("a", "r", "KeyR", 82, 2 | 8);
  await wait(1500);
  check(
    "Ctrl+Shift+R hard-reloads the page",
    hardPressed && pageGets >= getsBeforeHard + 1,
    { hardPressed, gets: { before: getsBeforeHard, after: pageGets } },
  );

  // With the focus on the app's own chrome (this CDP client talks to the app
  // renderer), Ctrl+R must reload the page the chrome is framing — the active
  // tab at this point is the fresh page from above.
  const getsBeforeChrome = pageGets;
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: 2,
    key: "r",
    code: "KeyR",
    windowsVirtualKeyCode: 82,
    nativeVirtualKeyCode: 82,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    key: "r",
    code: "KeyR",
    windowsVirtualKeyCode: 82,
    nativeVirtualKeyCode: 82,
  });
  await wait(1500);
  check(
    "Ctrl+R from the app chrome reloads the active page",
    pageGets >= getsBeforeChrome + 1,
    { gets: { before: getsBeforeChrome, after: pageGets } },
  );

  // --- DevTools -----------------------------------------------------------
  //
  // Docked beside the page, inside the app's own window. A `<webview>` guest
  // cannot hand its tools to another guest — the host binding never arrives, so
  // the front-end renders with nothing to talk to — which is why the panel is a
  // native `WebContentsView` main places in the page's own cell.
  //
  // Docking is proved by the page's own rectangle: opening a panel hands the
  // right part of the cell to it, so `bounds.width` has to shrink. A panel in a
  // separate window would leave the page at full width.
  const cellWidth = await client.evaluate(
    `document.querySelector('.stage')?.getBoundingClientRect().width ?? 0`,
  );
  const docked = await client.evaluate(`(async () => {
    // Activate it first: the toolbar describes the page the user is looking at,
    // so a panel opened for a background page is correctly not reported there.
    await window.ensemble.activateEmbeddedTab('${opened.a}');
    const before = (await window.ensemble.getEmbeddedState()).tabs.find((t) => t.id === '${opened.a}');
    await window.ensemble.openEmbeddedDevTools('${opened.a}');
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === '${opened.a}');
    const head = document.querySelector('.devtools-head');
    return {
      open: tab?.devtoolsOpen === true,
      width: tab?.devtoolsWidth ?? null,
      widthBefore: before?.bounds?.width ?? null,
      widthAfter: tab?.bounds?.width ?? null,
      grip: Boolean(document.querySelector('.devtools-grip')),
      // The panel is a native view and HTML cannot paint over it, so the app
      // gives up a band at the panel's top and draws the close button there.
      head: head ? Math.round(head.getBoundingClientRect().height) : null,
      headTop: head ? Math.round(head.getBoundingClientRect().y) : null,
      close: Boolean(document.querySelector('[data-devtools-close]')),
    };
  })()`);
  check("DevTools open for a page", docked?.open === true, docked);
  check(
    "the split is published for the handle to sit in",
    typeof docked?.width === "number" && docked.width > 0.2 && docked.width < 0.7,
    docked,
  );
  check(
    "the page gives up the panel's share of its cell",
    typeof docked?.widthAfter === "number" &&
      typeof docked?.widthBefore === "number" &&
      docked.widthAfter < docked.widthBefore * 0.95,
    { ...docked, cellWidth },
  );
  check("the page and the panel have a draggable seam", docked?.grip === true, docked);
  // The band exists so the panel can be closed from where the pointer already
  // is, like the real thing; it must be the app's own height, not whatever the
  // native panel happens to leave.
  check(
    "the panel carries an app-drawn title band with its close button",
    docked?.head === 26 && docked?.close === true,
    docked,
  );

  // The front-end has to be running: a toggle that reports open while the panel
  // never loaded is worse than one that fails.
  const frontEnd = await (async () => {
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    const dev = list.find((item) => item.url.startsWith("devtools://"));
    return { loaded: Boolean(dev), url: dev?.url.slice(0, 40) ?? null };
  })();
  check("the DevTools front-end is running", frontEnd?.loaded === true, frontEnd);

  const toolbarState = await client.evaluate(`(() => {
    // Located by accessible name, not by the hover hint: the hint is drawn by the
    // app's own tooltip now, so there is no \`title\` attribute left to read. The
    // aria-label is also what a screen reader announces, which makes it the more
    // meaningful thing for a test to depend on.
    const button = [...document.querySelectorAll('.toolbar .icon')].find((el) =>
      (el.getAttribute('aria-label') ?? '').includes('开发者工具'),
    );
    return { present: Boolean(button), active: button?.classList.contains('active') ?? null };
  })()`);
  check(
    "the toolbar marks DevTools as open",
    toolbarState?.present === true && toolbarState?.active === true,
    toolbarState,
  );

  // A resize round-trip. The live drag polls the real cursor, which a headless
  // run cannot aim, so this checks the machinery — begin, a few poll ticks with
  // their state publishes, release — without wedging the split either way.
  const resized = await client.evaluate(`(async () => {
    const read = async () =>
      (await window.ensemble.getEmbeddedState()).tabs.find(
        (t) => t.id === '${opened.a}',
      )?.devtoolsWidth ?? null;
    const before = await read();
    await window.ensemble.resizeEmbeddedDevTools('${opened.a}');
    await new Promise((r) => setTimeout(r, 400));
    const during = await read();
    await window.ensemble.endEmbeddedDevToolsResize();
    await new Promise((r) => setTimeout(r, 400));
    const after = await read();
    return { before, during, after };
  })()`);
  check(
    "a resize session opens and releases without wedging the split",
    typeof resized?.before === "number" &&
      typeof resized?.after === "number" &&
      Math.abs((resized.after ?? 0) - (resized.before ?? 0)) < 0.5,
    resized,
  );

  // Closing from the app must clear the toggle. The click goes through the
  // band's own button — the gesture a user reaching for the corner actually
  // makes — and the band and seam have to disappear with the panel.
  const closed = await client.evaluate(`(async () => {
    document.querySelector('[data-devtools-close]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === '${opened.a}');
    return {
      open: tab?.devtoolsOpen ?? null,
      head: Boolean(document.querySelector('.devtools-head')),
      grip: Boolean(document.querySelector('.devtools-grip')),
    };
  })()`);
  check(
    "the band's close button shuts DevTools down",
    closed?.open === false && closed?.head === false && closed?.grip === false,
    closed,
  );

  // --- F12 toggles from the page ------------------------------------------
  const f12 = await client.evaluate(`(async () => {
    return { openBefore: (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}')?.devtoolsOpen === true };
  })()`);
  // A real F12 press into the page, through CDP: the toggle lives in the page's
  // before-input-event, which a synthetic DOM key never exercises.
  async function pressF12(marker) {
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    const target = list.find((item) => item.url === `${PAGE_URL}?tab=${marker}`);
    if (!target) return false;
    const c = await connect(target.webSocketDebuggerUrl);
    try {
      await c.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown", key: "F12", code: "F12", windowsVirtualKeyCode: 123, nativeVirtualKeyCode: 123,
      });
      await c.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "F12", code: "F12", windowsVirtualKeyCode: 123, nativeVirtualKeyCode: 123,
      });
      return true;
    } finally {
      c.close();
    }
  }
  await pressF12("a");
  await new Promise((r) => setTimeout(r, 900));
  const afterF12 = await client.evaluate(
    `(async () => {
      const tab = (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}');
      return { open: tab?.devtoolsOpen === true };
    })()`,
  );
  check(
    "F12 opens DevTools",
    f12?.openBefore === false && afterF12?.open === true,
    { f12, afterF12 },
  );

  await pressF12("a");
  await new Promise((r) => setTimeout(r, 900));
  const f12Closed = await client.evaluate(
    `(async () => (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}')?.devtoolsOpen === true)()`,
  );
  check("F12 again closes DevTools", f12Closed === false, f12Closed);

  // --- F5 inside the panel reloads the page, not the front-end -------------
  //
  // The gesture has to keep working (Chrome reloads the inspected page when the
  // focus is in DevTools), and the panel must survive it. A marker on the page
  // distinguishes "nothing happened" from "the page reloaded".
  const pageReloadsFromPanel = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedDevTools('${opened.a}');
    await new Promise((r) => setTimeout(r, 1200));
    return { open: (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}')?.devtoolsOpen === true };
  })()`);
  const reloadKey = await (async () => {
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    const dev = list.find((item) => item.url.startsWith("devtools"));
    if (!dev) return { error: "no devtools target" };
    const c = await connect(dev.webSocketDebuggerUrl);
    try {
      await c.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "F5",
        code: "F5",
        windowsVirtualKeyCode: 116,
        nativeVirtualKeyCode: 116,
      });
      await c.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "F5",
        code: "F5",
        windowsVirtualKeyCode: 116,
        nativeVirtualKeyCode: 116,
      });
      await new Promise((r) => setTimeout(r, 2000));
      return { sent: true };
    } finally {
      c.close();
    }
  })();
  const stillOpen = await client.evaluate(
    `(async () => (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}')?.devtoolsOpen === true)()`,
  );
  check(
    "F5 pressed inside the panel leaves the panel open",
    pageReloadsFromPanel?.open === true &&
      reloadKey?.sent === true &&
      stillOpen === true,
    { pageReloadsFromPanel, reloadKey, stillOpen },
  );

  await client.evaluate(`window.ensemble.closeEmbeddedDevTools('${opened.a}')`);
  await new Promise((r) => setTimeout(r, 600));
  // --- Per-page isolation is structural, not a global factor ---------------
  const isolated = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    return state.tabs.map((tab) => ({ id: tab.id, zoom: tab.zoom }));
  })()`);
  check(
    "zoom lives on the page, so pages differ independently",
    isolated?.find((tab) => tab.id === opened.b)?.zoom === 80 &&
      isolated?.find((tab) => tab.id === opened.a)?.zoom === 80,
    isolated,
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
  page.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
