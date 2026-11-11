#!/usr/bin/env node
/**
 * End-to-end check of the message centre.
 *
 * The contract under test: things that happen while nobody is looking end up in
 * one list that survives a restart, each row carrying what it can still do —
 * save the captured login, reopen an account that failed, jump to a page the AI
 * touched — and rows whose target is gone say so instead of pretending.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-messages-"));
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const page = createServer((req, res) => {
  if (req.url.startsWith("/console")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body>console</body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录页</title></head>
<body>
<form id="f" action="/console" method="get">
  <label>账号 <input id="user" type="text" /></label>
  <label>密码 <input id="pass" type="password" /></label>
  <button id="submit" type="submit">登录</button>
</form>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const BASE_URL = `http://127.0.0.1:${PAGE_PORT}`;

const now = new Date().toISOString();
const siteId = "22222222-2222-4222-8222-222222222222";
const identityId = "33333333-3333-4333-8333-333333333333";

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "消息站点",
        baseUrl: BASE_URL,
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [
      {
        id: identityId,
        siteId,
        name: "消息账号",
        username: "message@example.test",
        role: "member",
        color: "teal",
        passwordMode: "custom",
        startPath: "/",
        tagIds: [],
        status: "unknown",
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN, layout: "free", layoutExplicit: true }),
);

const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"],
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

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
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

  // 1) A login produces a history row with the capture as its action.
  await client.evaluate(`window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(`${BASE_URL}/login`)} })`);
  await wait(1_500);
  const pageTarget = (await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json()).find(
    (item) => item.url.startsWith(BASE_URL),
  );
  check("login page is a CDP target", Boolean(pageTarget));
  if (pageTarget) {
    const pageClient = await connect(pageTarget.webSocketDebuggerUrl);
    await pageClient.evaluate(`(() => {
      const set = (selector, value) => {
        const el = document.querySelector(selector);
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        descriptor.set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('#user', 'message@example.test');
      set('#pass', 'pw-message');
      return true;
    })()`);
    await wait(250);
    await pageClient.evaluate(`document.querySelector('#submit').click()`);
    await wait(900);
    pageClient.close();
  }

  const afterLogin = await client.evaluate(`window.ensemble.listMessages()`);
  const captureRow = (afterLogin ?? []).find((item) => item.kind === "login-capture");
  check(
    "a captured login is recorded in the history",
    Boolean(captureRow) &&
      captureRow.read === false &&
      captureRow.action?.type === "login-capture" &&
      captureRow.stale !== true,
    captureRow ?? afterLogin,
  );

  // 2) The two entry points agree that something is unread. The rail keeps the
  // count (it is a list); the toolbar bell only carries a red dot, because a
  // number there widened the button and pushed it out of line with the icons
  // beside it — so the bell is asserted on the dot, not on a number.
  await client.evaluate(`document.querySelector('.layout-btn')?.click()`);
  await wait(900);
  const entryPoints = await client.evaluate(`(() => ({
    navLabel: document.querySelector('[data-nav="messages"] .nav-label')?.textContent?.trim() ?? '',
    navCount: document.querySelector('[data-nav="messages"] .nav-count')?.textContent?.trim() ?? '',
    bell: Boolean(document.querySelector('[data-messages-bell]')),
    bellDot: Boolean(document.querySelector('[data-messages-bell] .bell-dot')),
    bellCount: document.querySelector('.bell-count')?.textContent?.trim() ?? '',
  }))()`);
  check(
    "the rail row carries the unread count and the bell a red dot",
    entryPoints?.navLabel === "消息" &&
      entryPoints?.navCount === "1" &&
      entryPoints?.bell === true &&
      entryPoints?.bellDot === true &&
      entryPoints?.bellCount === "",
    entryPoints,
  );

  // 2b) The bell opens a popover, not a page. Clicking it used to leave the
  // browser for the message centre, and that navigation had no way back — so
  // the assertion is "the browser is still here and a panel appeared", plus the
  // panel's own door to the full list.
  const bellPanel = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bell = document.querySelector('[data-messages-bell]');
    bell?.click();
    await wait(350);
    const panel = document.querySelector('[data-bell-panel]');
    const rows = panel?.querySelectorAll('[data-message-kind]') ?? [];
    const box = panel?.getBoundingClientRect();
    const bellBox = bell?.getBoundingClientRect();
    return {
      panel: Boolean(panel),
      rows: rows.length,
      kinds: [...rows].map((el) => el.dataset.messageKind),
      // The popover hangs off the bell's right edge and stays inside the window.
      rightAligned: box && bellBox ? Math.abs(Math.round(box.right) - Math.round(bellBox.right)) <= 2 : false,
      insideWindow: box ? box.right <= window.innerWidth && box.left >= 0 && box.bottom <= window.innerHeight : false,
      foot: Boolean(panel?.querySelector('[data-bell-open-centre]')),
      // Still the browser: the message page's filter bar is not on screen.
      leftTheBrowser: Boolean(document.querySelector('[data-message-filter]')),
    };
  })()`);
  check(
    "the bell opens a popover in place instead of navigating",
    bellPanel?.panel === true &&
      bellPanel?.rows === 1 &&
      bellPanel?.kinds?.join(",") === "login-capture" &&
      bellPanel?.rightAligned === true &&
      bellPanel?.insideWindow === true &&
      bellPanel?.foot === true &&
      bellPanel?.leftTheBrowser === false,
    bellPanel,
  );

  // 2c) A row's detail is a layer, and opening it must not move the popover.
  // This is the regression the design exists for: expanding inside the list
  // pushed every following row down, so the list rearranged itself under the
  // pointer while the user was choosing from it.
  const bellDetail = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    };
    const panelBefore = box(document.querySelector('[data-bell-panel]'));
    const rowTops = (selector) => [...document.querySelectorAll(selector)].map((el) => Math.round(el.getBoundingClientRect().top));
    const rowsBefore = rowTops('[data-bell-panel] [data-message-kind]');

    document.querySelector('[data-bell-panel] .bell-row-main')?.click();
    await wait(350);

    const detail = document.querySelector('[data-message-detail]');
    const panelAfter = box(document.querySelector('[data-bell-panel]'));
    const rowsAfter = rowTops('[data-bell-panel] [data-message-kind]');
    const detailBox = box(detail);
    return {
      opened: Boolean(detail),
      // The popover's own box and every row's offset are unchanged.
      panelUnmoved: JSON.stringify(panelBefore) === JSON.stringify(panelAfter),
      rowsUnmoved: JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter),
      // And the layer is beside the popover, not on top of it.
      besidePanel:
        detailBox && panelAfter
          ? detailBox.right <= panelAfter.x || detailBox.x >= panelAfter.right
          : false,
      action: detail?.querySelector('[data-message-action]')?.textContent?.trim() ?? '',
      remove: Boolean(detail?.querySelector('[data-message-remove]')),
      // The list behind is still readable: the row that opened it is marked.
      openRow: Boolean(document.querySelector('[data-bell-panel] .bell-row.open')),
    };
  })()`);
  check(
    "a bell row opens its detail as a layer, and the popover does not move",
    bellDetail?.opened === true &&
      bellDetail?.panelUnmoved === true &&
      bellDetail?.rowsUnmoved === true &&
      bellDetail?.besidePanel === true &&
      String(bellDetail?.action).length > 0 &&
      bellDetail?.remove === true &&
      bellDetail?.openRow === true,
    bellDetail,
  );

  const bellDetailDismiss = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // A press inside the popover but outside the detail: the detail closes and
    // the popover stays. The panel's own head is such a place — pressing the
    // stage would be a press outside the bell too, which closes both.
    const head = document.querySelector('[data-bell-panel] .bell-head');
    head?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(300);
    return {
      detailGone: !document.querySelector('[data-message-detail]'),
      panelStill: Boolean(document.querySelector('[data-bell-panel]')),
    };
  })()`);
  check(
    "dismissing the detail leaves the popover open",
    bellDetailDismiss?.detailGone === true && bellDetailDismiss?.panelStill === true,
    bellDetailDismiss,
  );

  const bellDismiss = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // A press on the stage: outside the bell's anchor, so the popover closes.
    document.querySelector('.stage')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await wait(300);
    return { closed: !document.querySelector('[data-bell-panel]') };
  })()`);
  check("a press outside the bell closes the popover", bellDismiss?.closed === true, bellDismiss);

  // Its footer is the door to the full history.
  const bellFoot = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-messages-bell]')?.click();
    await wait(350);
    const opened = Boolean(document.querySelector('[data-bell-panel]'));
    document.querySelector('[data-bell-open-centre]')?.click();
    await wait(800);
    return {
      opened,
      gone: !document.querySelector('[data-bell-panel]'),
      onPage: Boolean(document.querySelector('[data-message-filter]')),
    };
  })()`);
  check(
    "the popover's footer opens the message centre",
    bellFoot?.opened === true && bellFoot?.gone === true && bellFoot?.onPage === true,
    bellFoot,
  );

  // 3) The page lists the row, and its actions live in a layer rather than on
  // the row: the row is one target that opens the detail, and the detail is the
  // only thing that executes.
  await client.evaluate(`document.querySelector('[data-nav="messages"]')?.click()`);
  await wait(600);
  const rendered = await client.evaluate(`(() => ({
    rows: document.querySelectorAll('[data-message-kind]').length,
    kinds: [...document.querySelectorAll('[data-message-kind]')].map((el) => el.dataset.messageKind),
    rowActions: document.querySelectorAll('.row [data-message-action]').length,
    rowRemoves: document.querySelectorAll('.row [data-message-remove]').length,
    titles: [...document.querySelectorAll('.row .title')].map((el) => el.textContent.trim()),
    filters: [...document.querySelectorAll('[data-message-filter]')].map((el) => el.dataset.messageFilter),
  }))()`);
  check(
    "the message page lists the row, with no action buttons on it",
    rendered?.rows === 1 &&
      rendered?.kinds?.join(",") === "login-capture" &&
      rendered?.rowActions === 0 &&
      rendered?.rowRemoves === 0 &&
      String(rendered?.titles?.[0]).includes("message@example.test") &&
      !String(rendered?.titles?.[0]).startsWith("app.") &&
      rendered?.filters?.length === 5,
    rendered,
  );

  // Opening a row is a layer again, and the list must not move under it.
  const pageDetail = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const tops = () => [...document.querySelectorAll('[data-message-kind]')].map((el) => Math.round(el.getBoundingClientRect().top));
    const before = tops();
    document.querySelector('[data-message-kind]')?.click();
    await wait(350);
    const detail = document.querySelector('[data-message-detail]');
    return {
      opened: Boolean(detail),
      unmoved: JSON.stringify(before) === JSON.stringify(tops()),
      action: detail?.querySelector('[data-message-action]')?.textContent?.trim() ?? '',
      remove: Boolean(detail?.querySelector('[data-message-remove]')),
      markedOpen: Boolean(document.querySelector('[data-message-kind].open')),
      read: (await window.ensemble.listMessages()).find((item) => item.kind === 'login-capture')?.read,
    };
  })()`);
  check(
    "clicking a row opens its detail without moving the list",
    pageDetail?.opened === true &&
      pageDetail?.unmoved === true &&
      String(pageDetail?.action).length > 0 &&
      pageDetail?.remove === true &&
      pageDetail?.markedOpen === true &&
      // Opening the row is what marks it read; the badge clears without a click.
      pageDetail?.read === true,
    pageDetail,
  );

  // 4) Filtering by kind narrows the list without losing the row. The detail
  // closes first: it belongs to a row the filter is about to hide.
  await client.evaluate(
    `document.querySelector('[data-message-detail-close]')?.click()`,
  );
  await wait(250);
  await client.evaluate(`document.querySelector('[data-message-filter="ai"]')?.click()`);
  await wait(300);
  const filtered = await client.evaluate(`document.querySelectorAll('[data-message-kind]').length`);
  await client.evaluate(`document.querySelector('[data-message-filter="all"]')?.click()`);
  await wait(300);
  const unfiltered = await client.evaluate(`document.querySelectorAll('[data-message-kind]').length`);
  check("filtering by kind hides rows of other kinds", filtered === 0 && unfiltered === 1, {
    filtered,
    unfiltered,
  });

  // 5) Running the action from the detail marks the row read and closes the
  // layer — the row already went read when it was opened, so this asserts the
  // whole path rather than the badge alone.
  const afterAct = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-message-kind]')?.click();
    await wait(300);
    const action = document.querySelector('[data-message-detail] [data-message-action]');
    const hadAction = Boolean(action);
    action?.click();
    await wait(800);
    const list = await window.ensemble.listMessages();
    return {
      hadAction,
      detailClosed: !document.querySelector('[data-message-detail]'),
      read: list.find((item) => item.kind === 'login-capture')?.read,
      unread: list.filter((item) => !item.read).length,
    };
  })()`);
  check(
    "the detail's action marks the row read and closes the layer",
    afterAct?.hadAction === true &&
      afterAct?.detailClosed === true &&
      afterAct?.read === true &&
      afterAct?.unread === 0,
    afterAct,
  );

  // 6) History is on disk, so a later run can still read it.
  const stored = JSON.parse(readFileSync(join(userData, "messages.json"), "utf8"));
  check(
    "the history is written to disk",
    Array.isArray(stored.messages) && stored.messages.length >= 1,
    { count: stored.messages?.length ?? 0 },
  );

  // 7) A row whose capture is gone is reported as stale instead of offering it.
  await client.evaluate(`(async () => {
    // Drop the pending capture directly: the token only lives in this process,
    // which is exactly the situation after a restart.
    for (const item of await window.ensemble.pendingLogins()) {
      await window.ensemble.dismissLoginCapture(item.token);
    }
    return true;
  })()`);
  await wait(400);
  const stale = await client.evaluate(`(async () => {
    const list = await window.ensemble.listMessages();
    return list.find((item) => item.kind === 'login-capture') ?? null;
  })()`);
  check(
    "a row whose target disappeared reports itself as stale",
    stale?.stale === true,
    stale,
  );

  // A stale row still opens its detail — that is where the reason is stated —
  // but offers no action, because there is nothing left to act on. The list has
  // to be re-read first: `stale` is decided by the main process when the history
  // is fetched, and the row on screen still carries the pre-invalidation copy.
  await client.evaluate(`document.querySelector('[data-nav="messages"]')?.click()`);
  await wait(500);
  const staleFlag = await client.evaluate(
    `(async () => (await window.ensemble.listMessages()).find((item) => item.kind === 'login-capture')?.stale ?? null)()`,
  );
  // The page's own store refreshes on the next mount; re-entering it is what a
  // user would do, and it is also the cheapest way to make the assertion honest.
  await client.evaluate(`document.querySelector('[data-nav="browser"]')?.click()`);
  await wait(400);
  await client.evaluate(`document.querySelector('[data-nav="messages"]')?.click()`);
  await wait(700);
  const staleLayer = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-message-kind]')?.click();
    await wait(350);
    const detail = document.querySelector('[data-message-detail]');
    return {
      opened: Boolean(detail),
      note: detail?.querySelector('.detail-note')?.textContent?.trim() ?? '',
      action: detail?.querySelector('[data-message-action]')?.textContent?.trim() ?? '',
      remove: Boolean(detail?.querySelector('[data-message-remove]')),
      staleOnRow: Boolean(document.querySelector('[data-message-kind].stale')),
    };
  })()`);
  check(
    "a stale row opens a detail that explains itself and offers no action",
    staleFlag === true &&
      staleLayer?.opened === true &&
      staleLayer?.staleOnRow === true &&
      String(staleLayer?.note).length > 0 &&
      staleLayer?.action === "" &&
      staleLayer?.remove === true,
    { staleFlag, ...staleLayer },
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
