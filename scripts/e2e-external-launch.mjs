#!/usr/bin/env node
/**
 * End-to-end check of the external launch path.
 *
 * The external surface had no UI-level coverage at all: its launch methods
 * existed and were reachable only through a global mode that nothing verified.
 * Now every launch point carries its own browser list, which means "pick the
 * built-in surface" and "pick a real browser" are two branches of one control —
 * and the branch that opens a real browser window is the one that can silently
 * stop working without any page looking wrong.
 *
 * What this asserts, in order:
 *
 * 1. The profile page's launch control opens a **real browser window** when an
 *    engine is picked, and the window is recorded as an instance in that profile.
 * 2. The clean session's row does the same but with `clean: true`, so its
 *    directory is disposable.
 * 3. The account page's card menu opens the account in the picked browser.
 * 4. Nothing was left running when the app was asked to stop everything.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-launch-"));

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: "site-1",
        name: "本地控制台",
        baseUrl: "http://127.0.0.1:9",
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    identities: [
      {
        id: "identity-1",
        siteId: "site-1",
        name: "管理员 · 主账号",
        username: "admin@example.test",
        role: "管理员",
        color: "amber",
        passwordMode: "inherit",
        status: "unknown",
        startPath: "/",
        tagIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "identities",
    guideVersion: GUIDE_SEEN,
    layout: "free",
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

async function inApp(client, body) {
  return client.evaluate(`(async () => { ${body} })()`);
}

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)
      ).json();
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
  await wait(2500);

  // --- 0. There is a real browser to launch into ---------------------------
  const engines = await inApp(
    client,
    `
    const workspace = await window.ensemble.getWorkspace();
    return workspace.engines.map((engine) => ({
      id: engine.id,
      brand: engine.brand,
      status: engine.status,
    }));
  `,
  );
  const usable = (engines ?? []).find((engine) => engine.status !== "blocked");
  check(
    "the app found a real browser to launch into",
    Boolean(usable?.id),
    engines,
  );
  if (!usable) throw new Error("no usable engine");

  // --- 1. A profile row opens a real window in that browser -----------------
  const profileWindow = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = (await api.getWorkspace()).instances.map((item) => item.id);
    const result = await api.launchProfile('work-check', { engineId: ${JSON.stringify(usable.id)} });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await api.getWorkspace();
    const instance = after.instances.find((item) => !before.includes(item.id));
    return {
      launchedId: result?.instance?.id ?? null,
      label: instance?.label ?? null,
      engineId: instance?.engineId ?? null,
      profileId: instance?.profileId ?? null,
      profileDir: instance?.profileDir ?? null,
      mode: instance?.mode ?? null,
    };
  `,
  ).catch((error) => ({ error: String(error?.message ?? error) }));
  check(
    "a profile row opens a real browser window in the picked engine",
    profileWindow?.engineId === usable.id &&
      profileWindow?.mode === "cdp" &&
      profileWindow?.profileId === "work-check",
    profileWindow,
  );
  check(
    "the window's profile directory is named after the profile, not a site",
    // The point of the segment: a profile is not a site, so its directory has to
    // be findable by profile id and must not sit under a site id.
    String(profileWindow?.profileDir ?? "").includes("work-check") &&
      !String(profileWindow?.profileDir ?? "").includes("site-1"),
    { profileDir: profileWindow?.profileDir },
  );

  // --- 2. The clean row's window is disposable ------------------------------
  const cleanWindow = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = (await api.getWorkspace()).instances.map((item) => item.id);
    await api.launchProfile('clean', { engineId: ${JSON.stringify(usable.id)} });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await api.getWorkspace();
    const instance = after.instances.find((item) => !before.includes(item.id));
    return {
      clean: instance?.clean ?? false,
      profileDir: instance?.profileDir ?? null,
      profileId: instance?.profileId ?? null,
    };
  `,
  ).catch((error) => ({ error: String(error?.message ?? error) }));
  check(
    "the clean row opens a throwaway window",
    cleanWindow?.clean === true &&
      String(cleanWindow?.profileDir ?? "").includes("clean-"),
    cleanWindow,
  );

  // --- 3. An account opens in the picked browser ----------------------------
  const accountWindow = await inApp(
    client,
    `
    const api = window.ensemble;
    const before = (await api.getWorkspace()).instances.map((item) => item.id);
    await api.launchIdentity('identity-1', undefined, ${JSON.stringify(usable.id)});
    await new Promise((r) => setTimeout(r, 2500));
    const after = await api.getWorkspace();
    const instance = after.instances.find((item) => !before.includes(item.id));
    return {
      identityId: instance?.identityId ?? null,
      engineId: instance?.engineId ?? null,
      label: instance?.label ?? null,
    };
  `,
  ).catch((error) => ({ error: String(error?.message ?? error) }));
  check(
    "an account opens in the browser the caller picked",
    accountWindow?.identityId === "identity-1" && accountWindow?.engineId === usable.id,
    accountWindow,
  );

  // --- 4. Everything is closed on request -----------------------------------
  const stopped = await inApp(
    client,
    `
    const api = window.ensemble;
    await api.stopAll();
    await new Promise((r) => setTimeout(r, 2000));
    return { left: (await api.getWorkspace()).instances.length };
  `,
  );
  check("stop-all leaves no instance behind", stopped?.left === 0, stopped);

  client.close();
} catch (error) {
  check("run completed", false, String(error));
  console.log("--- app log ---\n" + appLog.slice(-3000));
} finally {
  app.kill();
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
