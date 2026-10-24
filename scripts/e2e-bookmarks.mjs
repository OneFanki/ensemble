#!/usr/bin/env node
/**
 * End-to-end checks for the daily profile and bookmarks.
 *
 * Three things this has to prove, each of which was a real defect or a real
 * design claim before the change:
 *
 * 1. A page with no identity lands in the daily profile, and "clean open" lands
 *    in a throwaway session that is not the daily profile and not persistent.
 * 2. The bookmark grid renders on the new-tab surface, renames in place, and
 *    deletes through the right-click menu.
 * 3. The address-bar star adds the current page and toggles off again.
 *
 * Everything runs headless: a real window is parked outside every display so the
 * compositor still produces frames (screenshots would hang on a hidden window).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3989;
const DEBUG_PORT = 9789;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-bookmarks-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>文档首页</title></head>
<body><h1 id="doc">文档首页</h1></body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/docs`;

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

const now = new Date().toISOString();
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    // Two bookmarks so drag/order and the grid's multi-tile layout are real.
    bookmarks: [
      {
        id: uuid(30),
        name: "文档首页",
        url: PAGE_URL,
        order: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: uuid(31),
        name: "第二个书签",
        url: "https://example.invalid/two",
        order: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", onboardingVersion: 1 }),
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

/** Polls a boolean expression so a slow first paint cannot fail a check. */
async function waitFor(client, expression, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
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

  // --- Bookmark grid on the new-tab surface --------------------------------
  const grid = await client.evaluate(`(() => {
    const tiles = [...document.querySelectorAll('.bookmarks .tile')];
    return {
      count: tiles.length,
      names: tiles.map((tile) => tile.querySelector('.tile-name')?.textContent?.trim() ?? ''),
      hasGrid: Boolean(document.querySelector('.bookmarks')),
      surface: Boolean(document.querySelector('.stage .blank-slot .new-tab')),
    };
  })()`);
  check(
    "the new-tab surface shows the seeded bookmarks",
    grid?.surface === true && grid?.count === 2 && grid?.hasGrid === true,
    grid,
  );
  check(
    "bookmark tiles carry their names",
    grid?.names?.[0] === "文档首页" && grid?.names?.[1] === "第二个书签",
    grid?.names,
  );

  // A tile without an icon falls back to a stable colour block with an initial.
  const fallback = await client.evaluate(`(() => {
    const tile = document.querySelector('.bookmarks .tile .tile-icon');
    return {
      hasImage: Boolean(tile?.querySelector('img')),
      initial: tile?.querySelector('.tile-initial')?.textContent?.trim() ?? '',
      background: tile ? getComputedStyle(tile).backgroundColor : '',
    };
  })()`);
  check(
    "an icon-less bookmark draws an initial on a coloured tile",
    fallback?.hasImage === false &&
      fallback?.initial.length === 1 &&
      fallback?.background !== "rgba(0, 0, 0, 0)",
    fallback,
  );

  // --- Rename in place ------------------------------------------------------
  const renamed = await client.evaluate(`(async () => {
    const tile = document.querySelector('.bookmarks .tile');
    tile.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((done) => setTimeout(done, 250));
    const input = document.querySelector('.bookmarks .tile .tile-rename');
    if (!input) return { opened: false };
    input.value = '改名后的书签';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((done) => setTimeout(done, 600));
    const names = [...document.querySelectorAll('.bookmarks .tile .tile-name')].map((el) =>
      el.textContent.trim(),
    );
    const state = await window.ensemble.getWorkspace();
    return {
      opened: true,
      names,
      stored: state.bookmarks.map((item) => item.name),
    };
  })()`);
  check("double-click opens an inline rename field", renamed?.opened === true, renamed);
  check(
    "renaming a bookmark persists through the store",
    renamed?.stored?.includes("改名后的书签") && renamed?.names?.includes("改名后的书签"),
    renamed,
  );

  // --- Right-click menu deletes --------------------------------------------
  const removed = await client.evaluate(`(async () => {
    const tiles = [...document.querySelectorAll('.bookmarks .tile')];
    const target = tiles[tiles.length - 1];
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
    await new Promise((done) => setTimeout(done, 250));
    const menu = document.querySelector('.bookmark-menu');
    const rows = [...(menu?.querySelectorAll('.menu-row') ?? [])].map((row) =>
      row.textContent.trim(),
    );
    // The delete row is last; clicking it removes exactly that bookmark.
    menu?.querySelectorAll('.menu-row')[1]?.click();
    await new Promise((done) => setTimeout(done, 700));
    const state = await window.ensemble.getWorkspace();
    return {
      menuOpened: Boolean(menu),
      rows,
      remaining: state.bookmarks.map((item) => item.name),
      tiles: document.querySelectorAll('.bookmarks .tile').length,
    };
  })()`);
  check(
    "right-click opens a rename/remove menu",
    removed?.menuOpened === true && removed?.rows?.length === 2,
    removed,
  );
  check(
    "the remove row deletes that bookmark and leaves the other",
    removed?.remaining?.length === 1 && removed?.tiles === 1,
    removed,
  );

  // --- Daily profile vs clean session --------------------------------------
  const partitions = await client.evaluate(`(async () => {
    const before = (await window.ensemble.getEmbeddedState()).tabs;
    // A bookmark click goes through the address bar path: a page with no identity.
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} });
    const daily = (await window.ensemble.getEmbeddedState()).tabs.find(
      (tab) => tab.url.includes('/docs') && !tab.clean,
    );
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)}, clean: true });
    const after = (await window.ensemble.getEmbeddedState()).tabs;
    const clean = after.find((tab) => tab.clean);
    return {
      before: before.length,
      after: after.length,
      dailyFound: Boolean(daily),
      dailyCleanFlag: daily?.clean ?? false,
      cleanFound: Boolean(clean),
      cleanIsSameInstance: clean && daily ? clean.instanceId === daily.instanceId : null,
      cleanUrl: clean?.url ?? '',
    };
  })()`);
  check(
    "a bookmark opens in the daily profile, not a clean session",
    partitions?.dailyFound === true && partitions?.dailyCleanFlag === false,
    partitions,
  );
  check(
    "clean open is a separate instance flagged clean",
    partitions?.cleanFound === true && partitions?.cleanIsSameInstance === false,
    partitions,
  );

  // --- Address-bar star ----------------------------------------------------
  // The star test needs a page that is definitely not bookmarked yet: the seeded
  // bookmark already covers `/docs`, so the star there is filled from the start.
  // Opening a different address last also makes it the active tab.
  const STAR_URL = `http://127.0.0.1:${PAGE_PORT}/star-target`;
  await client.evaluate(
    `window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(STAR_URL)} })`,
  );
  const starReady = await waitFor(
    client,
    `document.querySelector('.toolbar .icon.star')?.getAttribute('aria-pressed') === 'false'`,
  );
  check("a page that is not bookmarked shows an empty star", starReady === true, { starReady });

  const star = await client.evaluate(`(async () => {
    // Drive the real button so the click path (not just the service) is covered.
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await window.ensemble.getWorkspace();
      const starButton = document.querySelector('.toolbar .icon.star');
      if (!starButton) return { missing: true };
      const wasPressed = starButton.getAttribute('aria-pressed');
      starButton.click();
      await wait(800);
      const after = await window.ensemble.getWorkspace();
      if (after.bookmarks.length !== before.bookmarks.length) {
        return {
          missing: false,
          wasPressed,
          nowPressed: document.querySelector('.toolbar .icon.star')?.getAttribute('aria-pressed'),
          delta: after.bookmarks.length - before.bookmarks.length,
          urls: after.bookmarks.map((item) => item.url),
        };
      }
      await wait(400);
    }
    return { missing: false, delta: 0 };
  })()`);
  check(
    "the star adds the current page to the bookmarks",
    star?.missing === false && star?.delta === 1,
    star,
  );
  check(
    "the star reports itself as pressed once the page is bookmarked",
    star?.nowPressed === "true",
    star,
  );
  check(
    "the bookmarked entry is the page that was open",
    (star?.urls ?? []).some((url) => String(url).endsWith("/star-target")),
    star,
  );

  const unstar = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const before = (await window.ensemble.getWorkspace()).bookmarks.length;
    document.querySelector('.toolbar .icon.star')?.click();
    await wait(800);
    const after = await window.ensemble.getWorkspace();
    return {
      before,
      after: after.bookmarks.length,
      pressed: document.querySelector('.toolbar .icon.star')?.getAttribute('aria-pressed'),
    };
  })()`);
  check(
    "clicking the filled star removes the bookmark again",
    unstar?.after === unstar?.before - 1 && unstar?.pressed === "false",
    unstar,
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
