#!/usr/bin/env node
/**
 * End-to-end check of launch reveal timing: the switch to the browser page must
 * happen when the launch *starts*, not when the page has finished loading.
 *
 * Reported symptom: clicking an account card left the user staring at the
 * accounts page for seconds — the reveal event used to fire only after
 * `createTab` returned, and `createTab` waits out the carrier attaching plus the
 * page's first load. A slow page made the wait obvious, and a slow view launch
 * (one load per member) made it worse.
 *
 * The probe starts a local page that stalls before answering, then watches for
 * the reveal event while the launch promise is still pending. Both UI entries
 * are checked: a single account (`openEmbeddedIdentity`) and a saved view
 * (`openEmbeddedView`).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-reveal-"));

const page = createServer((req, res) => {
  // Stalling here is the point: createTab must not resolve before the page does,
  // which is what makes the reveal timing observable at all.
  setTimeout(() => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>慢页 ${req.url}</title><h1>${req.url}</h1>`);
  }, 2_500);
});
const pagePort = await freePort();
await new Promise((done) => page.listen(pagePort, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${pagePort}`;

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";
const viewId = "22222222-2222-4222-8222-222222222222";
const ids = ["a", "b"].map(
  (c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`,
);

function identity(id, name) {
  return {
    id,
    siteId,
    name,
    username: `${name}@example.test`,
    role: "member",
    color: "teal",
    passwordMode: "inherit",
    status: "unknown",
    // The stall is what stretches createTab past the reveal event.
    startPath: "/slow",
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
        name: "启动站点",
        baseUrl,
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [identity(ids[0], "账号甲"), identity(ids[1], "账号乙")],
    views: [
      {
        id: viewId,
        siteId,
        name: "启动视图",
        identityIds: [ids[0], ids[1]],
        layoutId: "2x1",
        slotAssignments: { [ids[0]]: 0, [ids[1]]: 1 },
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
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: 1 }),
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

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
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

  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3000);

  // Single account: the reveal event must arrive while the launch is still
  // pending, and the page itself must still land.
  const single = await client.evaluate(`(async () => {
    let revealAt = 0;
    window.ensemble.onEmbeddedPage(() => { revealAt = Date.now(); });
    const startedAt = Date.now();
    const launch = window.ensemble.openEmbeddedIdentity('${ids[0]}');
    await new Promise((r) => setTimeout(r, 500));
    const revealedWhilePending = revealAt > 0;
    const state = await launch;
    return {
      revealedWhilePending,
      resolveMs: Date.now() - startedAt,
      tabs: state.tabs.filter((t) => t.identityId === '${ids[0]}').length,
    };
  })()`);
  check(
    "an account launch reveals the browser page before the page loads",
    single?.revealedWhilePending === true,
    single,
  );
  check(
    "the launched page still lands after the slow load",
    single?.tabs === 1 && (single?.resolveMs ?? 0) > 2_000,
    single,
  );

  // Saved view: same probe with one load per member, so the old ordering held
  // the reveal back for two loads.
  const view = await client.evaluate(`(async () => {
    let revealAt = 0;
    window.ensemble.onEmbeddedPage(() => { revealAt = Date.now(); });
    const startedAt = Date.now();
    const launch = window.ensemble.openEmbeddedView('${viewId}');
    await new Promise((r) => setTimeout(r, 500));
    const revealedWhilePending = revealAt > 0;
    const state = await launch;
    return {
      revealedWhilePending,
      resolveMs: Date.now() - startedAt,
      slots: state.views.find((v) => v.id === state.activeViewId)?.slotTabs?.filter(Boolean).length,
    };
  })()`);
  check(
    "a view launch reveals the browser page before its members load",
    view?.revealedWhilePending === true,
    view,
  );
  check(
    "the view still lands with every member after the loads",
    view?.slots === 2 && (view?.resolveMs ?? 0) > 2_000,
    view,
  );

  client.close();
} catch (error) {
  check("run completed", false, error?.stack ?? String(error));
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
