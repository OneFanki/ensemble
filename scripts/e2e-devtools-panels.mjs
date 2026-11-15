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
    cursor: getComputedStyle(document.body).cursor,
    touchDot: Boolean(document.getElementById('__ensemble_touch_dot')),
    touchClass: document.documentElement.classList.contains('ensemble-touch-cursor'),
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
    cursor: getComputedStyle(document.body).cursor,
    touchDot: Boolean(document.getElementById('__ensemble_touch_dot')),
    touchClass: document.documentElement.classList.contains('ensemble-touch-cursor'),
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

  const devtoolsFrontend = await (async () => {
    const port = await waitForDebugPort(userData);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find((item) => item.url.startsWith("devtools://"));
    if (!target) return null;
    const c = await connect(target.webSocketDebuggerUrl);
    try {
      return await c.evaluate(`(() => {
        const labels = [];
        let tree = null;
        const walk = (root, depth) => {
          if (depth > 8) return;
          for (const el of root.querySelectorAll("*")) {
            if (el.classList?.contains("elements-tree-outline")) tree = el;
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
            if (!el.children.length && labels.length <= 80) {
              const value = (el.textContent || "").trim();
              if (value && !/^[.:@#*]/.test(value) && !value.includes("var(")) labels.push(value.slice(0, 50));
            }
          }
        };
        walk(document, 0);
        let hostBound = false;
        try {
          hostBound = String(InspectorFrontendHost.sendMessageToBackend).includes("DevToolsAPI");
        } catch {
          // The stub means the front-end never got a host.
        }
        return {
          language: localStorage.getItem("language"),
          rootCursor: getComputedStyle(document.documentElement).cursor,
          labels,
          treeChildren: tree ? tree.children.length : -1,
          hostBound,
        };
      })()`);
    } finally {
      c.close();
    }
  })();
  check(
    "the native front-end opens in the app language, with no language bar",
    devtoolsFrontend?.labels?.includes("元素") &&
      devtoolsFrontend?.labels?.includes("控制台") &&
      !devtoolsFrontend.labels.some((label) => label.includes("now available in Chinese")),
    {
      language: devtoolsFrontend?.language,
      labels: devtoolsFrontend?.labels?.slice(0, 24),
    },
  );
  check(
    "the native front-end is bound to the page, not an empty shell",
    devtoolsFrontend?.hostBound === true && (devtoolsFrontend?.treeChildren ?? 0) > 0,
    { hostBound: devtoolsFrontend?.hostBound, treeChildren: devtoolsFrontend?.treeChildren },
  );
  check(
    "DevTools names an explicit default cursor, so a page's touch cursor cannot stick",
    devtoolsFrontend?.rootCursor === "default",
    { rootCursor: devtoolsFrontend?.rootCursor },
  );

  await client.evaluate(`document.querySelector('[data-devtools-tab="device"]')?.click()`);
  await wait(700);
  const devicePanel = await client.evaluate(`(() => {
    const panel = document.querySelector('[data-device-panel]');
    return {
      open: Boolean(panel),
      mode: document.querySelector('[data-device-mode].active')?.dataset.deviceMode ?? null,
      rows: document.querySelectorAll('[data-device-resolution]').length,
      adaptive: Boolean(document.querySelector('[data-device-adaptive]')),
      custom: Boolean(document.querySelector('[data-device-custom]')),
      preview: Boolean(document.querySelector('[data-device-preview]')),
      legacy: Boolean(document.querySelector('[data-device-touch], [data-device-ua], [data-device-dpr]')),
    };
  })()`);
  check(
    "the device tab is a desktop/mobile switch with one list and a custom row",
    devicePanel?.open === true &&
      devicePanel.mode === "desktop" &&
      devicePanel.rows === 5 &&
      devicePanel.adaptive === true &&
      devicePanel.custom === true &&
      devicePanel.preview === false &&
      devicePanel.legacy === false,
    devicePanel,
  );

  const click = async (selector) => {
    await client.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
    await wait(1200);
    return probe();
  };
  const clickMode = async (mode) => {
    await client.evaluate(`document.querySelector('[data-device-mode="${mode}"]')?.click()`);
    await wait(1200);
  };
  const tabState = () =>
    client.evaluate(
      `(async () => (await window.ensemble.getEmbeddedState()).tabs.find((t) => t.id === ${JSON.stringify(tabId)}) ?? null)()`,
    );
  const setSizeField = async (which, value) => {
    await client.evaluate(`(() => {
      const input = document.querySelector('[data-device-${which}]');
      if (!input) return false;
      input.focus();
      input.value = ${JSON.stringify(String(value))};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return true;
    })()`);
    await wait(1200);
    return probe();
  };

  const desktopPreset = await click('[data-device-resolution="1280x720"]');
  const desktopPresetState = await tabState();
  check(
    "a desktop resolution pins the viewport and leaves the page a desktop browser",
    desktopPreset?.innerWidth === 1280 &&
      Math.abs(Number(desktopPreset?.innerHeight) - 720) <= 1 &&
      desktopPreset?.touch === 0 &&
      desktopPresetState?.device === undefined &&
      desktopPresetState?.viewport?.width === 1280,
    { probe: desktopPreset, device: desktopPresetState?.device, viewport: desktopPresetState?.viewport },
  );

  await click("[data-device-custom]");
  const customFields = await client.evaluate(`({
    width: Boolean(document.querySelector('[data-device-width]')),
    height: Boolean(document.querySelector('[data-device-height]')),
    active: Boolean(document.querySelector('[data-device-custom].active')),
  })`);
  const customDesktop = await setSizeField("width", 900);
  check(
    "choosing Custom reveals the size fields, and typing applies a desktop size",
    customFields.width === true &&
      customFields.height === true &&
      customFields.active === true &&
      customDesktop?.innerWidth === 900 &&
      customDesktop?.touch === 0,
    { fields: customFields, probe: customDesktop },
  );

  /*
   * A custom size can land exactly on a preset. It still has to read as one
   * choice: the preset row used to light up alongside Custom, and both rows
   * carried a left accent rail. The rail is gone; selection is the background.
   */
  await setSizeField("width", 1920);
  await setSizeField("height", 1080);
  const selection = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-device-panel] .res-row.active')];
    return {
      count: rows.length,
      custom: rows.some((el) => el.hasAttribute('data-device-custom')),
      preset: rows.some((el) => el.hasAttribute('data-device-resolution')),
      shadows: rows.map((el) => getComputedStyle(el).boxShadow),
    };
  })()`);
  check(
    "a custom size that matches a preset leaves exactly one selected row, with no accent rail",
    selection?.count === 1 &&
      selection.custom === true &&
      selection.preset === false &&
      selection.shadows.every((shadow) => shadow === "none"),
    selection,
  );

  const adaptive = await click("[data-device-adaptive]");
  const adaptiveState = await tabState();
  const frameAfterAdaptive = await client.evaluate(
    `Boolean(document.querySelector('[data-page-frame]'))`,
  );
  check("adaptive removes the page resize frame", frameAfterAdaptive === false, {
    frame: frameAfterAdaptive,
  });
  check(
    "adaptive clears the device and gives the page its cell size back",
    adaptive?.innerWidth > 500 &&
      /*
       * The 1920×1080 step above was fitted by a zoom factor. Leaving it has to
       * hand the zoom back: a retained fit renders the adaptive page tiny, with
       * a DPR scaled by the stale factor and a CSS viewport wider than its own
       * box. The box is published by main, so it works with DevTools open.
       */
      Math.abs(Number(adaptive?.innerWidth) - Number(adaptiveState?.bounds?.width ?? 0)) <= 2 &&
      Math.abs(Number(adaptive?.dpr) - Number(baseline?.dpr)) < 0.01 &&
      adaptiveState?.device === undefined &&
      adaptiveState?.viewport === undefined,
    { probe: adaptive, device: adaptiveState?.device, viewport: adaptiveState?.viewport },
  );

  // --- Mobile mode ---------------------------------------------------------
  await clickMode("mobile");
  const mobilePanel = await client.evaluate(`({
    mode: document.querySelector('[data-device-mode].active')?.dataset.deviceMode ?? null,
    rows: document.querySelectorAll('[data-device-device]').length,
    active: document.querySelector('[data-device-device].active')?.dataset.deviceDevice ?? null,
    rowsDetail: [...document.querySelectorAll('[data-device-device]')].map((el) => ({
      name: el.dataset.deviceDevice,
      cls: el.className,
    })),
    adaptive: Boolean(document.querySelector('[data-device-adaptive]')),
  })`);
  const mobileState = await tabState();
  const iphone = await probe();
  check(
    "switching to Mobile applies a phone identity in one click",
    mobilePanel.mode === "mobile" &&
      mobilePanel.rows === 5 &&
      mobilePanel.active === "iPhone 15" &&
      mobilePanel.adaptive === false &&
      iphone?.innerWidth === 393 &&
      iphone?.innerHeight === 852 &&
      iphone?.dpr === 3 &&
      iphone?.touch === 5 &&
      /iPhone/.test(String(iphone?.ua)),
    { panel: mobilePanel, device: mobileState?.device, probe: iphone },
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

  /*
   * The touch cursor is Chromium's own native touch cursor, enabled by
   * `setEmitTouchEventsForMouse` only while the pointer is over the page. The
   * page therefore must not carry a second, DOM-drawn dot; the old version did,
   * and the two overlapped. Mouse-to-touch conversion itself cannot be observed
   * from synthetic CDP events, so a real drag is verified in a visible window.
   */
  const touchCursor = await (async () => {
    const pageTargetNow = await pageTarget();
    if (!pageTargetNow) return null;
    const c = await connect(pageTargetNow.webSocketDebuggerUrl);
    try {
      return await c.evaluate(`({
        dot: Boolean(document.getElementById('__ensemble_touch_dot')),
        cls: document.documentElement.classList.contains('ensemble-touch-cursor'),
        cursor: getComputedStyle(document.body).cursor,
      })`);
    } finally {
      c.close();
    }
  })();
  check(
    "touch emulation leaves the page's cursor to Chromium, with no second dot",
    touchCursor?.dot === false && touchCursor?.cls === false,
    touchCursor,
  );
  const hostCursor = await client.evaluate(`({
    body: getComputedStyle(document.body).cursor,
    shell: getComputedStyle(document.querySelector('.app-shell')).cursor,
    address: getComputedStyle(document.querySelector('.address input') ?? document.body).cursor,
  })`);
  check(
    "the touch cursor stays inside the page, not the app chrome",
    hostCursor.body === "default" &&
      hostCursor.shell === "default" &&
      hostCursor.address === "text",
    hostCursor,
  );

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
      afterNav?.touch === 5 &&
      afterNav?.touchDot === false,
    afterNav,
  );

  const pixel = await click('[data-device-device="Pixel 8"]');
  check(
    "another device replaces the whole identity",
    pixel?.innerWidth === 412 &&
      pixel?.innerHeight === 915 &&
      Math.abs(Number(pixel?.dpr) - 2.625) < 0.01 &&
      pixel?.touch === 5 &&
      /Pixel/.test(String(pixel?.ua)),
    pixel,
  );

  const rotated = await click("[data-device-swap]");
  check(
    "the swap control rotates the chosen device without losing its identity",
    rotated?.innerWidth === 915 &&
      rotated?.innerHeight === 412 &&
      Math.abs(Number(rotated?.dpr) - 2.625) < 0.01 &&
      rotated?.touch === 5 &&
      /Pixel/.test(String(rotated?.ua)),
    rotated,
  );

  await click("[data-device-custom]");
  const customMobile = await setSizeField("width", 500);
  const customMobileState = await tabState();
  const customSelected = await client.evaluate(
    `Boolean(document.querySelector('[data-device-custom].active'))`,
  );
  check(
    "a custom mobile size keeps the last device profile and drops its name",
    customMobile?.innerWidth === 500 &&
      customMobile?.innerHeight === 412 &&
      Math.abs(Number(customMobile?.dpr) - 2.625) < 0.01 &&
      customMobile?.touch === 5 &&
      /Pixel/.test(String(customMobile?.ua)) &&
      customMobileState?.device?.name === undefined &&
      customSelected === true,
    { probe: customMobile, device: customMobileState?.device, customSelected },
  );

  /*
   * The page's own edge, not the panel's preview: a fixed-size page is drawn
   * with a frame, a drag hint and a CSS-size badge, and dragging its right edge
   * must change both the page's innerWidth and the badge.
   */
  const frameInfo = await client.evaluate(`(() => {
    const frame = document.querySelector('[data-page-frame]');
    const badge = document.querySelector('[data-page-size]');
    const grip = document.querySelector('[data-page-resize="se"] .frame-grip');
    const right = document.querySelector('[data-page-resize="e"]');
    const bottom = document.querySelector('[data-page-resize="s"]');
    const fr = frame?.getBoundingClientRect();
    const br = badge?.getBoundingClientRect();
    const rr = right?.getBoundingClientRect();
    const sr = bottom?.getBoundingClientRect();
    const atRight = rr ? document.elementFromPoint(rr.left + rr.width / 2, rr.top + 20) : null;
    return {
      frame: Boolean(frame),
      grip: Boolean(grip),
      badge: badge?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      frameRect: fr ? { left: fr.left, right: fr.right, top: fr.top, bottom: fr.bottom } : null,
      badgeRect: br ? { left: br.left, top: br.top, right: br.right, bottom: br.bottom } : null,
      rightRect: rr ? { left: rr.left, top: rr.top, width: rr.width, height: rr.height } : null,
      bottomRect: sr ? { left: sr.left, top: sr.top, width: sr.width, height: sr.height } : null,
      rightHit: atRight?.getAttribute?.('data-page-resize') ?? null,
      rightCursor: atRight ? getComputedStyle(atRight).cursor : null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  const badgeRect = frameInfo?.badgeRect;
  const frameRect = frameInfo?.frameRect;
  check(
    "a fixed page shows its resize frame, grip and CSS size",
    frameInfo?.frame === true && frameInfo.grip === true && frameInfo.badge === "500 × 412",
    frameInfo,
  );
  check(
    "the size badge sits just outside the page edge, on screen",
    Boolean(badgeRect && frameRect) &&
      Math.abs(badgeRect.left - (frameRect.right + 8)) <= 2 &&
      badgeRect.right <= frameInfo.viewport.width &&
      badgeRect.bottom <= frameInfo.viewport.height &&
      (badgeRect.top >= frameRect.bottom + 6 || badgeRect.bottom <= frameRect.bottom - 6),
    { badge: badgeRect, frame: frameRect, viewport: frameInfo?.viewport },
  );
  check(
    "the resize handles sit outside the page, in the app's own gutter",
    Boolean(frameInfo?.rightRect && frameInfo?.bottomRect && frameRect) &&
      frameInfo.rightRect.left >= frameRect.right - 1 &&
      frameInfo.bottomRect.top >= frameRect.bottom - 1 &&
      frameInfo.rightRect.left > frameRect.right - 2,
    { right: frameInfo?.rightRect, bottom: frameInfo?.bottomRect, frame: frameRect },
  );
  check(
    "the page edge hit-tests as a resize handle with a resize cursor",
    frameInfo?.rightHit === "e" && frameInfo?.rightCursor === "ew-resize",
    { hit: frameInfo?.rightHit, cursor: frameInfo?.rightCursor },
  );

  const frameDrag = await client.evaluate(`(async () => {
    const handle = document.querySelector('[data-page-frame] [data-page-resize="e"]');
    const badge = document.querySelector('[data-page-size]');
    const frame = document.querySelector('[data-page-frame]');
    if (!handle || !badge || !frame) return { missing: true };
    const read = () => badge.textContent.replace(/\\s+/g, ' ').trim();
    const before = read();
    const rect = handle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, button: 0,
      pointerId: 61, pointerType: 'mouse', isPrimary: true,
    };
    handle.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
    handle.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + 40, clientY: y }));
    handle.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x + 40, clientY: y }));
    await new Promise((r) => setTimeout(r, 1200));
    return { before, after: read(), frameWidth: frame.getBoundingClientRect().width };
  })()`);
  const frameProbe = await probe();
  const frameState = await tabState();
  check(
    "dragging the page's right edge changes the page width and badge",
    frameDrag?.missing !== true &&
      frameDrag.after !== frameDrag.before &&
      frameProbe?.innerWidth > 500 &&
      frameState?.device?.name === undefined,
    { drag: frameDrag, probe: frameProbe, device: frameState?.device },
  );

  /*
   * A fixed page is fitted into its cell, so a drag that outgrows the cell used
   * to drop the fit scale: the page shrank in the axis nobody dragged, and the
   * frame — which follows the pointer — slid off the page's edge. The size is
   * capped at what the cell holds at the starting scale instead.
   */
  const cellWidth = frameState?.cell?.width ?? 0;
  check("the fitted cell is published for the resize frame", cellWidth > 300, frameState?.cell);
  await client.evaluate(
    `window.ensemble.setEmbeddedViewport(${JSON.stringify(tabId)}, { width: ${Math.max(320, cellWidth - 20)}, height: 360 })`,
  );
  await wait(1000);
  const wideDrag = await client.evaluate(`(async () => {
    const handle = document.querySelector('[data-page-frame] [data-page-resize="e"]');
    const frame = document.querySelector('[data-page-frame]');
    if (!handle || !frame) return { missing: true };
    const rect = handle.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true, cancelable: true, button: 0,
      pointerId: 62, pointerType: 'mouse', isPrimary: true,
    };
    handle.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x, clientY: y }));
    handle.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x + 60, clientY: y }));
    handle.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x + 60, clientY: y }));
    await new Promise((r) => setTimeout(r, 1200));
    const fr = frame.getBoundingClientRect();
    const guest = [...document.querySelectorAll('webview')]
      .map((node) => node.getBoundingClientRect())
      .find((box) => box.width > 0 && box.left >= 0);
    return {
      frame: { left: fr.left, right: fr.right, width: fr.width, height: fr.height },
      guest: guest && { left: guest.left, top: guest.top, right: guest.right, width: guest.width, height: guest.height },
    };
  })()`);
  const wideState = await tabState();
  check(
    "dragging past the cell caps the page instead of shrinking it",
    wideDrag?.missing !== true &&
      wideState?.viewport?.width === cellWidth &&
      wideState?.viewport?.height === 360 &&
      Math.abs((wideDrag?.guest?.height ?? 0) - 360) <= 1 &&
      Math.abs((wideDrag?.frame?.right ?? 0) - (wideDrag?.guest?.right ?? -1)) <= 1,
    { cellWidth, viewport: wideState?.viewport, bounds: wideState?.bounds, drag: wideDrag },
  );

  /*
   * Mobile mode is a whole preset, and leaving it must restore the desktop
   * answer that was there before — not carry the phone's 393×852 into desktop
   * mode and present it as a custom desktop size.
   */
  await client.evaluate(
    `window.ensemble.setEmbeddedViewport(${JSON.stringify(tabId)}, { width: 1024, height: 768 })`,
  );
  await wait(900);
  await click('[data-device-mode="mobile"]');
  await wait(900);
  const toMobile = await tabState();
  await click('[data-device-mode="desktop"]');
  await wait(900);
  const backToDesktop = await tabState();
  await click('[data-device-adaptive]');
  await wait(700);
  await click('[data-device-mode="mobile"]');
  await wait(700);
  await click('[data-device-mode="desktop"]');
  await wait(900);
  const adaptiveRoundTrip = await tabState();
  check(
    "leaving mobile mode restores the desktop viewport, not the phone's size",
    toMobile?.device !== undefined &&
      backToDesktop?.device === undefined &&
      backToDesktop?.viewport?.width === 1024 &&
      backToDesktop?.viewport?.height === 768,
    { mobile: toMobile?.viewport, back: backToDesktop?.viewport, device: backToDesktop?.device },
  );
  check(
    "an adaptive page stays adaptive across a mobile round trip",
    adaptiveRoundTrip?.device === undefined && adaptiveRoundTrip?.viewport === undefined,
    { viewport: adaptiveRoundTrip?.viewport, device: adaptiveRoundTrip?.device },
  );

  /*
   * Focusing the address bar opens a floating layer, which parks the docked
   * panel. That path used to write the raw split rectangle instead of fitting
   * the viewport into it: a 390px phone grew to the split width while emulation
   * still laid out at 390px, so the page sat at the top-left of an empty node.
   */
  const addressProbe = await (async () => {
    await client.evaluate(`(async () => {
      await window.ensemble.setEmbeddedDevice(${JSON.stringify(tabId)}, {
        width: 390, height: 844, dpr: 1, touch: true,
      });
    })()`);
    await wait(900);
    const read = () =>
      tabState().then((tab) => ({
        bounds: tab?.bounds,
        device: tab?.device,
        viewport: tab?.viewport,
        zoom: tab?.zoom,
      }));
    const before = await read();
    await client.evaluate(`(() => {
      const input = document.querySelector('.address input');
      input?.focus();
      input?.click();
      return Boolean(input);
    })()`);
    await wait(1100);
    const after = await read();
    await client.evaluate(`document.querySelector('.address input')?.blur()`);
    await wait(500);
    return { before, after };
  })();
  check(
    "focusing the address bar keeps a fixed page fitted instead of growing its node",
    (addressProbe.before.bounds?.width ?? 0) > 300 &&
      (addressProbe.before.bounds?.width ?? 0) < 390 &&
      addressProbe.after.bounds?.width === addressProbe.before.bounds?.width &&
      addressProbe.after.bounds?.x === addressProbe.before.bounds?.x &&
      addressProbe.after.zoom === addressProbe.before.zoom,
    addressProbe,
  );

  // Desktop mode restores what it wore before the phone, not the phone's size.
  await clickMode("desktop");
  const desktopCustom = await probe();
  const desktopCustomState = await tabState();
  check(
    "switching back to Desktop restores the desktop mode and drops the phone identity",
    desktopCustom?.touch === 0 &&
      desktopCustomState?.device === undefined &&
      desktopCustomState?.viewport === undefined &&
      desktopCustom?.innerWidth === desktopCustomState?.bounds?.width,
    { probe: desktopCustom, device: desktopCustomState?.device, viewport: desktopCustomState?.viewport },
  );
  check(
    "a desktop page no longer carries the touch cursor",
    desktopCustom?.cursor !== "none" && Boolean(desktopCustom?.touchDot) === false,
    { cursor: desktopCustom?.cursor, touchDot: desktopCustom?.touchDot },
  );

  const wideDesktop = await click('[data-device-resolution="1920x1080"]');
  const wideDesktopState = await tabState();
  check(
    "a generic desktop resolution stays a plain viewport",
    wideDesktop?.innerWidth === 1920 &&
      wideDesktop?.touch === 0 &&
      wideDesktopState?.device === undefined &&
      wideDesktopState?.viewport?.width === 1920 &&
      wideDesktopState?.viewport?.height === 1080,
    { probe: wideDesktop, device: wideDesktopState?.device, viewport: wideDesktopState?.viewport },
  );

  await click("[data-device-adaptive]");

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

  /*
   * Reading one number used to mean scanning the full width of the panel: the
   * metric name sat on the left and its current value on the far right. The pair
   * is now adjacent, the value carries the line's hue, every series is drawn the
   * same way, and the top gridline (where CPU's 100% sits) is a visible line
   * rather than a ghost.
   */
  const layout = await client.evaluate(`(() => {
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    return [...document.querySelectorAll('[data-perf-metric]')].map((row) => {
      const name = rect(row.querySelector('.metric-name'));
      const value = rect(row.querySelector('.metric-value'));
      const peak = rect(row.querySelector('.metric-peak'));
      const valueEl = row.querySelector('.metric-value');
      const line = row.querySelector('.spark-line');
      const grid = row.querySelector('.spark-grid:not(.dashed)');
      return {
        metric: row.getAttribute('data-perf-metric'),
        gap: name && value ? Math.round(value.left - name.right) : null,
        valueColor: valueEl ? getComputedStyle(valueEl).color : null,
        lineStroke: line ? getComputedStyle(line).stroke : null,
        d: line?.getAttribute('d') ?? null,
        gridOpacity: grid ? Number(getComputedStyle(grid).opacity) : null,
        gridDash: grid ? getComputedStyle(grid).strokeDasharray : null,
        valueBeforePeak: value && peak && peak.width > 0 ? value.left < peak.left : null,
      };
    });
  })()`);
  check(
    "the current value sits immediately after its metric name",
    layout?.length === 8 &&
      layout.every((row) => row.gap !== null && row.gap >= 0 && row.gap <= 12) &&
      layout.every((row) => row.valueBeforePeak !== false),
    layout?.map((row) => ({ metric: row.metric, gap: row.gap })),
  );
  check(
    "every value takes its curve's colour",
    layout?.length === 8 &&
      layout.every((row) => row.valueColor && row.valueColor === row.lineStroke),
    layout?.map((row) => ({
      metric: row.metric,
      value: row.valueColor,
      line: row.lineStroke,
    })),
  );
  check(
    "every series is a polyline, with no stepped segments",
    layout?.length === 8 &&
      layout.every((row) => typeof row.d === "string" && row.d.length > 0) &&
      layout.every((row) => !/[HV]/.test(row.d)),
    layout?.map((row) => ({ metric: row.metric, d: row.d?.slice(0, 24) })),
  );
  check(
    "the top gridline is a visible solid line",
    layout?.length === 8 &&
      layout.every((row) => row.gridOpacity >= 0.5 && row.gridDash === "none"),
    layout?.map((row) => ({ metric: row.metric, opacity: row.gridOpacity, dash: row.gridDash })),
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

  // --- The interval knob reaches the sampler --------------------------------
  // Both knobs cross a process boundary: settings live in the main process, the
  // panel reads the window back out of them to draw its axis, and the sampler
  // reads the interval. A break in that wire leaves the UI looking correct while
  // nothing behind it changed. Driven through the panel's own select, because
  // that is the only way a user can reach it now.
  const coarse = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const trigger = document.querySelector('[data-perf-interval] .select-trigger');
    if (!trigger) return { trigger: false };
    trigger.click();
    await wait(250);
    const options = [...document.querySelectorAll('[data-floating-panel] [role="option"]')];
    [...options].find((el) => el.textContent.includes('500 ms'))?.click();
    // Re-entering the tab restarts the sampler, which is the documented way a
    // cadence change takes effect.
    await window.ensemble.showEmbeddedDevtoolsTab(${JSON.stringify(tabId)}, "front-end");
    await wait(300);
    await window.ensemble.showEmbeddedDevtoolsTab(${JSON.stringify(tabId)}, "performance");
    await wait(3000);
    const samples = await window.ensemble.readEmbeddedPerf(${JSON.stringify(tabId)});
    const gaps = samples.slice(1).map((s, i) => s.t - samples[i].t);
    const saved = (await window.ensemble.getWorkspace())?.settings ?? {};
    return {
      trigger: true,
      saved: saved.perfSampleIntervalMs ?? null,
      shown: document.querySelector('[data-perf-interval] .select-value')?.textContent?.trim() ?? "",
      count: samples.length,
      meanGap: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0,
    };
  })()`);
  check(
    "the panel's interval knob saves, and a coarser value slows the sampler",
    coarse?.trigger === true &&
      coarse?.saved === 500 &&
      coarse?.shown === "500 ms" &&
      coarse?.count >= 3 &&
      coarse.meanGap >= 400,
    coarse,
  );

  // --- The window knob lives in the panel, and it really moves the axis ----
  // Both knobs used to be Settings rows, which meant leaving the page being
  // measured to change how it was being measured. They sit in the panel's header
  // now, so this drives the panel's own control rather than the settings API: a
  // select that draws the right window but never saves is exactly the failure
  // this pairing is for.
  const wide = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const trigger = document.querySelector('[data-perf-window] .select-trigger');
    if (!trigger) return { trigger: false };
    trigger.click();
    await wait(250);
    const options = [...document.querySelectorAll('[data-floating-panel] [role="option"]')];
    const labels = options.map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
    [...options].find((el) => el.textContent.includes('1 min'))?.click();
    await wait(900);
    const saved = (await window.ensemble.getWorkspace())?.settings ?? {};
    return {
      trigger: true,
      labels,
      settings: saved.perfWindowMs ?? null,
      shown: document.querySelector('[data-perf-window] .select-value')?.textContent?.trim() ?? "",
      // One sample is enough to prove the axis was rebuilt from the new window.
      samples: (await window.ensemble.readEmbeddedPerf(${JSON.stringify(tabId)})).length,
    };
  })()`);
  check(
    "the panel carries the window knob and saves the choice",
    wide?.trigger === true &&
      wide?.labels?.join(",").includes("1 min") &&
      wide?.settings === 60_000 &&
      wide?.shown === "1 min",
    wide,
  );
  // Back to the defaults: later checks time their waits against them.
  await client.evaluate(
    `window.ensemble.saveAppSettings({ perfSampleIntervalMs: 200, perfWindowMs: 20000 })`,
  );
  await wait(400);

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
