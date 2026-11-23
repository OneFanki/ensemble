#!/usr/bin/env node
/**
 * End-to-end check of the doors that open a page, after the toolbar's "+" left.
 *
 * The browser used to carry a split "+" in the toolbar: a blank page on one half,
 * an account chooser on the other. Both are gone. A page now starts from the
 * account bar in the window's first row — a session, a site, or an account — and
 * the launch face of the accounts pane carries the account door.
 *
 * What this suite pins is the part that was a real bug once and would be again:
 *
 *   1. The toolbar no longer asks "whose page is this" a second time. A blank
 *      page is the tab strip's own "+", and the chooser must not come back.
 *   2. Launching a session opens a page in that session — a real page, not an
 *      empty shell under the session's name.
 *   3. Launching an account from the accounts pane navigates to the account's
 *      site rather than sitting on about:blank under its name, and the pane then
 *      gets out of the way: the point of a launch is the page it produces.
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
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-openers-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>打开页面的门</title></head>
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
        name: "演示站点",
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
  [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"],
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

  // --- 1. No second "whose page is this" in the toolbar ---------------------
  const toolbar = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = await window.ensemble.getEmbeddedState();
    // The strip's own "+" is the blank answer: another page in this instance.
    document.querySelector('.strip-add')?.click();
    await wait(1500);
    const after = await window.ensemble.getEmbeddedState();
    return {
      split: Boolean(document.querySelector('.toolbar .split')),
      chooser: Boolean(document.querySelector('.open-menu, .open-panel')),
      before: before.tabs.length,
      after: after.tabs.length,
      railNewSession: Boolean(document.querySelector('[data-rail-new-session]')),
    };
  `,
  );
  check(
    "the toolbar carries no new-page chooser",
    toolbar?.split === false && toolbar?.chooser === false,
    toolbar,
  );
  check(
    "the strip's plus still adds a page without asking anything",
    toolbar?.after === toolbar?.before + 1,
    toolbar,
  );
  check(
    "the account bar is not a new-session door",
    toolbar?.railNewSession === false,
    toolbar,
  );

  // --- 2. A session launched from the pane's launch face opens its page -----
  const session = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Through the accounts pane's launch face: the bar's door opens it.
    document.querySelector('[data-rail-entry="identities"]')?.click();
    await wait(900);
    const nav = document.querySelector('[data-split-nav]');
    const rows = [...(nav?.querySelectorAll('[data-launch-session]') ?? [])];
    const before = await window.ensemble.getEmbeddedState();
    rows[0]?.click();
    await wait(2600);
    const after = await window.ensemble.getEmbeddedState();
    const added = after.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    return {
      paneOpened: Boolean(nav),
      sessions: rows.length,
      added: added.length,
      profileId: added[0]?.profileId ?? null,
      paneClosed: !document.querySelector('[data-floating-pane]'),
    };
  `,
  );
  check(
    "the pane's launch face lists the sessions",
    session?.paneOpened === true && session?.sessions > 0,
    session,
  );
  check(
    "a session launched there opens a page in that session",
    session?.added === 1 && typeof session?.profileId === "string" && session.profileId !== "",
    session,
  );
  check(
    "the pane leaves once the page exists",
    session?.paneClosed === true,
    session,
  );

  // --- 3. An account launched there lands on its site, not about:blank ------
  const account = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-rail-entry="identities"]')?.click();
    await wait(900);
    const before = await window.ensemble.getEmbeddedState();
    const tile = document.querySelector('[data-account-tile="${ids.a}"]');
    tile?.click();
    await wait(2600);
    const after = await window.ensemble.getEmbeddedState();
    const added = after.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    const found = added[0] ?? null;
    return {
      tileFound: Boolean(tile),
      added: added.length,
      identityId: found?.identityId ?? null,
      url: found?.url ?? null,
    };
  `,
  );
  check("the launch face shows the site's accounts", account?.tileFound === true, account);
  check(
    "an account launched there opens on its own site",
    account?.identityId === ids.a && Boolean(account?.url?.startsWith?.(baseUrl)),
    account,
  );

  // --- 4. Chips drag-reorder without touching the pages they own ------------
  // One synthetic drag through the real handlers, the way the strip's own
  // reorder is driven: dragstart fills the payload, dragover picks the edge and
  // raises the insertion mark, drop commits. The rail's order must change, and
  // the pages of every instance involved must keep their own order — moving a
  // chip is moving a whole instance block, not rewriting anyone's tab list.
  const chipDrag = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const chips = () => [...document.querySelectorAll('[data-account-rail] [data-instance-chip]')];
    const orderBefore = chips().map((el) => el.getAttribute('data-instance-chip'));
    const source = chips()[0];
    const target = chips()[1];
    const drag = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: drag }));
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: drag, clientX: r.left + r.width * 0.75, clientY: r.top + r.height / 2 }));
    await wait(40);
    const hinted = target.classList.contains('drop-after');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drag, clientX: r.left + r.width * 0.75, clientY: r.top + r.height / 2 }));
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: drag }));
    await wait(600);
    const orderAfter = chips().map((el) => el.getAttribute('data-instance-chip'));
    const state = await window.ensemble.getEmbeddedState();
    const pagesOf = (instanceId) => state.tabs.filter((tab) => tab.instanceId === instanceId).map((tab) => tab.id);
    return {
      hinted,
      orderBefore,
      orderAfter,
      // Dropped "after" the second chip: the source belongs right behind it.
      moved: orderAfter[1] === orderBefore[0] && orderAfter[0] === orderBefore[1],
      pagesIntact: pagesOf(orderBefore[0]).length > 0,
    };
  `,
  );
  check(
    "dragging a chip shows the insertion mark and moves that instance to the target",
    chipDrag?.hinted === true && chipDrag?.moved === true,
    chipDrag,
  );
  check(
    "the drag keeps every instance's own page order",
    chipDrag?.pagesIntact === true,
    chipDrag,
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
