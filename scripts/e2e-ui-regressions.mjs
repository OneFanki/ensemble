#!/usr/bin/env node
/**
 * Regression checks for three layout bugs reported from real use:
 *
 * 1. A teleported dropdown inside a dialog could not be hovered, and clicks
 *    passed through it onto the fields underneath (Reka locks the page with
 *    `pointer-events: none`, which a teleported panel inherits).
 * 2. The tag filter strip wrapped, so a workspace with many tags pushed the
 *    account cards down by hundreds of pixels.
 * 3. The login-capture prompt was a normal grid child of the app shell, so
 *    showing it added a fourth row and squeezed the whole layout upwards.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3987;
const DEBUG_PORT = 9787;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-ui-regression-"));

// A real icon is served so the dock's favicon path is exercised, not just the
// placeholder. A 1×1 PNG is enough: the fetch is what is being checked.
const FAVICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const page = createServer((req, res) => {
  if (req.url === "/favicon.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(FAVICON_PNG);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录页</title>
<link rel="icon" type="image/png" href="/favicon.png" /></head>
<body>
<form id="f" action="/console" method="get">
  <label>账号 <input id="user" name="user" type="text" /></label>
  <label>密码 <input id="pass" name="pass" type="password" /></label>
  <button id="submit" type="submit">登录</button>
</form>
<!-- Used by the slot tab strip check: a popup stays inside the same instance. -->
<a id="popup" href="/second" target="_blank">在新标签页打开</a>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/login`;

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

const now = new Date().toISOString();
const siteId = uuid(1);
const secondSiteId = uuid(19);
const colors = ["amber", "teal", "violet", "rose", "blue", "slate"];
// Twenty-four tags guarantee the strip would have wrapped several times under
// the old `flex-wrap: wrap` rule at any normal window width.
const tags = Array.from({ length: 24 }, (_, index) => ({
  id: uuid(20 + index),
  name: `标签${index + 1}`,
  color: colors[index % colors.length],
}));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags,
    sites: [
      {
        id: siteId,
        name: "界面检查站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/login",
        authCheckPath: "/api/me",
        autoSubmit: false,
        // One tag each, so the sites page renders two foldable groups. With
        // every site untagged there was a single group and "collapse all" could
        // not be exercised at all.
        tagIds: [tags[0].id],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        // A second site with its own account: the site menu can only prove that
        // the left column switches the right column if there is something to
        // switch to.
        id: secondSiteId,
        name: "第二个站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [tags[1].id],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [
      {
        id: uuid(18),
        siteId: secondSiteId,
        name: "第二站点账号",
        username: "second@example.test",
        role: "管理员",
        color: "blue",
        passwordMode: "inherit",
        status: "unknown",
        startPath: "/",
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: uuid(2),
        siteId,
        name: "管理员 · 主账号",
        username: "admin@example.test",
        role: "管理员",
        color: "amber",
        passwordMode: "inherit",
        status: "unknown",
        startPath: "/",
        tagIds: tags.map((tag) => tag.id),
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: uuid(3),
        siteId,
        name: "成员 · 子账号",
        username: "member@example.test",
        role: "成员",
        color: "teal",
        passwordMode: "inherit",
        status: "unknown",
        startPath: "/",
        tagIds: [tags[0].id],
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

  // --- Empty stage ---------------------------------------------------------
  // Startup opens one blank page, so the first thing on the stage is the search
  // surface instead of an empty rectangle. The empty state still exists for the
  // real empty case — it is checked by emptying the surface right after.
  const stageStart = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    return {
      tabs: state.tabs.length,
      url: state.tabs[0]?.url ?? "",
      surface: Boolean(document.querySelector('.stage .blank-slot .new-tab')),
      empty: Boolean(document.querySelector('.stage .empty')),
    };
  })()`);
  check(
    "a cold start lands on the search box instead of an empty stage",
    stageStart?.tabs === 1 &&
      (!stageStart?.url || stageStart.url === "about:blank") &&
      stageStart?.surface === true &&
      stageStart?.empty === false,
    stageStart,
  );

  // Closing the last page must still leave a way forward. It should offer
  // exactly one next step; a wall of site chips duplicated the address bar and
  // the new-tab split.
  await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    // Put one blank page back so the rest of the suite starts from the same
    // state a user gets at launch.
    await window.ensemble.openEmbeddedTab({});
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);
  const emptyStage = await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    await new Promise((r) => setTimeout(r, 300));
    const empty = document.querySelector('.stage .empty');
    const panel = {
      present: Boolean(empty),
      buttons: empty?.querySelectorAll('button').length ?? 0,
      text: empty?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      siteChips: document.querySelectorAll('.stage .empty .site-chip, .stage .empty .chip').length,
    };
    // Restore the launch state: later checks expect one blank page.
    await window.ensemble.openEmbeddedTab({});
    await new Promise((r) => setTimeout(r, 600));
    return panel;
  })()`);
  check(
    "the empty stage offers a single new-tab action",
    emptyStage?.present === true && emptyStage?.buttons === 1 && emptyStage?.siteChips === 0,
    emptyStage,
  );

  // --- Tag filter strip -----------------------------------------------------
  await client.evaluate(`(() => { document.querySelector('[data-nav="identities"]')?.click(); return true; })()`);
  await waitFor(client, `Boolean(document.querySelector('.tag-filters'))`);

  const strip = await client.evaluate(`(() => {
    const filters = document.querySelector('.tag-filters');
    const scroll = document.querySelector('.chip-scroll');
    const chips = [...document.querySelectorAll('.tag-chip')];
    const toolbar = document.querySelector('.toolbar');
    const tops = new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top)));
    return {
      hasStrip: Boolean(filters),
      chips: chips.length,
      rows: tops.size,
      stripHeight: filters ? Math.round(filters.getBoundingClientRect().height) : null,
      toolbarHeight: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : null,
      scrollable: scroll ? scroll.scrollWidth > scroll.clientWidth : null,
      overflowX: scroll ? getComputedStyle(scroll).overflowX : null,
    };
  })()`);
  check("the tag strip renders every tag", strip?.chips === tags.length + 1, strip);
  check("the chips stay on one row however many tags exist", strip?.rows === 1, strip);
  check("the strip is a fixed-height row", strip?.stripHeight !== null && strip.stripHeight <= 40, strip);
  check(
    "the excess chips scroll sideways instead of wrapping",
    strip?.scrollable === true && strip?.overflowX === "auto",
    strip,
  );

  const filtered = await client.evaluate(`(async () => {
    const before = document.querySelectorAll('.id-card').length;
    const chip = [...document.querySelectorAll('.tag-chip')].find((el) => el.textContent.trim() === '标签1');
    chip?.click();
    await new Promise((r) => setTimeout(r, 400));
    const after = document.querySelectorAll('.id-card').length;
    const on = chip?.classList.contains('on');
    return { before, after, on };
  })()`);
  // Three accounts exist; only the two on the tagged site carry 标签1, so the
  // filter has to drop exactly the untagged one.
  check(
    "clicking a tag filters the accounts",
    filtered?.before === 3 && filtered?.after === 2 && filtered?.on === true,
    filtered,
  );

  // --- Identity cards are not vertically compressed ------------------------
  // As an auto-sized grid inside a scrolling column, rows used to be squeezed
  // to the leftover height; the card's own `overflow: hidden` then cut off its
  // action row. Every card must be at least as tall as its content.
  const cards = await client.evaluate(`(() =>
    [...document.querySelectorAll('.id-card')].map((card) => {
      const actions = card.querySelector('.card-actions');
      const cardRect = card.getBoundingClientRect();
      const actionRect = actions?.getBoundingClientRect();
      return {
        clientHeight: card.clientHeight,
        scrollHeight: card.scrollHeight,
        actionsInside:
          Boolean(actionRect) && actionRect.bottom <= cardRect.bottom + 1 && actionRect.top >= cardRect.top,
      };
    })
  )()`);
  check(
    "identity cards show their whole content",
    Array.isArray(cards) &&
      cards.length > 0 &&
      cards.every((card) => card.scrollHeight <= card.clientHeight + 1 && card.actionsInside),
    cards,
  );

  await client.evaluate(`(() => {
    const chip = [...document.querySelectorAll('.tag-chip')].find((el) => el.textContent.trim() === '全部');
    chip?.click();
    return true;
  })()`);
  await wait(300);

  // --- Tags are a rail page, not a Settings tab ----------------------------
  const tagsNav = await client.evaluate(`(() => {
    const button = document.querySelector('[data-nav="tags"]');
    button?.click();
    return Boolean(button);
  })()`);
  await wait(600);
  const tagsPage = await client.evaluate(`(() => {
    const page = document.querySelector('.tags');
    return {
      present: Boolean(page),
      heading: page?.querySelector('h1')?.textContent.trim() ?? '',
      rows: page?.querySelectorAll('.list > .row').length ?? 0,
      // The whole point of moving it: the page must not be the settings shell.
      inSettings: Boolean(page?.closest('.settings')),
    };
  })()`);
  check(
    "the rail opens a standalone tags page",
    tagsNav === true && tagsPage?.present === true && tagsPage?.inSettings === false,
    tagsPage,
  );
  check(
    "the tags page lists every tag",
    tagsPage?.rows === tags.length,
    { rows: tagsPage?.rows, expected: tags.length },
  );

  await client.evaluate(`(() => { document.querySelector('[data-nav="settings"]')?.click(); return true; })()`);
  await waitFor(client, `Boolean(document.querySelector('[role="tab"]'))`);
  const settingsTabs = await client.evaluate(`(() =>
    [...document.querySelectorAll('[role="tab"]')].map((el) =>
      el.textContent.replace(/\\s+/g, ' ').trim(),
    )
  )()`);
  check(
    "Settings no longer carries a tags tab",
    !settingsTabs.some((label) => /标签|Tags/.test(label)),
    settingsTabs,
  );
  await client.evaluate(`(() => { document.querySelector('[data-nav="identities"]')?.click(); return true; })()`);
  await wait(400);

  // --- Dropdown inside a dialog --------------------------------------------
  await client.evaluate(
    `(() => { document.querySelector('.id-card .card-actions .edit')?.click(); return true; })()`,
  );
  const dialogOpened = await waitFor(client, `Boolean(document.querySelector('[role="dialog"]'))`);
  check("the identity dialog opens", dialogOpened === true, dialogOpened);

  // Click the chevron rather than calling `focus()`: the role field is often
  // already focused when the dialog opens, and a second `focus()` fires no
  // focus event, so the suggestions never opened and this block was flaky.
  await client.evaluate(`(() => {
    document.querySelector('[role="dialog"] .combo .chevron-btn')?.click();
    return true;
  })()`);
  const comboOpened = await waitFor(
    client,
    `Boolean(document.querySelector('.combo-panel'))`,
    2000,
  );
  check("the role field opens its suggestions", comboOpened === true, { comboOpened });

  const panelInfo = await client.evaluate(`(() => {
    const panel = document.querySelector('.combo-panel');
    if (!panel) return { panel: false };
    const option = panel.querySelector('.option');
    const rect = option?.getBoundingClientRect();
    const hit = rect
      ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : null;
    return {
      panel: true,
      pointerEvents: getComputedStyle(panel).pointerEvents,
      options: panel.querySelectorAll('.option').length,
      hitInsidePanel: Boolean(hit && panel.contains(hit)),
      optionBackground: option ? getComputedStyle(option).backgroundColor : null,
      optionCenter: rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null,
    };
  })()`);
  check("the suggestions panel opens inside the dialog", panelInfo?.panel === true, panelInfo);
  check(
    "the panel accepts pointer events instead of inheriting the dialog lock",
    panelInfo?.pointerEvents === "auto",
    panelInfo,
  );
  check(
    "clicks land on the panel instead of passing through",
    panelInfo?.hitInsidePanel === true,
    panelInfo,
  );

  if (panelInfo?.optionCenter) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: panelInfo.optionCenter.x,
      y: panelInfo.optionCenter.y,
    });
    await wait(350);
  }
  const hovered = await client.evaluate(`(() => {
    const option = document.querySelector('.combo-panel .option');
    return option ? getComputedStyle(option).backgroundColor : null;
  })()`);
  check(
    "a suggestion shows its hover state",
    hovered !== null && hovered !== panelInfo?.optionBackground,
    { before: panelInfo?.optionBackground, after: hovered },
  );

  await client.evaluate(`(() => { document.querySelector('[role="dialog"] .close')?.click(); return true; })()`);
  await waitFor(client, `!document.querySelector('[role="dialog"]')`);

  // --- Floating login-capture prompt ---------------------------------------
  await client.evaluate(`(() => { document.querySelector('[data-nav="browser"]')?.click(); return true; })()`);
  await waitFor(client, `Boolean(document.querySelector('.app-body'))`);

  // Cold start opens one blank page: switching to the browser page must land on
  // the search box, not on an empty rectangle waiting for a "+" click. Nothing
  // before this point has touched the embedded surface.
  await waitFor(client, `Boolean(document.querySelector('.stage .blank-slot .new-tab'))`);
  const starter = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    return {
      tabs: state.tabs.length,
      url: state.tabs[0]?.url ?? "",
      surface: Boolean(document.querySelector('.stage .blank-slot .new-tab .nt-input')),
    };
  })()`);
  check(
    "startup opens one blank page so the search box is already there",
    starter?.tabs === 1 && (!starter?.url || starter.url === "about:blank") && starter?.surface === true,
    starter,
  );
  const shellBefore = await client.evaluate(`(() => {
    const body = document.querySelector('.app-body');
    const shell = document.querySelector('.app-shell');
    return {
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
      rows: shell ? getComputedStyle(shell).gridTemplateRows.split(' ').length : null,
      children: shell ? shell.children.length : null,
    };
  })()`);

  // Listen before typing so the notice cannot be missed.
  await client.evaluate(`(() => {
    window.__captures = [];
    window.ensemble.onLoginCaptured((notice) => window.__captures.push(notice));
    return true;
  })()`);
  await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} });
    await new Promise((r) => setTimeout(r, 2200));
    return true;
  })()`);

  let loginTarget;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    loginTarget = list.find((item) => item.url.startsWith(PAGE_URL));
    if (loginTarget) break;
    await wait(250);
  }
  check("the login page is a CDP target", Boolean(loginTarget), loginTarget?.url);
  if (loginTarget) {
    const pageClient = await connect(loginTarget.webSocketDebuggerUrl);
    await pageClient.evaluate(`(() => {
      document.querySelector('#user').value = 'admin@example.test';
      document.querySelector('#pass').value = 'secret-from-form';
      document.querySelector('#user').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#pass').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await waitFor(client, `Boolean(document.querySelector('.capture-wrap'))`);
    pageClient.close();
  }

  const prompt = await client.evaluate(`(() => {
    const wrap = document.querySelector('.capture-wrap');
    const bar = document.querySelector('.capture-wrap .capture-bar, .capture-wrap > *');
    const body = document.querySelector('.app-body');
    const shell = document.querySelector('.app-shell');
    const rect = wrap?.getBoundingClientRect();
    return {
      present: Boolean(wrap),
      position: wrap ? getComputedStyle(wrap).position : null,
      zIndex: wrap ? getComputedStyle(wrap).zIndex : null,
      bottomGap: rect ? Math.round(window.innerHeight - rect.bottom) : null,
      bodyHeight: body ? Math.round(body.getBoundingClientRect().height) : null,
      rows: shell ? getComputedStyle(shell).gridTemplateRows.split(' ').length : null,
      children: shell ? shell.children.length : null,
      barVisible: Boolean(bar),
    };
  })()`);
  check("the save-login prompt appears", prompt?.present === true && prompt?.barVisible === true, prompt);
  check("the prompt floats above the layout", prompt?.position === "fixed", prompt);
  check(
    "showing the prompt does not resize the app body",
    prompt?.bodyHeight === shellBefore?.bodyHeight,
    { before: shellBefore, after: prompt },
  );
  check(
    "the prompt does not add a row to the shell grid",
    prompt?.rows === 3,
    { before: shellBefore, after: prompt },
  );
  check("the prompt sits above the status bar", prompt?.bottomGap !== null && prompt.bottomGap >= 30, prompt);

  // --- Toolbar "+" sizing, dock resize and collapse animation --------------
  // Read the animation intent before transitions are switched off below.
  const dockMotion = await client.evaluate(`(() => {
    const dock = document.querySelector('.dock');
    return {
      transition: dock ? getComputedStyle(dock).transitionProperty : null,
      handle: Boolean(document.querySelector('.dock-resize')),
      cursor: (() => {
        const handle = document.querySelector('.dock-resize');
        return handle ? getComputedStyle(handle).cursor : null;
      })(),
    };
  })()`);

  // Geometry checks below compare settled values. In a headless run the window
  // is never composited, so CSS transitions do not advance and every read would
  // land mid-animation; switching them off makes the target values observable.
  await client.evaluate(`(() => {
    const style = document.createElement('style');
    style.id = '__e2e-no-transition';
    style.textContent = '*{transition:none !important;animation:none !important}';
    document.head.appendChild(style);
    return true;
  })()`);

  const sizing = await client.evaluate(`(() => {
    const split = document.querySelector('.toolbar .split');
    const icons = [...document.querySelectorAll('.toolbar .icon')];
    const input = document.querySelector('.toolbar .address input');
    const stepper = document.querySelector('.toolbar .zoom-stepper');
    const rect = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
    return {
      split: rect(split),
      icon: rect(icons[0]),
      input: rect(input),
      splitMain: rect(split?.querySelector('.split-main')),
      stepper: rect(stepper),
      // Every control in the row must agree on one height; two heights is what
      // made the toolbar look assembled from different toolbars.
      heights: [...new Set([
        ...[...document.querySelectorAll('.toolbar .icon')].map(rect),
        rect(input),
        rect(stepper),
        rect(split),
      ].filter((value) => value !== null))],
    };
  })()`);
  check(
    "the new-tab split button is at least as tall as the toolbar icons",
    sizing?.split !== null && sizing?.icon !== null && sizing.split >= sizing.icon,
    sizing,
  );
  check(
    "the new-tab button is not visibly smaller than the address field",
    sizing?.split !== null && sizing?.input !== null && sizing.split >= sizing.input - 2,
    sizing,
  );
  check(
    "every toolbar control shares one height",
    sizing?.heights?.length === 1 && sizing.heights[0] === 30,
    sizing,
  );
  check(
    "the toolbar carries a zoom stepper",
    sizing?.stepper === 30,
    { stepper: sizing?.stepper },
  );

  // --- The site menu: toggling, switching, and the cover handshake ----------
  // Three things broke here at once, all invisible without driving the panel:
  // the chevron could not close it, clicking a site in the left column closed
  // it instead of switching, and it painted before the native page was parked,
  // so its left half was covered for about 100ms.
  const menuOpen = await client.evaluate(`(async () => {
    const chevron = document.querySelector('.toolbar .split-more');
    // Retried: the click is dispatched while the toolbar may still be settling
    // after the resize above, and a click that lands on a re-rendering button is
    // swallowed. Retrying the open is not weakening the check — the assertions
    // below still fail on a panel that paints before the stage is parked.
    for (let attempt = 0; attempt < 3 && !document.querySelector('.open-panel'); attempt += 1) {
      chevron?.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    const panel = document.querySelector('.open-panel');
    const rows = [...document.querySelectorAll('.site-row')];
    return {
      open: Boolean(panel),
      rows: rows.length,
      // A lone tag name under the account list read as an empty section.
      tagNote: Boolean(document.querySelector('.tag-note')),
      active: rows.filter((el) => el.classList.contains('active')).length,
      // The live page must be parked before the panel shows; the frozen frame
      // is what proves the parking finished. The header band (and the page strip
      // it carries) is app chrome and stays visible — only the native page has
      // to go, which is exactly what the frozen frame stands in for.
      frozen: document.querySelectorAll('.stage .frozen').length,
    };
  })()`);
  check(
    "the chevron opens the site menu with the live page already parked",
    menuOpen?.open === true && menuOpen?.frozen > 0,
    menuOpen,
  );
  check(
    "the site menu marks exactly one active site",
    menuOpen?.active === 1,
    { active: menuOpen?.active, rows: menuOpen?.rows },
  );
  check("the site menu shows no dangling tag row", menuOpen?.tagNote === false, menuOpen);

  const menuClosed = await client.evaluate(`(async () => {
    document.querySelector('.toolbar .split-more')?.click();
    await new Promise((r) => setTimeout(r, 700));
    return Boolean(document.querySelector('.open-panel'));
  })()`);
  check("a second click on the chevron closes the menu", menuClosed === false, {
    menuClosed,
  });

  const menuSwitch = await client.evaluate(`(async () => {
    document.querySelector('.toolbar .split-more')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.site-row')];
    rows[1]?.click();
    await new Promise((r) => setTimeout(r, 500));
    const active = document.querySelector('.site-row.active .site-name');
    const accounts = [...document.querySelectorAll('.account-row:not(.clean) .acc-name')].map(
      (el) => el.textContent.trim(),
    );
    return {
      stillOpen: Boolean(document.querySelector('.open-panel')),
      active: active?.textContent.trim() ?? "",
      accounts,
    };
  })()`);
  check(
    "clicking a site in the left column switches the account list without closing",
    menuSwitch?.stillOpen === true && menuSwitch?.active !== "" && menuSwitch?.accounts?.length > 0,
    menuSwitch,
  );

  const menuEscaped = await client.evaluate(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return Boolean(document.querySelector('.open-panel'));
  })()`);
  check("Escape closes the site menu", menuEscaped === false, { menuEscaped });

  const dockBefore = await client.evaluate(`(() => {    const dock = document.querySelector('.dock');
    return { width: dock ? Math.round(dock.getBoundingClientRect().width) : null };
  })()`);
  check(
    "the dock offers a resize handle on its edge",
    dockMotion?.handle === true && dockMotion?.cursor === "col-resize",
    dockMotion,
  );
  check(
    "the dock animates its width",
    dockMotion?.transition?.split(",").map((item) => item.trim()).includes("width"),
    dockMotion,
  );

  // Drag the handle 80px to the left: the dock must grow by the same amount.
  const dockBox = await client.evaluate(`(() => {
    const handle = document.querySelector('.dock-resize');
    if (!handle) return null;
    const r = handle.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 120) };
  })()`);
  if (dockBox) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: dockBox.x,
      y: dockBox.y,
      button: "left",
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: dockBox.x - 80,
      y: dockBox.y,
      button: "left",
    });
    await wait(150);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: dockBox.x - 80,
      y: dockBox.y,
      button: "left",
      clickCount: 1,
    });
    await wait(400);
  }
  const dockAfter = await client.evaluate(`(() => {
    const dock = document.querySelector('.dock');
    return {
      width: dock ? Math.round(dock.getBoundingClientRect().width) : null,
      stored: window.localStorage.getItem("ensemble.runtimeDock.width"),
    };
  })()`);
  check(
    "dragging the handle widens the dock",
    dockBox !== null && dockAfter?.width === dockBefore?.width + 80,
    { before: dockBefore?.width, after: dockAfter?.width, stored: dockAfter?.stored },
  );
  check(
    "the dragged width is persisted",
    Number(dockAfter?.stored) === dockAfter?.width,
    dockAfter,
  );

  // Collapse: the width shrinks to the strip while the contents fade, and the
  // panel keeps its transition so the change is animated rather than a jump.
  await client.evaluate(`(() => {
    document.querySelector('.dock-head .collapse-btn')?.click();
    return true;
  })()`);
  await wait(700);
  const collapsed = await client.evaluate(`(() => {
    const dock = document.querySelector('.dock');
    const main = document.querySelector('.dock-main');
    const pane = document.querySelector('.main-pane');
    const stage = document.querySelector('.stage');
    return {
      width: dock ? Math.round(dock.getBoundingClientRect().width) : null,
      collapsed: dock?.classList.contains('collapsed') ?? null,
      mainHidden: main ? getComputedStyle(main).visibility === "hidden" : null,
      transition: dock ? getComputedStyle(dock).transitionProperty : null,
      // The reclaimed width has to reach the stage: a 46px strip beside a stage
      // that kept the expanded layout leaves a dead band on screen.
      paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : null,
      stageWidth: stage ? Math.round(stage.getBoundingClientRect().width) : null,
      windowWidth: window.innerWidth,
      railWidth: Math.round(document.querySelector('.rail')?.getBoundingClientRect().width ?? 0),
    };
  })()`);
  check(
    "collapsing shrinks the dock to the icon strip",
    collapsed?.collapsed === true && collapsed?.width !== null && collapsed.width <= 48,
    collapsed,
  );
  check(
    "the stage takes back the width the dock gives up",
    collapsed?.paneWidth ===
      Math.round((collapsed?.windowWidth ?? 0) - (collapsed?.railWidth ?? 0) - (collapsed?.width ?? 0)),
    collapsed,
  );
  check(
    "the contents hide without being torn out of the panel",
    collapsed?.mainHidden === true,
    collapsed,
  );

  // A collapsed strip that only offers "expand" hides the fact that pages are
  // running. It has to keep one clickable icon per instance, and clicking one
  // must switch the stage to that instance instead of reopening the panel.
  const mini = await client.evaluate(`(async () => {
    // A second instance makes the switch observable: with only one there is
    // nothing to switch to, and the click assertion could not fail.
    await window.ensemble.openEmbeddedTab({ viewId: null });
    await new Promise((r) => setTimeout(r, 900));
    const before = await window.ensemble.getEmbeddedState();
    const icons = [...document.querySelectorAll('.mini-tab')];
    const instanceCount = new Set(before.tabs.map((tab) => tab.instanceId)).size;
    const current = before.tabs.find((tab) => tab.id === before.activeTabId);
    // The loose instance is listed last, so the first icon is the other one.
    const first = icons[0];
    first?.click();
    await new Promise((r) => setTimeout(r, 600));
    const after = await window.ensemble.getEmbeddedState();
    const landed = after.tabs.find((tab) => tab.id === after.activeTabId);
    return {
      icons: icons.length,
      instances: instanceCount,
      // Every tile carries a page icon slot, and it is never empty: a favicon
      // when the page reported one, a placeholder globe otherwise. A bare letter
      // was the old fallback and it read as a stray character in a 46px column.
      iconSlots: icons.filter((el) => {
        const slot = el.querySelector('.tab-icon');
        return Boolean(slot && (slot.querySelector('img') || slot.querySelector('svg')));
      }).length,
      stillCollapsed: document.querySelector('.dock')?.classList.contains('collapsed') ?? null,
      switched: Boolean(current && landed && landed.instanceId !== current.instanceId),
      sameInstance: Boolean(landed && current && landed.instanceId === current.instanceId),
      beforeTab: before.activeTabId,
      afterTab: after.activeTabId,
    };
  })()`);
  check(
    "the collapsed dock shows one clickable icon per running instance",
    mini?.icons === mini?.instances && mini?.icons >= 2 && mini?.iconSlots === mini?.icons,
    mini,
  );
  check(
    "clicking a strip icon switches instance without reopening the panel",
    mini?.switched === true && mini?.stillCollapsed === true,
    mini,
  );

  // The strip has to keep saying what the panel said: which instances belong
  // together. Grouping is structure (rules between groups), so it survives the
  // width drop that makes view names unprintable.
  //
  // Also checked here: the current tile carries a fill and no decorative bar.
  // It briefly had both, i.e. a straight line drawn on a rounded surface.
  const grouped = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const before = await api.getEmbeddedState();
    // Two containers of one instance each, so the strip must show a boundary
    // between them. Without a second group the rule count is 0 either way and
    // the assertion could not fail.
    const a = await api.createEmbeddedView({ layoutId: "1x1", name: "分组甲" });
    await api.openEmbeddedTabInSlot(a.activeViewId, 0);
    const b = await api.createEmbeddedView({ layoutId: "1x1", name: "分组乙" });
    await api.openEmbeddedTabInSlot(b.activeViewId, 0);
    await new Promise((r) => setTimeout(r, 1200));
    const rules = [...document.querySelectorAll('.mini-list .mini-rule')];
    const icons = [...document.querySelectorAll('.mini-tab')];
    const current = icons.find((el) => el.classList.contains('current'));
    const style = current ? getComputedStyle(current) : null;
    const idle = icons.find((el) => !el.classList.contains('current'));
    const dockBg = getComputedStyle(document.querySelector('.dock')).backgroundColor;
    return {
      rules: rules.length,
      ruleHeight: rules[0] ? Math.round(rules[0].getBoundingClientRect().height) : null,
      ruleRadius: rules[0] ? getComputedStyle(rules[0]).borderTopLeftRadius : null,
      icons: icons.length,
      views: (await api.getEmbeddedState()).views.length,
      currentFill: style ? style.backgroundColor : null,
      currentShadow: style ? style.boxShadow : "none",
      currentRadius: style ? style.borderTopLeftRadius : null,
      // An idle tile has to be visible against the dock, or the strip reads as
      // floating characters. This is worth asserting because it is exactly the
      // failure mode of picking a token that only happens to work in one theme.
      idleFill: idle ? getComputedStyle(idle).backgroundColor : null,
      dockBg,
    };
  })()`);
  check(
    "the collapsed strip separates groups with a square rule",
    (grouped?.rules ?? 0) >= 1 &&
      grouped?.ruleHeight === 1 &&
      (grouped?.ruleRadius === "0px" || grouped?.ruleRadius === "0"),
    grouped,
  );
  check(
    "the current instance is marked by fill only, not fill plus a bar",
    grouped?.currentFill !== null &&
      grouped.currentFill !== "rgba(0, 0, 0, 0)" &&
      grouped.currentFill !== grouped?.idleFill &&
      (grouped?.currentShadow === "none" || !String(grouped?.currentShadow).includes("inset")),
    grouped,
  );
  check(
    "an idle tile is a visible surface, not a floating letter",
    grouped?.idleFill !== null &&
      grouped.idleFill !== "rgba(0, 0, 0, 0)" &&
      grouped.idleFill !== grouped?.dockBg,
    grouped,
  );

  // Expanding and collapsing are the same control in the same place. It sat at
  // the bottom of the strip while collapse sat in the panel header, so the same
  // action lived at two ends of the window.
  const expandAt = await client.evaluate(`(() => {
    const strip = document.querySelector('.mini');
    const button = strip?.querySelector('.expand');
    if (!strip || !button) return null;
    const s = strip.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const first = strip.querySelector('.mini-tab')?.getBoundingClientRect();
    return {
      fromTop: Math.round(b.top - s.top),
      aboveFirstIcon: first ? b.bottom <= first.top + 1 : null,
      radius: getComputedStyle(button).borderTopLeftRadius,
      borderWidth: getComputedStyle(button).borderTopWidth,
    };
  })()`);
  check(
    "the expand control sits at the top, above the instances",
    expandAt?.fromTop !== null && expandAt?.fromTop <= 12 && expandAt?.aboveFirstIcon === true,
    expandAt,
  );
  check(
    "the expand control is a borderless tile like the ones it sits with",
    expandAt?.borderWidth === "0px" && expandAt?.radius !== "0px",
    expandAt,
  );

  await client.evaluate(`(() => {
    document.querySelector('.dock .expand')?.click();
    return true;
  })()`);
  await wait(500);
  const expanded = await client.evaluate(`(() => {
    const dock = document.querySelector('.dock');
    return { width: dock ? Math.round(dock.getBoundingClientRect().width) : null };
  })()`);
  check(
    "expanding restores the dragged width",
    expanded?.width === dockAfter?.width,
    { expected: dockAfter?.width, got: expanded?.width },
  );

  // The strip checks above opened two extra containers; close them so the slot
  // assertions that follow work on a known surface.
  await client.evaluate(`(async () => {
    const api = window.ensemble;
    for (const view of (await api.getEmbeddedState()).views) {
      if (view.name === "分组甲" || view.name === "分组乙") {
        await api.closeEmbeddedView(view.id, "all");
      }
    }
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);

  await client.evaluate(`(() => {
    document.getElementById('__e2e-no-transition')?.remove();
    return true;
  })()`);

  // --- Flat mode: the default tab group has the same controls as a cell ----
  // The stage showed one page with no strip at all: an instance opened into the
  // default tab group could not reach its other pages, had no "+" and no page
  // menu. Same instance, same controls — only the number of cells differs.
  const flatStrip = await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    // A loose page on a real URL, then a second page inside the same instance.
    const first = await window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(PAGE_URL)} });
    await new Promise((r) => setTimeout(r, 1400));
    await window.ensemble.openEmbeddedTabInInstance(first.instanceId);
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const heads = () => document.querySelectorAll('.stage .slot-header').length;
    const flatHeads = () => document.querySelectorAll('.stage .slot-header.flat').length;
    const tabs = () => [...document.querySelectorAll('.stage .slot-tab')];
    const before = {
      viewOnStage: state.activeViewId ?? null,
      heads: heads(),
      flatHeads: flatHeads(),
      tabs: tabs().length,
      hasAdd: Boolean(document.querySelector('.stage .slot-tab-add')),
      current: tabs().findIndex((el) => el.classList.contains('current')),
    };
    // Switching pages from the strip must move the page, not the cell.
    const other = tabs().find((el) => !el.classList.contains('current'));
    other?.click();
    await new Promise((r) => setTimeout(r, 700));
    const switched = {
      activeTabId: (await window.ensemble.getEmbeddedState()).activeTabId,
      clickedId: other?.getAttribute('data-tab-id') ?? null,
      current: tabs().findIndex((el) => el.classList.contains('current')),
    };
    return { before, switched };
  })()`);
  check(
    "the flat stage carries a page strip for its instance",
    flatStrip?.before.viewOnStage === null &&
      flatStrip?.before.heads === 1 &&
      flatStrip?.before.flatHeads === 1 &&
      flatStrip?.before.tabs === 2 &&
      flatStrip?.before.hasAdd === true &&
      flatStrip?.before.current >= 0,
    flatStrip,
  );
  check(
    "a flat page tab switches which page the stage shows",
    flatStrip?.switched.clickedId !== null &&
      flatStrip?.switched.activeTabId === flatStrip?.switched.clickedId &&
      flatStrip?.switched.current >= 0,
    flatStrip,
  );

  // A layout for the flat list: choosing one groups the loose pages into a view
  // with that layout, which is how the default tab group stops being the one
  // place with no layout.
  const flatLayout = await client.evaluate(`(async () => {
    const select = document.querySelector('.dock [data-flat-layout] .select-trigger');
    const before = await window.ensemble.getEmbeddedState();
    select?.click();
    await new Promise((r) => setTimeout(r, 300));
    const options = [...document.querySelectorAll('.select-panel .option')].map((el) =>
      el.querySelector('.option-label')?.textContent.trim(),
    );
    const target = [...document.querySelectorAll('.select-panel .option')].find((el) =>
      (el.querySelector('.option-label')?.textContent ?? "").includes("2 × 1"),
    );
    target?.click();
    await new Promise((r) => setTimeout(r, 1200));
    const after = await window.ensemble.getEmbeddedState();
    const view = after.views.find((item) => item.id === after.activeViewId);
    const instancesOf = (tabs) => new Set(tabs.filter((tab) => !tab.viewId).map((tab) => tab.instanceId)).size;
    return {
      trigger: Boolean(select),
      options,
      beforeViews: before.views.length,
      beforeLoose: before.tabs.filter((tab) => !tab.viewId).length,
      beforeLooseInstances: instancesOf(before.tabs),
      afterViews: after.views.length,
      activeViewId: after.activeViewId ?? null,
      layoutId: view?.layoutId ?? null,
      // A cell holds an instance, so the two pages of one browser are one member.
      members: view?.slotTabs?.filter(Boolean).length ?? 0,
      looseLeft: after.tabs.filter((tab) => !tab.viewId).length,
      cells: document.querySelectorAll('.stage .slot-header:not(.flat)').length,
    };
  })()`);
  check(
    "the tabs block offers layouts and turns loose pages into a view",
    flatLayout?.trigger === true &&
      flatLayout?.options?.some((label) => label.includes("2 × 1")) === true &&
      flatLayout?.afterViews === flatLayout?.beforeViews + 1 &&
      flatLayout?.layoutId === "2x1" &&
      flatLayout?.members === flatLayout?.beforeLooseInstances &&
      flatLayout?.looseLeft === 0 &&
      flatLayout?.cells === 1,
    flatLayout,
  );

  // Put the surface back to one view with one page: the checks below count cells.
  await client.evaluate(`(async () => {
    for (const view of (await window.ensemble.getEmbeddedState()).views) {
      await window.ensemble.closeEmbeddedView(view.id, "all");
    }
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);

  // --- Slot header strip: pages of the instance in the cell -----------------
  // Every cell that holds a browser shows its page strip, even with one page:
  // the strip is what distinguishes "window title" from "tabs", and it is the
  // only place the per-instance "+" can live.
  const slotOpen = await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    const created = await window.ensemble.createEmbeddedView({ layoutId: "2x1", name: "标签检查" });
    const viewId = created.activeViewId;
    await window.ensemble.openEmbeddedTabInSlot(viewId, 0);
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === viewId);
    const tabId = view?.slotTabs?.[0] ?? null;
    if (tabId) {
      const tab = state.tabs.find((item) => item.id === tabId);
      await window.ensemble.navigateEmbeddedTab(tabId, ${JSON.stringify(PAGE_URL)});
      await new Promise((r) => setTimeout(r, 1200));
    }
    return { viewId, tabId, tabCount: state.tabs.length };
  })()`);
  check("a view is on stage for the slot strip check", Boolean(slotOpen?.tabId), slotOpen);

  const single = await client.evaluate(`(() => {
    const header = document.querySelector('.stage .slot-header');
    const tab = header?.querySelector('.slot-tab');
    const add = header?.querySelector('.slot-tab-add');
    const close = header?.querySelector('.slot-tab-close');
    const selectedText = header?.querySelector('.slot-selected');
    return {
      headers: document.querySelectorAll('.stage .slot-header').length,
      strip: Boolean(header?.querySelector('.slot-tabs')),
      pages: header?.querySelectorAll('.slot-tab').length ?? 0,
      hasAdd: Boolean(add),
      hasClose: Boolean(close),
      // The word "selected" used to eat band width; the state is now drawn.
      noSelectedText: !selectedText,
      // Unselected pages need their own surface, or the strip is invisible.
      tabBackground: tab ? getComputedStyle(tab).backgroundColor : "",
      tabBorder: tab ? getComputedStyle(tab).borderTopWidth : "",
    };
  })()`);
  check(
    "a one-page instance still shows its strip, with add and close",
    single?.headers === 1 &&
      single?.strip === true &&
      single?.pages === 1 &&
      single?.hasAdd === true &&
      single?.hasClose === true,
    single,
  );
  check(
    "a page tab has its own surface and the header drops the 'selected' text",
    single?.noSelectedText === true &&
      single?.tabBackground !== "rgba(0, 0, 0, 0)" &&
      single?.tabBackground !== "transparent" &&
      single?.tabBorder !== "0px",
    single,
  );

  // The header band is laid out from the stage box, not from the tab list. It
  // once read a non-reactive clientWidth, so collapsing the dock left the band
  // at the expanded width while the native page had already moved: a dead band
  // appeared to the right of the last cell.
  const headerFollow = await client.evaluate(`(async () => {
    const headerWidth = () => {
      const header = document.querySelector('.stage .slot-header');
      return header ? Math.round(header.getBoundingClientRect().width) : null;
    };
    const stageWidth = () => {
      const stage = document.querySelector('.stage');
      return stage ? Math.round(stage.getBoundingClientRect().width) : null;
    };
    const before = { header: headerWidth(), stage: stageWidth() };
    document.querySelector('.dock-head .collapse-btn')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const collapsed = { header: headerWidth(), stage: stageWidth() };
    document.querySelector('.dock .expand')?.click();
    await new Promise((r) => setTimeout(r, 900));
    return { before, collapsed, restored: headerWidth() };
  })()`);
  check(
    "the slot header widens with the stage when the dock collapses",
    headerFollow?.before.header !== null &&
      headerFollow?.collapsed.header !== null &&
      headerFollow.collapsed.header > headerFollow.before.header &&
      headerFollow.collapsed.stage > headerFollow.before.stage,
    headerFollow,
  );
  check(
    "the header goes back to its width when the dock expands",
    headerFollow?.restored === headerFollow?.before.header,
    headerFollow,
  );

  // Open a popup from inside the page: it joins the same instance, so the slot
  // gains a second page without gaining a cell.
  let popupTarget;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    popupTarget = list.find((item) => item.url.startsWith(PAGE_URL));
    if (popupTarget) break;
    await wait(250);
  }
  check("the embedded page is a CDP target", Boolean(popupTarget), popupTarget?.url);
  if (popupTarget) {
    const pageClient = await connect(popupTarget.webSocketDebuggerUrl);
    await pageClient.evaluate(`(() => {
      document.querySelector('#popup')?.click();
      return true;
    })()`);
    pageClient.close();
  }

  const slotStrip = await (async () => {
    const deadline = Date.now() + 6000;
    let last = null;
    while (Date.now() < deadline) {
      last = await client.evaluate(`(() => {
        const header = document.querySelector('.stage .slot-header');
        const strip = header?.querySelector('.slot-tabs');
        const tabs = [...(strip?.querySelectorAll('.slot-tab') ?? [])];
        const number = header?.querySelector('.slot-index');
        const stripRect = strip?.getBoundingClientRect();
        const numberRect = number?.getBoundingClientRect();
        return {
          headers: document.querySelectorAll('.stage .slot-header').length,
          tabs: tabs.map((el) => el.textContent.trim()),
          current: tabs.findIndex((el) => el.classList.contains('current')),
          // The strip comes after the slot number and uses the rest of the band.
          afterNumber:
            Boolean(stripRect && numberRect) && stripRect.left >= numberRect.right - 1,
          sameRowAsNumber:
            Boolean(stripRect && numberRect) &&
            Math.abs(stripRect.top + stripRect.height / 2 - (numberRect.top + numberRect.height / 2)) <
              12,
        };
      })()`);
      if (last?.tabs?.length > 1) return last;
      await wait(250);
    }
    return last;
  })();
  check(
    "a second page adds no cell but appears in the slot header",
    slotStrip?.headers === 1 && slotStrip?.tabs?.length === 2,
    slotStrip,
  );
  check("exactly one page tab is marked current", slotStrip?.current >= 0, slotStrip);
  check(
    "the tab strip follows the slot number on the same row",
    slotStrip?.afterNumber === true && slotStrip?.sameRowAsNumber === true,
    slotStrip,
  );

  const beforeSwitch = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === state.activeViewId);
    return { focused: view?.focusedTabId, active: state.activeTabId, root: view?.slotTabs?.[0] };
  })()`);

  // Click the tab that is not current: the page changes, the cell does not.
  await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.stage .slot-tab')];
    const target = tabs.find((el) => !el.classList.contains('current'));
    target?.click();
    return Boolean(target);
  })()`);
  await wait(600);

  const afterSwitch = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === state.activeViewId);
    const header = document.querySelector('.stage .slot-header');
    const tabs = [...(header?.querySelectorAll('.slot-tab') ?? [])];
    return {
      active: state.activeTabId,
      focused: view?.focusedTabId,
      root: view?.slotTabs?.[0],
      current: tabs.findIndex((el) => el.classList.contains('current')),
      headers: document.querySelectorAll('.stage .slot-header').length,
    };
  })()`);
  check(
    "clicking a page tab switches the page shown in that cell",
    afterSwitch?.active !== beforeSwitch?.active && afterSwitch?.current >= 0,
    { before: beforeSwitch, after: afterSwitch },
  );
  check(
    "the cell keeps the same instance and the layout is untouched",
    afterSwitch?.root === beforeSwitch?.root && afterSwitch?.headers === 1,
    { before: beforeSwitch, after: afterSwitch },
  );

  // --- "+" adds a page to the same instance, and a blank page is a search box --
  // A work profile needs a console, a docs page and the page under test at once.
  // The "+" must therefore extend the existing session, not open a second one,
  // and the blank page it lands on must offer something to type into.
  const added = await client.evaluate(`(async () => {
    const before = await window.ensemble.getEmbeddedState();
    const view = before.views.find((item) => item.id === before.activeViewId);
    const beforePages = before.tabs.filter((tab) => tab.instanceId === view?.slotTabs?.[0]).length;
    const header = document.querySelector('.stage .slot-header');
    header?.querySelector('.slot-tab-add')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const nextView = state.views.find((item) => item.id === state.activeViewId);
    const pages = state.tabs.filter((tab) => tab.instanceId === nextView?.slotTabs?.[0]);
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return {
      beforePages,
      instancePages: pages.length,
      instances: new Set(state.tabs.map((tab) => tab.instanceId)).size,
      activeBlank: Boolean(active) && (!active.url || active.url === "about:blank"),
      surface: Boolean(document.querySelector('.stage .blank-slot .new-tab')),
      hasInput: Boolean(document.querySelector('.stage .blank-slot .nt-input')),
    };
  })()`);
  check(
    "the strip's + adds a page to the same instance",
    added?.instancePages === (added?.beforePages ?? 0) + 1 && added?.instances === 1,
    added,
  );
  check(
    "a blank page draws the new-tab surface instead of an empty rectangle",
    added?.activeBlank === true && added?.surface === true && added?.hasInput === true,
    added,
  );

  // One field, no explanatory rows: the placeholder carries the rule and the
  // engine picker sits in the field itself, so a second sentence and a row of
  // engine chips were both removed. Reading them back is what keeps them gone.
  const newTabLayout = await client.evaluate(`(async () => {
    const surface = document.querySelector('.stage .blank-slot .new-tab');
    if (!surface) return null;
    const rowCount = surface.querySelectorAll('.nt-engines, .nt-chips, .nt-hint').length;
    return {
      forms: surface.querySelectorAll("form").length,
      extraRows: rowCount,
      engine: surface.querySelector('.nt-engine-name')?.textContent?.trim() ?? "",
      placeholder: surface.querySelector('.nt-input')?.getAttribute('placeholder') ?? "",
    };
  })()`);
  check(
    "the new tab is one search field with the engine in it, and no hint row",
    newTabLayout?.forms === 1 &&
      newTabLayout?.extraRows === 0 &&
      newTabLayout?.engine === "Bing" &&
      newTabLayout?.placeholder.length > 0,
    newTabLayout,
  );

  // The backdrop picker is the "make the homepage mine" affordance: choosing a
  // swatch has to persist, or it is only a preview.
  const backdrop = await client.evaluate(`(async () => {
    const surface = document.querySelector('.stage .blank-slot .new-tab');
    if (!surface) return null;
    const before = (await window.ensemble.getWorkspace()).settings.newTabBackground;
    surface.querySelector('.nt-look-btn')?.click();
    await new Promise((r) => setTimeout(r, 120));
    const swatches = [...surface.querySelectorAll('.nt-swatch')];
    const target = swatches.find((el) => !el.classList.contains('active')) ?? swatches[0];
    const chosen = target?.getAttribute('title') ?? "";
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const after = (await window.ensemble.getWorkspace()).settings.newTabBackground;
    return { before, after, chosen, count: swatches.length, reopened: false };
  })()`);
  check(
    "picking a backdrop persists it as a setting",
    Boolean(backdrop?.before) &&
      Boolean(backdrop?.after) &&
      backdrop?.after !== backdrop?.before &&
      (backdrop?.count ?? 0) >= 3,
    backdrop,
  );

  // Typing a host must open it — that half of the input field is the whole
  // point of having no separate "go to address" mode.
  const newTabAddress = await client.evaluate(`(async () => {
    const input = document.querySelector('.stage .blank-slot .nt-input');
    if (!input) return null;
    input.value = "127.0.0.1:${PAGE_PORT}/second";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('.stage .blank-slot .nt-box')?.requestSubmit();
    await new Promise((r) => setTimeout(r, 1500));
    const state = await window.ensemble.getEmbeddedState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    return {
      url: active?.url ?? "",
      surfaceGone: !document.querySelector('.stage .blank-slot .new-tab'),
    };
  })()`);
  check(
    "a host typed into the new tab navigates instead of searching",
    String(newTabAddress?.url).startsWith("http://127.0.0.1") &&
      newTabAddress?.surfaceGone === true,
    newTabAddress,
  );

  // The other half of the same field: words must reach the configured engine.
  // A custom engine pointing at the local test server is what makes this
  // checkable without network access — and it exercises the custom-engine path
  // at the same time.
  const newTabSearch = await client.evaluate(`(async () => {
    const searchUrl = "http://127.0.0.1:${PAGE_PORT}/search?q=%s";
    // Opening a loose tab leaves the view off stage; the rest of the suite
    // works inside its cells, so the view is put back before returning.
    const viewId = (await window.ensemble.getEmbeddedState()).activeViewId;
    await window.ensemble.saveSettings({
      customSearchEngines: [{ id: "e2e-engine", name: "本地搜索", urlTemplate: searchUrl }],
      searchEngineId: "e2e-engine",
    });
    await window.ensemble.openEmbeddedTab({ viewId: null });
    await new Promise((r) => setTimeout(r, 900));
    const input = document.querySelector('.stage .blank-slot .nt-input');
    if (!input) return null;
    const engine = document.querySelector('.stage .blank-slot .nt-engine-name')?.textContent?.trim();
    input.value = "租户 管理";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('.stage .blank-slot .nt-box')?.requestSubmit();
    await new Promise((r) => setTimeout(r, 1500));
    const state = await window.ensemble.getEmbeddedState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    // Leave the workspace on the default engine for anything later in the suite.
    await window.ensemble.saveSettings({ searchEngineId: "bing" });
    if (viewId) await window.ensemble.activateEmbeddedView(viewId);
    await new Promise((r) => setTimeout(r, 600));
    return {
      engine,
      url: active?.url ?? "",
      restored: (await window.ensemble.getEmbeddedState()).activeViewId === viewId,
    };
  })()`);
  check(
    "typed words search on the selected engine",
    newTabSearch?.engine === "本地搜索" &&
      String(newTabSearch?.url).includes("/search?q=") &&
      // Decoded rather than compared against `encodeURIComponent`: Chromium may
      // canonicalize the query, and what matters is the term, not the escaping.
      decodeURIComponent(String(newTabSearch?.url)).includes("租户 管理") &&
      newTabSearch?.restored === true,
    newTabSearch,
  );

  // Freezing the stage happens for every overlay, and a blank page has no native
  // pixels to capture. Including it produced an empty image that covered the
  // search box — the surface was there, just painted over.
  const freezeBlank = await client.evaluate(`(async () => {
    const state0 = await window.ensemble.getEmbeddedState();
    const viewId = state0.activeViewId;
    await window.ensemble.openEmbeddedTab({ viewId: null });
    await new Promise((r) => setTimeout(r, 900));
    const slots = await window.ensemble.freezeEmbedded();
    const state = await window.ensemble.getEmbeddedState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    window.ensemble.setEmbeddedStage({
      x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
    });
    const surface = document.querySelector('.stage .blank-slot .new-tab');
    const overlap = surface
      ? [...document.querySelectorAll('.stage .frozen')].some((img) => {
          const a = img.getBoundingClientRect();
          const b = surface.getBoundingClientRect();
          return a.width > 0 && b.width > 0 && a.left < b.right && a.right > b.left &&
            a.top < b.bottom && a.bottom > b.top;
        })
      : false;
    // Restore the view: the rest of this suite works inside its cells.
    if (viewId) await window.ensemble.activateEmbeddedView(viewId);
    await new Promise((r) => setTimeout(r, 700));
    return {
      activeBlank: Boolean(active) && (!active.url || active.url === "about:blank"),
      frozen: slots.length,
      surfaceUnderFrozen: overlap,
      restored: (await window.ensemble.getEmbeddedState()).activeViewId === viewId,
    };
  })()`);
  check(
    "freezing the stage leaves the new-tab surface un-covered",
    freezeBlank?.activeBlank === true &&
      freezeBlank?.frozen === 0 &&
      freezeBlank?.surfaceUnderFrozen === false &&
      freezeBlank?.restored === true,
    freezeBlank,
  );

  // --- Page actions: close one page, and the right-click menu ---------------
  const closeOne = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === state.activeViewId);
    const before = state.tabs.filter((tab) => tab.instanceId === view?.slotTabs?.[0]).length;
    const header = document.querySelector('.stage .slot-header');
    const target = header?.querySelector('.slot-tab:not(.current) .slot-tab-close');
    target?.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = await window.ensemble.getEmbeddedState();
    return {
      before,
      after: after.tabs.filter((tab) => tab.instanceId === view?.slotTabs?.[0]).length,
      cells: after.views.find((item) => item.id === view?.id)?.slotTabs?.filter(Boolean).length,
    };
  })()`);
  check(
    "the strip's close button closes one page and keeps the cell",
    closeOne?.after === (closeOne?.before ?? 0) - 1 && closeOne?.cells === 1,
    closeOne,
  );

  const menu = await client.evaluate(`(async () => {
    const tab = document.querySelector('.stage .slot-tab');
    if (!tab) {
      const state = await window.ensemble.getEmbeddedState();
      return {
        missing: true,
        tabs: state.tabs.length,
        activeTabId: state.activeTabId ?? null,
        activeViewId: state.activeViewId ?? null,
        heads: document.querySelectorAll('.stage .slot-header').length,
        stage: Boolean(document.querySelector('.stage')),
      };
    }
    const rect = tab.getBoundingClientRect();
    tab.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(rect.left + 10),
      clientY: Math.round(rect.top + 6),
    }));
    await new Promise((r) => setTimeout(r, 700));
    const panel = document.querySelector('.tab-menu');
    return {
      open: Boolean(panel),
      items: [...(panel?.querySelectorAll('.tab-menu-item') ?? [])].map((el) => el.textContent.trim()),
      frozen: Boolean(document.querySelector('.stage .frozen')),
    };
  })()`);
  check(
    "right-clicking a page tab opens the page menu over a frozen stage",
    menu?.open === true && menu?.frozen === true && (menu?.items?.length ?? 0) >= 4,
    menu,
  );

  const duplicated = await client.evaluate(`(async () => {
    const before = await window.ensemble.getEmbeddedState();
    // The group key is the instance id of the page in the cell, not the slot's
    // root id: closing the original root keeps the surviving pages in one
    // instance, so the slot name and the group key can differ.
    const beforeActive = before.tabs.find((tab) => tab.id === before.activeTabId);
    const instanceId = beforeActive?.instanceId;
    const beforePages = before.tabs.length;
    const beforeSameInstance = before.tabs.filter((tab) => tab.instanceId === instanceId).length;
    const item = [...document.querySelectorAll('.tab-menu-item')].find((el) =>
      el.textContent.includes("复制标签页"),
    );
    item?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const after = await window.ensemble.getEmbeddedState();
    const active = after.tabs.find((tab) => tab.id === after.activeTabId);
    return {
      instanceId,
      beforePages,
      afterPages: after.tabs.length,
      beforeSameInstance,
      sameInstancePages: after.tabs.filter((tab) => tab.instanceId === instanceId).length,
      copyInSameInstance: active?.instanceId === instanceId,
      menuClosed: !document.querySelector('.tab-menu'),
      urlCopied: String(active?.url ?? "").startsWith("http://127.0.0.1"),
    };
  })()`);
  check(
    "the menu's duplicate adds the copy to the same instance",
    duplicated?.afterPages === (duplicated?.beforePages ?? 0) + 1 &&
      duplicated?.sameInstancePages === (duplicated?.beforeSameInstance ?? 0) + 1 &&
      duplicated?.copyInSameInstance === true &&
      duplicated?.menuClosed === true &&
      duplicated?.urlCopied === true,
    duplicated,
  );

  // --- The tab/window rows name their account ------------------------------
  // Four windows on the same admin console all show the same page title, so the
  // row has to say whose session it is.
  await client.evaluate(`(() => { document.querySelector('[data-nav="browser"]')?.click(); return true; })()`);
  await wait(400);
  const labelled = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({
      url: ${JSON.stringify(PAGE_URL)},
      identityId: ${JSON.stringify(uuid(2))},
      label: "管理员 · 主账号",
    });
    await new Promise((r) => setTimeout(r, 800));
    const rows = [...document.querySelectorAll('.dock .tab-row')];
    return {
      accounts: rows.map((el) => el.querySelector('.tab-account')?.textContent.trim() ?? ""),
      labels: rows.map((el) => el.querySelector('.tab-label')?.textContent.trim() ?? ""),
    };
  })()`);
  check(
    "a running tab row names its account",
    labelled?.accounts?.includes("管理员 · 主账号"),
    labelled,
  );

  // --- Leaving the browser page must not show or flatten the pages ----------
  // Pages keep running when the user is on another rail page. Two things must
  // hold there, and both broke at some point:
  //  * the native view is parked outside the window, or it paints over the page
  //    the user is looking at;
  //  * the page keeps a real viewport, or every geometry-based decision the AI
  //    makes ("is this text visible", where is the button) is wrong.
  await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs[0];
    if (tab) await window.ensemble.navigateEmbeddedTab(tab.id, ${JSON.stringify(PAGE_URL)});
    await new Promise((r) => setTimeout(r, 1200));
    return Boolean(tab);
  })()`);
  await client.evaluate(
    `(() => { document.querySelector('[data-nav="identities"]')?.click(); return true; })()`,
  );
  await wait(1200);

  const parkedState = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      tabs: state.tabs.map((tab) => ({ id: tab.id, bounds: tab.bounds ?? null })),
      onIdentities: Boolean(document.querySelector('.id-card')),
    };
  })()`);
  check(
    "switching pages keeps every embedded page parked outside the window",
    parkedState?.onIdentities === true &&
      parkedState.tabs.length > 0 &&
      parkedState.tabs.every(
        (tab) => tab.bounds && tab.bounds.x >= parkedState.viewportWidth,
      ),
    parkedState,
  );

  const parkedViewport = await (async () => {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const targets = list.filter((item) => item.url.startsWith(PAGE_URL));
    const sizes = [];
    for (const target of targets) {
      const pageClient = await connect(target.webSocketDebuggerUrl);
      sizes.push(
        await pageClient.evaluate(
          `({ w: window.innerWidth, h: window.innerHeight, bodyW: document.body.getBoundingClientRect().width })`,
        ),
      );
      pageClient.close();
    }
    return sizes;
  })();
  check(
    "no parked page collapses to a zero-width layout",
    parkedViewport.length > 0 &&
      parkedViewport.every((size) => size && size.w > 0 && size.h > 0 && size.bodyW > 0),
    parkedViewport,
  );

  // --- Dock rows: a click brings the browser page forward -------------------
  // The dock is on screen from every rail page, so clicking one of its rows has
  // to show the page it selects. It used to switch the tab behind the accounts
  // page and leave the user looking at account cards, which read as a dead click.
  const dockSwitch = await client.evaluate(`(async () => {
    const row = document.querySelector('.dock .tab-row[data-tab-id]');
    const wanted = row?.getAttribute('data-tab-id') ?? null;
    // Falsifiability: the assertion below is only meaningful from another page.
    const elsewhereBefore = !document.querySelector('.stage') && Boolean(document.querySelector('.id-card'));
    row?.click();
    await new Promise((r) => setTimeout(r, 1000));
    const after = await window.ensemble.getEmbeddedState();
    return {
      elsewhereBefore,
      clicked: Boolean(row),
      wanted,
      onBrowserAfter: Boolean(document.querySelector('.stage')),
      activeTab: after.activeTabId,
    };
  })()`);
  check(
    "clicking a dock row from another page switches to the browser page",
    dockSwitch?.elsewhereBefore === true &&
      dockSwitch?.clicked === true &&
      dockSwitch?.onBrowserAfter === true &&
      dockSwitch?.activeTab === dockSwitch?.wanted,
    dockSwitch,
  );

  // Every page row carries the site's icon, with a placeholder when the page has
  // not reported one. Checking a run means recognising pages by site, and the
  // rows used to be bare titles.
  const pageIcons = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!active) return null;
    // A second page is what makes the instance's own page list appear.
    await window.ensemble.openEmbeddedTabInInstance(active.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    const rows = [...document.querySelectorAll('.dock .pages .page-row')];
    const slots = rows.map((row) => {
      const icon = row.querySelector('.tab-icon');
      return Boolean(icon && (icon.querySelector('img') || icon.querySelector('svg')));
    });
    // Leave the surface as it was found.
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      if (tab.instanceId === active.instanceId && tab.id !== active.id) {
        await window.ensemble.closeEmbeddedTab(tab.id);
      }
    }
    await new Promise((r) => setTimeout(r, 700));
    return { rows: rows.length, slots };
  })()`);
  check(
    "each page row in the dock shows an icon or its placeholder",
    (pageIcons?.rows ?? 0) >= 2 &&
      pageIcons?.slots?.length === pageIcons?.rows &&
      pageIcons.slots.every(Boolean),
    pageIcons,
  );

  // The favicon path itself, not only the placeholder: the test page declares an
  // icon, so at least one row must be showing a real image. Without this the
  // check above would keep passing if the whole `src` wiring broke.
  const realIcon = await client.evaluate(`(async () => {
    const deadline = Date.now() + 5000;
    let found = { rows: 0, images: 0, src: "" };
    while (Date.now() < deadline) {
      const rows = [...document.querySelectorAll('.dock .tab-row .tab-icon')];
      const images = rows.filter((row) => row.querySelector('img'));
      found = {
        rows: rows.length,
        images: images.length,
        src: images[0]?.querySelector('img')?.getAttribute('src')?.slice(0, 20) ?? "",
      };
      if (images.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return found;
  })()`);
  check(
    "a dock row shows the site's real favicon, inlined as a data URL",
    realIcon?.images >= 1 && String(realIcon?.src).startsWith("data:image/"),
    realIcon,
  );

  // --- The flows empty state sits in the middle of the page ----------------
  // The section did not fill the pane, so `margin: auto` had no free space to
  // distribute and the block hugged the header instead of centring.
  const flowsEmpty = await client.evaluate(`(async () => {
    document.querySelector('[data-nav="flows"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const page = document.querySelector('.flows');
    const empty = page?.querySelector('.empty');
    if (!page || !empty) return { present: false };
    const p = page.getBoundingClientRect();
    const e = empty.getBoundingClientRect();
    const head = page.querySelector('.head')?.getBoundingClientRect();
    const padBottom = parseFloat(getComputedStyle(page).paddingBottom) || 0;
    return {
      present: true,
      // Horizontally the block must sit on the page's own axis.
      dx: Math.round(Math.abs(e.left + e.width / 2 - (p.left + p.width / 2))),
      // Vertically the free space above and below must match: that is what an
      // auto margin produces, and what a header-hugging block does not.
      above: Math.round(e.top - (head?.bottom ?? p.top)),
      below: Math.round(p.bottom - padBottom - e.bottom),
    };
  })()`);
  check(
    "the flows empty state is centred in the page",
    flowsEmpty?.present === true &&
      flowsEmpty?.dx <= 2 &&
      Math.abs(flowsEmpty.above - flowsEmpty.below) <= 6,
    flowsEmpty,
  );

  // --- Group headers fold, per group and all at once -----------------------
  // Every grouped list (sites by tag, accounts by site, flows by site) had fixed
  // headers: fifteen tags meant fifteen sections and no way to tidy up.
  await client.evaluate(`(() => { document.querySelector('[data-nav="sites"]')?.click(); return true; })()`);
  await waitFor(client, `document.querySelectorAll('.sites .group-head').length >= 2`);

  const sitesFold = await client.evaluate(`(async () => {
    const heads = () => [...document.querySelectorAll('.sites .group-head')];
    const cards = () => document.querySelectorAll('.sites .env-card').length;
    const before = { heads: heads().length, cards: cards() };
    // Collapse the first group through its header row, not the tiny arrow.
    heads()[0]?.click();
    await new Promise((r) => setTimeout(r, 250));
    const folded = {
      cards: cards(),
      expanded: heads()[0]?.getAttribute('aria-expanded'),
      nameStillShown: Boolean(heads()[0]?.querySelector('.group-name')?.textContent.trim()),
      secondStillOpen: heads()[1]?.getAttribute('aria-expanded'),
    };
    // The whole header stays: a folded section must still say what is folded.
    heads()[0]?.click();
    await new Promise((r) => setTimeout(r, 250));
    const reopened = { cards: cards(), expanded: heads()[0]?.getAttribute('aria-expanded') };

    // One switch for the page. It lives in the header row and changes its own
    // label, so its direction is checkable from the DOM.
    const all = () => document.querySelector('.sites [data-group-collapse-all]');
    const label = () => [...document.querySelectorAll('.sites .head-actions button')]
      .map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
    const beforeLabel = label();
    all()?.click();
    await new Promise((r) => setTimeout(r, 300));
    const collapsedAll = {
      cards: cards(),
      anyOpen: heads().some((h) => h.getAttribute('aria-expanded') === 'true'),
      labels: label(),
    };
    // Same button, now the other direction.
    all()?.click();
    await new Promise((r) => setTimeout(r, 300));
    const expandedAll = { cards: cards(), anyClosed: heads().some((h) => h.getAttribute('aria-expanded') === 'false') };
    return { before, folded, reopened, beforeLabel, collapsedAll, expandedAll };
  })()`);
  check(
    "a group header folds its cards and keeps saying what is folded",
    sitesFold?.before.heads >= 2 &&
      sitesFold?.before.cards > 0 &&
      sitesFold?.folded.cards < sitesFold?.before.cards &&
      sitesFold?.folded.expanded === "false" &&
      sitesFold?.folded.nameStillShown === true &&
      sitesFold?.folded.secondStillOpen === "true",
    sitesFold,
  );
  check(
    "clicking the header again reopens the group",
    sitesFold?.reopened.cards === sitesFold?.before.cards &&
      sitesFold?.reopened.expanded === "true",
    sitesFold,
  );
  check(
    "one switch folds every group, and it turns into the opposite action",
    sitesFold?.collapsedAll.cards === 0 &&
      sitesFold?.collapsedAll.anyOpen === false &&
      sitesFold?.collapsedAll.labels?.some((text) => text.includes("全部展开")) === true,
    sitesFold,
  );
  check(
    "the same switch expands every group again",
    sitesFold?.expandedAll.cards === sitesFold?.before.cards &&
      sitesFold?.expandedAll.anyClosed === false,
    sitesFold,
  );

  // --- Auto-submit: global default, per-site override, resolved value ------
  // The control is three-way because "follow the global setting" is not a
  // boolean. The resolved value has to be readable without opening the dropdown:
  // "follow global" is what most sites will be left on, so answering "will this
  // site submit?" only while the list is open answers it when it no longer matters.
  const submitMode = await client.evaluate(`(async () => {
    const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find(
      (el) => el.querySelector('.field .select'),
    );
    const effective = () => dialog()?.querySelector('[data-submit-effective]')?.textContent.trim() ?? "";
    const trigger = () => dialog()?.querySelector('.select-trigger .select-value')?.textContent.trim() ?? "";
    const openForm = async () => {
      document.querySelector('.sites .head-actions .btn.primary')?.click();
      await new Promise((r) => setTimeout(r, 500));
      return dialog();
    };
    const closeForm = async () => {
      dialog()?.querySelector('.close')?.click();
      await new Promise((r) => setTimeout(r, 300));
    };

    const before = await window.ensemble.getWorkspace();
    document.querySelector('[data-nav="sites"]')?.click();
    await new Promise((r) => setTimeout(r, 400));

    await openForm();
    const onDefault = { trigger: trigger(), effective: effective() };
    await closeForm();

    // Flip the global answer and reopen: the same "follow global" state must now
    // report the other outcome, without the site storing anything.
    await window.ensemble.saveSettings({ autoSubmitLogin: false });
    await new Promise((r) => setTimeout(r, 400));
    await openForm();
    const offDefault = { trigger: trigger(), effective: effective() };

    // Picking an explicit answer hides the resolved line — the choice is right
    // there in the trigger, and two statements of the same thing would drift.
    dialog()?.querySelector('.select-trigger')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const always = [...document.querySelectorAll('.select-panel .option')].find(
      (el) => el.textContent.trim() === '总是自动提交',
    );
    always?.click();
    await new Promise((r) => setTimeout(r, 300));
    const overridden = { trigger: trigger(), effective: effective() };
    await closeForm();

    await window.ensemble.saveSettings({ autoSubmitLogin: before.settings.autoSubmitLogin });
    await new Promise((r) => setTimeout(r, 400));
    // Closing the form cancels: test site fixtures already carry a stored
    // autoSubmit, so counting how many sites have one says nothing. The
    // question here is whether cancelling created a site, and it must not.
    return {
      globalWas: before.settings.autoSubmitLogin,
      onDefault,
      offDefault,
      overridden,
      siteCount: { was: before.sites.length, now: (await window.ensemble.getWorkspace()).sites.length },
    };
  })()`);
  check(
    "the resolved auto-submit answer is visible while following the global setting",
    submitMode?.globalWas === true &&
      submitMode?.onDefault?.trigger === "跟随全局设置" &&
      submitMode?.onDefault?.effective.includes("总是") &&
      submitMode?.offDefault?.trigger === "跟随全局设置" &&
      submitMode?.offDefault?.effective.includes("从不") &&
      submitMode?.overridden?.trigger === "总是自动提交" &&
      submitMode?.overridden?.effective === "" &&
      submitMode?.siteCount?.was === submitMode?.siteCount?.now,
    submitMode,
  );

  // --- Accounts: folding, and turning a selection into a saved view ---------
  await client.evaluate(`(() => { document.querySelector('[data-nav="identities"]')?.click(); return true; })()`);
  await waitFor(client, `document.querySelectorAll('.identities .group-head').length >= 2`);

  const accountsFold = await client.evaluate(`(async () => {
    const heads = () => [...document.querySelectorAll('.identities .group-head')];
    const cards = () => document.querySelectorAll('.identities .id-card').length;
    const before = cards();
    heads()[0]?.click();
    await new Promise((r) => setTimeout(r, 250));
    const folded = cards();
    heads()[0]?.click();
    await new Promise((r) => setTimeout(r, 250));

    // Selection → view. The dialog is the existing new-view form, seeded with
    // exactly the picked accounts; anything else would be a second, drifting
    // way to define a view.
    document.querySelector('.identities [data-batch-select]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const entering = {
      buttonFound: Boolean(document.querySelector('.identities [data-batch-select]')),
      selectBar: Boolean(document.querySelector('.identities .select-bar')),
    };
    const picks = [...document.querySelectorAll('.identities .id-card')].slice(0, 2);
    picks[0]?.click();
    picks[1]?.click();
    await new Promise((r) => setTimeout(r, 300));
    // Re-read after the re-render: the clicked nodes are replaced, so counting
    // the "picked" class on the old references always said zero.
    const selectedCount = document.querySelectorAll('.identities .id-card.picked').length;
    document.querySelector('.identities [data-batch-create-view]')?.click();
    await new Promise((r) => setTimeout(r, 600));
    // The view form specifically: a login-capture prompt from earlier in this
    // suite is also role="dialog", and matching that one made this check read an
    // empty member list.
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((el) =>
      el.querySelector(".member-group, .members"),
    );
    const chosen = [...(dialog?.querySelectorAll('.member.on') ?? [])].map((el) =>
      el.querySelector('.m-name')?.textContent.trim(),
    );
    const dialogInfo = {
      title: dialog?.querySelector("h2, .title")?.textContent?.trim() ?? "",
      members: dialog?.querySelectorAll(".member").length ?? 0,
      onMembers: dialog?.querySelectorAll(".member.on").length ?? 0,
      anyDialog: dialog?.className ?? "",
    };
    dialog?.querySelector('.close')?.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      before,
      folded,
      reopened: cards(),
      entering,
      selectedCount,
      dialogOpen: Boolean(dialog),
      dialogInfo,
      chosen,
      stillSelecting: Boolean(document.querySelector('.identities .select-bar')),
    };
  })()`);
  check(
    "an account group folds and reopens",
    accountsFold?.folded > 0 &&
      accountsFold?.folded < accountsFold?.before &&
      accountsFold?.reopened === accountsFold?.before,
    accountsFold,
  );
  check(
    "picking accounts and choosing 创建视图 opens the view form with them chosen",
    accountsFold?.selectedCount === 2 &&
      accountsFold?.dialogOpen === true &&
      accountsFold?.chosen?.length === 2 &&
      accountsFold?.stillSelecting === false,
    accountsFold,
  );

  // --- Views reorder by dragging -------------------------------------------
  // Real HTML5 drags, not direct calls to the move API: the drop handler is what
  // is on trial here. A list that looks reorderable but never persists the order
  // (or that moves a filtered row to the wrong place) is the failure mode.
  //
  // Shared in page context so both checks below drag the same way.
  const dragRow = `async (fromIndex, toIndex) => {
    const rows = () => [...document.querySelectorAll('.views .view-row')];
    const source = rows()[fromIndex];
    const target = rows()[toIndex];
    const transfer = new DataTransfer();
    const fire = (el, type) =>
      el?.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    fire(source, 'dragstart');
    fire(target, 'dragover');
    fire(target, 'drop');
    fire(source, 'dragend');
    await new Promise((r) => setTimeout(r, 900));
    return {
      names: rows().map((el) => el.querySelector('.view-name')?.textContent.trim()),
      draggable: source?.getAttribute('draggable'),
    };
  }`;
  const viewOrder = await client.evaluate(`(async () => {
    const snap = await window.ensemble.getWorkspace();
    const identity = snap.identities[0];
    if (!identity) return { error: "no identity to build a view with" };
    const names = ["排序甲", "排序乙", "排序丙"];
    for (const view of snap.views) {
      if (names.includes(view.name)) await window.ensemble.deleteView(view.id);
    }
    for (const name of names) {
      await window.ensemble.saveView({
        siteId: identity.siteId,
        name,
        identityIds: [identity.id],
        layoutId: "1x1",
        slotAssignments: {},
        paths: {},
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-nav="views"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    if (!document.querySelector('.views')) return { error: "views page did not open" };

    const before = [...document.querySelectorAll('.views .view-row')].map((el) =>
      el.querySelector('.view-name')?.textContent.trim(),
    );
    // Drag the first of the three onto the last: the expected result is that it
    // ends up after the row it was dropped on.
    const dragRow = ${dragRow};
    const moved = await dragRow(0, 2);
    // What the workspace stores is the real answer: the DOM would look right
    // even if the move never reached disk.
    const stored = (await window.ensemble.getWorkspace()).views.map((view) => view.name);
    for (const view of (await window.ensemble.getWorkspace()).views) {
      if (names.includes(view.name)) await window.ensemble.deleteView(view.id);
    }
    await new Promise((r) => setTimeout(r, 400));
    return { before, after: moved.names, stored, draggable: moved.draggable };
  })()`);
  check(
    "a view row can be dragged and the new order is what gets stored",
    viewOrder?.draggable === "true" &&
      viewOrder?.before?.slice(-3).join(",") === "排序甲,排序乙,排序丙" &&
      viewOrder?.after?.slice(-3).join(",") === "排序乙,排序丙,排序甲" &&
      viewOrder?.stored?.slice(-3).join(",") === "排序乙,排序丙,排序甲",
    viewOrder,
  );

  // The list is filtered by site/tag, so the drop index a row reports is an
  // index into the *visible* subset. Moving by that number puts the view at the
  // wrong place in storage — visible only after the filter is cleared. Dragging
  // under an active tag filter is the cheapest way to prove the id lookup.
  const filteredOrder = await client.evaluate(`(async () => {
    const snap = await window.ensemble.getWorkspace();
    const identity = snap.identities[0];
    if (!identity) return { error: "no identity to build a view with" };
    const names = ["筛选甲", "筛选乙", "筛选丙"];
    const tagName = "排序筛选";
    for (const view of snap.views) {
      if (names.includes(view.name)) await window.ensemble.deleteView(view.id);
    }
    for (const tag of snap.tags) {
      if (tag.name === tagName) await window.ensemble.deleteTag(tag.id);
    }
    const tagged = await window.ensemble.saveTag({ name: tagName, color: "amber" });
    const tag = tagged.tags.find((item) => item.name === tagName);
    // 甲 and 丙 carry the tag, 乙 does not: with the filter on, the visible list
    // skips 乙 at the same time as its stored index still counts it.
    for (const [index, name] of names.entries()) {
      await window.ensemble.saveView({
        siteId: identity.siteId,
        name,
        identityIds: [identity.id],
        layoutId: "1x1",
        slotAssignments: {},
        paths: {},
        ...(index === 1 ? {} : { tagIds: [tag.id] }),
      });
    }
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-nav="views"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const chip = [...document.querySelectorAll('.views .filters .filter-chip')].find(
      (el) => el.textContent.trim() === tagName,
    );
    chip?.click();
    await new Promise((r) => setTimeout(r, 500));

    const dragRow = ${dragRow};
    const moved = await dragRow(0, 1);
    const stored = (await window.ensemble.getWorkspace()).views.map((view) => view.name);
    for (const view of (await window.ensemble.getWorkspace()).views) {
      if (names.includes(view.name)) await window.ensemble.deleteView(view.id);
    }
    for (const item of (await window.ensemble.getWorkspace()).tags) {
      if (item.name === tagName) await window.ensemble.deleteTag(item.id);
    }
    await new Promise((r) => setTimeout(r, 400));
    return { filtered: moved.names, stored };
  })()`);
  check(
    "dragging under a filter lands the view where the row showed it",
    filteredOrder?.filtered?.join(",") === "筛选丙,筛选甲" &&
      filteredOrder?.stored?.slice(-3).join(",") === "筛选乙,筛选丙,筛选甲",
    filteredOrder,
  );

  // --- Flows: the same folding, over rows rather than cards ----------------
  const flowsFold = await client.evaluate(`(async () => {
    const sites = (await window.ensemble.getWorkspace()).sites;
    for (const [index, site] of sites.entries()) {
      await window.ensemble.saveFlow({
        siteId: site.id,
        name: "分组折叠检查 " + (index + 1),
        description: "",
        params: [],
        steps: [{ action: "navigate", url: site.baseUrl }],
      });
    }
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('[data-nav="flows"]')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const heads = () => [...document.querySelectorAll('.flows .group-head')];
    const rows = () => document.querySelectorAll('.flows .flow-row').length;
    const before = { heads: heads().length, rows: rows() };
    heads()[0]?.click();
    await new Promise((r) => setTimeout(r, 250));
    const folded = { rows: rows(), expanded: heads()[0]?.getAttribute('aria-expanded') };
    heads()[0]?.click();
    await new Promise((r) => setTimeout(r, 250));
    // Count the reopened rows *before* cleaning up: deleting the probes first
    // made the count 0 and the assertion could never pass.
    const reopened = rows();
    // Remove the two probes: the flows page is a workspace asset, and leaving
    // test flows behind would show up in the user's own workspace.
    for (const flow of (await window.ensemble.getWorkspace()).flows) {
      if (flow.name.startsWith("分组折叠检查")) await window.ensemble.deleteFlow(flow.id);
    }
    await new Promise((r) => setTimeout(r, 400));
    return { before, folded, reopened, remaining: rows() };
  })()`);
  check(
    "a flow group folds its rows and reopens",
    flowsFold?.before.heads >= 2 &&
      flowsFold?.before.rows >= 2 &&
      flowsFold?.folded.rows < flowsFold?.before.rows &&
      flowsFold?.folded.expanded === "false" &&
      flowsFold?.reopened === flowsFold?.before.rows &&
      flowsFold?.remaining === 0,
    flowsFold,
  );

  // --- AI entry in the status bar ------------------------------------------
  // The endpoint is off in this profile's settings, so the entry must still be
  // there and must say so; the point of it is to be findable on any screen.
  const mcpEntry = await client.evaluate(`(() => {
    const button = document.querySelector('.status-mcp');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {
      text: button.textContent.replace(/\\s+/g, ' ').trim(),
      hasIcon: Boolean(button.querySelector('svg')),
      hasLed: Boolean(button.querySelector('.mcp-led')),
      height: Math.round(rect.height),
      inFooter: button.closest('.statusbar') !== null,
    };
  })()`);
  check(
    "the status bar carries an AI entry with an icon and a status light",
    Boolean(mcpEntry?.inFooter && mcpEntry?.hasIcon && mcpEntry?.hasLed),
    mcpEntry,
  );
  // The status light already says "off"; spelling it out spent footer width on
  // information the dot carries.
  check(
    "the AI entry shows no text while the endpoint is off",
    mcpEntry?.text === "",
    { text: mcpEntry?.text },
  );
  // The footer is one 30px row; an entry that overflows it would clip the version.
  check(
    "the AI entry fits the status bar height",
    Boolean(mcpEntry) && mcpEntry.height > 0 && mcpEntry.height <= 30,
    { height: mcpEntry?.height },
  );

  const trimmed = await client.evaluate(`(() => {
    const bar = document.querySelector('.statusbar');
    return {
      // The engine version list and the "single user" marker used to sit here.
      hasEngines: Boolean(bar?.querySelector('.status-engines')),
      text: bar?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    };
  })()`);
  check("the status bar dropped the engine list", trimmed?.hasEngines === false, trimmed);

  await client.evaluate(`(() => { document.querySelector('.status-mcp')?.click(); return true; })()`);
  const landedOnMcp = await waitFor(
    client,
    `Boolean(document.querySelector('.mcp-endpoint'))`,
  );
  const settingsState = await client.evaluate(`(() => ({
    selected: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((el) =>
      el.textContent.replace(/\\s+/g, ' ').trim(),
    ),
    hasEndpointBlock: Boolean(document.querySelector('.mcp-endpoint')),
  }))()`);
  check(
    "clicking the AI entry opens the AI access tab with the endpoint block",
    landedOnMcp && settingsState?.hasEndpointBlock === true,
    settingsState,
  );

  // Settings stays mounted, so a manual tab change must not stick to the page.
  await client.evaluate(
    `(() => { document.querySelector('[role="tab"]:nth-child(1)')?.click(); return true; })()`,
  );
  await wait(400);
  await client.evaluate(`(() => { document.querySelector('.status-mcp')?.click(); return true; })()`);
  const returned = await waitFor(client, `Boolean(document.querySelector('.mcp-endpoint'))`);
  check("the AI entry retargets the tab after a manual change", returned === true, {
    returned,
  });

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
