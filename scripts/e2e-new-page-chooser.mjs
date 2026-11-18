#!/usr/bin/env node
/**
 * End-to-end check of the toolbar "+" and its chooser.
 *
 * The "+" is two halves with two answers:
 *
 *   - the main half is the blank answer: one click opens a blank page — the
 *     app's own new-tab surface, no site navigated, no account panel —
 *   - the arrow half opens the chooser, where an account (locked to a view's
 *     site when the container names one), a site's own openings or a profile
 *     can be picked on purpose.
 *
 * Before the split, the whole "+" was the chooser: clicking it for a blank page
 * landed on the accounts tab with the first site pre-picked, so "just open
 * something empty" started with a site the user never asked for. The suites
 * below pin the new contract: blank is blank, and the account question is only
 * asked where the user opened the chooser themselves.
 *
 * Two other surfaces that used to ask the same question — the view header's
 * "+" and the empty cell's picker — are retired with the grid (ADR 0012); the
 * account-driven batch start lives in the instance rail's [+ 启动] panel,
 * covered by the batch-launch suite. The chooser must sit in front of the page
 * it covers, and a row picked for an account must navigate to that account's
 * site rather than sit on about:blank under the account's name.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

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

  // --- 3. The toolbar's main half is the blank answer ----------------------
  const blankOpen = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = await api.getEmbeddedState();
    document.querySelector('.toolbar .split-main')?.click();
    await new Promise((r) => setTimeout(r, 2200));
    const state = await api.getEmbeddedState();
    const added = state.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    const page = added[0] ?? null;
    return {
      panelOpen: Boolean(document.querySelector('.open-panel')),
      added: added.length,
      label: page?.label ?? null,
      identityId: page?.identityId ?? null,
      url: page?.url ?? null,
      blankSurface: Boolean(document.querySelector('.blank-slot')),
      addressBar: document.querySelector('.address-shell input')?.value ?? '',
    };
  `,
  );
  check(
    "the toolbar's main half creates a page without opening the chooser",
    blankOpen?.panelOpen === false && blankOpen?.added === 1,
    blankOpen,
  );
  check(
    "that page is a blank new-tab page: no account, no site navigated",
    blankOpen?.label === "新标签页" &&
      blankOpen?.url === "about:blank" &&
      blankOpen?.identityId === null &&
      blankOpen?.blankSurface === true,
    blankOpen,
  );
  check(
    "the address bar stays empty on the blank page",
    blankOpen?.addressBar === "",
    blankOpen,
  );

  // --- 4. The toolbar's arrow opens the chooser ---------------------------
  const toolbar = await inApp(
    client,
    `
    const api = window.ensemble;
    const trigger = document.querySelector('.toolbar .split-arrow');
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
    const frozen = document.querySelectorAll('.stage .frozen').length;
    const before = await api.getEmbeddedState();
    // A profile row opens a blank browser in that profile — a blank page there
    // is the point, because the profile is the cookie jar, not a destination.
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
      pageOnTop,
      frozen,
      carrier: before.carrier ?? "native",
      profiles,
      added: added.length,
      label: page?.label ?? null,
      identityId: page?.identityId ?? null,
      profileId: page?.profileId ?? null,
      url: page?.url ?? null,
    };
  `,
  );
  check(
    "the toolbar arrow opens the chooser",
    toolbar?.open === true,
    toolbar,
  );
  check(
    "the chooser offers accounts and profiles, accounts first",
    toolbar?.modes?.length === 2 &&
      toolbar?.modes?.[0]?.on === true &&
      toolbar?.modes?.[0]?.label === "账号" &&
      toolbar?.modes?.[1]?.label === "档案",
    toolbar,
  );
  check(
    "the chooser is in front of the page",
    toolbar?.carrier === "guest" ? toolbar?.pageOnTop === false : toolbar?.frozen > 0,
    toolbar,
  );
  check(
    "the account tab keeps the site's own two openings above its accounts",
    toolbar?.anonymous?.length === 2,
    toolbar,
  );

  /*
   * The two openings are one line each. They used to carry a second line of
   * explanation, which cost every visit a sentence the reader learned on the
   * first one; the text now lives on hover. Both halves are asserted, because
   * deleting the line without wiring the tooltip would just lose the text.
   */
  const openings = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!document.querySelector('.open-menu')) {
      document.querySelector('.toolbar .split-arrow')?.click();
      await wait(900);
    }
    document.querySelector('.open-menu .mode[data-mode="accounts"]')?.click();
    await wait(200);
    const rows = [...document.querySelectorAll('.open-menu .account-row.anonymous')];
    const heights = rows.map((el) => Math.round(el.getBoundingClientRect().height));
    const notes = document.querySelectorAll('.open-menu .account-row.anonymous .acc-note').length;
    const daily = document.querySelector('[data-open-daily]');
    daily?.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(700);
    const tip = document.querySelector('.app-tooltip');
    const tipText = tip?.textContent.trim() ?? '';
    const tipVisible = tip?.classList.contains('visible') ?? false;
    daily?.dispatchEvent(new PointerEvent('pointerleave'));
    return { heights, notes, tipText, tipVisible };
  `,
  );
  check(
    "each opening is a single line",
    openings?.notes === 0 &&
      openings?.heights?.length === 2 &&
      Math.max(...(openings?.heights ?? [0])) <= 40,
    openings,
  );
  check(
    "the explanation is available on hover instead",
    openings?.tipVisible === true && Boolean(openings?.tipText),
    openings,
  );
  check(
    "the profile tab lists profiles and opens a blank browser in one",
    toolbar?.profiles > 0 &&
      toolbar?.added === 1 &&
      toolbar?.identityId === null &&
      toolbar?.label === "新标签页" &&
      Boolean(toolbar?.profileId),
    toolbar,
  );

  // Picking an account from the chooser must navigate to that account's site,
  // never sit on about:blank under the account's name.
  const picked = await inApp(
    client,
    `
    const api = window.ensemble;
    await api.activateEmbeddedView(null);
    const trigger = document.querySelector('.toolbar .split-arrow');
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
      siteRows,
      identityId: page?.identityId ?? null,
      url: page?.url ?? null,
      activeViewId: state.activeViewId ?? null,
    };
  `,
  );
  check(
    "the chooser lists the workspace's sites",
    picked?.siteRows > 0,
    picked,
  );
  check(
    "an account picked there opens a loose page on the account's site",
    picked?.identityId === ids.a &&
      picked?.activeViewId === null &&
      Boolean(picked?.url?.startsWith?.(baseUrl)),
    picked,
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
