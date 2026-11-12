#!/usr/bin/env node
/**
 * End-to-end check of browser profiles.
 *
 * The claim a profile makes is a storage boundary, and the only way to test a
 * storage boundary is to store something on one side and look for it from the
 * other. Four things have to hold:
 *
 * 1. Two profiles get different session partitions, and a cookie set in one is
 *    invisible from the other — through a real page, not through the records.
 * 2. One profile reuses its partition: a second browser in the same profile sees
 *    the first browser's cookie. That is what makes a profile worth keeping.
 * 3. A throwaway profile never keeps anything, and two of its browsers do not
 *    share.
 * 4. The default profile setting decides where an account-less page lands.
 *
 * Plus the panel and page that manage profiles, driven the way a user would.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-profiles-"));

/**
 * A page that can be told to set a cookie, and that reports the cookie it sees.
 *
 * `/set?value=x` stores a cookie, and `/read` puts whatever cookie reached the
 * server into the document title. The title is the observable that needs no
 * script channel: the browser's own tab record carries it, so "which cookie jar
 * is this page in" can be answered from the state the chrome already shows.
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
    bookmarks: [{ id: "b1", name: "档案检查", url: ORIGIN, order: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
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

/**
 * Opens a browser in `profileId` at `url` and reports the session it landed in.
 *
 * The partition is read back from the published tab rather than re-derived: a
 * test that recomputed it from the same helper the app uses would pass while the
 * app handed the page the wrong one.
 */
