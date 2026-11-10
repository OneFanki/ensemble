#!/usr/bin/env node
/**
 * End-to-end check of the proxy settings' connectivity test.
 *
 * Both probes are pointed at local servers through `ENSEMBLE_CONNECTIVITY_*`,
 * so the flow (button → IPC → `net.fetch` through the session → rendered rows)
 * is exercised without touching the real network. The seeded settings use the
 * manual proxy mode to prove the probe ride the session like the update check
 * does.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PROBE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-connectivity-"));
// Chromium owns the debug port: it picks one at bind time and writes it back,
// so there is no window in which another process can steal the number.
const port = "0";

const zen = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("probe: zen");
});
const noContent = createServer((req, res) => {
  res.writeHead(204);
  res.end();
});
await new Promise((done) => zen.listen(PROBE_PORT, "127.0.0.1", done));
await new Promise((done) => noContent.listen(PROBE_PORT + 1, "127.0.0.1", done));
const UPDATE_API = `http://127.0.0.1:${PROBE_PORT}/zen`;
const EXIT_PROBE = `http://127.0.0.1:${PROBE_PORT + 1}/generate_204`;

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
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "sites",
    guideVersion: GUIDE_SEEN,
    proxyMode: "manual",
    proxyUrl: "http://127.0.0.1:1",
  }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  {
    env: {
      ...process.env,
      ENSEMBLE_HEADLESS: "1",
      ENSEMBLE_CONNECTIVITY_UPDATE_API: UPDATE_API,
      ENSEMBLE_CONNECTIVITY_PROBE: EXIT_PROBE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
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

async function waitFor(client, expression, timeout = 8000) {
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

  await client.evaluate(openNav("settings-general"));
  check(
    "settings page rendered with the test button",
    await waitFor(
      client,
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '测试连接')`,
    ),
  );

  await client.evaluate(`(() => {
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === '测试连接')
      ?.click();
  })()`);

  const readout = await waitFor(
    client,
    `(() => {
      const rows = [...document.querySelectorAll('.probe-row')];
      if (rows.length !== 2) return false;
      if (!rows.every((row) => row.querySelector('.probe-dot.ok'))) return false;
      // The automatic readout is the paragraph right after the probe list.
      const note = document.querySelector('.probe-results')?.nextElementSibling;
      return Boolean(note?.classList.contains('fineprint') && note.textContent.trim().length > 0);
    })()`,
  );
  const state = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.probe-row')].map((row) => ({
      ok: Boolean(row.querySelector('.probe-dot.ok')),
      detail: row.querySelector('.probe-detail')?.textContent?.trim() ?? '',
    }));
    const note = document.querySelector('.probe-results')?.nextElementSibling;
    return {
      rows,
      readout: note?.classList.contains('fineprint') ? note.textContent.trim() : '',
    };
  })()`);
  check("both probes answered ok and rendered", readout === true && state?.rows?.length === 2, state);
  check("the rows carry latencies", (state?.rows ?? []).every((row) => /ms/.test(row.detail)), state);
  check(
    "an automatic readout is shown",
    typeof state?.readout === "string" && state.readout.length > 0,
    state?.readout,
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
  zen.close();
  noContent.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
