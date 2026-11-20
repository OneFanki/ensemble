#!/usr/bin/env node
/**
 * End-to-end check of the profile fold-in.
 *
 * Profiles have folded into accounts: a user only ever needs the word
 * "account". Four things have to hold:
 *
 * 1. The account form carries an "独立隔离档案" fold and it starts closed —
 *    creating an account asks nothing about storage; the fold holds the one
 *    sentence that says what isolation means and (for a saved account) the one
 *    action that touches that data.
 * 2. No profile surface remains in the everyday paths: the new-browser chooser
 *    has no profile tab, the toolbar menu has no profiles row.
 * 3. A workspace with user-created profiles shows the one-time merge invitation
 *    in Settings; a workspace with only the built-ins never does. The
 *    invitation says up front that merged profiles sign in again and that the
 *    data stays on disk — merging must never be a silent logout.
 * 4. Merging leaves exactly the two built-ins, points the default back at
 *    "default", keeps every profile directory on disk, and after a restart an
 *    account-less page lands in the default profile's partition — where the
 *    merged profiles' cookies do *not* appear, exactly as the invitation
 *    warned. That is the honest contract: sessions under a merged profile are
 *    not silently kept, and not silently destroyed either (the data is still
 *    on disk).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";
import { openRail } from "./lib/e2e-nav.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-profiles-"));

/**
 * A page that can be told to set a cookie, and that reports the cookie it sees.
 *
 * `/set?value=x` stores a cookie, and `/read` puts whatever cookie reached the
 * server into the document title. The title is the observable that needs no
 * script channel: the browser's own tab record carries it.
 */
const page = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PAGE_PORT}`);
  if (url.pathname === "/set") {
    const value = url.searchParams.get("value") ?? "";
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `probe=${encodeURIComponent(value)}; Path=/; SameSite=Lax`,
    });
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>set-${value}</title></head>` +
        `<body><p id="done">set</p></body></html>`,
    );
    return;
  }
  const cookies = req.headers.cookie ?? "";
  const probe = /(?:^|;\s*)probe=([^;]*)/.exec(cookies)?.[1] ?? "";
  const seen = probe ? decodeURIComponent(probe) : "none";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${seen}</title></head>` +
      `<body><p id="probe">${seen}</p></body></html>`,
  );
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

mkdirSync(join(userData, "profiles"), { recursive: true });
const now = new Date().toISOString();
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: "site-1",
        name: "演示站点",
        baseUrl: ORIGIN,
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
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

function launchApp() {
  return spawn(electronBinary, [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`], {
    env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const app = launchApp();
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

/**
 * Connects to a freshly started app on the same user data.
 *
 * `waitForWindow` caches the first launch's debug port, and a restart binds a
 * new one, so this reads `DevToolsActivePort` directly and connects itself.
 */
async function reconnect() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    await wait(300);
    try {
      const [first] = (await readFile(join(userData, "DevToolsActivePort"), "utf8")).split(
        /\r?\n/,
      );
      const port = Number.parseInt(first ?? "", 10);
      if (!Number.isInteger(port) || port <= 0) continue;
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools"),
      );
      if (target) return await connectToWindow(target.webSocketDebuggerUrl);
    } catch {
      // The file and the endpoint both appear only once the app is up.
    }
  }
  throw new Error("重启后的应用窗口没有出现");
}

