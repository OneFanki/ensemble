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
 *    deletes through the right-click menu. A legacy `folder` name label in the
 *    seeded file loads as a real folder and shows up in the strip.
 * 3. The address-bar star opens the bookmark dialog with the page offered, and
 *    saving it files the bookmark; the filled star still toggles off.
 * 4. The management page: folders nest through the dialog, the bookmark dialog
 *    files into a picked folder, and deleting a folder re-parents its contents.
 *
 * Everything runs headless: a real window is parked outside every display so the
 * compositor still produces frames (screenshots would hang on a hidden window).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
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
    // The second one carries the legacy `folder` name label — the shape files
    // wrote before folders became records — so the load-time migration is
    // exercised by the real startup path, not only by unit tests.
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
        folder: "旧分组",
        order: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: 1 }),
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
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
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
  // The level grid's root lists top-level folders first, then unfiled
  // bookmarks; the second seed bookmark is inside the migrated folder, so it
  // only appears once the folder tile is entered.
  check(
    "root tiles carry the migrated folder then the unfiled bookmark",
    grid?.names?.[0] === "旧分组" && grid?.names?.[1] === "文档首页",
    grid?.names,
  );

  const entered = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const folderTile = [...document.querySelectorAll('.bookmarks .tile')].find(
      (item) => item.querySelector('.tile-name')?.textContent?.trim() === '旧分组',
    );
    folderTile?.click();
    await wait(400);
    const names = [...document.querySelectorAll('.bookmarks .tile .tile-name')].map((el) =>
      el.textContent?.trim(),
    );
    document.querySelector('.folder-strip .folder-chip')?.click();
    await wait(400);
    return { names };
  })()`);
  check(
    "entering a folder tile reveals the bookmark filed inside it",
    entered?.names?.length === 1 && entered?.names?.[0] === "第二个书签",
    entered?.names,
  );

  // A tile without an icon falls back to a stable colour block with an initial.
  const fallback = await client.evaluate(`(() => {
    const tile = document.querySelector('.bookmarks .tile:not(.folder-tile) .tile-icon');
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

  // --- Legacy folder migration ----------------------------------------------
  const migrated = await client.evaluate(`(async () => {
    const state = await window.ensemble.getWorkspace();
    const folders = state.bookmarkFolders ?? [];
    return {
      names: folders.map((folder) => folder.name),
      filedAs: state.bookmarks.map((bookmark) => {
        const folder = folders.find((item) => item.id === bookmark.folderId);
        return folder?.name ?? null;
      }),
      folderTiles: [...document.querySelectorAll('.bookmarks .tile.folder-tile')].map((tile) =>
        tile.textContent?.trim() ?? '',
      ),
    };
  })()`);
  check(
    "a legacy folder label loads as a real top-level folder",
    migrated?.names?.length === 1 &&
      migrated.names[0] === "旧分组" &&
      migrated.filedAs[1] === "旧分组",
    migrated,
  );
  check(
    "the new-tab folder tile lists the migrated folder with its count",
    (migrated?.folderTiles ?? []).some((text) => text.includes("旧分组") && text.includes("1")),
    migrated?.folderTiles,
  );

  // --- Rename in place ------------------------------------------------------
  const renamed = await client.evaluate(`(async () => {
    const tile = document.querySelector('.bookmarks .tile:not(.folder-tile)');
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
    // The level grid shows one level at a time: the second seed bookmark lives
    // inside the migrated 旧分组 folder, so the root only tiles the unfiled
    // one. Enter the folder and delete ITS tile — the unfiled bookmark stays
    // for the management-page drag block below.
    const folderTile = [...document.querySelectorAll('.bookmarks .tile')].find(
      (item) => item.querySelector('.tile-name')?.textContent?.trim() === '旧分组',
    );
    folderTile?.click();
    await new Promise((done) => setTimeout(done, 400));
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
    const folderEmptied = document.querySelectorAll('.bookmarks .tile').length;
    // Back to the root level for the checks that follow.
    document.querySelector('.folder-strip .folder-chip')?.click();
    await new Promise((done) => setTimeout(done, 400));
    return {
      menuOpened: Boolean(menu),
      rows,
      remaining: state.bookmarks.map((item) => item.name),
      folderEmptied,
      rootHasRenamed: [...document.querySelectorAll('.bookmarks .tile .tile-name')].some(
        (name) => name.textContent?.trim() === '改名后的书签',
      ),
    };
  })()`);
  check(
    "right-click opens a rename/remove menu",
    removed?.menuOpened === true && removed?.rows?.length === 2,
    removed,
  );
  check(
    "the remove row deletes that bookmark and leaves the other",
    removed?.remaining?.length === 1 && removed?.folderEmptied === 0 && removed?.rootHasRenamed === true,
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
    // Adding now opens the dialog; the name arrives prefilled from the title.
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const before = await window.ensemble.getWorkspace();
    const starButton = document.querySelector('.toolbar .icon.star');
    if (!starButton) return { missing: true };
    starButton.click();
    await wait(600);
    const dialog = document.querySelector('.content');
    const title = dialog?.querySelector('.title')?.textContent?.trim() ?? '';
    const offered = dialog?.querySelector('.form input.input')?.value ?? '';
    const picker = Boolean(dialog?.querySelector('.tree-pick'));
    const saveButton = [...(dialog?.querySelectorAll('.foot .btn') ?? [])].find((button) =>
      button.textContent.includes('保存'),
    );
    saveButton?.click();
    await wait(900);
    const after = await window.ensemble.getWorkspace();
    return {
      missing: false,
      title,
      offered,
      picker,
      dialogClosed: !document.querySelector('.content .tree-pick'),
      delta: after.bookmarks.length - before.bookmarks.length,
      urls: after.bookmarks.map((item) => item.url),
      nowPressed: document.querySelector('.toolbar .icon.star')?.getAttribute('aria-pressed'),
    };
  })()`);
  check(
    "the star opens the new-bookmark dialog with the page offered",
    star?.missing === false && star?.title === "新建书签" && (star?.offered ?? "").length > 0 && star?.picker === true,
    star,
  );
  check(
    "saving the dialog files the page as a bookmark",
    star?.delta === 1 && star?.dialogClosed === true,
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

  // --- Management page: tree, dialogs, nesting ------------------------------
  // The navigation is the sidebar, which only exists once something is open
  // beside the page — so reaching this row is a step of its own.
  await client.evaluate(openNav("bookmarks"));
  const pageReady = await waitFor(client, `Boolean(document.querySelector('.bookmarks-page .tree'))`);
  check("the management page opens with its folder tree", pageReady === true);

  const made = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const head = document.querySelector('.bookmarks-page .page-head');
    [...(head?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent.includes('新建文件夹'))
      ?.click();
    await wait(500);
    const dialog = document.querySelector('.content');
    const input = dialog?.querySelector('.form input.input');
    if (!input) return { ok: false, step: 'dialog-open' };
    input.value = '工作';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...(dialog.querySelectorAll('.foot .btn') ?? [])]
      .find((button) => button.textContent.includes('保存'))
      ?.click();
    await wait(700);
    const state = await window.ensemble.getWorkspace();
    const folder = (state.bookmarkFolders ?? []).find((item) => item.name === '工作');
    const treeNames = [...document.querySelectorAll('.bookmarks-page .tree .tree-name')].map(
      (el) => el.textContent.trim(),
    );
    // The success toast must only ever follow a real save: a failure path that
    // still toasted success would read as created while the tree stays empty.
    const lastToast = [...document.querySelectorAll('.toast')].pop()?.textContent?.trim() ?? '';
    return {
      ok: Boolean(folder),
      folderId: folder?.id ?? null,
      treeNames,
      lastToast,
      successToasted: lastToast.includes('已创建文件夹'),
    };
  })()`);
  check(
    "a folder can be created from the header dialog",
    made?.ok === true && made?.treeNames?.includes('工作'),
    made,
  );
  check(
    "the success toast follows an actual save, not a swallowed failure",
    made?.successToasted === true,
    made?.lastToast,
  );

  const nested = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const rows = [...document.querySelectorAll('.bookmarks-page .tree .tree-row')];
    const workRow = rows.find(
      (row) => row.querySelector('.tree-name')?.textContent?.trim() === '工作',
    );
    // The row's first hover action is "add a folder inside".
    workRow?.querySelector('.tree-actions button')?.click();
    await wait(500);
    const dialog = document.querySelector('.content');
    const picked = [...(dialog?.querySelectorAll('.tree-pick .pick-row') ?? [])]
      .find((row) => row.classList.contains('on'))
      ?.textContent?.trim();
    const input = dialog?.querySelector('.form input.input');
    if (!input) return { ok: false, step: 'dialog', picked };
    input.value = '后台';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...(dialog.querySelectorAll('.foot .btn') ?? [])]
      .find((button) => button.textContent.includes('保存'))
      ?.click();
    await wait(700);
    const state = await window.ensemble.getWorkspace();
    const parent = (state.bookmarkFolders ?? []).find((item) => item.name === '工作');
    const child = (state.bookmarkFolders ?? []).find((item) => item.name === '后台');
    return { ok: Boolean(parent && child && child.parentId === parent.id), picked };
  })()`);
  check(
    "a child folder is created under the selected folder, prefilled in the picker",
    nested?.ok === true && (nested?.picked ?? '').includes('工作'),
    nested,
  );

  const filed = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const head = document.querySelector('.bookmarks-page .page-head');
    [...(head?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent.includes('新建书签'))
      ?.click();
    await wait(500);
    const dialog = document.querySelector('.content');
    const inputs = [...(dialog?.querySelectorAll('.form input.input') ?? [])];
    if (inputs.length < 2) return { ok: false, step: 'inputs' };
    inputs[0].value = '控制台';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 'https://console.example.com/admin';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...(dialog?.querySelectorAll('.tree-pick .pick-row') ?? [])]
      .find((row) => row.querySelector('.pick-name')?.textContent?.trim() === '后台')
      ?.click();
    await wait(200);
    [...(dialog.querySelectorAll('.foot .btn') ?? [])]
      .find((button) => button.textContent.includes('保存'))
      ?.click();
    await wait(700);
    const state = await window.ensemble.getWorkspace();
    const child = (state.bookmarkFolders ?? []).find((item) => item.name === '后台');
    const bookmark = state.bookmarks.find((item) => item.name === '控制台');
    return {
      ok: Boolean(bookmark && bookmark.folderId === child?.id),
      dialogGone: !document.querySelector('.content .tree-pick'),
    };
  })()`);
  check(
    "a new bookmark lands in the folder picked in the dialog",
    filed?.ok === true && filed?.dialogGone === true,
    filed,
  );

  const drill = await client.evaluate(`(async () => {
    const rows = [...document.querySelectorAll('.bookmarks-page .tree .tree-row')];
    rows
      .find((row) => row.querySelector('.tree-name')?.textContent?.trim() === '后台')
      ?.click();
    await new Promise((done) => setTimeout(done, 300));
    const crumbs = [...document.querySelectorAll('.bookmarks-page .crumb')].map((el) =>
      el.textContent.trim(),
    );
    const names = [...document.querySelectorAll('.bookmarks-page .row-name')].map((el) =>
      el.textContent.trim(),
    );
    return { crumbs, names };
  })()`);
  check(
    "selecting a folder filters the list and builds the breadcrumb",
    drill?.crumbs?.join('>') === '全部>工作>后台' && drill?.names?.includes('控制台'),
    drill,
  );

  const moved = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const row = document.querySelector('.bookmarks-page .rows .row');
    row?.querySelector('.icon-btn:not(.danger)')?.click();
    await wait(500);
    const dialog = document.querySelector('.content');
    // The picker's first row is the root option: 未分类.
    dialog?.querySelector('.tree-pick .pick-row')?.click();
    await wait(200);
    [...(dialog.querySelectorAll('.foot .btn') ?? [])]
      .find((button) => button.textContent.includes('保存'))
      ?.click();
    await wait(700);
    const state = await window.ensemble.getWorkspace();
    return { folderId: state.bookmarks.find((item) => item.name === '控制台')?.folderId ?? null };
  })()`);
  check("editing in the dialog can move a bookmark to unfiled", moved?.folderId === null, moved);

  const refiled = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    // The bookmark just left the open folder, so go back to "all" where the
    // row is visible again, and find it by name — the first row is whatever
    // the seed sorted first, not necessarily the one this scenario created.
    document.querySelector('.bookmarks-page .tree .tree-row.root')?.click();
    await wait(400);
    const target = [...document.querySelectorAll('.bookmarks-page .rows .row')].find(
      (row) => row.querySelector('.row-name')?.textContent?.trim() === '控制台',
    );
    target?.querySelector('.icon-btn:not(.danger)')?.click();
    await wait(500);
    const dialog = document.querySelector('.content');
    [...(dialog?.querySelectorAll('.tree-pick .pick-row') ?? [])]
      .find((row) => row.querySelector('.pick-name')?.textContent?.trim() === '后台')
      ?.click();
    await wait(200);
    [...(dialog.querySelectorAll('.foot .btn') ?? [])]
      .find((button) => button.textContent.includes('保存'))
      ?.click();
    await wait(700);
    const state = await window.ensemble.getWorkspace();
    const child = (state.bookmarkFolders ?? []).find((item) => item.name === '后台');
    return { filed: state.bookmarks.find((item) => item.name === '控制台')?.folderId === child?.id };
  })()`);
  check("a bookmark can be re-filed through the edit dialog", refiled?.filed === true, refiled);

  const reparent = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const rows = [...document.querySelectorAll('.bookmarks-page .tree .tree-row')];
    const childRow = rows.find(
      (row) => row.querySelector('.tree-name')?.textContent?.trim() === '后台',
    );
    // The row's last hover action is delete.
    [...(childRow?.querySelectorAll('.tree-actions button') ?? [])].pop()?.click();
    await wait(500);
    [...(document.querySelectorAll('.content .actions .btn') ?? [])]
      .find((button) => button.textContent.trim() === '删除')
      ?.click();
    await wait(800);
    const state = await window.ensemble.getWorkspace();
    const folders = state.bookmarkFolders ?? [];
    return {
      foldersLeft: folders.map((folder) => folder.name),
      bookmarkFiledTo:
        folders.find((folder) => folder.id === state.bookmarks.find((item) => item.name === '控制台')?.folderId)
          ?.name ?? null,
    };
  })()`);
  check(
    "deleting a folder re-parents its bookmark one level up",
    (reparent?.foldersLeft ?? []).includes('后台') === false && reparent?.bookmarkFiledTo === '工作',
    reparent,
  );

  // --- File-manager drag & drop ---------------------------------------------
  // Synthetic DragEvents drive the real handlers: drag a bookmark row onto a
  // folder row to file it, and drag folders onto tree nodes to nest or uproot.
  const dragged = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const fire = (el, type) => el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }),
    );
    const state = () => window.ensemble.getWorkspace();
    const folderByName = (s, name) => (s.bookmarkFolders ?? []).find((f) => f.name === name);
    const rowOf = (name) => [...document.querySelectorAll('.bookmarks-page .rows .row')].find(
      (row) => row.querySelector('.row-name')?.textContent?.trim() === name,
    );
    const treeOf = (name) => [...document.querySelectorAll('.bookmarks-page .tree .tree-row')].find(
      (row) => row.querySelector('.tree-name')?.textContent?.trim() === name,
    );
    // The renamed seed bookmark is the unfiled one at this point; file it into 工作 by dropping the row.
    let s = await state();
    const workId = folderByName(s, '工作')?.id;
    const docRow = rowOf('改名后的书签');
    if (!docRow || !workId) return { ok: false, step: 'setup' };
    fire(docRow, 'dragstart');
    fire(docRow, 'dragover');
    fire(rowOf('工作'), 'dragover');
    fire(rowOf('工作'), 'drop');
    fire(docRow, 'dragend');
    await wait(700);
    s = await state();
    const filed = s.bookmarks.find((item) => item.name === '改名后的书签')?.folderId === workId;
    // Nest 工作 under 旧分组 by dropping the folder row on the tree node.
    fire(rowOf('工作'), 'dragstart');
    fire(treeOf('旧分组'), 'dragover');
    fire(treeOf('旧分组'), 'drop');
    fire(rowOf('工作'), 'dragend');
    await wait(700);
    s = await state();
    const nested = folderByName(s, '工作')?.parentId === folderByName(s, '旧分组')?.id;
    // 工作 is one level down now, so enter 旧分组 to see its row again — the
    // root list only ever shows top-level folders, exactly like a file manager.
    treeOf('旧分组')?.click();
    await wait(500);
    // Drop the folder on the root node to bring it back to the top level.
    fire(rowOf('工作'), 'dragstart');
    fire(treeOf('全部'), 'dragover');
    fire(treeOf('全部'), 'drop');
    fire(rowOf('工作'), 'dragend');
    await wait(700);
    s = await state();
    const uprooted = folderByName(s, '工作')?.parentId === undefined;
    // Unfile the bookmark again via the root drop target, from inside 工作.
    treeOf('工作')?.click();
    await wait(500);
    fire(rowOf('改名后的书签'), 'dragstart');
    fire(treeOf('全部'), 'dragover');
    fire(treeOf('全部'), 'drop');
    fire(rowOf('改名后的书签'), 'dragend');
    await wait(700);
    s = await state();
    const unfiled = s.bookmarks.find((item) => item.name === '改名后的书签')?.folderId === undefined;
    return { ok: filed && nested && uprooted && unfiled, filed, nested, uprooted, unfiled };
  })()`);
  check(
    "rows drag onto folders and tree nodes to file, nest and uproot",
    dragged?.ok === true,
    dragged,
  );

  // --- Import from an installed browser --------------------------------------
  // This machine has real Edge/Firefox profiles, so the dialog lists real
  // sources and importing one exercises the actual file parsing, sqlite copy
  // included, inside Electron's runtime.
  const imported = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const head = document.querySelector('.bookmarks-page .page-head');
    [...(head?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent.includes('导入'))
      ?.click();
    await wait(1200);
    const sources = await window.ensemble.bookmarkImportSources();
    const rows = [...document.querySelectorAll('.content .source')];
    if (!rows.length) return { listed: sources.length, imported: false };
    rows[0]?.click();
    await wait(300);
    const before = (await window.ensemble.getWorkspace()).bookmarks.length;
    const rootFoldersBefore = (await window.ensemble.getWorkspace()).bookmarkFolders.filter(
      (folder) => !folder.parentId,
    ).length;
    [...(document.querySelector('.content')?.querySelectorAll('.foot .btn') ?? [])]
      .find((button) => button.textContent.trim() === '导入')
      ?.click();
    await wait(3000);
    const after = await window.ensemble.getWorkspace();
    const lastToast = [...document.querySelectorAll('.toast')].pop()?.textContent?.trim() ?? '';
    // The import is supposed to be a merge, not a shapshot of the browser's own
    // tree: no folder named after a browser and none of the browsers' root
    // containers may appear at the top level.
    const scaffolding = /^(Edge|Chrome|Firefox) 书签$|^(书签栏|收藏夹栏|书签工具栏|书签菜单|其他书签|移动设备书签|Bookmarks bar|Other bookmarks|Bookmarks Toolbar|Bookmarks Menu|Mobile bookmarks)$/i;
    return {
      listed: sources.length,
      imported: true,
      grew: after.bookmarks.length >= before,
      rootFoldersBefore,
      rootFoldersAfter: (after.bookmarkFolders ?? []).filter((folder) => !folder.parentId).length,
      scaffoldingAtRoot: (after.bookmarkFolders ?? [])
        .filter((folder) => !folder.parentId && scaffolding.test(folder.name))
        .map((folder) => folder.name),
      lastToast,
    };
  })()`);
  check(
    "the import dialog lists the browsers installed on this machine",
    (imported?.listed ?? 0) >= 1,
    imported,
  );
  check(
    "importing a real browser profile merges into the top level",
    imported?.imported === true &&
      imported?.grew === true &&
      (imported?.scaffoldingAtRoot?.length === 0 || (imported?.lastToast ?? '').includes('没有可导入')),
    imported,
  );

  // Back on a blank start page, the strip shows the surviving folder only.
  await client.evaluate(`document.querySelector('[data-nav="browser"]')?.click()`);
  await client.evaluate(`window.ensemble.openEmbeddedTab({})`);
  // The start page navigates one level at a time: top-level folders appear as
  // tiles, the strip above them is the breadcrumb.
  const strip = await waitFor(
    client,
    `Boolean(document.querySelector('.blank-slot .new-tab')) && [...document.querySelectorAll('.bookmarks .tile.folder-tile .tile-name')].some((name) => name.textContent?.trim() === '工作')`,
  );
  const folderTileNames = await client.evaluate(
    `[...document.querySelectorAll('.bookmarks .tile.folder-tile .tile-name')].map((name) => name.textContent?.trim())`,
  );
  check(
    "the start page lists the surviving folder, not the deleted one",
    strip === true && (folderTileNames ?? []).every((text) => !text.includes('后台')),
    folderTileNames,
  );

  // Dropping a tile on a folder chip files it, straight from the start page.
  const chipFiled = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const state = () => window.ensemble.getWorkspace();
    // Top-level only: an imported browser tree may contain a folder with the
    // same name, and this check is about the chip, which is a top-level folder.
    const workId = (await state()).bookmarkFolders.find(
      (f) => f.name === '工作' && !f.parentId,
    )?.id;
    const tile = [...document.querySelectorAll('.bookmarks .tile')].find(
      (item) => item.querySelector('.tile-name')?.textContent?.trim() === '改名后的书签',
    );
    // Top-level exact name: the imported browser tree nests everything under
    // one folder, so a same-named folder deeper down cannot appear here.
    const workTile = [...document.querySelectorAll('.bookmarks .tile.folder-tile')].find(
      (item) => item.querySelector('.tile-name')?.textContent?.trim() === '工作',
    );
    if (!tile || !workTile || !workId) return { ok: false, step: 'setup' };
    const fire = (el, type) => el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }),
    );
    fire(tile, 'dragstart');
    fire(workTile, 'dragover');
    fire(workTile, 'drop');
    fire(tile, 'dragend');
    await wait(700);
    const s = await state();
    return { ok: s.bookmarks.find((item) => item.name === '改名后的书签')?.folderId === workId };
  })()`);
  check("a tile dropped on a folder tile is filed into it", chipFiled?.ok === true, chipFiled);

  // A crumb caret drops that level's children: reach a sibling level without
  // walking in and back out.
  const crumbJump = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const caret = document.querySelector('.crumb-wrap .crumb-caret');
    if (!caret) return { ok: false, step: 'caret' };
    caret.click();
    await wait(300);
    const menuRows = [...document.querySelectorAll('.crumb-menu .crumb-menu-name')].map((n) =>
      n.textContent?.trim(),
    );
    if (!menuRows?.includes('旧分组')) return { ok: false, step: 'menu', menuRows };
    const row = [...document.querySelectorAll('.crumb-menu .crumb-menu-row')].find(
      (item) => item.querySelector('.crumb-menu-name')?.textContent?.trim() === '旧分组',
    );
    row?.click();
    await wait(500);
    const crumbs = [...document.querySelectorAll('.folder-strip .folder-chip')].map((chip) =>
      chip.textContent?.trim(),
    );
    // 旧分组 is empty here (its bookmark was deleted earlier), so the grid has
    // no tiles — the jump itself is what the check asserts.
    const tiles = document.querySelectorAll('.bookmarks .tile').length;
    return { ok: crumbs.length === 2 && crumbs[1] === '旧分组' && tiles === 0, crumbs, tiles };
  })()`);
  check("a crumb caret jumps straight into a sibling level", crumbJump?.ok === true, crumbJump);

  // Search matches bookmarks across the whole tree, so a bookmark filed deep
  // opens from the root with a few keystrokes.
  const search = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    document.querySelector('.folder-strip .folder-chip')?.click();
    await wait(400);
    const input = document.querySelector('.nt-input');
    if (!input) return { ok: false, step: 'input' };
    input.value = '控制台';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(400);
    const rows = [...document.querySelectorAll('.nt-suggest .nt-suggest-name')].map((n) =>
      n.textContent?.trim(),
    );
    if (!rows?.includes('控制台')) return { ok: false, step: 'suggest', rows };
    const row = [...document.querySelectorAll('.nt-suggest .nt-suggest-row')].find(
      (item) => item.querySelector('.nt-suggest-name')?.textContent?.trim() === '控制台',
    );
    row?.click();
    // Polled, not a fixed wait: a guest page is carried through the renderer, so
    // opening a bookmark has one more hop than a native view had. What the check
    // asserts is that the new-tab surface eventually goes away.
    //
    // The budget is generous because the bookmark points at a host that does not
    // resolve: Chromium spends a DNS timeout on it before the document exists,
    // and on a loaded machine that outran a four-second window.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!document.querySelector('.blank-slot .new-tab')) break;
      await wait(150);
    }
    return { ok: true, rows, newTabGone: !document.querySelector('.blank-slot .new-tab') };
  })()`);
  check(
    "searching the new-tab box surfaces a deep bookmark and opening it navigates",
    search?.ok === true && search?.newTabGone === true,
    search,
  );

  // --- Bookmark bar on the new-tab page ------------------------------------
  // Every assertion below runs on a fresh blank page, because the strip is a
  // property of that surface: the checks above ended on a loaded page.
  const bar = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const outer = await window.ensemble.saveBookmarkFolder({ name: '栏文件夹' });
    const outerId = outer.bookmarkFolders.find((folder) => folder.name === '栏文件夹')?.id;
    const inner = await window.ensemble.saveBookmarkFolder({ name: '栏子文件夹', parentId: outerId });
    const innerId = inner.bookmarkFolders.find((folder) => folder.name === '栏子文件夹')?.id;
    await window.ensemble.saveBookmark({ name: '深层栏书签', url: 'https://example.invalid/deep', folderId: innerId });
    // 20 root bookmarks: enough to overflow a 1320px strip even with short names.
    for (let index = 0; index < 20; index += 1) {
      await window.ensemble.saveBookmark({
        name: '栏书签' + String(index).padStart(2, '0'),
        url: 'https://example.invalid/bar' + index,
      });
    }
    await window.ensemble.openEmbeddedTab({ url: 'about:blank' });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (document.querySelector('.bookmark-bar')) break;
      await wait(150);
    }
    const strip = document.querySelector('.bookmark-bar');
    const cells = [...(strip?.querySelectorAll('.bb-cell') ?? [])];
    const box = strip?.getBoundingClientRect();
    const rows = cells.map((cell) => {
      const entry = cell.querySelector('.bb-entry');
      const cellBox = cell.getBoundingClientRect();
      const entryBox = entry?.getBoundingClientRect();
      return {
        label: cell.textContent.trim(),
        right: cellBox.right,
        cellWidth: cellBox.width,
        entryWidth: entryBox?.width ?? 0,
      };
    });
    return {
      present: Boolean(strip),
      cells: cells.length,
      height: box ? Math.round(box.height) : null,
      labels: cells.map((cell) => cell.textContent.trim()),
      overflow: Boolean(strip?.querySelector('.bb-more')),
      // The fit is measured, so a row whose right edge is past the strip was
      // declared to fit and does not: it would be clipped instead of moving
      // into the overflow menu.
      spilling: rows
        .filter((row) => row.right > (box?.right ?? 0) + 0.5)
        .map((row) => row.label),
      // A row wider than its own cell means the flex pass narrowed the cell
      // under its content — the rows then overlap each other, and the widths
      // the measuring pass read were the squeezed ones, so the fit came out
      // too generous.
      pressed: rows
        .filter((row) => row.entryWidth > row.cellWidth + 0.5)
        .map((row) => row.label + ':' + Math.round(row.entryWidth) + '>' + Math.round(row.cellWidth)),
    };
  })()`);
  check(
    "the new-tab page carries a bookmark strip with its root rows",
    bar?.present === true && bar?.labels?.includes("栏文件夹"),
    bar,
  );
  // The strip belongs to a blank page and must read lighter than a cell's own
  // header (32px), which carries the account name and the page tabs.
  check(
    "the strip is shorter than a workbench cell header",
    typeof bar?.height === "number" && bar.height <= 28,
    bar,
  );
  // Overflow is measured, not guessed: a strip too narrow for every row keeps
  // the tail behind "more" instead of clipping it out of reach. The row count
  // itself is not asserted — how many root rows exist depends on what earlier
  // checks (and the import above) put there; what matters is that the newest
  // tail row is behind the menu and that nothing was left hanging past the edge.
  check(
    "a strip that cannot fit every row collapses the tail into an overflow menu",
    bar?.overflow === true &&
      !bar?.labels?.includes("栏书签19") &&
      bar?.spilling?.length === 0 &&
      bar?.pressed?.length === 0,
    bar,
  );

  const hover = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const entry = [...document.querySelectorAll('.bookmark-bar .bb-folder.level-root')].find(
      (node) => node.querySelector('.bb-name')?.textContent?.trim() === '栏文件夹',
    );
    if (!entry) return { ok: false, step: 'entry' };
    entry.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await wait(320);
    const first = entry.querySelector(':scope > .bb-flyout');
    const firstRows = [...(first?.querySelectorAll('.bb-name') ?? [])].map((n) => n.textContent.trim());
    // Cross the gap the way a pointer does: leave the row, sit in the empty
    // strip between row and panel for a moment, come back in. The panel used to
    // close on that first leave, which is the "it vanishes before I get there"
    // complaint — so surviving the crossing is the behaviour under test.
    entry.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    await wait(60);
    const survivedGap = Boolean(entry.querySelector(':scope > .bb-flyout'));
    entry.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    const nested = first?.querySelector('.bb-folder');
    nested?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await wait(320);
    const second = nested?.querySelector(':scope > .bb-flyout');
    const secondRows = [...(second?.querySelectorAll('.bb-name') ?? [])].map((n) => n.textContent.trim());
    const firstBox = first?.getBoundingClientRect();
    const secondBox = second?.getBoundingClientRect();
    // Leaving for good still closes it — the grace period is a grace period,
    // not a panel that stays on screen after the pointer is gone.
    entry.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    await wait(320);
    const closedAfterLeaving = !entry.querySelector(':scope > .bb-flyout');
    return {
      ok: true,
      firstRows,
      secondRows,
      survivedGap,
      closedAfterLeaving,
      // The nested panel opens beside its row, not stacked underneath it.
      beside: Boolean(firstBox && secondBox && secondBox.left >= firstBox.right - 1),
    };
  })()`);
  check(
    "hovering a folder opens its contents and a nested folder opens beside it",
    hover?.ok === true &&
      hover?.firstRows?.includes("栏子文件夹") &&
      hover?.secondRows?.includes("深层栏书签") &&
      hover?.beside === true,
    hover,
  );
  check(
    "the panel survives crossing the gap to it",
    hover?.survivedGap === true && hover?.closedAfterLeaving === true,
    hover,
  );

  const offSurface = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    // The focused tab, not the first one flagged active: several instances each
    // keep their own active page, and only this one is on the stage.
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    await window.ensemble.navigateEmbeddedTab(tab.id, 'https://example.invalid/loaded');
    // Polled rather than a fixed wait: the blank surface goes away when the
    // page reports a URL, which is one broadcast later than the navigate call.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!document.querySelector('.blank-slot .new-tab')) break;
      await wait(150);
    }
    return {
      blankSurface: Boolean(document.querySelector('.blank-slot .new-tab')),
      bar: Boolean(document.querySelector('.bookmark-bar')),
    };
  })()`);
  check(
    "the strip is gone once the page has navigated away from the blank surface",
    offSurface?.blankSurface === false && offSurface?.bar === false,
    offSurface,
  );

  // --- Reload menu ----------------------------------------------------------
  // The reload button's left click stays a plain reload; the menu exists for
  // the cache-clearing variant, which has no other affordance.
  const reloadMenu = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const button = document.querySelector('[data-reload-button]');
    if (!button) return { ok: false, step: 'button' };
    button.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 90 }),
    );
    await wait(250);
    const menu = document.querySelector('.reload-menu');
    const labels = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) =>
      item.textContent.trim(),
    );
    const clear = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].find((item) =>
      item.textContent.includes('清空缓存'),
    );
    clear?.click();
    await wait(1_200);
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    return { ok: true, labels, closed: !document.querySelector('.reload-menu'), url: tab?.url ?? '' };
  })()`);
  check(
    "right-clicking reload offers an empty-cache reload and it returns to the page",
    reloadMenu?.ok === true &&
      reloadMenu?.labels?.length === 2 &&
      reloadMenu.labels[1].includes("清空缓存") &&
      reloadMenu?.closed === true &&
      reloadMenu?.url?.includes("example.invalid/loaded"),
    reloadMenu,
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
