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
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";
import { openNav } from "./lib/e2e-nav.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
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
const siteGroups = Array.from({ length: 24 }, (_, index) => ({
  id: uuid(20 + index),
  name: `分组${index + 1}`,
  color: colors[index % colors.length],
}));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    siteGroups,
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
        tagIds: [siteGroups[0].id],
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
        tagIds: [siteGroups[1].id],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
      // Filler sites, one per remaining group.
      //
      // The filter strip only shows groups that actually hold a site, so the
      // overflow checks below need enough *populated* groups to overflow — 22
      // empty groups would render nothing and "scrolls sideways" would pass on
      // a strip with three chips in it. These carry no accounts: the assertions
      // they feed are about the strip's layout, not about the accounts page.
      ...siteGroups.slice(2).map((group, index) => ({
        id: `filler-site-${index}`,
        name: `填充站点${index + 1}`,
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [group.id],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      })),
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
        tagIds: siteGroups.map((group) => group.id),
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
        tagIds: [siteGroups[0].id],
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
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
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

/** Polls a boolean expression so a slow first paint cannot fail a check. */
async function waitFor(client, expression, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

/**
 * Open one of the app's pages.
 *
 * The shared navigation in `scripts/lib/e2e-nav.mjs` owns the selectors: a rail
 * entry for 站点 / 账号 / 更多, the app menu for settings, and the second click
 * each of those needs (a `[data-more-tab]` section, a `[data-ai-tab]` tab, a
 * `[data-section]` in settings).
 */
async function openConsolePage(client, view) {
  await client.evaluate(openNav(view));
  const marker =
    view === "settings" || view.startsWith("settings-")
      ? `Boolean(document.querySelector('.page.settings'))`
      : `Boolean(document.querySelector('[data-floating-pane]'))`;
  const opened = await waitFor(client, marker, 5000);
  // The accounts pane opens on its launch face, and every suite here is about the
  // editing face (columns, row actions, group folding, drag). Switch once, here,
  // rather than teaching fifteen assertions about two faces.
  if (opened && (view === "identities" || view === "sites")) {
    await client.evaluate(`(async () => {
      document.querySelector('[data-mode-edit]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      return true;
    })()`);
  }
  return opened;
}

/** Back to the browser surface: the pane closes, the browser stays mounted. */
async function backToBrowser(client) {
  await client.evaluate(`(async () => {
    document.querySelector('[data-floating-pane] .pane-head button')?.click();
    await new Promise((r) => setTimeout(r, 450));
    // Settings is the one page that still replaces the browser.
    document.querySelector('.page.settings .settings-head .back')?.click();
    await new Promise((r) => setTimeout(r, 450));
    return true;
  })()`);
  await waitFor(
    client,
    `Boolean(document.querySelector('[data-account-rail]')) &&
      !document.querySelector('[data-floating-pane]') &&
      !document.querySelector('.page.settings')`,
    5000,
  );
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
  /*
   * Wait for the surface rather than sleeping a fixed 3s and hoping.
   *
   * A cold start renders the shell, the blank page's new-tab surface and (on a
   * fresh profile) the guide. Measured: they land together anywhere between 1.3
   * and 1.8 seconds on this machine, so a hard 3-second sample had ~1.2s of slack
   * and failed intermittently on a slower run. A poll removes the guess: it
   * returns as soon as the surface exists and still reports a miss after the
   * deadline, which is the failure this check is actually about.
   */
  await waitFor(
    client,
    `Boolean(document.querySelector('.stage .blank-slot .new-tab'))`,
    8000,
  );
  // One settle frame after the surface exists: the blank page draws its search
  // box and bookmark bar in a follow-up render, and the rest of the suite reads
  // the shell from this state.
  await wait(400);

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
      empty: Boolean(document.querySelector('.stage .stage-empty')),
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
    const empty = document.querySelector('.stage .stage-empty');
    const panel = {
      present: Boolean(empty),
      buttons: empty?.querySelectorAll('button').length ?? 0,
      text: empty?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      siteChips: document.querySelectorAll('.stage .stage-empty .site-chip, .stage .stage-empty .chip').length,
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
  await openConsolePage(client, "identities");
  await waitFor(client, `Boolean(document.querySelector('.group-filters'))`);

  const strip = await client.evaluate(`(() => {
    const filters = document.querySelector('.group-filters');
    const scroll = document.querySelector('.chip-scroll');
    const chips = [...document.querySelectorAll('.group-chip')];
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
  check("the group strip renders every group", strip?.chips === siteGroups.length + 1, strip);
  check("the chips stay on one row however many groups exist", strip?.rows === 1, strip);
  check("the strip is a fixed-height row", strip?.stripHeight !== null && strip.stripHeight <= 40, strip);
  check(
    "the excess chips scroll sideways instead of wrapping",
    strip?.scrollable === true && strip?.overflowX === "auto",
    strip,
  );

  const filtered = await client.evaluate(`(async () => {
    const before = document.querySelectorAll('.id-card').length;
    const chip = [...document.querySelectorAll('.group-chip')].find((el) => el.textContent.trim() === '分组1');
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

  // --- Identity cards are dense, stable, and not clipped --------------------
  // Three contracts. Historic: as an auto-sized grid inside a scrolling column,
  // rows used to be squeezed to the leftover height and the card's own
  // `overflow: hidden` cut off its action row — content must still fit. New: the
  // card is exactly three rows (identity, facts, actions), and the action row is
  // ALWAYS visible — folding it until hover made the card change height as the
  // pointer crossed the grid, reflowing every card below it.
  const cards = await client.evaluate(`(() =>
    [...document.querySelectorAll('.id-card')].map((card) => {
      const actions = card.querySelector('.card-actions');
      const cardRect = card.getBoundingClientRect();
      const actionRect = actions?.getBoundingClientRect();
      return {
        clientHeight: card.clientHeight,
        scrollHeight: card.scrollHeight,
        height: Math.round(cardRect.height),
        actionsInside:
          Boolean(actionRect) && actionRect.bottom <= cardRect.bottom + 1 && actionRect.top >= cardRect.top,
        actionsVisible: Boolean(actionRect) && actionRect.height > 0,
        hasPasswordRow: Boolean(card.querySelector('.pw-row')),
      };
    })
  )()`);
  check(
    "identity cards fit their content without clipping",
    Array.isArray(cards) &&
      cards.length > 0 &&
      cards.every((card) => card.scrollHeight <= card.clientHeight + 1 && card.actionsInside),
    cards,
  );
  check(
    "identity card actions are always visible, so hovering never reflows the grid",
    Array.isArray(cards) && cards.length > 0 && cards.every((card) => card.actionsVisible),
    cards,
  );
  check(
    "identity cards dropped the password-dots row",
    Array.isArray(cards) && cards.length > 0 && cards.every((card) => !card.hasPasswordRow),
    cards,
  );
  check(
    "identity cards stay under 110px so a screen holds many accounts",
    Array.isArray(cards) && cards.length > 0 && cards.every((card) => card.height <= 110),
    cards.map((card) => card.height),
  );

  await client.evaluate(`(() => {
    const chip = [...document.querySelectorAll('.group-chip')].find((el) => el.textContent.trim() === '全部');
    chip?.click();
    return true;
  })()`);
  await wait(300);

  // --- Site groups are a settings section now --------------------------------
  //
  // They used to be "tags" and lived behind the account rail's [管理] menu. What
  // changed is the concept: it narrowed to "which section a site is filed
  // under", so it belongs with the other configuration.
  await openConsolePage(client, "groups");
  await waitFor(client, `Boolean(document.querySelector('.site-groups'))`);
  const groupsPage = await client.evaluate(`(() => {
    const page = document.querySelector('.site-groups');
    return {
      present: Boolean(page),
      heading: page?.querySelector('h1')?.textContent.trim() ?? '',
      rows: page?.querySelectorAll('.list > .row, .rows > .row, .row').length ?? 0,
      inSettings: Boolean(page?.closest('.page.settings, .settings')),
    };
  })()`);
  check(
    "site groups are a settings section",
    groupsPage?.present === true && groupsPage?.inSettings === true,
    groupsPage,
  );
  check(
    "the site groups page lists every group",
    groupsPage?.rows >= siteGroups.length,
    { rows: groupsPage?.rows, expectedAtLeast: siteGroups.length },
  );

  // Creating happens in a dialog, and the dialog has a way out that is not
  // "save" — the two failures the inline form used to have: it pushed the list
  // down, and it had no single place to close from.
  const groupDialog = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const opener = document.querySelector('[data-group-new], [data-group-create]');
    opener?.click();
    await new Promise((r) => setTimeout(r, 400));
    const input = document.querySelector('[data-group-name]');
    const inDialog = Boolean(input?.closest('[role="dialog"]'));
    if (input) {
      input.value = '弹窗分组';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('[data-group-color="rose"]')?.click();
    document.querySelector('[data-group-save]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const after = await api.getWorkspace();
    const saved = after.siteGroups.find((g) => g.name === '弹窗分组');
    return {
      opened: Boolean(input),
      inDialog,
      closed: document.querySelector('[data-group-name]') === null,
      color: saved?.color ?? null,
    };
  })()`);
  check(
    "creating a site group happens in a dialog and saves the picked colour",
    groupDialog?.opened === true &&
      groupDialog?.inDialog === true &&
      groupDialog?.closed === true &&
      groupDialog?.color === "rose",
    groupDialog,
  );

  await openConsolePage(client, "settings");
  await waitFor(client, `Boolean(document.querySelector('.page.settings'))`);
  const settingsTabs = await client.evaluate(`(() =>
    [...document.querySelectorAll('.page.settings [role="tab"]')].map((el) =>
      el.textContent.replace(/\s+/g, ' ').trim(),
    )
  )()`);
  check(
    "Settings carries the site groups section",
    settingsTabs.some((label) => /分组|Groups/.test(label)),
    settingsTabs,
  );
  check(
    "Settings carries no sites or AI activity tab",
    !settingsTabs.some((label) => /^(站点|Sites)$|AI 记录|AI activity/i.test(label)),
    settingsTabs,
  );
  await openConsolePage(client, "identities");
  await wait(400);

  // --- Dropdown inside a dialog --------------------------------------------
  await client.evaluate(
    `(() => { document.querySelector('[data-edit-identity]')?.click(); return true; })()`,
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
  await backToBrowser(client);
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
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    loginTarget = list.find((item) => item.url.startsWith(PAGE_URL));
    if (loginTarget) break;
    await wait(250);
  }
  check("the login page is a CDP target", Boolean(loginTarget), loginTarget?.url);
  if (loginTarget) {
    const pageClient = await connectToWindow(loginTarget.webSocketDebuggerUrl);
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
  // The shell is a flex column now, not a fixed-rows grid, and the status bar is
  // gone — so "did it add a row" is no longer answerable that way. What the check
  // is actually about is that the prompt is an overlay and does not take part in
  // layout: fixed positioning plus the same measured height is that guarantee.
  check(
    "the prompt does not take part in the shell's layout",
    prompt?.position === "fixed" && prompt?.bodyHeight === shellBefore?.bodyHeight,
    { before: shellBefore, after: prompt },
  );
  check("the prompt floats above the page", prompt?.bottomGap !== null && prompt.bottomGap >= 20, prompt);

  // --- Toolbar "+" sizing -----------------------------------------------
  //
  // The run dock and its resize handle went out with the multi-cell workbench
  // (ADR 0012), and so did the layout glyph that used to turn them on. What is
  // still worth measuring in this row is the control heights agreeing and the
  // zoom stepper staying out of it.

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
    // The address field is two boxes now: the shell draws the border, the input
    // is the text area inside it. The shell is the control, so it is what has to
    // match the row — measuring the input made it one border short of every
    // icon, which is a true measurement of the wrong element.
    const input = document.querySelector('.toolbar .address input');
    const field = document.querySelector('.toolbar .address-shell');
    const stepper = document.querySelector('.toolbar .zoom-stepper');
    const rect = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
    return {
      split: rect(split),
      icon: rect(icons[0]),
      input: rect(field),
      inputText: rect(input),
      splitMain: rect(split?.querySelector('.split-main')),
      stepper: rect(stepper),
      // Every control in the row must agree on one height; two heights is what
      // made the toolbar look assembled from different toolbars.
      controlLg: Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-lg'))),
      heights: [...new Set([
        ...[...document.querySelectorAll('.toolbar .icon')].map(rect),
        rect(field),
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
    sizing?.heights?.length === 1 && sizing.heights[0] === sizing.controlLg,
    sizing,
  );
  // The zoom stepper used to live in this row and took a tenth of it. It now
  // sits in the app menu and the viewport menu; what this checks is that the
  // toolbar is actually free of it (a second copy would push the row over at
  // 960px) and that a gesture still reports its result.
  check(
    "the toolbar no longer carries a zoom stepper",
    sizing?.stepper === null,
    { stepper: sizing?.stepper },
  );

  // --- The account chooser: toggling, switching, and the cover handshake ----
  // Three things broke here once, all invisible without driving the panel: the
  // trigger could not close it, clicking a site in the left column closed it
  // instead of switching, and it painted before the native page was parked, so
  // its left half was covered for about 100ms.
  const menuOpen = await client.evaluate(`(async () => {
    const trigger = document.querySelector('.toolbar .split-arrow');
    // Retried: the click is dispatched while the toolbar may still be settling
    // after the resize above, and a click that lands on a re-rendering button is
    // swallowed. Retrying the open is not weakening the check — the assertions
    // below still fail on a panel that paints before the stage is parked.
    for (let attempt = 0; attempt < 3 && !document.querySelector('.open-panel'); attempt += 1) {
      trigger?.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    const panel = document.querySelector('.open-panel');
    const rows = [...document.querySelectorAll('.site-row')];
    const panelBox = panel?.getBoundingClientRect();
    return {
      open: Boolean(panel),
      rows: rows.length,
      // A lone tag name under the account list read as an empty section.
      tagNote: Boolean(document.querySelector('.tag-note')),
      active: rows.filter((el) => el.classList.contains('active')).length,
      // The live page must be out of the way before the panel shows. With a
      // native view the frozen frame is what proves it; a guest stacks, so the
      // proof is that the panel is the element drawn at its own centre.
      frozen: document.querySelectorAll('.stage .frozen').length,
      onTop: panelBox
        ? document
            .elementsFromPoint(
              Math.round(panelBox.left + panelBox.width / 2),
              Math.round(panelBox.top + panelBox.height / 2),
            )
            .some((el) => el.closest('.open-panel'))
        : false,
      carrier: (await window.ensemble.getEmbeddedState()).carrier ?? "native",
    };
  })()`);
  check(
    "the new-tab button opens the account chooser in front of the live page",
    menuOpen?.open === true &&
      (menuOpen?.carrier === "guest" ? menuOpen?.onTop === true : menuOpen?.frozen > 0),
    menuOpen,
  );
  check(
    "the chooser marks exactly one active site",
    menuOpen?.active === 1,
    { active: menuOpen?.active, rows: menuOpen?.rows },
  );
  check("the chooser shows no dangling tag row", menuOpen?.tagNote === false, menuOpen);

  const menuShape = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.account-row')];
    const anonymous = rows.filter((el) => el.classList.contains('anonymous'));
    const accounts = rows.filter((el) => !el.classList.contains('anonymous'));
    const firstAccountIndex = rows.findIndex((el) => !el.classList.contains('anonymous'));
    // The chooser asks one question — whose page this is. Profiles are not a
    // mode here any more: the account list answers "which login", the site's
    // two openings answer "no login in particular", and that is the whole menu.
    const modes = [...document.querySelectorAll('.open-menu .mode')];
    return {
      accounts: accounts.length,
      anonymous: anonymous.length,
      names: anonymous.map((el) => el.querySelector('.acc-name')?.textContent?.trim() ?? ''),
      modes: modes.length,
      profilesHidden: document.querySelectorAll('.open-menu .profile-row').length,
      // The site's own openings are fixed above the scrolling account list: a
      // site with thirty accounts must not push "open daily" past the fold.
      anonymousBeforeAccounts:
        rows.map((el) => anonymous.includes(el)).lastIndexOf(true) < firstAccountIndex,
    };
  })()`);
  check(
    "the chooser lists the site's two openings and its accounts",
    menuShape?.accounts > 0 && menuShape?.anonymous === 2,
    menuShape,
  );
  check(
    "the chooser has no profile mode and no profile rows",
    menuShape?.modes === 0 && menuShape?.profilesHidden === 0,
    menuShape,
  );
  check(
    "the site's fixed openings come before its account list",
    menuShape?.anonymousBeforeAccounts === true,
    menuShape,
  );

  const menuClosed = await client.evaluate(`(async () => {
    document.querySelector('.toolbar .split-arrow')?.click();
    await new Promise((r) => setTimeout(r, 700));
    return Boolean(document.querySelector('.open-panel'));
  })()`);
  check("a second click on the trigger closes the chooser", menuClosed === false, {
    menuClosed,
  });

  const menuSwitch = await client.evaluate(`(async () => {
    document.querySelector('.toolbar .split-arrow')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const rows = [...document.querySelectorAll('.site-row')];
    rows[1]?.click();
    await new Promise((r) => setTimeout(r, 500));
    const active = document.querySelector('.site-row.active .site-name');
    const accounts = [...document.querySelectorAll('.account-row:not(.anonymous) .acc-name')].map(
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

  /*
   * The downloads panel is the same kind of overlay as the site menu: an HTML box
   * anchored under the toolbar, hanging over the stage. It shipped without being
   * registered as an overlay, so the native page painted straight over it — the
   * trigger lit up and nothing appeared. The frozen frame is the observable proof
   * that the page was parked before the panel is drawn.
   */
  const downloadsPanel = await client.evaluate(`(async () => {
    const before = document.querySelectorAll('.stage .frozen').length;
    const carrier = (await window.ensemble.getEmbeddedState()).carrier ?? "native";
    const trigger = document.querySelector('.downloads-anchor .icon');
    trigger?.click();
    await new Promise((r) => setTimeout(r, 900));
    const panel = document.querySelector('.downloads-panel');
    const box = panel?.getBoundingClientRect();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    // The panel has to win the stacking contest against a live page. A native
    // view always paints above HTML, so back then it had to be frozen out of
    // the way; a guest is a normal element, so the check asks what the user
    // actually needs: is the panel in front at a point it shares with the
    // stage?
    const covered = box && stage
      ? (() => {
          const x = Math.round(box.left + box.width / 2);
          const y = Math.round(box.top + box.height / 2);
          if (x < stage.left || x > stage.right || y < stage.top || y > stage.bottom) {
            return null;
          }
          return document.elementsFromPoint(x, y).some((el) => el.closest('.downloads-panel'));
        })()
      : null;
    return {
      opened: Boolean(panel),
      frozenBefore: before,
      frozenAfter: document.querySelectorAll('.stage .frozen').length,
      // The panel hangs over the stage, which is what makes parking mandatory.
      overlapsStage: Boolean(box && stage && box.bottom > stage.top),
      // A panel that is open but has no box was laid out behind the page.
      width: box ? Math.round(box.width) : null,
      onTop: covered,
      carrier,
    };
  })()`);
  check(
    "the downloads panel is in front of the live page",
    downloadsPanel?.opened === true &&
      (downloadsPanel?.carrier === "guest"
        ? downloadsPanel?.onTop === true
        : downloadsPanel?.frozenAfter > 0),
    downloadsPanel,
  );
  check(
    "the downloads panel is drawn over the stage, not under it",
    downloadsPanel?.overlapsStage === true && (downloadsPanel?.width ?? 0) > 100,
    downloadsPanel,
  );

  const downloadsClosed = await client.evaluate(`(async () => {
    document.querySelector('.downloads-anchor .icon')?.click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      open: Boolean(document.querySelector('.downloads-panel')),
      frozen: document.querySelectorAll('.stage .frozen').length,
      staged: (await window.ensemble.getEmbeddedState()).tabs.some(
        (tab) => tab.bounds && tab.bounds.width > 0 && tab.bounds.height > 0,
      ),
    };
  })()`);
  check(
    "closing the downloads panel gives the stage back",
    downloadsClosed?.open === false &&
      downloadsClosed?.frozen === 0 &&
      downloadsClosed?.staged === true,
    downloadsClosed,
  );

  // --- The workbench column is retired; the account rail is the navigation --
  /*
   * The dock's resize handle, collapse animation and collapsed strip all
   * belonged to the navigation column, which the single-stage shell (ADR 0012)
   * removed. The equivalents that remain are asserted here: no column comes
   * back, the stage fills the right column beside the account rail, and the
   * account rail is the one instance switcher.
   */
  const retired = await client.evaluate(`(async () => {
    await window.ensemble.getEmbeddedState();
    // A second instance makes the rail switch observable.
    await window.ensemble.openEmbeddedTab({ viewId: null });
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const chips = [...document.querySelectorAll('[data-instance-chip]')];
    const current = state.tabs.find((tab) => tab.id === state.activeTabId);
    const otherChip = chips.find(
      (el) => el.getAttribute('data-instance-chip') !== current?.instanceId,
    );
    const stage = document.querySelector('.stage');
    const rail = document.querySelector('[data-account-rail]');
    const stageBox = stage?.getBoundingClientRect();
    const railBox = rail?.getBoundingClientRect();
    return {
      sidebar: Boolean(document.querySelector('.sidebar')),
      dock: Boolean(document.querySelector('.dock')),
      handle: Boolean(document.querySelector('.sidebar-resize')),
      rail: Boolean(rail),
      chips: chips.length,
      instances: new Set(state.tabs.map((tab) => tab.instanceId)).size,
      stageLeft: stageBox ? Math.round(stageBox.left) : null,
      stageRight: stageBox ? Math.round(stageBox.right) : null,
      railRight: railBox ? Math.round(railBox.right) : null,
      windowWidth: window.innerWidth,
      clickedOther: otherChip?.getAttribute('data-instance-chip') ?? null,
    };
  })()`);
  if (retired?.clickedOther) {
    await client.evaluate(`(async () => {
      const chip = [...document.querySelectorAll('[data-instance-chip]')].find(
        (el) => el.getAttribute('data-instance-chip') === '${retired?.clickedOther ?? ""}',
      );
      chip?.click();
      await new Promise((r) => setTimeout(r, 600));
    })()`);
  }
  const switchCheck = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const landed = state.tabs.find((tab) => tab.id === state.activeTabId);
    return { landedInstance: landed?.instanceId ?? null };
  })()`);
  check(
    "the navigation column stays retired",
    retired?.sidebar === false && retired?.dock === false && retired?.handle === false,
    retired,
  );
  check(
    "the account rail is the one instance switcher",
    retired?.rail === true && retired?.chips === retired?.instances && retired?.chips >= 2,
    retired,
  );
  check(
    "the stage fills the right column, edge to edge on the window's right",
    retired?.stageLeft === retired?.railRight &&
      retired?.stageRight === retired?.windowWidth,
    retired,
  );
  check(
    "clicking another account switches the instance on stage",
    switchCheck?.landedInstance === retired?.clickedOther,
    { clickedOther: retired?.clickedOther, landed: switchCheck?.landedInstance },
  );

  // The rail entries lead with a square avatar and the account name, and the
  // on-stage one carries a fill the others do not. The avatar replaced a 3px
  // colour bar: at this width a bar was the only thing telling two accounts
  // apart before the name was read.
  const railLook = await client.evaluate(`(() => {
    const onStage = document.querySelector('[data-instance-chip][data-on-stage="1"]');
    const idle = document.querySelector('[data-instance-chip][data-on-stage="0"]');
    const stage = onStage ? getComputedStyle(onStage).backgroundColor : null;
    const other = idle ? getComputedStyle(idle).backgroundColor : null;
    const avatar = onStage?.querySelector('.avatar, .avatar-letter');
    const box = avatar ? avatar.getBoundingClientRect() : null;
    return {
      onStageFill: stage,
      idleFill: other,
      hasAvatar: Boolean(avatar),
      avatarSquare: box ? Math.abs(box.width - box.height) <= 1 : false,
      account: onStage?.querySelector('.chip-account')?.textContent?.trim() ?? "",
    };
  })()`);
  check(
    "the on-stage rail entry is marked by fill, and each entry leads with a square avatar",
    railLook?.onStageFill !== null &&
      railLook.onStageFill !== "rgba(0, 0, 0, 0)" &&
      railLook.onStageFill !== railLook?.idleFill &&
      railLook?.hasAvatar === true &&
      railLook?.avatarSquare === true &&
      (railLook?.account ?? "").length > 0,
    railLook,
  );


  await client.evaluate(`(() => {
    document.getElementById('__e2e-no-transition')?.remove();
    return true;
  })()`);

  // --- Flat mode: the default tab group has the same controls as a cell ----
  // The stage showed one page with no strip at all: an instance opened into the
  // default tab group could not reach its other pages, had no "+" and no page
  // menu. Same instance, same controls — only the number of cells differs.
  // A flat stage shows one instance and no cell band at all: the window-level
  // strip above the toolbar already lists that instance's pages, and drawing a
  // band here as well produced two identical tab rows one under the other.
  // What this asserts is the intent, not the carrier — the instance's pages are
  // reachable, switchable, and can grow.
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
    const tabs = () => [...document.querySelectorAll('.tabstrip .tab')];
    const before = {
      viewOnStage: state.activeViewId ?? null,
      heads: heads(),
      tabs: tabs().length,
      hasAdd: Boolean(document.querySelector('.tabstrip .strip-add')),
      current: tabs().findIndex((el) => el.classList.contains('active')),
    };
    // Switching pages from the strip must move the page, not the cell.
    const other = tabs().find((el) => !el.classList.contains('active'));
    other?.click();
    await new Promise((r) => setTimeout(r, 700));
    const switched = {
      activeTabId: (await window.ensemble.getEmbeddedState()).activeTabId,
      clickedId: other?.getAttribute('data-tab-id') ?? null,
      current: tabs().findIndex((el) => el.classList.contains('active')),
    };
    return { before, switched };
  })()`);
  check(
    "the flat stage lists its instance's pages in the window strip",
    flatStrip?.before.viewOnStage === null &&
      flatStrip?.before.heads === 0 &&
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
  // --- The window strip: the on-stage instance's pages ---------------------
  // The cell header's strip is retired with the grid (ADR 0012). What the
  // header strip offered — see this instance's pages, add one, close one,
  // switch between them — is what the second row does now, for the one
  // instance that is on stage.
  await client.evaluate(`(async () => {
    for (const tab of (await window.ensemble.getEmbeddedState()).tabs) {
      await window.ensemble.closeEmbeddedTab(tab.id);
    }
    const first = await window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(PAGE_URL)} });
    await new Promise((r) => setTimeout(r, 1400));
    return true;
  })()`);

  const single = await client.evaluate(`(() => {
    const tab = document.querySelector('.tabstrip .tab');
    const add = document.querySelector('.tabstrip .strip-add');
    const close = tab?.querySelector('.tab-close');
    return {
      headers: document.querySelectorAll('.stage .slot-header').length,
      strip: document.querySelectorAll('.tabstrip .tab').length,
      hasAdd: Boolean(add),
      hasClose: Boolean(close),
    };
  })()`);
  check(
    "a one-page instance shows its pages in the window strip, with add and close",
    single?.headers === 0 && single?.strip === 1 && single?.hasAdd === true && single?.hasClose === true,
    single,
  );

  // Open a popup from inside the page: it joins the same instance, so the strip
  // gains a second page without any second window or cell appearing.
  let popupTarget;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    popupTarget = list.find((item) => item.url.startsWith(PAGE_URL));
    if (popupTarget) break;
    await wait(250);
  }
  check("the embedded page is a CDP target", Boolean(popupTarget), popupTarget?.url);
  if (popupTarget) {
    const pageClient = await connectToWindow(popupTarget.webSocketDebuggerUrl);
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
        const tabs = [...document.querySelectorAll('.tabstrip .tab')];
        return {
          headers: document.querySelectorAll('.stage .slot-header').length,
          tabs: tabs.map((el) => el.textContent.trim()),
          current: tabs.findIndex((el) => el.classList.contains('active')),
        };
      })()`);
      if (last?.tabs?.length > 1) return last;
      await wait(250);
    }
    return last;
  })();
  check(
    "a second page joins the same instance's strip, with no second window",
    slotStrip?.headers === 0 && slotStrip?.tabs?.length === 2,
    slotStrip,
  );
  check("exactly one page tab is marked current", slotStrip?.current >= 0, slotStrip);

  // Click the tab that is not current: the page on stage changes.
  await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    const target = tabs.find((el) => !el.classList.contains('active'));
    target?.click();
    return Boolean(target);
  })()`);
  await wait(600);

  const afterSwitch = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const tabs = [...document.querySelectorAll('.tabstrip .tab')];
    return {
      active: state.activeTabId,
      current: tabs.findIndex((el) => el.classList.contains('active')),
      strip: tabs.length,
    };
  })()`);
  check(
    "clicking a strip tab moves the stage to that page",
    afterSwitch?.current >= 0 && afterSwitch?.strip === 2,
    { before: slotStrip, after: afterSwitch },
  );


  // --- "+" adds a page to the same instance, and a blank page is a search box --
  // A work profile needs a console, a docs page and the page under test at once.
  // The "+" must therefore extend the existing session, not open a second one,
  // and the blank page it lands on must offer something to type into.
  const added = await client.evaluate(`(async () => {
    const before = await window.ensemble.getEmbeddedState();
    const currentInstance = before.tabs.find((tab) => tab.id === before.activeTabId)?.instanceId;
    const beforePages = before.tabs.filter((tab) => tab.instanceId === currentInstance).length;
    document.querySelector('.tabstrip .strip-add')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const pages = state.tabs.filter((tab) => tab.instanceId === currentInstance);
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    // The surface has to fill the stage, not merely exist: a scoped parent rule
    // once sized it to a 26px toolbar button, and an existence check stayed green
    // while the whole new-tab page rendered as a thumbnail in the corner.
    const slot = document.querySelector('.stage .blank-slot');
    const surface = slot?.querySelector('.new-tab');
    const slotBox = slot?.getBoundingClientRect();
    const surfaceBox = surface?.getBoundingClientRect();
    return {
      beforePages,
      instancePages: pages.length,
      instances: new Set(state.tabs.map((tab) => tab.instanceId)).size,
      activeBlank: Boolean(active) && (!active.url || active.url === "about:blank"),
      surface: Boolean(surface),
      hasInput: Boolean(document.querySelector('.stage .blank-slot .nt-input')),
      surfaceFill: slotBox && surfaceBox
        ? {
            widthRatio: Math.round((surfaceBox.width / slotBox.width) * 100),
            heightRatio: Math.round((surfaceBox.height / slotBox.height) * 100),
          }
        : null,
    };
  })()`);
  check(
    "the strip's + adds a page to the same instance",
    added?.instancePages === (added?.beforePages ?? 0) + 1 && added?.instances === 1,
    added,
  );
  check(
    "a blank page draws the new-tab surface instead of an empty rectangle",
    added?.activeBlank === true &&
      added?.surface === true &&
      added?.hasInput === true &&
      added?.surfaceFill?.widthRatio === 100 &&
      added?.surfaceFill?.heightRatio === 100,
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

  // The field's row and the text on it share a centre line. The input used to
  // carry its own height on top of the shell's `stretch`, and a stretched flex
  // item with an explicit height aligns at the cross-start: every placeholder
  // sat five pixels above the middle of the box.
  //
  // Focus has to paint the shell's edges, not the field. The old treatment was a
  // conic gradient with a glow clipped inside the box, so focusing washed a
  // rotating light across the content. Now the focus state is two straight rules
  // on the horizontal edges whose width grows from zero, anchored left: the
  // accent is already in the strip, so widening it *is* the draw.
  //
  // The rules have no second stage. The SVG dash they replaced travelled a full
  // lap and then a second stroke faded in behind it — nearly a second before a
  // focus click looked finished, which is what the user rejected as 拖沓.
  const newTabField = await client.evaluate(`(async () => {
    const box = document.querySelector('.stage .blank-slot .nt-box');
    const input = box?.querySelector('.nt-input');
    if (!box || !input) return null;
    const readRule = (pseudo) => {
      const style = getComputedStyle(box, pseudo);
      return {
        clipPath: style.clipPath,
        opacity: style.opacity,
        borderTopWidth: style.borderTopWidth,
        borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderTopColor: style.borderTopColor,
        borderRadius: style.borderRadius,
        content: style.content,
      };
    };
    const resting = readRule("::after");
    input.focus();
    // Past the 170ms wipe: the outline is fully open and stays there.
    await new Promise((r) => setTimeout(r, 300));
    const b = box.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    const focused = readRule("::after");
    const outline = getComputedStyle(box.querySelector('.shell-outline'));
    return {
      centreGap: Math.abs((b.top + b.bottom) / 2 - (i.top + i.bottom) / 2),
      matchesFocus: box.matches(':focus-within'),
      resting,
      focused,
      outlineWidth: outline.strokeWidth,
      borderWidth: getComputedStyle(box).borderTopWidth,
      boxWidth: b.width,
      radius: parseFloat(getComputedStyle(box).getPropertyValue('--shell-radius')) || 0,
    };
  })()`);
  check(
    "the new-tab field centres its text in the box",
    newTabField?.centreGap !== undefined && newTabField.centreGap <= 1,
    newTabField,
  );
  check(
    "the focus outline is closed at rest and fully open when focused",
    // A clip wipe, not two strips: at rest the overlay is clipped to nothing
    // (`inset(0px 100% ...)`) and when focused the clip is `inset(0px)`. The
    // direction of the reveal is the browser's to interpolate; what the assertion
    // holds is that the end states are closed and open, so the field ends up with
    // all four edges rather than only its top and bottom.
    newTabField?.matchesFocus === true &&
      /100%/.test(newTabField.resting.clipPath) &&
      !/100%/.test(newTabField.focused.clipPath) &&
      newTabField.focused.opacity === "1",
    newTabField,
  );
  check(
    "the focus outline covers all four edges of the field",
    // The regression this locks: the two-strip version lit the top and bottom
    // edges only, so the left and right sides never highlighted and the corners
    // were missing entirely — a broken ring on a focused field.
    ["top", "right", "bottom", "left"].every(
      (edge) => newTabField?.focused[`border${edge[0].toUpperCase()}${edge.slice(1)}Width`] === "2px",
    ) &&
      newTabField?.focused.borderTopColor !== "rgba(0, 0, 0, 0)" &&
      parseFloat(newTabField?.focused.borderRadius ?? "0") >= newTabField.radius &&
      newTabField?.outlineWidth === "1px" &&
      parseFloat(newTabField?.borderWidth ?? "1") === 0,
    newTabField,
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
    // A preview has to preview something: a 5% wash in a 20px circle is the
    // same near-black disc for every preset, which is what the picker used to
    // show. The swatch paint is the same hues at thumbnail strength.
    const paints = swatches.map((el) => getComputedStyle(el).backgroundImage);
    const target = swatches.find((el) => !el.classList.contains('active')) ?? swatches[0];
    const chosen = target?.getAttribute("title") ?? "";
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const after = (await window.ensemble.getWorkspace()).settings.newTabBackground;
    return {
      before,
      after,
      chosen,
      count: swatches.length,
      uniquePaints: new Set(paints).size,
      reopened: false,
    };
  })()`);
  check(
    "picking a backdrop persists it as a setting",
    Boolean(backdrop?.before) &&
      Boolean(backdrop?.after) &&
      backdrop?.after !== backdrop?.before &&
      (backdrop?.count ?? 0) >= 3,
    backdrop,
  );
  check(
    "every backdrop offers its own preview",
    backdrop?.count >= 3 && backdrop?.uniquePaints === backdrop?.count,
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

  // A blank page draws its own new-tab surface, and nothing may be painted over
  // it. While pages were native views this was the freeze path's job: a blank
  // page has no pixels to capture, so capturing it produced an empty image that
  // covered the search box. A guest is a node in this document, so the check
  // that still means something is that the surface owns the pixels where it is
  // drawn.
  const blankSurface = await client.evaluate(`(async () => {
    const state0 = await window.ensemble.getEmbeddedState();
    const viewId = state0.activeViewId;
    await window.ensemble.openEmbeddedTab({ viewId: null });
    await new Promise((r) => setTimeout(r, 900));
    const state = await window.ensemble.getEmbeddedState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    window.ensemble.setEmbeddedStage({
      x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
    });
    await new Promise((r) => requestAnimationFrame(r));
    const surface = document.querySelector('.stage .blank-slot .new-tab');
    // Nothing may sit on top of the surface where it is drawn.
    const box = surface?.getBoundingClientRect();
    const hit = box
      ? document.elementFromPoint(
          Math.round(box.left + box.width / 2),
          Math.round(box.top + box.height / 2),
        )
      : null;
    // Restore the view: the rest of this suite works inside its cells.
    if (viewId) await window.ensemble.activateEmbeddedView(viewId);
    await new Promise((r) => setTimeout(r, 700));
    // What was actually on top of the surface's centre, as a selector chain.
    // "Something is covering the search box" is the whole genre of failure this
    // assertion catches, and the element that owns the pixel is the answer — a
    // bare boolean would send the next reader hunting through the DOM by hand.
    // (No backticks in this comment: it lives inside a template literal.)
    const covering = [];
    for (let n = hit; n && covering.length < 6; n = n.parentElement) {
      covering.push(
        n.tagName.toLowerCase() +
          "." +
          (n.className || "").toString().split(" ").filter(Boolean).join("."),
      );
    }
    return {
      activeBlank: Boolean(active) && (!active.url || active.url === "about:blank"),
      surfacePresent: Boolean(surface),
      surfaceOwnsItsCentre: Boolean(hit && surface?.contains(hit)),
      restored: (await window.ensemble.getEmbeddedState()).activeViewId === viewId,
      covering,
    };
  })()`);
  check(
    "a blank page's new-tab surface draws and owns its own box",
    blankSurface?.activeBlank === true &&
      blankSurface?.surfacePresent === true &&
      blankSurface?.surfaceOwnsItsCentre === true &&
      blankSurface?.restored === true,
    blankSurface,
  );

  // --- Page actions: close one page, and the right-click menu ---------------
  // Closing several pages quickly used to mean hovering each one first. The
  // window strip renders the close button at rest.
  const slotCloses = await client.evaluate(`(() =>
    [...document.querySelectorAll('.tabstrip .tab')].map((tab) => {
      const close = tab.querySelector('.tab-close');
      return {
        id: tab.getAttribute('data-tab-id'),
        current: tab.classList.contains('active'),
        opacity: close ? Number(getComputedStyle(close).opacity) : null,
      };
    })
  )()`);
  check(
    "every page tab in the strip shows its close button without hovering",
    slotCloses?.length > 0 && slotCloses.every((tab) => (tab.opacity ?? 0) >= 0.5),
    slotCloses,
  );

  const closeOne = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const currentInstance = state.tabs.find((tab) => tab.id === state.activeTabId)?.instanceId;
    // The close needs a second, non-current tab to act on; earlier steps may
    // have left only one.
    if (state.tabs.filter((tab) => tab.instanceId === currentInstance).length < 2) {
      await window.ensemble.openEmbeddedTabInInstance(currentInstance);
      await new Promise((r) => setTimeout(r, 900));
    }
    const fresh = await window.ensemble.getEmbeddedState();
    const before = fresh.tabs.filter((tab) => tab.instanceId === currentInstance).length;
    const target = document.querySelector('.tabstrip .tab:not(.active) .tab-close');
    target?.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = await window.ensemble.getEmbeddedState();
    return {
      before,
      after: after.tabs.filter((tab) => tab.instanceId === currentInstance).length,
      cells: after.tabs.filter((tab) => tab.instanceId === currentInstance).length,
    };
  })()`);
  check(
    "the strip's close button closes one page",
    closeOne?.after === (closeOne?.before ?? 0) - 1,
    closeOne,
  );

  // The menu floats over the page, and a blank page has no native pixels to
  // capture — `freeze()` skips it on purpose so the app's new-tab surface is
  // not painted over. Put real content on stage first; otherwise this check
  // fails for a reason that has nothing to do with the menu.
  const menu = await client.evaluate(`(async () => {
    const state0 = await window.ensemble.getEmbeddedState();
    const shown = state0.tabs.find((tab) => tab.id === state0.activeTabId);
    if (shown) {
      await window.ensemble.navigateEmbeddedTab(shown.id, ${JSON.stringify(PAGE_URL)});
      await new Promise((r) => setTimeout(r, 1200));
    }
    const tab = document.querySelector('.tabstrip .tab');
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
    const menuBox = panel?.getBoundingClientRect();
    return {
      open: Boolean(panel),
      items: [...(panel?.querySelectorAll('.tab-menu-item') ?? [])].map((el) => el.textContent.trim()),
      frozen: Boolean(document.querySelector('.stage .frozen')),
      // The menu hangs over the stage; what matters is that it is actually the
      // thing drawn there. A native page used to require a frozen frame first;
      // a guest just stacks, so ask the renderer which element is on top.
      onTop: menuBox
        ? document
            .elementsFromPoint(
              Math.round(menuBox.left + menuBox.width / 2),
              Math.round(menuBox.top + menuBox.height / 2),
            )
            .some((el) => el.closest('.tab-menu'))
        : false,
      carrier: (await window.ensemble.getEmbeddedState()).carrier ?? "native",
    };
  })()`);
  check(
    "right-clicking a page tab opens the page menu over the stage",
    menu?.open === true &&
      (menu?.carrier === "guest" ? menu?.onTop === true : menu?.frozen === true) &&
      (menu?.items?.length ?? 0) >= 4,
    menu,
  );

  // A frozen frame is a picture placed at the rect the main process reported
  // when it captured, so it must never paint outside the stage. The dock that
  // used to resize the stage mid-menu is retired; the clipping guarantee
  // remains: the stage hides its overflow, so whatever the frame's rect says,
  // nothing spills past the stage's own box.
  const spill = await client.evaluate(`(() => {
    const stage = document.querySelector('.stage');
    if (!stage) return null;
    const stageBox = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    const frames = [...document.querySelectorAll('.stage .frozen')];
    return {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      frozen: frames.length,
      spilled: frames
        .map((img) => img.getBoundingClientRect())
        .filter((box) => box.right > stageBox.right + 1 || box.bottom > stageBox.bottom + 1).length,
    };
  })()`);
  check(
    "the stage clips its children so a frozen frame cannot spill out",
    spill?.overflowX === "hidden" &&
      spill?.overflowY === "hidden" &&
      spill?.spilled === 0,
    spill,
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

  // --- The instance rail names its account ----------------------------------
  // Four windows on the same admin console all show the same page title, so the
  // entry has to say whose session it is.
  await backToBrowser(client);
  await wait(400);
  const labelled = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({
      url: ${JSON.stringify(PAGE_URL)},
      identityId: ${JSON.stringify(uuid(2))},
      label: "管理员 · 主账号",
    });
    await new Promise((r) => setTimeout(r, 800));
    const chips = [...document.querySelectorAll('[data-instance-chip]')];
    return {
      accounts: chips.map((el) => el.querySelector('.chip-account')?.textContent.trim() ?? ""),
    };
  })()`);
  check(
    "a rail entry names its account",
    labelled?.accounts?.includes("管理员 · 主账号"),
    labelled,
  );

  // --- A management layer must not take the page off the stage --------------
  // Pages keep running while a layer is open, and they now keep their pixels
  // too: the layer covers part of the stage, the page under it stays where it
  // was. Two things must hold, and both broke at some point:
  //  * the page must keep a real rectangle (a parked node has no viewport, and
  //    every geometry-based decision the AI makes then answers wrong);
  //  * opening a layer must report the docked DevTools as parked, because that
  //    panel is a native view no HTML can stack over.
  await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs[0];
    if (tab) await window.ensemble.navigateEmbeddedTab(tab.id, ${JSON.stringify(PAGE_URL)});
    await new Promise((r) => setTimeout(r, 1200));
    return Boolean(tab);
  })()`);
  const stagedBefore = await client.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('webview')]
      .map((node) => node.getBoundingClientRect())
      .map((rect) => ({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }));
    return { boxes };
  })()`);
  await client.evaluate(openNav("identities"));
  await wait(1200);

  const parkedState = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const nodes = [...document.querySelectorAll('webview')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      carrier: state.carrier ?? "native",
      tabs: state.tabs.map((tab) => ({ id: tab.id, bounds: tab.bounds ?? null })),
      nodes,
      devtoolsParked: state.devtoolsParked === true,
      paneOpen: Boolean(document.querySelector('[data-floating-pane]')),
      onIdentities: Boolean(document.querySelector('.id-card')),
    };
  })()`);
  // The layer is mounted over part of the stage, so the page it covers must
  // still report the same rectangle it had — that is what "the layer does not
  // take the page away" means, and it is also what keeps the AI's viewport
  // reads honest while a page is open.
  check(
    "a management layer leaves every embedded page on its stage rectangle",
    parkedState?.paneOpen === true &&
      parkedState?.onIdentities === true &&
      parkedState.tabs.length > 0 &&
      (parkedState.carrier === "guest"
        ? parkedState.nodes.some(
            (node) => node.width > 0 && node.height > 0 && node.x + node.width > 0,
          )
        : parkedState.tabs.some((tab) => tab.bounds && tab.bounds.width > 0)) &&
      // Every node that had a box before the layer opened still has the same
      // one: the layer covers part of the stage, it does not unmount it.
      (stagedBefore?.boxes ?? []).every((box) =>
        parkedState.nodes.some(
          (node) =>
            node.x === box.x && node.y === box.y && node.width === box.width && node.height === box.height,
        ) ||
        box.x + box.width <= 0 ||
        box.width <= 0,
      ),
    { parkedState, stagedBefore },
  );
  check(
    "an open management layer parks the docked DevTools panels",
    parkedState?.devtoolsParked === true,
    parkedState,
  );

  const parkedViewport = await (async () => {
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    const targets = list.filter((item) => item.url.startsWith(PAGE_URL));
    const sizes = [];
    for (const target of targets) {
      const pageClient = await connectToWindow(target.webSocketDebuggerUrl);
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
    "no page under an open layer collapses to a zero-width layout",
    parkedViewport.length > 0 &&
      parkedViewport.every((size) => size && size.w > 0 && size.h > 0 && size.bodyW > 0),
    parkedViewport,
  );

  // --- Account rail: a click selects the instance that item stands for ------
  // The rail shares the screen with the stage, so an item click must select its
  // own instance and leave the stage mounted.
  const dockSwitch = await client.evaluate(`(async () => {
    if (document.querySelector('[data-floating-pane]')) {
      document.querySelector('[data-floating-pane] .pane-head button')?.click();
      await new Promise((r) => setTimeout(r, 500));
    }
    const chip = [...document.querySelectorAll('[data-instance-chip]')].find(
      (el) => el.getAttribute('data-on-stage') !== '1',
    );
    const wanted = chip?.getAttribute('data-instance-chip') ?? null;
    const onBrowserBefore = Boolean(document.querySelector('.stage'));
    chip?.click();
    await new Promise((r) => setTimeout(r, 1000));
    const after = await window.ensemble.getEmbeddedState();
    const landed = after.tabs.find((tab) => tab.id === after.activeTabId);
    return {
      onBrowserBefore,
      clicked: Boolean(chip),
      wanted,
      onBrowserAfter: Boolean(document.querySelector('.stage')),
      activeTab: landed?.instanceId,
    };
  })()`);
  check(
    "clicking an account rail item selects that instance and keeps the stage on screen",
    dockSwitch?.onBrowserBefore === true &&
      dockSwitch?.clicked === true &&
      dockSwitch?.onBrowserAfter === true &&
      dockSwitch?.activeTab === dockSwitch?.wanted,
    dockSwitch,
  );

  // A second page must not add any second stage: the instance's pages live in
  // the window strip, and the stage stays single-cell.
  const noNestedPages = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!active) return null;
    await window.ensemble.openEmbeddedTabInInstance(active.instanceId);
    await new Promise((r) => setTimeout(r, 1200));
    const after = await window.ensemble.getEmbeddedState();
    const instancePages = after.tabs.filter((tab) => tab.instanceId === active.instanceId);
    return {
      pages: instancePages.length,
      stripTabs: document.querySelectorAll('.tabstrip .tab').length,
      headers: document.querySelectorAll('.stage .slot-header').length,
      stagedBounds: after.tabs.filter(
        (tab) => tab.instanceId === active.instanceId && (tab.bounds?.width ?? 0) > 0,
      ).length,
      activeBlank: active.url === "about:blank" || !active.url,
    };
  })()`);
  check(
    "a second page joins the strip, and the stage stays one cell",
    (noNestedPages?.pages ?? 0) >= 2 &&
      noNestedPages?.stripTabs === noNestedPages?.pages &&
      noNestedPages?.headers === 0 &&
      // One stage: at most one page of the instance holds a real rect. The
      // "+ lands on a blank page" case has its surface drawn by the app (no
      // bounds at all), and a page caught mid-park reads zero for a frame.
      (noNestedPages?.stagedBounds ?? 0) <= 1,
    noNestedPages,
  );

  // The favicon path itself, not only the placeholder: the test page declares an
  // icon, so at least one chip must be showing a real image. Without this the
  // check above would keep passing if the whole `src` wiring broke.
  const realIcon = await client.evaluate(`(async () => {
    const deadline = Date.now() + 5000;
    let found = { rows: 0, images: 0, src: "" };
    while (Date.now() < deadline) {
      const chips = [...document.querySelectorAll('[data-instance-chip] .chip-site')];
      const images = chips.filter((row) => row.querySelector('img'));
      found = {
        rows: chips.length,
        images: images.length,
        src: images[0]?.querySelector('img')?.getAttribute('src')?.slice(0, 20) ?? "",
      };
      if (images.length > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return found;
  })()`);
  check(
    "a rail chip shows the site's real favicon, inlined as a data URL",
    realIcon?.images >= 1 && String(realIcon?.src).startsWith("data:image/"),
    realIcon,
  );

  // --- The flows empty state sits in the middle of the page ----------------
  // The section did not fill the pane, so `margin: auto` had no free space to
  // distribute and the block hugged the header instead of centring.
  await openConsolePage(client, "flows");
  const flowsEmpty = await client.evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 800));
    const page = document.querySelector('.flows');
    const empty = page?.querySelector('.empty');
    if (!page || !empty) return { present: false };
    const p = page.getBoundingClientRect();
    const e = empty.getBoundingClientRect();
    const head = page.querySelector('.page-head')?.getBoundingClientRect();
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
  // Every grouped list (accounts by site, flows by site) had fixed headers:
  // twenty-four groups meant twenty-four sections and no way to tidy up. The
  // page these checks run on is the accounts page now — a site is the heading of
  // its accounts — but the header, the fold-all switch and the labels are the
  // same components, so the assertions moved with them.
  await openConsolePage(client, "identities");
  await waitFor(client, `document.querySelectorAll('.identities .group-head').length >= 2`);

  const sitesFold = await client.evaluate(`(async () => {
    const heads = () => [...document.querySelectorAll('.identities .group-head')];
    const cards = () => document.querySelectorAll('.identities .id-card').length;
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
    const all = () => document.querySelector('.identities [data-group-collapse-all]');
    // The switch labels itself, so its direction is readable from the element
    // itself rather than from whatever buttons happen to share its container.
    const label = () => all()?.textContent.replace(/\\s+/g, ' ').trim() ?? "";
    const beforeLabel = label();
    all()?.click();
    await new Promise((r) => setTimeout(r, 300));
    const collapsedAll = {
      cards: cards(),
      anyOpen: heads().some((h) => h.getAttribute('aria-expanded') === 'true'),
      labels: [label()],
    };
    // Same button, now the other direction.
    all()?.click();
    await new Promise((r) => setTimeout(r, 300));
    const expandedAll = { cards: cards(), anyClosed: heads().some((h) => h.getAttribute('aria-expanded') === 'false') };
    return { before, folded, reopened, beforeLabel: [beforeLabel], collapsedAll, expandedAll };
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
      // The site form is still the same dialog; its entrance moved to the
      // accounts page's header when the sites page was folded into it.
      document.querySelector('[data-new-site]')?.click();
      await new Promise((r) => setTimeout(r, 500));
      return dialog();
    };
    const closeForm = async () => {
      dialog()?.querySelector('.close')?.click();
      await new Promise((r) => setTimeout(r, 300));
    };

    const before = await window.ensemble.getWorkspace();
    // Already on the accounts page (the fold checks above opened it), which is
    // where sites are configured now.

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
  await openConsolePage(client, "identities");
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

    // Selection → batch launch. The saved-view form is retired (P1-3), so the
    // selection bar is the only thing a picked group turns into. Start from a
    // clean slate: a previous block may have left selection mode on with its
    // own picks, which would make the clicks below cancel instead of choose.
    if (document.querySelector('.identities .select-bar')) {
      const cancel = [...document.querySelectorAll('.identities .select-bar button')].find(
        (el) => (el.textContent ?? "").trim() === "取消",
      );
      cancel?.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    document.querySelector('.identities [data-batch-select]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const entering = {
      buttonFound: Boolean(document.querySelector('.identities [data-batch-select]')),
      selectBar: Boolean(document.querySelector('.identities .select-bar')),
      // The retired entry must not come back with the selection bar.
      createViewEntry: Boolean(document.querySelector('.identities [data-batch-create-view]')),
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
    "picking accounts keeps the selection bar, with no view-form entry",
    accountsFold?.selectedCount === 2 &&
      // Entering selection mode again is a no-op: the bar from the previous
      // block is still up, so either the entry button or the bar proves it.
      (accountsFold?.entering?.buttonFound === true || accountsFold?.entering?.selectBar === true) &&
      // The saved-view form is retired (P1-3): a batch is launched, not saved.
      // No dialog of the member-picker kind may open from the selection, and
      // the bar carries no view-form entry any more.
      accountsFold?.dialogOpen === false &&
      accountsFold?.entering?.createViewEntry === false,
    accountsFold,
  );

  // --- Linking accounts in bulk -------------------------------------------
  // The account form's site picker needs one card at a time, and the failure it
  // guards against is invisible: an account with no site looks like every other
  // card until you try to launch it. Select several, pick a site, all attached.
  const bulkLink = await client.evaluate(`(async () => {
    const snapBefore = await window.ensemble.getWorkspace();
    const site = snapBefore.sites[0];
    if (!site) return { error: "no site to link to" };
    const victims = snapBefore.identities.slice(0, 2);
    const wanted = victims.map((item) => item.name);

    document.querySelector('.identities [data-batch-select]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const cards = [...document.querySelectorAll('.identities .id-card')];
    // Pick by name so the two cards really are the workspace's first two: the
    // grid order follows the group order, not the workspace array.
    const picks = cards.filter((card) =>
      wanted.includes(card.querySelector('.name')?.textContent.trim()),
    );
    picks.forEach((card) => card.click());
    await new Promise((r) => setTimeout(r, 300));
    const selectedCount = document.querySelectorAll('.identities .id-card.picked').length;

    // The link control is a button opening a dialog: a stray click must not be
    // able to re-home a whole batch, so the site is chosen and confirmed.
    const beforeDialog = (await window.ensemble.getWorkspace()).identities
      .filter((item) => wanted.includes(item.name))
      .map((item) => ({ name: item.name, siteId: item.siteId }));

    const linkButton = document.querySelector('.identities .select-bar [data-batch-link-site]');
    const buttonFound = Boolean(linkButton);
    linkButton?.click();
    await new Promise((r) => setTimeout(r, 500));
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((el) =>
      el.querySelector('.link-field'),
    );
    const dialogOpen = Boolean(dialog);
    // Ask for a site explicitly, even if the dialog pre-selected one, so this
    // also proves the picker inside the dialog works.
    dialog?.querySelector('.link-field .select-trigger')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 400));
    const option = [...document.querySelectorAll('.select-panel .option')].find((el) =>
      (el.textContent ?? '').includes(site.name),
    );
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const confirm = dialog?.querySelector('[data-confirm-link-site]');
    const confirmFound = Boolean(confirm);
    // Choosing a site in the dialog must not write anything yet: compare against
    // what the workspace looked like before the dialog opened (these accounts may
    // legitimately already be on the target site).
    const afterPick = (await window.ensemble.getWorkspace()).identities
      .filter((item) => wanted.includes(item.name))
      .map((item) => ({ name: item.name, siteId: item.siteId }));
    const untouchedBeforeConfirm =
      JSON.stringify(afterPick) === JSON.stringify(beforeDialog);
    confirm?.click();
    await new Promise((r) => setTimeout(r, 1000));

    const snapAfter = await window.ensemble.getWorkspace();
    return {
      siteId: site.id,
      selectedCount,
      buttonFound,
      dialogOpen,
      confirmFound,
      untouchedBeforeConfirm,
      stillSelecting: Boolean(document.querySelector('.identities .select-bar')),
      linked: snapAfter.identities
        .filter((item) => wanted.includes(item.name))
        .map((item) => ({ name: item.name, siteId: item.siteId })),
    };
  })()`);
  check(
    "selecting accounts and confirming a site in the dialog links them all",
    bulkLink?.buttonFound === true &&
      bulkLink?.dialogOpen === true &&
      bulkLink?.confirmFound === true &&
      bulkLink?.untouchedBeforeConfirm === true &&
      bulkLink?.selectedCount === 2 &&
      bulkLink?.linked?.length === 2 &&
      bulkLink?.linked?.every((item) => item.siteId === bulkLink?.siteId) &&
      bulkLink?.stillSelecting === false,
    bulkLink,
  );

  // --- Views reorder by dragging -------------------------------------------
  // Real HTML5 drags, not direct calls to the move API: the drop handler is what
  // is on trial here. A list that looks reorderable but never persists the order
  // (or that moves a filtered row to the wrong place) is the failure mode.
  //
  // --- Saved views: the page is retired, the data survives ------------------
  /*
   * The views page and its drag-to-reorder rows are retired with the grid
   * (ADR 0012); the workspace's `views` field and its ordering logic keep
   * their coverage in the unit tests (tests/view-order.test.ts). What the
   * shell must still guarantee: no route to the page from the management
   * layers, and the workspace round-trip keeps existing rows.
   */
  await backToBrowser(client);
  const viewsRetired = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Every management layer there is, read for an entry that opens saved views.
    const entries = [];
    for (const layer of ['sites', 'identities', 'more']) {
      document.querySelector('[data-rail-entry="' + layer + '"]')?.click();
      for (let attempt = 0; attempt < 20 && !document.querySelector('[data-floating-pane]'); attempt += 1) {
        await wait(80);
      }
      for (const el of document.querySelectorAll('[data-floating-pane] [data-more-tab], [data-floating-pane] .page')) {
        if (el.dataset.moreTab) entries.push(el.dataset.moreTab);
      }
      document.querySelector('[data-floating-pane] .pane-head button')?.click();
      await wait(300);
    }
    // An old workspace still carries saved views; the shell keeps the data
    // readable and untouched by the retirement.
    const snap = await window.ensemble.getWorkspace();
    return { entries, viewsInData: Array.isArray(snap.views) };
  })()`);
  check(
    "no management layer routes to saved views, and view data round-trips",
    viewsRetired?.entries?.includes("views") === false &&
      viewsRetired?.viewsInData === true,
    viewsRetired,
  );

  // --- The browser page's standing navigation -------------------------------
  // The account rail carries exactly one entry. Everything else — sections,
  // message centre, flows, and launching an account — lives inside a floating
  // layer, so there must be no section rows and no launch button on the browser
  // surface itself.
  const navEntries = await client.evaluate(`(() => {
    const railEntries = [...document.querySelectorAll('[data-rail-entry]')].map((el) =>
      el.getAttribute('data-rail-entry'),
    );
    return {
      railEntries,
      // The launch control moved into the accounts pane, where picking an account
      // is the whole point of the page. Its absence here is the assertion: a
      // second entry point was a duplicate of that page.
      launchButtonOnRail: Boolean(document.querySelector('[data-launch-btn]')),
      sectionsOnBrowser: document.querySelectorAll('[data-more-tab]').length,
      paneOpen: Boolean(document.querySelector('[data-floating-pane]')),
    };
  })()`);
  check(
    "the browser page carries one rail entry and no second launch button",
    navEntries?.launchButtonOnRail === false &&
      navEntries?.railEntries?.length === 1 &&
      navEntries.railEntries.join(",") === "identities" &&
      navEntries.sectionsOnBrowser === 0 &&
      navEntries.paneOpen === false,
    navEntries,
  );


  // --- Flows: the same folding, over rows rather than cards ----------------
  await openConsolePage(client, "flows");
  await wait(600);
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
    // Already on the flows tab: openConsolePage(client, "flows") above went
    // through the pane's AI section and opened it.
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

  // --- AI entry in the toolbar ---------------------------------------------
  // The endpoint used to be reported by a status bar across the bottom of every
  // screen — the single clearest sign that a window is a console rather than a
  // browser. It then became a row in the app menu, which hid the one thing that
  // matters at a glance: whether the assistant is listening. It is a toolbar
  // control now, because "connected?" is a live state, and the records behind it
  // are what the menu row was opening settings to look at.
  // Earlier checks leave the app on a console page; without this the browser's
  // toolbar is simply not mounted and every assertion below would read null.
  await backToBrowser(client);
  await waitFor(client, `Boolean(document.querySelector('[data-app-menu]'))`, 5000);
  const aiEntry = await client.evaluate(`(async () => {
    const button = document.querySelector('[data-ai-panel]');
    if (!button) return { found: false };
    const rect = button.getBoundingClientRect();
    button.click();
    await new Promise((r) => setTimeout(r, 400));
    const panel = document.querySelector('[data-ai-panel-body]');
    const panelRect = panel?.getBoundingClientRect();
    const status = await window.ensemble.mcpStatus();
    return {
      found: true,
      inToolbar: Boolean(button.closest('.toolbar')),
      labelled: (button.getAttribute('aria-label') ?? '').length > 0,
      // The dot tracks the endpoint, so it is asserted against the endpoint's
      // own state rather than against a literal: this suite runs with the
      // endpoint off, and a hard-coded true would demand a state the fixture
      // never sets.
      live: Boolean(button.querySelector('.ai-live-dot')),
      running: status?.running === true,
      statusText: panel?.querySelector('.ai-head-status')?.textContent?.trim() ?? '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      panel: Boolean(panel),
      panelInsideWindow:
        !panelRect || (panelRect.right <= window.innerWidth && panelRect.left >= 0),
    };
  })()`);
  check("the AI entry is a toolbar control", aiEntry?.found === true && aiEntry?.inToolbar === true, aiEntry);
  check(
    "the AI entry is labelled and states the endpoint's state",
    aiEntry?.labelled === true &&
      aiEntry?.live === aiEntry?.running &&
      typeof aiEntry?.statusText === 'string' &&
      aiEntry.statusText.length > 0,
    aiEntry,
  );
  // An icon button, not a menu row: it has to sit in the same 32px row as the
  // bell and the app menu without widening it.
  check(
    "the AI entry is an icon button, not a full-width row",
    typeof aiEntry?.width === 'number' &&
      typeof aiEntry?.height === 'number' &&
      aiEntry.width <= aiEntry.height * 2,
    { width: aiEntry?.width, height: aiEntry?.height },
  );
  check(
    "the AI panel opens inside the window",
    aiEntry?.panel === true && aiEntry?.panelInsideWindow === true,
    aiEntry,
  );
  // Leave the panel closed: the probe opened it, and the next step clicks a
  // control behind it.
  await client.evaluate(`(async () => {
    document.querySelector('[data-ai-panel]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`);

  // The status bar is gone: its 30px across every screen was the clearest sign
  // that this was a console. Assert the removal, so it cannot creep back.
  const noStatusBar = await client.evaluate(`(() => ({
    statusbar: Boolean(document.querySelector('.statusbar')),
    footer: Boolean(document.querySelector('.app-shell > footer')),
  }))()`);
  check("the window has no status bar", noStatusBar?.statusbar === false && noStatusBar?.footer === false, noStatusBar);

  // The panel's gear is the door to the full editor: the panel answers "what is
  // it doing here", settings answers "what may it do anywhere".
  await client.evaluate(`(async () => {
    document.querySelector('[data-ai-panel]')?.click();
    await new Promise((r) => setTimeout(r, 350));
    document.querySelector('[data-ai-open-settings]')?.click();
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })()`);
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
    "the AI panel's gear opens the AI access tab with the endpoint block",
    landedOnMcp && settingsState?.hasEndpointBlock === true,
    settingsState,
  );

  // The connection facts are laid out in the open with one primary copy action.
  // The token itself must never be printed: "copy config" is how it travels.
  const connBlock = await client.evaluate(`(() => {
    const block = document.querySelector('.mcp-endpoint');
    if (!block) return null;
    const copy = block.querySelector('[data-copy-config]');
    const text = block.textContent.replace(/\\s+/g, ' ');
    const snapshot = document.querySelector('.mcp-endpoint')?.innerHTML ?? '';
    return {
      hasCopyConfig: Boolean(copy),
      inDetails: Boolean(block.closest('details')),
      readOnlyToken: !/[A-Za-z0-9_-]{24,}/.test(text.replace(/Bullet|•/g, '')),
      hidesToken: text.includes('•'),
      urlShown: text.includes('127.0.0.1') || text.includes('http'),
      // The URL is in the DOM; the token must not be.
      tokenLeaked: /token["']?\\s*[:=]\\s*["'][A-Za-z0-9_-]{20,}/.test(snapshot),
    };
  })()`);
  check(
    "the AI access block shows its config in the open, not behind a disclosure",
    Boolean(connBlock) && connBlock.inDetails === false && connBlock.urlShown === true,
    connBlock,
  );
  check(
    "the copy-config button is the primary action and sits outside any disclosure",
    connBlock?.hasCopyConfig === true,
    connBlock,
  );
  check(
    "the token is masked in the UI and never rendered as plain text",
    Boolean(connBlock) && connBlock.hidesToken === true && connBlock.tokenLeaked === false,
    connBlock,
  );

  // A missing message renders as the key itself, which is how 1.1.0 shipped a
  // button labelled `app.copyToken` and a summary labelled `app.mcpConfigTitle`.
  // The unit guard covers every literal key in the source; this one covers what
  // actually reached the screen.
  const rawKeys = await client.evaluate(`(() => {
    const text = document.body.textContent || '';
    return {
      keys: (text.match(/\\bapp\\.[a-zA-Z][a-zA-Z0-9_.]{2,}/g) || []),
      hasDisclosure: Boolean(document.querySelector('.mcp-endpoint details')),
    };
  })()`);
  check(
    "the settings page renders no raw i18n keys",
    Array.isArray(rawKeys?.keys) && rawKeys.keys.length === 0,
    rawKeys,
  );
  check(
    "the AI access block has no leftover collapsible section",
    rawKeys?.hasDisclosure === false,
    rawKeys,
  );

  // Settings is the one full-window page left, so "a manual tab change must not
  // stick" is about the request reaching the page: pick another tab, leave
  // settings, and ask the AI entry for the MCP section again.
  await client.evaluate(
    `(() => { document.querySelector('.page.settings [data-section="general"]')?.click(); return true; })()`,
  );
  await wait(400);
  await client.evaluate(`(async () => {
    // Back to the browser first: the AI entry is a toolbar control, and
    // settings has neither that toolbar nor the control.
    document.querySelector('.page.settings .settings-head .back')?.click();
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('[data-ai-panel]')?.click();
    await new Promise((r) => setTimeout(r, 350));
    document.querySelector('[data-ai-open-settings]')?.click();
    await new Promise((r) => setTimeout(r, 600));
    return true;
  })()`);
  const returned = await waitFor(client, `Boolean(document.querySelector('.mcp-endpoint'))`);
  check("the AI panel's gear retargets the tab after a manual change", returned === true, {
    returned,
  });

  // --- Empty stage: the strip's "+" must still do something -----------------
  // It grows the focused instance, and with no page open there is no instance —
  // so it was a dead button exactly when it was the only control left.
  await backToBrowser(client);
  const emptyPlus = await client.evaluate(`(async () => {
    const api = window.ensemble;
    for (const tab of (await api.getEmbeddedState()).tabs) await api.closeEmbeddedTab(tab.id);
    await new Promise((done) => setTimeout(done, 700));
    const before = (await api.getEmbeddedState()).tabs.length;
    const add = document.querySelector('.tabstrip .strip-add');
    add?.click();
    await new Promise((done) => setTimeout(done, 1200));
    return {
      before,
      after: (await api.getEmbeddedState()).tabs.length,
      addPresent: Boolean(add),
      onBrowser: Boolean(document.querySelector('[data-account-rail]')),
      paneOpen: Boolean(document.querySelector('[data-floating-pane]')),
      settingsOpen: Boolean(document.querySelector('.page.settings')),
    };
  })()`);
  check(
    "the strip's plus opens a page even when nothing is open",
    emptyPlus?.before === 0 && emptyPlus?.after === 1,
    emptyPlus,
  );

  // --- Accounts of different shapes keep one row height ---------------------
  // A long role, a non-default browser and extra fields used to wrap an account
  // to a second chip line, which stretched its grid row and left every neighbour
  // with a band of empty space under its actions. The default is a list now, so
  // the assertion follows rows instead of grid cells: every row in a group shares
  // a height, and the wordy account's chips still sit on one line.
  const wordySeed = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const snap = await api.getWorkspace();
    const site = snap.sites[0];
    await api.saveIdentity({
      siteId: site.id,
      name: "长描述账号",
      username: "verbose@example.internal",
      role: "数据管理员 · 读写 · 跨区域",
      color: "teal",
      passwordMode: "custom",
      password: "e2e-placeholder-password",
      extraFields: [
        { label: "租户", value: "acme" },
        { label: "区域", value: "cn-north" },
      ],
    });
    return { ok: true, siteId: site.id };
  })()`);
  await openConsolePage(client, "identities");
  // Earlier checks fold and reopen groups; the wordy account has to be on
  // screen for its chips to be measurable.
  await client.evaluate(`(() => {
    for (const head of document.querySelectorAll('.identities .group-head[aria-expanded="false"]')) {
      head.click();
    }
    return true;
  })()`);
  await wait(300);
  await waitFor(client, `document.querySelectorAll('.id-card').length >= 2`);
  const heights = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.id-card')];
    // Collect heights per group: rows between one group header and the next.
    const parent = cards[0]?.parentElement;
    const groups = [];
    let current = null;
    for (const node of parent ? [...parent.children] : []) {
      if (node.classList.contains('group-head')) {
        current = [];
        groups.push(current);
      } else if (node.classList.contains('id-card')) {
        if (!current) {
          current = [];
          groups.push(current);
        }
        current.push(Math.round(node.getBoundingClientRect().height));
      }
    }
    const wordy = cards.find((card) => card.querySelector('.name')?.textContent?.includes('长描述'));
    const chips = wordy ? [...wordy.querySelectorAll('.meta-row > .tag')] : [];
    const visibleGroups = groups.filter((list) => list.length > 0);
    return {
      cardCount: cards.length,
      groupCount: visibleGroups.length,
      // Rows of the same group share a height.
      uniform: visibleGroups.length > 0 && visibleGroups.every((list) => new Set(list).size === 1),
      heights: visibleGroups,
      chips: chips.length,
      // One line means every chip shares a top edge.
      oneLine: chips.length > 0 && new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top))).size === 1,
      folded: chips.find((chip) => chip.classList.contains('more'))?.getAttribute('title') ?? '',
    };
  })()`);
  check(
    "accounts of different shapes keep one row height",
    wordySeed?.ok === true &&
      heights?.uniform === true &&
      heights?.oneLine === true &&
      heights?.groupCount >= 1,
    heights,
  );
  // Folding must not hide: the counter carries the names it swallowed.
  check(
    "the facts a row folds away stay readable from its counter",
    typeof heights?.folded === "string" && heights.folded.length > 0,
    heights,
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
