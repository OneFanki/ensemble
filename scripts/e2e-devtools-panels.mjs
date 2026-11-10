#!/usr/bin/env node
/**
 * End-to-end checks for the docked panel's two extra tabs.
 *
 * Contract under test:
 *
 * - A device really reaches the page: `innerWidth`, DPR, `maxTouchPoints` and
 *   the UA all change, and touch events are delivered.
 * - Device emulation survives a cross-document navigation. This is the one that
 *   breaks silently otherwise: the CDP overrides are per-document, so a page
 *   being tested as a phone would snap back to desktop the moment you clicked a
 *   link — exactly when the emulation matters.
 * - Clearing a device keeps its size as a plain viewport, and the page goes back
 *   to being a desktop browser.
 * - The performance tab produces samples, and only while it is showing.
 * - Switching tabs parks the native front-end rather than closing it.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-panels-"));
const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

/*
 * Two documents. `/second` exists so the navigation check has somewhere to go:
 * the point is that the emulation survives leaving the first document.
 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>面板探针</title></head>
<body>
<h1 id="title">第一页</h1>
<a id="next" href="/second">下一页</a>
<script>
  window.__probe = () => ({
    url: location.href,
    innerWidth, innerHeight,
    dpr: devicePixelRatio,
    touch: navigator.maxTouchPoints,
    ua: navigator.userAgent,
    screenW: screen.width,
  });
  window.__touchCount = 0;
  addEventListener('touchstart', () => { window.__touchCount += 1; }, { passive: true });
  // Busy work, so the performance tab has something to measure.
  setInterval(() => {
    const box = document.createElement('div');
    box.textContent = 'x';
    document.body.appendChild(box);
    if (document.body.children.length > 200) box.remove();
  }, 50);
</script>
</body></html>`;

const SECOND = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>第二页</title></head>
<body><h1>第二页</h1>
<script>
  window.__probe = () => ({
    url: location.href, innerWidth, innerHeight,
    dpr: devicePixelRatio, touch: navigator.maxTouchPoints, ua: navigator.userAgent,
  });
</script>
</body></html>`;

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url.startsWith("/second") ? SECOND : PAGE);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${PAGE_PORT}`;

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2, tags: [],
    sites: [{
      id: siteId, name: "面板站点", baseUrl: BASE, loginPath: "/", autoSubmit: false,
      tagIds: [], extraFields: [], createdAt: now, updatedAt: now,
    }],
    identities: [], views: [], instances: [], flows: [], bookmarks: [],
    bookmarkFolders: [], manualEngines: [], layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark", locale: "zh", lastView: "browser", guideVersion: 99,
    layout: "free", layoutExplicit: true,
  }),
);

const app = spawn(electron, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (c) => (appLog += c));
app.stderr.on("data", (c) => (appLog += c));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  let next = 0;
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
        const id = ++next;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result?.result?.value;
    },
    close() { socket.close(); },
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/** The embedded page's CDP target, matched by origin. */
async function pageTarget() {
  const list = await (
    await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)
  ).json();
  return list.find((item) => item.url.startsWith(BASE));
}

