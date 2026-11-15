#!/usr/bin/env node
/**
 * End-to-end check of the Sites / Identities list and table layouts.
 *
 * The two pages now share one row markup and switch density through a setting
 * (`sitesView` / `identitiesView`), so three things have to be true together:
 *
 * 1. The default is the list: a fresh workspace draws rows, not a table header.
 * 2. Choosing table draws a per-group header with the expected columns and the
 *    choice lands in `settings.json`, not just in renderer state.
 * 3. The choice survives navigating away and coming back, and choosing list
 *    again removes the header.
 *
 * Runs headless like the other e2e scripts: the window is parked outside every
 * display, so nothing pops up on screen.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-views-"));
const now = new Date().toISOString();
const PAGE_URL = "http://127.0.0.1:3997";

const tags = ["甲", "乙"].map((name, index) => ({
  id: `tag-${index}`,
  name: `标签${name}`,
  color: ["amber", "teal"][index],
  createdAt: now,
}));

const sites = tags.map((tag, index) => ({
  id: `site-${index}`,
  name: `站点${tag.name.slice(1)}`,
  baseUrl: PAGE_URL,
  loginPath: "/",
  autoSubmit: false,
  tagIds: [tag.id],
  createdAt: now,
  updatedAt: now,
}));

const identities = [
  {
    id: "identity-0",
    siteId: "site-0",
    name: "管理员 · 主账号",
    username: "admin@example.internal",
    role: "管理员",
    color: "amber",
    passwordMode: "inherit",
    status: "unknown",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "identity-1",
    siteId: "site-0",
    name: "审核员 · 子账号",
    username: "reviewer@example.internal",
    role: "审核",
    color: "teal",
    passwordMode: "inherit",
    status: "unknown",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "identity-2",
    siteId: "site-1",
    name: "只读账号",
    username: "viewer@example.internal",
    role: "只读",
    color: "violet",
    passwordMode: "inherit",
    status: "unknown",
    createdAt: now,
    updatedAt: now,
  },
];

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags,
    sites,
    identities,
    views: [],
    flows: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
    bookmarkFolders: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "sites", guideVersion: GUIDE_SEEN }),
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

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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

async function waitFor(client, expression, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

/** Reads the settings file the main process writes next to the workspace. */
function readSettings() {
  try {
    return JSON.parse(readFileSync(join(userData, "settings.json"), "utf8"));
  } catch {
    return {};
  }
}

/** The two values under test, for readable failure output. */
function viewSettings() {
  const settings = readSettings();
  return { sitesView: settings.sitesView, identitiesView: settings.identitiesView };
}

/** Polls the file rather than the renderer: the setting must actually persist. */
async function waitForStoredSetting(key, value, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (readSettings()[key] === value) return true;
    await wait(150);
  }
  return false;
}

async function go(client, view) {
  await client.evaluate(openNav(view));
  await wait(350);
}

/**
 * How one group's rows line up.
 *
 * Every row is its own grid, so a column only stays a column if each row
 * resolves the same tracks. Comparing the header cell positions with the rows is
 * the cheapest way to catch a row that silently invented its own widths.
 */
