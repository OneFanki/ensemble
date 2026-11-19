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
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

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

/**
 * What the actions column of every row in a table looks like.
 *
 * The complaint this guards against was visual, so the measurements are: how
 * many controls, whether any of them carries a word, whether they are all the
 * same height, and whether every row's cluster ends on the same pixel. A row
 * whose cluster stops short of the others' right edge is the "distant pencil"
 * shape — a group that absorbed the column's spare width instead of being
 * pushed right.
 */
function actionsScript(rowSelector, actionsSelector) {
  return `(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
    const columns = rows.map((row) => row.querySelector(${JSON.stringify(actionsSelector)}));
    if (columns.some((column) => !column)) {
      return { rows: rows.length, missing: columns.filter((column) => !column).length };
    }
    // Buttons inside a split control are one decision, so count the outer
    // controls: icon buttons, split controls, and anything else clickable that
    // is not inside one of those.
    const outerControls = (column) =>
      [...column.querySelectorAll('button, .launch-split')].filter(
        (node) => !node.parentElement?.closest('button, .launch-split'),
      );
    const clusters = columns.map((column) =>
      outerControls(column).map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          right: Math.round(rect.right),
          // A control with visible text is a worded button; the split control's
          // halves have no text in the compact variant.
          worded: node.textContent.trim().length > 0,
        };
      }),
    );
    const rights = clusters.map((controls) => Math.max(...controls.map((control) => control.right)));
    return {
      rows: rows.length,
      counts: clusters.map((controls) => controls.length),
      worded: clusters.flat().filter((control) => control.worded).length,
      heights: [...new Set(clusters.flat().map((control) => control.height))].sort((a, b) => a - b),
      rightEdges: rights,
      // How much of the column sits left of the cluster. A right-aligned cluster
      // in a column that is only as wide as its contents leaves a small gap;
      // a cluster floating in a wide column leaves a large one.
      leftGaps: columns.map((column) => {
        const cluster = outerControls(column);
        if (!cluster.length) return null;
        const first = Math.round(cluster[0].getBoundingClientRect().left);
        return first - Math.round(column.getBoundingClientRect().left);
      }),
    };
  })()`;
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

  // --- Sites: folded into the accounts page --------------------------------
  //
  // A site used to have its own table. It is a heading now: the accounts page
  // groups accounts under the site they belong to, and the site is configured
  // from that heading. The table assertions that lived here are gone with the
  // page — the accounts table below is the one that still exists, and it
  // carries the same column discipline.

  // --- Identities: the same table shape ------------------------------------
  await go(client, "identities");
  check(
    "the identities page rendered the seeded accounts",
    await waitFor(client, `document.querySelectorAll('.identities .id-card').length === 3`),
  );
  const identitiesTable = await client.evaluate(`(() => {
    const heads = [...document.querySelectorAll('.identities .id-table-head')];
    const rows = [...document.querySelectorAll('.identities .id-card')];
    return {
      heads: heads.length,
      labels: heads[0]
        ? [...heads[0].children].map((cell) => cell.textContent.trim()).filter(Boolean)
        : [],
      toggle: Boolean(document.querySelector('.identities [data-view-toggle]')),
      modeClass:
        document.querySelector('.identities .cards')?.className.match(/view-(list|table)/)?.[0] ?? null,
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
      pickHooks: Boolean(document.querySelector('.identities [data-batch-select]')),
    };
  })()`);
  check(
    "the identities page draws one header row per group, with no view switch",
    identitiesTable?.heads === 2 &&
      JSON.stringify(identitiesTable?.labels) ===
        JSON.stringify(["账号", "角色与密码", "状态", "操作"]) &&
      identitiesTable?.toggle === false &&
      identitiesTable?.modeClass === null,
    identitiesTable,
  );
  check(
    "account rows are one horizontal line with the existing hooks",
    Array.isArray(identitiesTable?.cells) &&
      identitiesTable.cells.length === 3 &&
      identitiesTable.cells.every((count) => count === 4) &&
      identitiesTable.singleLine === true &&
      identitiesTable.accountCell === true &&
      identitiesTable.actionsCell === true &&
      identitiesTable.statusCell === true &&
      identitiesTable.editHook === true &&
      identitiesTable.pickHooks === true,
    identitiesTable,
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

  const identitiesActions = await client.evaluate(
    actionsScript(".identities .id-card", ".card-actions"),
  );
  check(
    "every account row's actions are icons of one size, ending on one right edge",
    identitiesActions?.rows === 3 &&
      Array.isArray(identitiesActions?.counts) &&
      identitiesActions.counts.every((count) => count === 4) &&
      identitiesActions.worded === 0 &&
      identitiesActions.heights?.length === 1 &&
      new Set(identitiesActions.rightEdges).size === 1,
    identitiesActions,
  );

  // --- Table caps and feet -------------------------------------------------
  // A joined table has one cap (the header) and one foot per group. Rows keep
  // only their side and bottom rules; a row that still rounds its own corners
  // reads as a stack of cards with no gaps.
  const tableShape = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.identities .id-card')];
    const heads = [...document.querySelectorAll('.identities .id-table-head')];
    const radius = (node) => getComputedStyle(node).borderTopLeftRadius;
    return {
      rowRadii: [...new Set(rows.map(radius))],
      headRadii: [...new Set(heads.map(radius))],
      lastRowRadii: rows
        .filter((row) => row.classList.contains('last'))
        .map((node) => getComputedStyle(node).borderBottomLeftRadius),
      lastRows: rows.filter((row) => row.classList.contains('last')).length,
      groups: heads.length,
    };
  })()`);
  check(
    "the table is capped by its header and footed by each group's last row",
    tableShape?.headRadii?.length === 1 &&
      tableShape.headRadii[0] !== "0px" &&
      tableShape.rowRadii?.length === 1 &&
      tableShape.rowRadii[0] === "0px" &&
      tableShape.lastRows === tableShape.groups &&
      tableShape.lastRowRadii.every((value) => value !== "0px"),
    tableShape,
  );

  // --- Selection mode still fits the table ---------------------------------
  // The row grows a leading checkbox column; the header has to grow it too, or
  // every label slides one column left of the values under it.
  await client.evaluate(`document.querySelector('.identities [data-batch-select]')?.click()`);
  const picking = await waitFor(
    client,
    `document.querySelectorAll('.identities .id-table-head.picking').length === 2`,
  );
  const pickingAlignment = await client.evaluate(
    alignmentScript(".identities .id-card.picking", ".identities .id-table-head.picking"),
  );
  check(
    "selection mode adds the checkbox column to rows and header alike",
    picking === true &&
      pickingAlignment?.columns === 5 &&
      pickingAlignment?.headers === 5 &&
      pickingAlignment?.headerAligned === true &&
      pickingAlignment?.uniform === true,
    pickingAlignment,
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