/** Opens the account form and reports the fold's state. */
async function openAccountForm(client) {
  return inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // The account column's 账号 entry opens the accounts page in a floating pane.
    document.querySelector('[data-rail-entry="identities"]')?.click();
    for (let attempt = 0; attempt < 20 && !document.querySelector('[data-floating-pane]'); attempt += 1) {
      await wait(80);
    }
    // The pane opens on its launch face, where the header carries only the face
    // switch: creating an account is a write, so it lives on the edit face.
    // Switch there, then open the create menu — one `+`, two branches.
    document.querySelector('[data-mode-edit]')?.click();
    await wait(350);
    // The empty state spells both doors out; a populated list keeps them behind
    // the `+`. Try the direct button first, then the menu.
    let newAccount = document.querySelector('[data-new-account]');
    if (!newAccount) {
      document.querySelector('[data-create-entry]')?.click();
      await wait(250);
      newAccount = document.querySelector('[data-new-account]');
    }
    newAccount?.click();
    await wait(600);
    const toggle = document.querySelector('[data-advanced-toggle]');
    return {
      dialogOpen: Boolean(document.querySelector('.content .form')),
      toggleText: toggle?.textContent?.trim() ?? null,
      panelClosed: document.querySelector('[data-advanced-panel]') === null,
      expanded: toggle?.getAttribute('aria-expanded') === 'true',
    };
  `,
  );
}

try {
  let client;
  try {
    client = await waitForWindow({ userData, waitForDebugPort });
  } catch (error) {
    check("app window appeared", false, appLog.slice(-600));
    throw error;
  }
  check("app window appeared", true);
  // The account rail starts collapsed; this suite reads its chips.
  await client.evaluate(openRail());
  await wait(400);
  await wait(3000);

  // --- 1. The account form's isolation fold, closed by default -------------
  const form = await openAccountForm(client);
  check(
    "the account form opens with an isolation fold",
    form?.dialogOpen === true && form?.toggleText !== null && form.toggleText.length > 0,
    form,
  );
  check(
    "the isolation fold starts collapsed",
    form?.panelClosed === true && form?.expanded === false,
    form,
  );

  const fold = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-advanced-toggle]')?.click();
    await wait(300);
    const panel = document.querySelector('[data-advanced-panel]');
    return {
      note: panel?.querySelector('.note')?.textContent?.trim() ?? null,
      // A brand-new account has no session data yet, so the fold holds only
      // the sentence — no action.
      clearButton: Boolean(panel?.querySelector('[data-clear-session]')),
    };
  `,
  );
  check(
    "expanding the fold explains isolation and offers no action yet",
    fold?.note?.includes("独立保存") === true && fold?.clearButton === false,
    fold,
  );

  // Close the dialog; the account is not saved (no site exists and the fold is
  // what this section tests, not the form's validation).
  await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '取消')?.click();
    await wait(300);
  `,
  );

  // A saved account's fold holds the one action that touches session data, and
  // the footer no longer carries it — the default path through the form stays
  // free of it.
  await inApp(
    client,
    `
    const api = window.ensemble;
    await api.saveIdentity({
      siteId: "site-1",
      name: "隔离检查账号",
      username: "isolated@example.test",
      role: "member",
      color: "teal",
      passwordMode: "inherit",
      startPath: "/",
    });
  `,
  );
  await wait(700);
  const editFold = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Rows and their per-row actions are the edit face's; the launch face has
    // tiles and no edit affordance at all.
    if (!document.querySelector('[data-mode-edit][aria-pressed="true"]')) {
      document.querySelector('[data-mode-edit]')?.click();
      await wait(350);
    }
    document.querySelector('[data-edit-identity]')?.click();
    await wait(700);
    document.querySelector('[data-advanced-toggle]')?.click();
    await wait(300);
    const clearButton = document.querySelector('[data-clear-session]');
    const footerText = document.querySelector('.content .foot')?.textContent ?? '';
    return {
      footerFound: footerText.length > 0,
      clearButtonThere: Boolean(clearButton),
      clearLabel: clearButton?.textContent?.trim() ?? null,
      footerHasClear: footerText.includes('清除会话数据'),
    };
  `,
  );
  check(
    "a saved account's fold holds the clear-session action",
    editFold?.clearButtonThere === true && editFold?.clearLabel === "清除会话数据",
    editFold,
  );
  check(
    "the clear-session action lives in the fold, not the footer",
    editFold?.footerFound === true && editFold?.footerHasClear === false,
    editFold,
  );
  await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '取消')?.click();
    await wait(300);
  `,
  );

  // --- 2. No profile surface in the everyday paths -------------------------
  // The account form left the app on the accounts page, which is a floating
  // pane over the browser; the toolbar surfaces under test live on the browser
  // itself, so the pane goes first.
  await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-floating-pane] [data-pane-close]')?.click();
    await wait(700);
  `,
  );
  const chooser = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 0; attempt < 4 && !document.querySelector('.open-menu'); attempt += 1) {
      document.querySelector('.toolbar .split-arrow')?.click();
      await wait(700);
    }
    const state = await window.ensemble.getEmbeddedState();
    return {
      open: Boolean(document.querySelector('.open-menu')),
      profileTabs: document.querySelectorAll('.open-menu .mode[data-mode="profiles"]').length,
      profileRows: document.querySelectorAll('.open-menu .profile-row').length,
      accountOpenings: document.querySelectorAll('.open-menu [data-open-daily], .open-menu [data-open-clean]').length,
      tabs: state.tabs.length,
    };
  `,
  );
  check(
    "the new-browser chooser has no profile tab and no profile rows",
    chooser?.open === true && chooser?.profileTabs === 0 && chooser?.profileRows === 0,
    chooser,
  );
  check(
    "the chooser keeps the site-less openings (default profile, clean session)",
    chooser?.accountOpenings === 2,
    chooser,
  );

  const menu = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.body.click();
    await wait(300);
    document.querySelector('.app-menu-anchor .app-menu-btn')?.click();
    await wait(500);
    return {
      profilesRow: document.querySelectorAll('.app-menu [data-menu-item="profiles"]').length,
      bookmarksRow: document.querySelectorAll('.app-menu [data-menu-item="bookmarks"]').length,
    };
  `,
  );
  check(
    // 书签的入口在管理窗格的「更多」组（W2-A），应用菜单不保留页面入口；
    // 这里两行都应为 0。
    "the toolbar menu has no profiles row",
    menu?.profilesRow === 0 && menu?.bookmarksRow === 0,
    menu,
  );
  await inApp(client, `document.body.click(); await new Promise((r) => setTimeout(r, 300));`);

  // --- 3. Two profiles sign in, then the invitation appears ----------------
  const created = await inApp(
    client,
    `
    const api = window.ensemble;
    await api.createProfile("工作档案");
    const settings = await api.createProfile("对照档案");
    return settings.profiles.map((item) => ({ id: item.id, name: item.name }));
  `,
  );
  const work = created?.find((item) => item.name === "工作档案");
  const alt = created?.find((item) => item.name === "对照档案");
  check(
    "two user profiles exist alongside the built-ins",
    Boolean(work?.id) && Boolean(alt?.id) && created?.length === 4,
    created?.map((item) => item.name),
  );

  // Each jar signs in to the probe page: a cookie in its own partition. The
  // partition is read while the page is open — the closed page leaves no record.
  const seeded = [];
  for (const [profile, value] of [
    [work, "work-login"],
    [alt, "alt-login"],
  ]) {
    seeded.push(
      await inApp(
        client,
        `
        const api = window.ensemble;
        const tab = await api.openEmbeddedTab({
          url: ${JSON.stringify(`${ORIGIN}/set?value=` + value)},
          profileId: ${JSON.stringify(profile?.id ?? "")},
          viewId: null,
        });
        await new Promise((r) => setTimeout(r, 1500));
        const state = await api.getEmbeddedState();
        const live = state.tabs.find((item) => item.id === tab.id);
        const seen = { profileId: live?.profileId ?? null, partition: live?.partition ?? null };
        await api.closeEmbeddedTab(tab.id).catch(() => {});
        return seen;
      `,
      ),
    );
  }
  check(
    "each profile's page carried its own partition",
    seeded?.[0]?.profileId === work?.id &&
      seeded?.[1]?.profileId === alt?.id &&
      seeded?.[0]?.partition !== seeded?.[1]?.partition,
    seeded,
  );

  await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 0; attempt < 4 && !document.querySelector('.page.settings'); attempt += 1) {
      // Settings is the one full-window page left; the app menu is its door.
      document.querySelector('[data-app-menu]')?.click();
      await wait(300);
      document.querySelector('[data-menu-item="settings"]')?.click();
      await wait(700);
    }
    // Settings opens on general; the invitation lives on the data tab.
    const dataTab = [...document.querySelectorAll('.page.settings [data-section]')]
      .find((el) => el.dataset.section === 'data');
    dataTab?.click();
    await wait(500);
  `,
  );
  const invite = await inApp(
    client,
    `
    return {
      invite: Boolean(document.querySelector('[data-merge-apply]')),
      names: document.querySelector('.merge-names')?.textContent?.trim() ?? null,
      note: document.querySelector('[data-merge-note]')?.textContent?.trim() ?? null,
      keep: document.querySelector('[data-merge-keep]')?.textContent?.trim() ?? null,
    };
  `,
  );
  check(
    "settings shows the merge invitation naming both profiles",
    invite?.invite === true && invite?.names === "工作档案、对照档案",
    invite,
  );
  check(
    "the invitation warns about re-sign-in and kept data before any click",
    invite?.note?.includes("重新登录") === true && invite?.note?.includes("保留") === true,
    invite?.note,
  );

  // --- 4. Merging: two rows leave, the default takes over, data stays ------
  await inApp(client, `document.querySelector('[data-merge-apply]')?.click();`);
  await wait(600);
  const mergeConfirm = await inApp(
    client,
    `
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // The confirm is an alert dialog with its own two-button row; the answer is
    // the second one, whatever the label currently reads.
    const alert = document.querySelector('[role="alertdialog"]');
    const buttons = [...(alert?.querySelectorAll('.actions button') ?? [])];
    const confirm = buttons[buttons.length - 1];
    const bodyText = alert?.textContent ?? '';
    confirm?.click();
    await wait(900);
    const after = await window.ensemble.getWorkspace();
    return {
      warnedAgain: bodyText.includes('重新登录'),
      profileIds: after.settings.profiles.map((item) => item.id).sort(),
      profileNames: after.settings.profiles.map((item) => item.name),
      defaultProfileId: after.settings.defaultProfileId,
      inviteGone: document.querySelector('[data-merge-apply]') === null,
    };
  `,
  );
  check(
    "the confirm dialog repeats the re-sign-in warning",
    mergeConfirm?.warnedAgain === true,
    mergeConfirm,
  );
  // Identified by id, not by name: the two built-ins keep their ids across a
  // change of wording, and the point of the check is that only they survive.
  check(
    "merging leaves exactly the built-in profiles with the default in charge",
    mergeConfirm?.profileIds?.length === 2 &&
      mergeConfirm?.profileIds?.includes("default") === true &&
      mergeConfirm?.profileIds?.includes("clean") === true &&
      mergeConfirm?.defaultProfileId === "default",
    mergeConfirm,
  );
  check(
    "the invitation leaves the settings page once answered",
    mergeConfirm?.inviteGone === true,
    mergeConfirm,
  );

  // --- 5. Restart: the default profile serves account-less pages, the merged
  //     jars' data is still on disk, their cookies are not in the default ----
  client.close();
  app.kill();
  await new Promise((done) => setTimeout(done, 2500));

  const second = launchApp();
  second.stdout.on("data", (chunk) => (appLog += chunk));
  second.stderr.on("data", (chunk) => (appLog += chunk));
  client = await reconnect();
  await wait(2500);

  const reopened = await inApp(
    client,
    `
    const api = window.ensemble;
    const tab = await api.openEmbeddedTab({ url: ${JSON.stringify(`${ORIGIN}/read`)}, viewId: null });
    await new Promise((r) => setTimeout(r, 1800));
    const state = await api.getEmbeddedState();
    const live = state.tabs.find((item) => item.id === tab.id);
    return {
      partition: live?.partition ?? null,
      profileId: live?.profileId ?? null,
      title: live?.title ?? null,
      profiles: (await api.getWorkspace()).settings.profiles.length,
    };
  `,
  );
  check(
    "after a restart an account-less page lands in the default profile",
    reopened?.partition === "persist:embedded-clean" &&
      (reopened?.profileId === "default" || reopened?.profileId === null),
    reopened,
  );
  check(
    "the default partition does not hold a merged profile's cookie",
    reopened?.title === "none",
    { title: reopened?.title, partition: reopened?.partition },
  );

  const keptOnDisk =
    existsSync(join(userData, "Partitions", `profile-${work?.id}`)) &&
    existsSync(join(userData, "Partitions", `profile-${alt?.id}`));
  check(
    "the merged profiles' partition data is still on disk",
    keptOnDisk,
    { work: join(userData, "Partitions", `profile-${work?.id}`) },
  );
  check(
    "the workspace still reports exactly the two built-ins after the restart",
    reopened?.profiles === 2,
    reopened?.profiles,
  );

  client.close();
} catch (error) {
  check("run completed", false, String(error));
  console.log("--- app log ---\n" + appLog.slice(-3000));
} finally {
  app.kill();
  await new Promise((done) => page.close(done));
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
