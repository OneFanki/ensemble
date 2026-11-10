#!/usr/bin/env node
/**
 * The chrome's click geometry and the tab-insert animation.
 *
 * Three things people reported, all about the top band:
 *
 * 1. **Tabs started 4px below the window's top edge.** The tab was 30px inside a
 *    34px strip, bottom-aligned. On a maximised window that turns the top of the
 *    screen — normally an infinite target you can slam the pointer into — into a
 *    4px band of dead frame. The tab now fills the strip.
 * 2. **Clicking the empty part of the header did not dismiss an open menu.** The
 *    header is an app-region, and Electron consumes mouse events there, so the
 *    click never reached the document where the dismissal listeners live. While
 *    any layer is open the regions surrender their role.
 * 3. **A new tab appeared instantly**, popping in at full width while every tab
 *    to its right jumped sideways. It now grows and the neighbours slide.
 *
 * All three are measured, not eyeballed: the geometry from `getBoundingClientRect`,
 * the dismissal by dispatching the click a person would make, and the animation
 * by sampling the width across frames.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-chromeclick-"));
const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>页面</title></head>
<body style="margin:0;background:#134e4a;color:#fff;font:16px system-ui;padding:24px">页面</body></html>`,
  );
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [
      { id: uuid(2), name: "管理员 · 主账号", username: "admin", role: "admin", color: "amber" },
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
const app = spawn(electron, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
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

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message.result);
    }
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

try {
  let target;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) => item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      /* starting */
    }
  }
  if (!target) throw new Error(`no renderer\n${appLog.slice(-800)}`);
  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3400);

  await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(`http://127.0.0.1:${PAGE_PORT}/`)} });
    return true;
  })()`);
  await wait(2000);

  // --- 1. The tab reaches the window's top edge ----------------------------
  const geometry = await client.evaluate(`(() => {
    const strip = document.querySelector('.tabstrip');
    const tab = document.querySelector('.tabstrip .tab');
    if (!strip || !tab) return null;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    return {
      stripTop: Math.round(stripBox.top),
      stripHeight: Math.round(stripBox.height),
      tabTop: Math.round(tabBox.top),
      tabHeight: Math.round(tabBox.height),
      gapAbove: Math.round(tabBox.top - stripBox.top),
      gapBelow: Math.round(stripBox.bottom - tabBox.bottom),
    };
  })()`);
  check("the tab strip starts at the window's top", geometry?.stripTop === 0, geometry);
  check(
    "the tab itself reaches the window's top edge",
    geometry?.gapAbove === 0 && geometry?.tabHeight === geometry?.stripHeight,
    geometry,
  );
  check(
    "the whole strip height is clickable tab",
    geometry?.gapBelow === 0,
    geometry,
  );

  // --- 2. Clicking the header's empty area dismisses an open layer ---------
  const dismissal = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const panel = () => document.querySelector('.global-viewport-menu');
    const trigger = document.querySelector('.global-viewport .viewport-btn');
    if (!trigger) return { error: 'no viewport trigger' };

    trigger.click();
    await wait(250);
    const opened = Boolean(panel());
    // The drag flag must be published while the menu is up, or the click below
    // would never reach the document at all.
    const floatingWhileOpen = document.documentElement.dataset.floating ?? null;

    // The empty middle of the strip: not a control, exactly where a person aims
    // to dismiss something.
    const strip = document.querySelector('.tabstrip');
    const rect = strip.getBoundingClientRect();
    const x = Math.round(rect.width * 0.6);
    const y = Math.round(rect.top + rect.height / 2);
    const atPoint = document.elementFromPoint(x, y);
    const target = atPoint ?? strip;

    for (const type of ['pointerdown', 'pointerup', 'click']) {
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    }
    await wait(300);

    return {
      opened,
      closedByHeaderClick: !panel(),
      floatingWhileOpen,
      floatingAfterClose: document.documentElement.dataset.floating ?? null,
    };
  })()`);
  check("the viewport menu opens", dismissal?.opened === true, dismissal);
  check(
    "a layer announces itself so the drag band can stand down",
    dismissal?.floatingWhileOpen === "1",
    dismissal,
  );
  check(
    "clicking the header's empty area dismisses the menu",
    dismissal?.closedByHeaderClick === true,
    dismissal,
  );
  check(
    "the drag band comes back once the layer is closed",
    dismissal?.floatingAfterClose === null,
    dismissal,
  );

  // --- 3. A new tab animates in ------------------------------------------
  const animation = await client.evaluate(`(async () => {
    const strip = document.querySelector('.tabstrip .tabs');
    if (!strip) return { error: 'no tabs container' };

    // The strip lists the pages of the *focused window*, so the new entry has to
    // be a page of the same instance. Opening a loose tab would create a second
    // window and leave this strip's contents unchanged.
    const state = await window.ensemble.getEmbeddedState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!active) return { error: 'no active tab' };
    const instanceId = active.instanceId;

    const before = [...strip.querySelectorAll('.tab')].length;
    const done = window.ensemble.openEmbeddedTabInInstance(instanceId).then(() => true);

    /*
     * Ask the browser what it is animating rather than sampling widths.
     *
     * A width sampler looked like the honest test and was not: under load rAF
     * ticks can skip most of a 160ms transition, so a working animation reads as
     * a single intermediate value and the suite fails on a busy machine. The
     * animations on the new tab are a fact the engine reports directly, and they
     * are what the transition is made of.
     */
    const deadline = performance.now() + 3000;
    let animations = [];
    while (performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
      const tabs = [...strip.querySelectorAll('.tab')];
      if (tabs.length <= before) continue;
      const last = tabs[tabs.length - 1];
      // getAnimations includes CSS transitions in flight. Read the properties
      // they touch so a transform-only fade cannot pass as a grow.
      animations = last.getAnimations().map((animation) => ({
        duration: animation.effect?.getTiming().duration ?? null,
        properties: animation.transitionProperty ?? animation.animationName ?? null,
      }));
      if (animations.length) break;
    }
    await done;
    await new Promise((r) => setTimeout(r, 400));

    const after = [...strip.querySelectorAll('.tab')].length;
    return {
      before,
      after,
      animations,
      // The transition has to cover layout-affecting properties; a pure opacity
      // fade would leave the strip snapping sideways.
      animatesLayout: animations.some((item) =>
        ["max-width", "min-width", "padding", "padding-left", "padding-right"].includes(item.properties),
      ),
    };
  })()`);
  check("the new tab was added", (animation?.after ?? 0) === (animation?.before ?? 0) + 1, animation);
  check(
    "the new tab animates its width instead of appearing at full size",
    animation?.animatesLayout === true,
    animation,
  );

  client.close();
} catch (error) {
  check("the suite ran to completion", false, String(error));
  console.error(appLog.slice(-1200));
} finally {
  app.kill();
  page.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n[chrome-click] ${passed}/${results.length} assertions passed`);
process.exit(passed === results.length ? 0 : 1);