/** Reads the page's own view of itself. */
async function probe() {
  const target = await pageTarget();
  if (!target) return null;
  const c = await connect(target.webSocketDebuggerUrl);
  try {
    return await c.evaluate("window.__probe ? window.__probe() : null");
  } finally {
    c.close();
  }
}

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)
      ).json();
      target = list.find(
        (item) => item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
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

  const opened = await client.evaluate(
    `window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(BASE + "/")} })`,
  );
  const tabId = opened?.id ?? opened?.tabId;
  await wait(1800);
  check("a page is open", Boolean(tabId), { tabId });

  const baseline = await probe();
  check(
    "unemulated pages start as a desktop browser",
    baseline?.touch === 0 && baseline?.dpr !== 3 && baseline?.innerWidth > 800,
    baseline,
  );

  /*
   * Exactly one guest node may be opaque.
   *
   * Regression: the renderer's `isOnStage` compared instance ids, so every page
   * of the focused instance reported "on stage" — including the `about:blank`
   * placeholder a fresh tab starts with. Two nodes shared `opacity: 1` in the
   * same rect and the placeholder won, which is why a saved account sat on a
   * blank page until a reload shuffled the layers.
   */
  const opaque = await client.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.guest-pool webview')];
    return {
      total: nodes.length,
      opaque: nodes
        .filter((el) => getComputedStyle(el).opacity === '1')
        .map((el) => String(el.getAttribute('src') ?? '').slice(0, 60)),
    };
  })()`);
  check(
    "only one guest node is opaque at a time",
    opaque?.opaque?.length === 1 && !String(opaque.opaque[0]).startsWith("about:blank"),
    opaque,
  );

  // --- Device emulation reaches the page -----------------------------------
  await client.evaluate(`window.ensemble.openEmbeddedDevTools(${JSON.stringify(tabId)})`);
  await wait(1600);
  const panels = await client.evaluate(`(() => ({
    head: Boolean(document.querySelector('.devtools-head')),
    tabs: [...document.querySelectorAll('[data-devtools-tab]')].map((el) => el.dataset.devtoolsTab),
    active: document.querySelector('.devtools-tab.active')?.dataset.devtoolsTab ?? null,
  }))()`);
  check(
    "the panel opens on the native front-end with three tabs",
    panels?.head === true &&
      panels.tabs.join(",") === "front-end,device,performance" &&
      panels.active === "front-end",
    panels,
  );

  await client.evaluate(`document.querySelector('[data-devtools-tab="device"]')?.click()`);
  await wait(700);
  const devicePanel = await client.evaluate(`(() => ({
    open: Boolean(document.querySelector('[data-device-panel]')),
    presets: [...document.querySelectorAll('[data-device-preset]')].map((el) => el.dataset.devicePreset),
  }))()`);
  check(
    "the device tab shows the device list",
    devicePanel?.open === true && devicePanel.presets.length >= 4,
    devicePanel,
  );

  await client.evaluate(
    `(() => { document.querySelector('[data-device-preset="iPhone 15"]')?.click(); return true; })()`,
  );
  await wait(1200);
  const emulated = await probe();
  check(
    "the emulated device reaches innerWidth, DPR, touch and the UA",
    emulated?.innerWidth === 393 &&
      emulated?.innerHeight === 852 &&
      emulated?.dpr === 3 &&
      emulated?.touch === 5 &&
      /iPhone/.test(String(emulated?.ua)),
    emulated,
  );

  // A touch event has to actually arrive; a page that only reports the numbers
  // would look emulated while ignoring every tap.
  const touchDelivered = await (async () => {
    const pageTargetNow = await pageTarget();
    if (!pageTargetNow) return null;
    const c = await connect(pageTargetNow.webSocketDebuggerUrl);
    try {
      await c.send("Input.dispatchTouchEvent", {
        type: "touchStart", touchPoints: [{ x: 60, y: 60 }],
      });
      await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await wait(300);
      return await c.evaluate("window.__touchCount");
    } finally {
      c.close();
    }
  })();
  check("touch events reach an emulated page", touchDelivered >= 1, { touchDelivered });

  // --- Survives navigation -------------------------------------------------
  await (async () => {
    const pageTargetNow = await pageTarget();
    const c = await connect(pageTargetNow.webSocketDebuggerUrl);
    try {
      await c.evaluate("document.getElementById('next').click()");
    } finally {
      c.close();
    }
  })();
  await wait(1800);
  const afterNav = await probe();
  check(
    "the device survives a cross-document navigation",
    String(afterNav?.url).endsWith("/second") &&
      afterNav?.innerWidth === 393 &&
      afterNav?.touch === 5,
    afterNav,
  );

  // --- Back to a plain viewport keeps the size -----------------------------
  await client.evaluate(`document.querySelector('[data-device-clear]')?.click()`);
  await wait(1200);
  const cleared = await probe();
  const clearedState = await client.evaluate(
    `(async () => (await window.ensemble.getEmbeddedState()).tabs.find(t => t.id === ${JSON.stringify(tabId)}) ?? null)()`,
  );
  /*
   * The page is still split with the panel, so its *drawn* width is less than
   * the viewport it lays out at — the viewport is what the page reports, and
   * the zoom factor is what fits it into the split. Asserting the drawn width
   * would be asserting the split, not the emulation.
   */
  const scale = clearedState?.zoom ? clearedState.zoom / 100 : 1;
  check(
    "clearing a device drops touch and the UA but keeps the size",
    Math.abs(cleared?.innerWidth - 393) <= 2 &&
      cleared?.touch === 0 &&
      !/iPhone/.test(String(cleared?.ua)) &&
      clearedState?.viewport?.width === 393 &&
      clearedState?.device === undefined,
    { probe: cleared, viewport: clearedState?.viewport, device: clearedState?.device, scale },
  );

  // --- Performance tab -----------------------------------------------------
  await client.evaluate(`document.querySelector('[data-devtools-tab="performance"]')?.click()`);
  await wait(2600);
  const perf = await client.evaluate(`(async () => ({
    open: Boolean(document.querySelector('[data-perf-panel]')),
    values: [...document.querySelectorAll('[data-perf-value]')].map((el) => ({
      metric: el.dataset.perfValue, text: el.textContent.trim(),
    })),
    samples: (await window.ensemble.readEmbeddedPerf(${JSON.stringify(tabId)})).length,
  }))()`);
  check(
    "the performance tab collects samples and fills the table",
    perf?.open === true &&
      perf.samples >= 1 &&
      perf.values.length === 8 &&
      perf.values.every((entry) => entry.text && entry.text !== "—"),
    { samples: perf?.samples, values: perf?.values },
  );

  const history = await client.evaluate(
    `window.ensemble.readEmbeddedPerf(${JSON.stringify(tabId)})`,
  );
  check(
    "the samples carry real values, not placeholders",
    Array.isArray(history) &&
      history.length >= 1 &&
      history.every((sample) => typeof sample.nodes === "number" && sample.nodes >= 0),
    history?.slice(-1),
  );

  // --- Samples arrive often enough to show a stutter ----------------------
  // The first version sampled once a second, so a 200ms freeze fell entirely
  // between two samples and the chart was a flat line on a busy page. Checked
  // while this tab still owns the sampler: switching tabs stops it by design.
  const cadence = await client.evaluate(
    `(async () => {
      const samples = await window.ensemble.readEmbeddedPerf(${JSON.stringify(tabId)});
      const gaps = samples.slice(1).map((s, i) => s.t - samples[i].t);
      return { count: samples.length, maxGap: Math.max(0, ...gaps) };
    })()`,
  );
  check(
    "the performance sampler runs several times a second",
    cadence?.count >= 6 && cadence.maxGap < 900,
    cadence,
  );

  // --- Dragging the split must not bring the native front-end back ---------
  // Regression: `placeDevTools` wrote the panel's bounds on every layout pass,
  // so a split drag re-showed the native DevTools over the Device tab. It is a
  // native view, so it painted on top of the HTML panel and the tab vanished.
  await client.evaluate(`document.querySelector('[data-devtools-tab="device"]')?.click()`);
  await wait(500);
  const grip = await client.evaluate(`(() => {
    const el = document.querySelector('.devtools-grip');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  check("the split has a grabbable handle", grip !== null, grip ?? undefined);
  if (grip) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: grip.x, y: grip.y, button: "left", clickCount: 1,
    });
    for (const offset of [14, 30, 48]) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: grip.x - offset, y: grip.y, button: "left", buttons: 1,
      });
      await wait(140);
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: grip.x - 48, y: grip.y, button: "left", clickCount: 1,
    });
    await wait(800);
  }
  const afterDrag = await client.evaluate(`(() => ({
    devicePanel: Boolean(document.querySelector('[data-device-panel]')),
    activeTab: document.querySelector('.devtools-tab.active')?.dataset.devtoolsTab ?? null,
  }))()`);
  check(
    "dragging the split leaves the Device tab showing, not the native panel",
    afterDrag.devicePanel === true && afterDrag.activeTab === "device",
    afterDrag,
  );

  // --- Zoom: gone from the toolbar, still reachable, and it reports back ---
  // The page is still pinned at 393×852 here, so this also covers the gesture
  // that *cannot* change the zoom: it must still say what the state is rather
  // than look like a dead shortcut.
  const zoomUi = await client.evaluate(`(() => ({
    inToolbar: Boolean(document.querySelector('.toolbar .zoom-stepper')),
  }))()`);
  check("the toolbar no longer carries a zoom stepper", zoomUi.inToolbar === false, zoomUi);

  await client.evaluate(`window.ensemble.zoomEmbeddedTab(${JSON.stringify(tabId)}, 'in')`);
  await wait(500);
  const noticeShown = await client.evaluate(
    `Boolean(document.querySelector('[data-zoom-toast]'))`,
  );
  check("a zoom gesture raises the transient percentage overlay", noticeShown === true, {
    noticeShown,
  });
  await wait(1700);
  const noticeGone = await client.evaluate(
    `Boolean(document.querySelector('[data-zoom-toast]'))`,
  );
  check("the overlay goes away on its own", noticeGone === false, { noticeGone });
  await client.evaluate(`window.ensemble.zoomEmbeddedTab(${JSON.stringify(tabId)}, 'reset')`);

  // --- Leaving the tab stops the sampling ----------------------------------
  await client.evaluate(`document.querySelector('[data-devtools-tab="front-end"]')?.click()`);
  await wait(800);
  const stopped = await client.evaluate(
    `(async () => {
      const before = (await window.ensemble.readEmbeddedPerf(${JSON.stringify(tabId)})).length;
      await new Promise((r) => setTimeout(r, 2600));
      const after = (await window.ensemble.readEmbeddedPerf(${JSON.stringify(tabId)})).length;
      return { before, after };
    })()`,
  );
  check(
    "leaving the performance tab stops polling",
    stopped?.before === 0 && stopped.after === 0,
    stopped,
  );

  // The native front-end must come back, which is only observable at the target
  // level: it is a main-process view.
  const devtoolsTargets = (
    await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json()
  ).filter((item) => item.url.startsWith("devtools://"));
  check("the native front-end is still alive after switching tabs", devtoolsTargets.length >= 1, {
    count: devtoolsTargets.length,
  });

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1200);
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