function alignmentScript(rowSelector, headerSelector) {
  return `(() => {
    const headerRow = document.querySelector(${JSON.stringify(headerSelector)});
    const headers = headerRow ? [...headerRow.children] : [];
    const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
    if (!rows.length || !headers.length) return { rows: rows.length, headers: headers.length };
    const leftsOf = (row) => [...row.children].map((cell) => Math.round(cell.getBoundingClientRect().left));
    const first = leftsOf(rows[0]);
    return {
      rows: rows.length,
      headers: headers.length,
      headerLefts: headers.map((cell) => Math.round(cell.getBoundingClientRect().left)),
      rowLefts: first,
      // The first row's cells must sit under the header labels. The actions
      // label is right-aligned inside its column, so its right edge is the one
      // that lines up with the row's controls.
      headerAligned:
        headers.length === first.length &&
        headers.every((cell, index) => {
          const header = cell.getBoundingClientRect();
          const rowCell = rows[0].children[index].getBoundingClientRect();
          return index === headers.length - 1
            ? Math.abs(Math.round(header.right) - Math.round(rowCell.right)) <= 1
            : Math.abs(Math.round(header.left) - Math.round(rowCell.left)) <= 1;
        }),
      // Every later row must use the same tracks as the first.
      uniform: rows.every((row) => {
        const lefts = leftsOf(row);
        return lefts.length === first.length && lefts.every((left, index) => Math.abs(left - first[index]) <= 1);
      }),
      columns: first.length,
      singleLine: rows.every((row) => {
        const centers = [...row.children].map((cell) => {
          const rect = cell.getBoundingClientRect();
          return Math.round(rect.top + rect.height / 2);
        });
        return new Set(centers).size === 1;
      }),
    };
  })()`;
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

  // --- Sites: the default is the list --------------------------------------
  await go(client, "sites");
  check(
    "the sites page rendered both seeded rows",
    await waitFor(client, `document.querySelectorAll('.sites .env-card').length === 2`),
  );
  const sitesList = await client.evaluate(`(async () => {
    const snapshot = await window.ensemble.getWorkspace();
    const rows = [...document.querySelectorAll('.sites .env-card')];
    const list = document.querySelector('.sites [data-collection-view="list"]');
    const table = document.querySelector('.sites [data-collection-view="table"]');
    return {
      stored: snapshot.settings.sitesView,
      toggle: Boolean(document.querySelector('.sites [data-view-toggle]')),
      listActive: list?.getAttribute('aria-pressed') === 'true' && list.classList.contains('active'),
      tableActive: table?.getAttribute('aria-pressed') === 'true',
      header: Boolean(document.querySelector('.sites .env-table-head')),
      mode: document.querySelector('.sites .env-grid')?.classList.contains('view-list') ?? false,
      // One row: grip, name, address, facts, actions, all on the same line.
      cells: rows.map((row) => row.children.length),
      singleLine: rows.every((row) => {
        const centers = [...row.children].map((cell) => {
          const rect = cell.getBoundingClientRect();
          return Math.round(rect.top + rect.height / 2);
        });
        return new Set(centers).size === 1;
      }),
      dragHook: Boolean(rows[0]?.querySelector('.site-grip')),
    };
  })()`);
  check(
    "a fresh workspace opens the sites page in list mode",
    sitesList?.stored === "list" &&
      sitesList?.toggle === true &&
      sitesList?.listActive === true &&
      sitesList?.tableActive === false &&
      sitesList?.header === false &&
      sitesList?.mode === true,
    sitesList,
  );
  check(
    "site rows are one horizontal line with the drag grip",
    Array.isArray(sitesList?.cells) &&
      sitesList.cells.length === 2 &&
      sitesList.cells.every((count) => count === 5) &&
      sitesList.singleLine === true &&
      sitesList.dragHook === true,
    sitesList,
  );

  // --- Sites: table mode adds a header per group and persists --------------
  await client.evaluate(
    `document.querySelector('.sites [data-collection-view="table"]')?.click()`,
  );
  const sitesTable = await waitFor(
    client,
    `document.querySelectorAll('.sites .env-table-head').length === 2`,
  );
  const sitesTableState = await client.evaluate(`(() => {
    const heads = [...document.querySelectorAll('.sites .env-table-head')];
    const labels = heads[0]
      ? [...heads[0].children].map((cell) => cell.textContent.trim()).filter(Boolean)
      : [];
    return {
      heads: heads.length,
      labels,
      mode: document.querySelector('.sites .env-grid')?.classList.contains('view-table') ?? false,
      tableActive:
        document.querySelector('.sites [data-collection-view="table"]')?.getAttribute('aria-pressed') === 'true',
      listActive:
        document.querySelector('.sites [data-collection-view="list"]')?.getAttribute('aria-pressed') === 'true',
    };
  })()`);
  check(
    "switching sites to table draws one header row per group",
    sitesTable === true &&
      sitesTableState?.heads === 2 &&
      JSON.stringify(sitesTableState?.labels) === JSON.stringify(["站点", "地址", "账号与视图", "操作"]) &&
      sitesTableState?.mode === true &&
      sitesTableState?.tableActive === true &&
      sitesTableState?.listActive === false,
    sitesTableState,
  );
  const sitesAlignment = await client.evaluate(
    alignmentScript(".sites .env-card", ".sites .env-table-head"),
  );
  check(
    "site table rows share the header's columns and stay on one line",
    sitesAlignment?.rows === 2 &&
      sitesAlignment?.headers === 5 &&
      sitesAlignment?.columns === 5 &&
      sitesAlignment?.headerAligned === true &&
      sitesAlignment?.uniform === true &&
      sitesAlignment?.singleLine === true,
    sitesAlignment,
  );
  check(
    "the sites table choice lands in settings.json",
    (await waitForStoredSetting("sitesView", "table")) === true,
    viewSettings(),
  );

  // The choice is a stored setting: leaving the page and coming back must keep it.
  await go(client, "identities");
  await go(client, "sites");
  check(
    "the sites table survives leaving and reopening the page",
    (await waitFor(client, `document.querySelectorAll('.sites .env-table-head').length === 2`)) === true,
  );

  // --- Identities: default list, then table --------------------------------
  await go(client, "identities");
  check(
    "the identities page rendered the seeded accounts",
    await waitFor(client, `document.querySelectorAll('.identities .id-card').length === 3`),
  );
  const identitiesList = await client.evaluate(`(async () => {
    const snapshot = await window.ensemble.getWorkspace();
    const rows = [...document.querySelectorAll('.identities .id-card')];
    return {
      stored: snapshot.settings.identitiesView,
      toggle: Boolean(document.querySelector('.identities [data-view-toggle]')),
      listActive:
        document.querySelector('.identities [data-collection-view="list"]')?.getAttribute('aria-pressed') === 'true',
      header: Boolean(document.querySelector('.identities .id-table-head')),
      mode: document.querySelector('.identities .cards')?.classList.contains('view-list') ?? false,
      cells: rows.map((row) => row.children.length),
      singleLine: rows.every((row) => {
        const centers = [...row.children].map((cell) => {
          const rect = cell.getBoundingClientRect();
          return Math.round(rect.top + rect.height / 2);
        });
        return new Set(centers).size === 1;
      }),
      accountCell: Boolean(rows[0]?.querySelector('.card-top .avatar')),
      actionsCell: Boolean(rows[0]?.querySelector('.card-actions')),
      statusCell: Boolean(rows[0]?.querySelector('.state')),
      editHook: Boolean(rows[0]?.querySelector('[data-edit-identity]')),
      pickHooks: Boolean(
        document.querySelector('.identities [data-batch-select]'),
      ),
    };
  })()`);
  check(
    "a fresh workspace opens the identities page in list mode",
    identitiesList?.stored === "list" &&
      identitiesList?.toggle === true &&
      identitiesList?.listActive === true &&
      identitiesList?.header === false &&
      identitiesList?.mode === true,
    identitiesList,
  );
  check(
    "account rows are one horizontal line with the existing hooks",
    Array.isArray(identitiesList?.cells) &&
      identitiesList.cells.length === 3 &&
      identitiesList.cells.every((count) => count === 4) &&
      identitiesList.singleLine === true &&
      identitiesList.accountCell === true &&
      identitiesList.actionsCell === true &&
      identitiesList.statusCell === true &&
      identitiesList.editHook === true &&
      identitiesList.pickHooks === true,
    identitiesList,
  );

  await client.evaluate(
    `document.querySelector('.identities [data-collection-view="table"]')?.click()`,
  );
  const identitiesTable = await waitFor(
    client,
    `document.querySelectorAll('.identities .id-table-head').length === 2`,
  );
  const identitiesTableState = await client.evaluate(`(() => {
    const heads = [...document.querySelectorAll('.identities .id-table-head')];
    const labels = heads[0]
      ? [...heads[0].children].map((cell) => cell.textContent.trim()).filter(Boolean)
      : [];
    return {
      heads: heads.length,
      labels,
      mode: document.querySelector('.identities .cards')?.classList.contains('view-table') ?? false,
      tableActive:
        document.querySelector('.identities [data-collection-view="table"]')?.getAttribute('aria-pressed') === 'true',
    };
  })()`);
  check(
    "switching identities to table draws one header row per group",
    identitiesTable === true &&
      identitiesTableState?.heads === 2 &&
      JSON.stringify(identitiesTableState?.labels) ===
        JSON.stringify(["账号", "角色与密码", "状态", "操作"]) &&
      identitiesTableState?.mode === true &&
      identitiesTableState?.tableActive === true,
    identitiesTableState,
  );
  const identitiesAlignment = await client.evaluate(
    alignmentScript(".identities .id-card", ".identities .id-table-head"),
  );
  check(
    "account table rows share the header's columns and stay on one line",
    identitiesAlignment?.rows === 3 &&
      identitiesAlignment?.headers === 4 &&
      identitiesAlignment?.columns === 4 &&
      identitiesAlignment?.headerAligned === true &&
      identitiesAlignment?.uniform === true &&
      identitiesAlignment?.singleLine === true,
    identitiesAlignment,
  );
  check(
    "the identities table choice lands in settings.json",
    (await waitForStoredSetting("identitiesView", "table")) === true,
    viewSettings(),
  );

  // --- Back to list on both pages -----------------------------------------
  await client.evaluate(
    `document.querySelector('.identities [data-collection-view="list"]')?.click()`,
  );
  const identitiesBack = await waitFor(
    client,
    `!document.querySelector('.identities .id-table-head') && document.querySelector('.identities .cards')?.classList.contains('view-list')`,
  );
  check(
    "switching identities back to list removes the table header",
    identitiesBack === true &&
      (await client.evaluate(`document.querySelectorAll('.identities .id-card').length`)) === 3,
  );
  check(
    "the identities list choice lands in settings.json",
    (await waitForStoredSetting("identitiesView", "list")) === true,
    viewSettings(),
  );

  await go(client, "sites");
  await client.evaluate(
    `document.querySelector('.sites [data-collection-view="list"]')?.click()`,
  );
  const sitesBack = await waitFor(
    client,
    `!document.querySelector('.sites .env-table-head') && document.querySelector('.sites .env-grid')?.classList.contains('view-list')`,
  );
  check(
    "switching sites back to list removes the table header",
    sitesBack === true &&
      (await client.evaluate(`document.querySelectorAll('.sites .env-card').length`)) === 2,
  );
  check(
    "the sites list choice lands in settings.json",
    (await waitForStoredSetting("sitesView", "list")) === true,
    viewSettings(),
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
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
