#!/usr/bin/env node
/**
 * First-run behaviour: the guide opens itself once, and the neutral layout is
 * what a fresh install gets.
 *
 * Both are things a returning user cannot see and an e2e that seeds a workspace
 * cannot cover: the guide only auto-opens while `guideVersion` is unset, and the
 * layout default only applies while the user has never picked one. So this suite
 * starts from a settings file with neither, which is what a new install looks
 * like.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-firstrun-"));
const uuid = (index) =>
  `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: uuid(1),
        name: "本地开发环境",
        baseUrl: "http://127.0.0.1:9/",
        loginPath: "/login",
      },
    ],
    identities: [
      {
        id: uuid(2),
        siteId: uuid(1),
        name: "管理员 · 主账号",
        username: "admin",
        role: "管理员",
        color: "amber",
      },
    ],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
    bookmarkFolders: [],
  }),
);
// Deliberately no `guideVersion` and no `layout`: a fresh install.
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser" }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(electronBinary, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

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
        throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
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

async function waitFor(client, expression, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

let client;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const port = await waitForDebugPort(userData);
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  client = await connect(target.webSocketDebuggerUrl);
  await wait(3200);

  // --- The guide introduces the app on its own -----------------------------
  const firstRun = await waitFor(client, `Boolean(document.querySelector('.guide-backdrop'))`).then(
    () =>
      client.evaluate(`(() => {
        const dialog = document.querySelector('.guide-backdrop');
        return {
          open: Boolean(dialog),
          title: dialog?.querySelector('.guide-title')?.textContent?.trim() ?? '',
          // The first screen is the diagram plus the AI turn — not a list of
          // features the user has not needed yet.
          hasPath: Boolean(dialog?.querySelector('ol.path')),
          sections: dialog?.querySelectorAll('.guide-nav .nav-entry').length ?? 0,
        };
      })()`),
  );
  check(
    "a fresh install opens the guide by itself",
    firstRun?.open === true && firstRun?.title.length > 0 && firstRun?.sections >= 3,
    firstRun,
  );

  // Opening it counts as reading it: closing and reopening the app must not
  // show it again.
  await client.evaluate(`(() => {
    document.querySelector('.guide-close')?.click();
    return true;
  })()`);
  await wait(400);
  const closed = await client.evaluate(`(() => {
    const hidden = !document.querySelector('.guide-backdrop');
    return { hidden };
  })()`);
  check("the guide closes and stays closed", closed?.hidden === true, closed);

  const stored = await client.evaluate(`(async () => {
    const snap = await window.ensemble.getWorkspace();
    return { guideVersion: snap.settings.guideVersion ?? 0 };
  })()`);
  check(
    "opening the guide records that it was read",
    Number(stored?.guideVersion) >= 1,
    stored,
  );

  // --- Neutral layout out of the box ---------------------------------------
  // Both entry points start with one page, so the default must not pre-split
  // the stage into cells the user never asked for.
  const layouts = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const snap = await api.getWorkspace();
    const created = await api.createEmbeddedView({ name: "默认布局" });
    const view = created.views.find((item) => item.id === created.activeViewId);
    const identityId = snap.identities[0]?.id;
    return { setting: snap.settings.layout, viewLayout: view?.layoutId, identityId };
  })()`);
  check(
    "a new view starts with no layout",
    layouts?.setting === "free" && layouts?.viewLayout === "free",
    layouts,
  );

  const batch = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const snap = await api.getWorkspace();
    const state = await api.launchEmbeddedIdentities([snap.identities[0].id]);
    const view = state.views.find((item) => item.id === state.activeViewId);
    return {
      viewLayout: view?.layoutId,
      slotTabs: view?.slotTabs,
      pages: state.tabs.filter((tab) => tab.viewId === state.activeViewId).length,
    };
  })()`);
  check(
    "a batch launch lays its pages out without a grid",
    batch?.viewLayout === "free" && batch?.pages === 1,
    batch,
  );

  // A user's choice has to survive: picking a layout in Settings stops the
  // factory default from overriding it on the next start.
  const chosen = await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.saveAppSettings({ layout: "2x2" });
    const snap = await api.getWorkspace();
    return { layout: snap.settings.layout, explicit: snap.settings.layoutExplicit };
  })()`);
  check(
    "picking a layout marks it as the user's choice",
    chosen?.layout === "2x2" && chosen?.explicit === true,
    chosen,
  );

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  client?.close();
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
