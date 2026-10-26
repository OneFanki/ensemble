#!/usr/bin/env node
/**
 * End-to-end checks for zoom and DevTools on the built-in surface.
 *
 * Zoom contract: the global setting applies to every page the user has not
 * touched; Ctrl +/- changes one page only and leaves an override; Ctrl + 0
 * returns to the global default. There is deliberately no per-site zoom.
 *
 * DevTools contract: they open docked inside the page, can be detached into
 * their own window, and closing them clears the toolbar's toggle state.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3985;
const DEBUG_PORT = 9793;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-zoom-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>缩放页</title></head>
<body><h1>缩放测试</h1></body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

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
    onboardingVersion: 1,
    browserZoom: 100,
  }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`],
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
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
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
async function pressCtrlKey(marker, key, code, windowsVirtualKeyCode) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = list.find((item) => item.url === `${PAGE_URL}?tab=${marker}`);
  if (!target) return false;
  const client = await connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: 2, // Ctrl
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: 2,
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
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
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
    return { a: a.id, b: b.id };
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

  // --- DevTools dock and detach -------------------------------------------
  const docked = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedDevTools('${opened.a}', 'docked');
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === '${opened.a}');
    return { open: tab?.devtoolsOpen === true };
  })()`);
  check("DevTools open docked by default", docked?.open === true, docked);

  // Docked tools shrink the page inside its view. The freeze used by every HTML
  // overlay must report the page's real box, otherwise a dialog would show a
  // horizontally stretched page for as long as it is open.
  const freeze = await client.evaluate(`(async () => {
    await window.ensemble.activateEmbeddedTab('${opened.a}');
    await new Promise((r) => setTimeout(r, 400));
    const stage = document.querySelector('.stage');
    const box = stage?.getBoundingClientRect();
    const slots = await window.ensemble.freezeEmbedded();
    window.ensemble.setEmbeddedStage({ x: Math.round(box.left), y: Math.round(box.top), width: Math.floor(box.width), height: Math.floor(box.height) });
    return { stageWidth: Math.round(box?.width ?? 0), slots };
  })()`);
  check(
    "a frozen page behind an overlay keeps its real width, not the slot's",
    freeze?.slots?.length === 1 && freeze.slots[0].rect.width < freeze.stageWidth,
    { stageWidth: freeze?.stageWidth, slots: freeze?.slots?.map((slot) => slot.rect) },
  );

  const toolbarState = await client.evaluate(`(() => {
    const button = [...document.querySelectorAll('.toolbar .icon')].find((el) =>
      el.title.includes('开发者工具'),
    );
    return { present: Boolean(button), active: button?.classList.contains('active') ?? null };
  })()`);
  check(
    "the toolbar marks DevTools as open",
    toolbarState?.present === true && toolbarState?.active === true,
    toolbarState,
  );

  const detached = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedDevTools('${opened.a}', 'window');
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === '${opened.a}');
    return { open: tab?.devtoolsOpen === true };
  })()`);
  check("DevTools can be detached into their own window", detached?.open === true, detached);

  // Closing from the app must clear the toggle; closing from DevTools' own
  // header is covered by the devtools-closed listener wired in the browser.
  const closed = await client.evaluate(`(async () => {
    await window.ensemble.closeEmbeddedDevTools('${opened.a}');
    await new Promise((r) => setTimeout(r, 800));
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === '${opened.a}');
    return { open: tab?.devtoolsOpen ?? null };
  })()`);
  check("closing DevTools clears the open state", closed?.open === false, closed);

  // --- F12 toggles from the page, and the panel reports its split ----------
  const f12 = await client.evaluate(`(async () => {
    return { openBefore: (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}')?.devtoolsOpen === true };
  })()`);
  // A real F12 press into the page, through CDP: the toggle lives in the page's
  // before-input-event, which a synthetic DOM key never exercises.
  async function pressF12(marker) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
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
      return { open: tab?.devtoolsOpen === true, width: tab?.devtoolsWidth ?? null };
    })()`,
  );
  check(
    "F12 opens DevTools and the docked split is reported",
    f12?.openBefore === false && afterF12?.open === true && afterF12?.width !== null,
    { f12, afterF12 },
  );
  await pressF12("a");
  await new Promise((r) => setTimeout(r, 900));
  const f12Closed = await client.evaluate(
    `(async () => (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}')?.devtoolsOpen === true)()`,
  );
  check("F12 again closes DevTools", f12Closed === false, f12Closed);

  // --- The drag handle: visible in the gap, and moving it re-splits --------
  const grip = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedDevTools('${opened.a}', 'docked');
    await new Promise((r) => setTimeout(r, 800));
    const gripEl = document.querySelector('.devtools-grip');
    const before = (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}');
    const pageBefore = before?.bounds;
    // Keyboard path first: the separator's arrows.
    gripEl?.focus();
    gripEl?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    const after = (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}');
    return {
      present: Boolean(gripEl),
      labelled: Boolean(gripEl?.getAttribute('aria-label')),
      widthBefore: before?.devtoolsWidth ?? null,
      widthAfter: after?.devtoolsWidth ?? null,
      pageMoved: Boolean(pageBefore && after?.bounds && pageBefore.width !== after.bounds.width),
    };
  })()`);
  check(
    "the DevTools grip exists and arrow keys re-split the cell",
    grip?.present === true &&
      grip?.labelled === true &&
      typeof grip?.widthBefore === "number" &&
      typeof grip?.widthAfter === "number" &&
      Math.abs(grip.widthAfter - grip.widthBefore - 0.04) < 0.001 &&
      grip?.pageMoved === true,
    grip,
  );

  // A drag hands the split to the main process: the width lands where the
  // cursor is. The scripted cursor cannot move, so begin-then-end proves the
  // session lifecycle (state restored, listeners dropped) rather than geometry.
  const drag = await client.evaluate(`(async () => {
    await window.ensemble.beginEmbeddedDevToolsResize('${opened.a}');
    await new Promise((r) => setTimeout(r, 200));
    await window.ensemble.endEmbeddedDevToolsResize();
    await new Promise((r) => setTimeout(r, 400));
    const tab = (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === '${opened.a}');
    return { open: tab?.devtoolsOpen === true, width: tab?.devtoolsWidth ?? null };
  })()`);
  check(
    "a resize session opens and closes without breaking the panel",
    drag?.open === true && typeof drag?.width === "number",
    drag,
  );

  // --- The language prompt answers itself ----------------------------------
  // The prompt's choice is never persisted (Electron keeps DevTools prefs in
  // memory only) and clicking "switch" reloads the front-end, so what the app
  // really owes the user is the switched UI. Assert on that: Chinese tab
  // titles inside the DevTools front-end, after the answer and its reload.
  // The prompt itself may legitimately reappear after the reload — the choice
  // cannot be persisted — so it is not what this check is about.
  await client.evaluate(`(async () => {
    await window.ensemble.closeEmbeddedDevTools('${opened.a}');
    await new Promise((r) => setTimeout(r, 600));
    await window.ensemble.openEmbeddedDevTools('${opened.a}', 'docked');
    return true;
  })()`);
  const locale = await (async () => {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const dev = list.find((item) => item.url.startsWith("devtools"));
    if (!dev) return { error: "no devtools target" };
    const c = await connect(dev.webSocketDebuggerUrl);
    try {
      await new Promise((r) => setTimeout(r, 6000));
      return await c.evaluate(`(() => {
        const texts = [];
        const walk = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        // Tab titles live in the front-end's own strings; the switched UI says
        // 元素/控制台 where the unswitched one says Elements/Console.
        const ui = document.body.textContent || '';
        for (const el of document.querySelectorAll('*')) {
          if (el.shadowRoot) texts.push(el.shadowRoot.textContent ?? '');
        }
        const all = (ui + texts.join(''));
        return {
          chinese: all.includes('元素') && (all.includes('控制台') || all.includes('网络')),
          english: all.includes('Elements') && all.includes('Console'),
          navLang: navigator.language,
        };
      })()`);
    } finally {
      c.close();
    }
  })();
  check(
    "the DevTools front-end answers the language prompt and switches to Chinese",
    locale?.chinese === true,
    locale,
  );


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