async function probe(client, profileId, url) {
  return inApp(
    client,
    `
    const api = window.ensemble;
    const tab = await api.openEmbeddedTab({
      url: ${JSON.stringify(url)},
      profileId: ${JSON.stringify(profileId)},
      viewId: null,
    });
    await new Promise((r) => setTimeout(r, 1800));
    const state = await api.getEmbeddedState();
    const live = state.tabs.find((item) => item.id === tab.id);
    return {
      id: tab.id,
      partition: live?.partition ?? tab.partition,
      profileId: live?.profileId ?? null,
      title: live?.title ?? null,
      url: live?.url ?? null,
    };
  `,
  );
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

  // --- 1. Two profiles are two cookie jars --------------------------------
  const createdA = await inApp(
    client,
    `return await window.ensemble.createProfile("工作档案");`,
  );
  const createdB = await inApp(
    client,
    `return await window.ensemble.createProfile("对照档案");`,
  );
  const profiles = createdB?.profiles ?? [];
  const profileA = profiles.find((item) => item.name === "工作档案");
  const profileB = profiles.find((item) => item.name === "对照档案");
  check(
    "profiles can be created and both are listed",
    Boolean(profileA?.id) && Boolean(profileB?.id) && profiles.length === 4,
    profiles.map((item) => item.name),
  );

  const seeded = await inApp(
    client,
    `
    const api = window.ensemble;
    const tab = await api.openEmbeddedTab({
      url: ${JSON.stringify(`${ORIGIN}/set?value=alpha`)},
      profileId: ${JSON.stringify(profileA?.id ?? "")},
      viewId: null,
    });
    await new Promise((r) => setTimeout(r, 1800));
    const state = await api.getEmbeddedState();
    const live = state.tabs.find((item) => item.id === tab.id);
    return { partition: live?.partition ?? null, profileId: live?.profileId ?? null };
  `,
  );
  check(
    "a browser opened in a profile records that profile",
    seeded?.profileId === profileA?.id,
    seeded,
  );

  const readA = await probe(client, profileA?.id ?? "", `${ORIGIN}/read`);
  const readB = await probe(client, profileB?.id ?? "", `${ORIGIN}/read`);
  check(
    "a cookie set in one profile is not visible from another",
    readA?.partition !== readB?.partition &&
      readA?.partition?.includes(profileA?.id ?? "-") === true &&
      readB?.partition?.includes(profileB?.id ?? "-") === true,
    { a: readA?.partition, b: readB?.partition },
  );

  // --- 2. A profile keeps its session between browsers --------------------
  const readA2 = await probe(client, profileA?.id ?? "", `${ORIGIN}/read`);
  check(
    "a second browser in the same profile reuses its partition",
    readA2?.partition === readA?.partition,
    { first: readA?.partition, second: readA2?.partition },
  );

  // The cookie itself, read through the page rather than the records: navigate a
  // browser in each profile to `/read` and read the title the server echoed. A
  // page title reaches the chrome, so this needs no script channel into the page.
  const titles = await inApp(
    client,
    `
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const of = (profileId) =>
      state.tabs
        .filter((tab) => tab.profileId === profileId && tab.url.includes('/read'))
        .map((tab) => tab.title);
    return { a: of(${JSON.stringify(profileA?.id ?? "")}), b: of(${JSON.stringify(profileB?.id ?? "")}) };
  `,
  );
  check(
    "the served page echoes the cookie only in the profile that set it",
    titles?.a?.includes("alpha") === true && titles?.b?.every((title) => title !== "alpha"),
    titles,
  );

  // --- 3. A throwaway profile keeps nothing ---------------------------------
  const clean1 = await inApp(
    client,
    `
    const api = window.ensemble;
    const tab = await api.openEmbeddedTab({
      url: ${JSON.stringify(`${ORIGIN}/set?value=beta`)},
      profileId: "clean",
      ephemeral: true,
      viewId: null,
    });
    await new Promise((r) => setTimeout(r, 1800));
    const state = await api.getEmbeddedState();
    const live = state.tabs.find((item) => item.id === tab.id);
    return { partition: live?.partition ?? null, clean: live?.clean ?? false };
  `,
  );
  const clean2 = await inApp(
    client,
    `
    const api = window.ensemble;
    const tab = await api.openEmbeddedTab({
      url: ${JSON.stringify(`${ORIGIN}/read`)},
      profileId: "clean",
      ephemeral: true,
      viewId: null,
    });
    await new Promise((r) => setTimeout(r, 1800));
    const state = await api.getEmbeddedState();
    const live = state.tabs.find((item) => item.id === tab.id);
    return { partition: live?.partition ?? null, title: live?.title ?? null };
  `,
  );
  check(
    "throwaway browsers get their own in-memory session",
    clean1?.partition !== clean2?.partition &&
      Boolean(clean1?.partition?.startsWith("embedded-clean-")) === true &&
      clean1?.clean === true,
    clean1,
  );
  check(
    "a throwaway browser does not see another one's cookie",
    clean2?.title === "none",
    clean2,
  );

  // --- 4. The default profile decides where an account-less page lands ------
  const switched = await inApp(
    client,
    `return await window.ensemble.setDefaultProfile(${JSON.stringify(profileB?.id ?? "")});`,
  );
  check(
    "a profile can be made the default",
    switched?.defaultProfileId === profileB?.id,
    { defaultProfileId: switched?.defaultProfileId, expected: profileB?.id },
  );

  const implicit = await inApp(
    client,
    `
    const api = window.ensemble;
    const tab = await api.openEmbeddedTab({ url: ${JSON.stringify(`${ORIGIN}/read`)}, viewId: null });
    await new Promise((r) => setTimeout(r, 1500));
    const state = await api.getEmbeddedState();
    const live = state.tabs.find((item) => item.id === tab.id);
    return { profileId: live?.profileId ?? null, partition: live?.partition ?? null };
  `,
  );
  check(
    "a bookmark-style open lands in the default profile",
    implicit?.profileId === profileB?.id,
    { implicit, expected: profileB?.id },
  );

  // --- 5. The built-ins cannot be deleted, and the list survives mode swings --
  const deleteBuiltin = await inApp(
    client,
    `return await window.ensemble.deleteProfile("default").then(() => "deleted").catch((e) => String(e?.message ?? e));`,
  );
  check(
    "the built-in profile cannot be deleted",
    String(deleteBuiltin).includes("内置"),
    { deleteBuiltin },
  );

  const renamed = await inApp(
    client,
    `return await window.ensemble.renameProfile("default", "日常档案");`,
  );
  check(
    "the built-in profile can be renamed",
    renamed?.profiles?.some((item) => item.id === "default" && item.name === "日常档案") === true,
    renamed?.profiles?.map((item) => item.name),
  );

  const ephemeralDefault = await inApp(
    client,
    `return await window.ensemble.setDefaultProfile("clean").then(() => "accepted").catch((e) => String(e?.message ?? e));`,
  );
  check(
    "a throwaway profile cannot become the default",
    String(ephemeralDefault).includes("干净会话"),
    { ephemeralDefault },
  );

  // --- 6. The panel opens a browser in a picked profile --------------------
  const panel = await inApp(
    client,
    `
    const api = window.ensemble;
    const trigger = document.querySelector('.toolbar .split-main');
    for (let attempt = 0; attempt < 3 && !document.querySelector('.open-panel'); attempt += 1) {
      trigger?.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    const modes = [...document.querySelectorAll('.open-menu .mode')].map((el) => el.textContent?.trim() ?? '');
    document.querySelector('.open-menu .mode[data-mode="profiles"]')?.click();
    await new Promise((r) => setTimeout(r, 250));
    const rows = [...document.querySelectorAll('.open-menu .profile-row')].map((el) => ({
      name: el.querySelector('.acc-name')?.textContent?.trim() ?? '',
      default: Boolean(el.querySelector('.badge')),
    }));
    const before = await api.getEmbeddedState();
    const target = [...document.querySelectorAll('.open-menu .profile-row')]
      .find((el) => el.textContent?.includes('工作档案'));
    target?.click();
    await new Promise((r) => setTimeout(r, 1800));
    const after = await api.getEmbeddedState();
    const added = after.tabs.filter((tab) => !before.tabs.some((old) => old.id === tab.id));
    const live = added[0] ?? null;
    return {
      modes,
      rows,
      panelOpen: Boolean(document.querySelector('.open-panel')),
      profileId: live?.profileId ?? null,
      partition: live?.partition ?? null,
      url: live?.url ?? null,
    };
  `,
  );
  check(
    "the panel offers the account and profile modes, accounts first",
    panel?.modes?.[0] === "账号" && panel?.modes?.[1] === "档案",
    panel?.modes,
  );
  check(
    "the profile list marks exactly the default",
    panel?.rows?.filter((row) => row.default)?.length === 1,
    panel?.rows,
  );
  check(
    "picking a profile opens a blank browser in it and closes the panel",
    panel?.profileId === profileA?.id &&
      panel?.url === "about:blank" &&
      panel?.partition === readA?.partition &&
      panel?.panelOpen === false,
    panel,
  );

  // --- 7. The profiles page manages the list ------------------------------
  // Reached through the app menu, which is the door that exists in the plainer
  // shell too: the sidebar (and its 档案 row) only appears in the workbench.
  const page = await inApp(
    client,
    `
    const menu = document.querySelector('[data-app-menu]')?.querySelector('button');
    // The toolbar's app menu trigger, whatever its icon is today.
    document.querySelector('.app-menu-anchor button')?.click();
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('[data-menu-item="profiles"]')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('.profiles .row')].map((el) => ({
      name: el.querySelector('.row-name')?.textContent?.trim() ?? '',
      default: Boolean(el.querySelector('.badge')),
      canDelete:
        Boolean(el.querySelector('[data-profile-delete]')) &&
        !el.querySelector('[data-profile-delete]')?.disabled,
    }));
    return {
      opened: Boolean(document.querySelector('.profiles')),
      rows,
      menuFound: Boolean(document.querySelector('[data-menu-item="profiles"]')),
      hadMenu: Boolean(menu),
    };
  `,
  );
  check(
    "the profiles page is reachable from the app menu",
    page?.opened === true && page?.rows?.length === 4,
    { opened: page?.opened, rows: page?.rows, menuFound: page?.menuFound },
  );
  check(
    "the page marks the default and hides delete on built-ins",
    page?.rows?.filter((row) => row.default)?.length === 1 &&
      page?.rows?.find((row) => row.name === "日常档案")?.canDelete === false &&
      page?.rows?.find((row) => row.name === "工作档案")?.canDelete === true,
    page?.rows,
  );
  const removed = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = await api.getWorkspace();
    const target = before.settings.profiles.find((item) => item.name === '对照档案');
    document.querySelector('[data-profile-delete="' + target.id + '"]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    // The confirmation dialog owns the decision; press its destructive button.
    const buttons = [...document.querySelectorAll('.content.actions button, .actions button')];
    const confirm = buttons.find((el) => el.textContent?.trim() === '删除');
    confirm?.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = await api.getWorkspace();
    return {
      before: before.settings.profiles.length,
      after: after.settings.profiles.length,
      names: after.settings.profiles.map((item) => item.name),
      // Deleting the default has to leave the choice somewhere real.
      defaultProfileId: after.settings.defaultProfileId,
    };
  `,
  );
  check(
    "deleting a user profile removes it and hands the default to a real profile",
    removed?.after === removed?.before - 1 &&
      !removed?.names?.includes("对照档案") &&
      removed?.defaultProfileId !== profileB?.id,
    removed,
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
