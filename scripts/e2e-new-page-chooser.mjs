#!/usr/bin/env node
/**
 * End-to-end check of every "+" that used to create a daily-profile blank page.
 *
 * A page in this app belongs to a system, and usually to an account: which
 * account decides the session partition, so the account is a question, not a
 * default. Three surfaces answered it by guessing (daily profile):
 *
 *   1. the view header's "+" in the dock,
 *   2. the empty cell's account picker,
 *   3. the toolbar's new-tab button while a view is on stage.
 *
 * The empty-cell picker had a second bug of its own: the page was created with
 * an identity but no URL, so it sat on about:blank while the dock already showed
 * the account's name and the stage kept drawing the new-tab search surface.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-chooser-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>选择窗站点</title></head>
<body><h1>登录页</h1></body></html>`,
  );
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const viewId = "22222222-2222-4222-8222-222222222222";
const ids = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const baseUrl = `http://127.0.0.1:${PAGE_PORT}`;

function identity(id, name, color) {
  return {
    id,
    siteId,
    name,
    username: `${name}@example.test`,
    role: "member",
    color,
    passwordMode: "inherit",
    status: "unknown",
    startPath: "/",
    createdAt: now,
    updatedAt: now,
  };
}

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "选择窗站点",
        baseUrl,
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [identity(ids.a, "账号甲", "amber"), identity(ids.b, "账号乙", "teal")],
    views: [
      {
        // 2×2 with one member: three empty cells, so all three "+" surfaces can
        // be driven in one run without a page being swapped out from under a
        // later assertion.
        id: viewId,
        siteId,
        name: "选择窗验证",
        identityIds: [ids.a],
        layoutId: "2x2",
        slotAssignments: { [ids.a]: 0 },
        paths: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
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
    guideVersion: GUIDE_SEEN,
    autoFillOnLaunch: false,
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

/** Runs the body in the renderer and returns whatever it resolves to. */
async function inApp(client, body) {
  return client.evaluate(`(async () => { ${body} })()`);
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

  const opened = await inApp(
    client,
    `
    const api = window.ensemble;
    const state = await api.openEmbeddedView('${viewId}');
    await new Promise((r) => setTimeout(r, 1600));
    const view = state.views.find((item) => item.id === state.activeViewId);
    return {
      container: view?.id,
      slots: view?.slotTabs,
      emptyCells: document.querySelectorAll('.slot-empty').length,
    };
  `,
  );
  check(
    "the view opens with one member and three empty cells",
    Boolean(opened?.container) &&
      opened?.slots?.filter(Boolean).length === 1 &&
      opened?.emptyCells === 3,
    opened,
  );

  // --- 1. The empty cell's account picker must actually navigate ------------
  const slotPick = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = await api.getEmbeddedState();
    const trigger = document.querySelector('.slot-add-icon');
    trigger?.click();
    await new Promise((r) => setTimeout(r, 500));
    const items = [...document.querySelectorAll('.slot-identity-item')];
    const offered = items.length;
    items[1]?.click();
    await new Promise((r) => setTimeout(r, 2500));
    const state = await api.getEmbeddedState();
    const added = state.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    const page = added[0] ?? null;
    return {
      offered,
      label: page?.label ?? null,
      identityId: page?.identityId ?? null,
      url: page?.url ?? null,
      viewId: page?.viewId ?? null,
      // The new-tab surface is drawn by the app wherever a blank page sits; a
      // page that never navigated leaves it on screen under the account's name.
      blankSurfaces: document.querySelectorAll('.blank-slot').length,
    };
  `,
  );
  check(
    "the empty cell offers the site's accounts",
    slotPick?.offered === 2,
    slotPick,
  );
  check(
    "picking an account navigates to the site instead of staying on about:blank",
    Boolean(slotPick?.url) &&
      slotPick.url !== "about:blank" &&
      slotPick.url.startsWith(baseUrl),
    slotPick,
  );
  check(
    "the account page lands inside the view it was added to",
    slotPick?.viewId === opened?.container && slotPick?.label === "账号乙",
    slotPick,
  );

  // --- 2. The view header's "+" asks which account -------------------------
  const viewPlus = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = await api.getEmbeddedState();
    const trigger = document.querySelector('.view-block .block-head .split-main');
    for (let attempt = 0; attempt < 3 && !document.querySelector('.open-panel'); attempt += 1) {
      trigger?.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    const panel = document.querySelector('.open-panel');
    const rows = [...document.querySelectorAll('.account-row')];
    const frozen = document.querySelectorAll('.stage .frozen').length;
    // The chooser covers the stage. With a native page that means freezing it
    // into an image first; a guest stacks, so the proof is that it is not the
    // topmost thing at the chooser's own centre.
    const box = panel?.getBoundingClientRect();
    const pageOnTop = box
      ? document
          .elementsFromPoint(
            Math.round(box.left + box.width / 2),
            Math.round(box.top + box.height / 2),
          )
          .some((el) => el.tagName.toLowerCase() === "webview")
      : false;
    // A locked chooser shows one system's accounts and no site column: the view
    // already names the system, so a site picker there would be a second answer
    // to a question the container has answered.
    return {
      clicked: Boolean(trigger),
      open: Boolean(panel),
      siteRows: document.querySelectorAll('.site-row').length,
      accounts: rows.filter((el) => !el.classList.contains('anonymous')).length,
      frozen,
      pageOnTop,
      carrier: before.carrier ?? "native",
    };
  `,
  );
  check(
    "the view header's + opens a chooser instead of creating a page",
    viewPlus?.clicked === true && viewPlus?.open === true,
    viewPlus,
  );
  check(
    "the chooser is locked to the view's own site",
    viewPlus?.siteRows === 0 && viewPlus?.accounts === 2,
    viewPlus,
  );
  check(
    "the chooser is in front of the page",
    viewPlus?.carrier === "guest" ? viewPlus?.pageOnTop === false : viewPlus?.frozen > 0,
    viewPlus,
  );

  const viewPlusPick = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = await api.getEmbeddedState();
    const rows = [...document.querySelectorAll('.account-row')];
    const accounts = rows.filter((el) => !el.classList.contains('anonymous'));
    accounts[0]?.click();
    await new Promise((r) => setTimeout(r, 2500));
    const state = await api.getEmbeddedState();
    const added = state.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    const page = added[0] ?? null;
    const view = state.views.find((item) => item.id === '${opened?.container ?? ""}');
    return {
      added: added.length,
      label: page?.label ?? null,
      identityId: page?.identityId ?? null,
      url: page?.url ?? null,
      viewId: page?.viewId ?? null,
      slots: view?.slotTabs,
      panelOpen: Boolean(document.querySelector('.open-panel')),
    };
  `,
  );
  check(
    "the view header's chooser creates exactly one account page",
    viewPlusPick?.added === 1 &&
      viewPlusPick?.label === "账号甲" &&
      viewPlusPick?.identityId === ids.a,
    viewPlusPick,
  );
  check(
    "that page lands in a cell of the view it was opened from",
    viewPlusPick?.viewId === opened?.container &&
      Boolean(viewPlusPick?.url?.startsWith?.(baseUrl)),
    viewPlusPick,
  );
  check("the chooser closes after a pick", viewPlusPick?.panelOpen === false, viewPlusPick);

  // --- 3. The toolbar's "+" with a view on stage ---------------------------
  const toolbar = await inApp(
    client,
    `
    const api = window.ensemble;
    const trigger = document.querySelector('.toolbar .split-main');
    for (let attempt = 0; attempt < 3 && !document.querySelector('.open-panel'); attempt += 1) {
      trigger?.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    const panel = document.querySelector('.open-panel');
    const modes = [...document.querySelectorAll('.open-menu .mode')].map((el) => ({
      label: el.textContent?.trim() ?? '',
      on: el.classList.contains('on'),
    }));
    const anonymous = [...document.querySelectorAll('.account-row.anonymous')].map((el) =>
      el.querySelector('.acc-name')?.textContent?.trim() ?? '',
    );
    const before = await api.getEmbeddedState();
    // A profile row opens a blank browser in that profile — the same thing the
    // old "blank page" row did, now named by which cookie jar it lands in.
    // The account tab is the default, so the profile list only exists after the
    // mode switch.
    document.querySelector('.open-menu .mode[data-mode="profiles"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    const profiles = document.querySelectorAll('.open-menu .profile-row').length;
    document.querySelector('.open-menu .profile-row')?.click();
    await new Promise((r) => setTimeout(r, 2200));
    const state = await api.getEmbeddedState();
    const added = state.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    const page = added[0] ?? null;
    return {
      open: Boolean(panel),
      modes,
      anonymous,
      profiles,
      added: added.length,
      label: page?.label ?? null,
      identityId: page?.identityId ?? null,
      profileId: page?.profileId ?? null,
      url: page?.url ?? null,
      viewId: page?.viewId ?? null,
    };
  `,
  );
  check(
    "the toolbar button opens the same chooser with a view on stage",
    toolbar?.open === true &&
      toolbar?.modes?.length === 2 &&
      toolbar?.modes?.[0]?.on === true &&
      toolbar?.modes?.[0]?.label === "账号" &&
      toolbar?.modes?.[1]?.label === "档案",
    toolbar,
  );
  check(
    "the account tab keeps the site's own two openings above its accounts",
    toolbar?.anonymous?.length === 2,
    toolbar,
  );
  check(
    "the profile tab lists profiles and opens a blank browser in one",
    toolbar?.profiles > 0 &&
      toolbar?.added === 1 &&
      toolbar?.identityId === null &&
      toolbar?.label === "新标签页" &&
      Boolean(toolbar?.profileId) &&
      toolbar?.viewId === opened?.container,
    toolbar,
  );

  const loose = await inApp(
    client,
    `
    const api = window.ensemble;
    await api.activateEmbeddedView(null);
    const trigger = document.querySelector('.toolbar .split-main');
    for (let attempt = 0; attempt < 3 && !document.querySelector('.open-panel'); attempt += 1) {
      trigger?.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    const siteRows = document.querySelectorAll('.site-row').length;
    const before = await api.getEmbeddedState();
    const rows = [...document.querySelectorAll('.account-row')];
    const accounts = rows.filter((el) => !el.classList.contains('anonymous'));
    accounts[0]?.click();
    await new Promise((r) => setTimeout(r, 2200));
    const state = await api.getEmbeddedState();
    const added = state.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    const page = added[0] ?? null;
    return {
      // No view on stage: the chooser is not locked, so the site column is back.
      siteRows,
      identityId: page?.identityId ?? null,
      viewId: page?.viewId ?? null,
      activeViewId: state.activeViewId ?? null,
      url: page?.url ?? null,
    };
  `,
  );
  check(
    "with no view on stage the chooser lists every site again",
    loose?.siteRows > 0,
    loose,
  );
  check(
    "an account picked there opens a loose page in the flat strip",
    loose?.identityId === ids.a &&
      loose?.viewId === null &&
      loose?.activeViewId === null &&
      Boolean(loose?.url?.startsWith?.(baseUrl)),
    loose,
  );

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  page.close();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
