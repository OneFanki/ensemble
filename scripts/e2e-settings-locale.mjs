#!/usr/bin/env node
/**
 * End-to-end check of the language picker's "follow system" option.
 *
 * The picker's first segment stores `"system"`, and the settings patch schema
 * used to list only zh/en — clicking the segment surfaced the raw zod issues as
 * a toast and never saved. This drives the real click through IPC and asserts
 * the setting lands; a schema rejection would leave the seeded "zh" in place.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-locale-"));
const port = await freePort();
const now = new Date().toISOString();

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [],
    views: [],
    flows: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
    bookmarkFolders: [],
  }),
);
// Seeded to "zh" so a successful click visibly flips the stored value.
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "sites", onboardingVersion: 1 }),
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

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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

async function waitFor(client, expression, timeout = 5000) {
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

  await client.evaluate(`document.querySelector('[data-nav="settings"]')?.click()`);
  check(
    "settings page rendered with the language picker",
    await waitFor(
      client,
      `[...document.querySelectorAll('button.seg')].some((b) => b.textContent.trim() === '跟随系统')`,
    ),
  );

  await client.evaluate(`(() => {
    // "跟随系统" labels both the theme and the language segments; anchor on the
    // 语言 row so the click lands on the locale picker's first segment.
    const row = [...document.querySelectorAll('.option-row')].find(
      (item) => item.querySelector('.option-label')?.textContent?.trim() === '语言',
    );
    row?.querySelector('button.seg')?.click();
  })()`);
  await wait(800);

  const state = await client.evaluate(
    `(async () => {
      const snapshot = await window.ensemble.getWorkspace();
      return {
        locale: snapshot.settings.locale,
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
      };
    })()`,
  );
  check(
    "clicking 跟随系统 saves locale=system",
    state?.locale === "system",
    state,
  );
  check(
    "no schema rejection toast",
    (state?.toasts ?? []).every((text) => !text.includes("invalid_value")),
    state?.toasts,
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
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
