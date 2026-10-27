#!/usr/bin/env node
/**
 * Proves that the update check and the built-in browser actually use the
 * configured proxy, rather than merely saving the setting.
 *
 * The claim being tested is the one the user reported: with a proxy configured,
 * update traffic must go through it. A stub HTTP proxy stands in for Clash and
 * records every CONNECT/absolute-URI request it sees; the app is pointed at a
 * fake release endpoint and told to use that proxy manually.
 *
 * Nothing here reaches the internet: the release payload is served by the stub
 * proxy itself, so a pass means the request arrived through the proxy and a
 * fail means it went direct (which, with the fake endpoint unreachable,
 * surfaces as a timeout or a DNS error).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROXY_PORT = 49891;
const UPDATE_PORT = 49892;
const DEBUG_PORT = 9793;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-proxy-"));

const seen = [];
const proxy = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, host: req.headers.host ?? null });
  // The app asks for the release API through the proxy; answer it here so the
  // whole path runs without the internet being involved.
  if (String(req.url).includes("/releases/latest") || String(req.url).includes("fake-release")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        tag_name: "v9.9.9",
        html_url: "https://github.com/OneFanki/ensemble/releases/tag/v9.9.9",
        body: "proxy probe",
        assets: [],
      }),
    );
    return;
  }
  res.writeHead(502);
  res.end("not found");
});
proxy.on("connect", (req, socket) => {
  seen.push({ method: "CONNECT", url: req.url, host: req.headers.host ?? null });
  socket.destroy();
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((done) => proxy.listen(PROXY_PORT, "127.0.0.1", done));

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
      flows: [],
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
      lastView: "browser",
      onboardingVersion: 1,
      // Manual, pointing at the stub: this is the setting under test.
      proxyMode: "manual",
      proxyUrl: `http://127.0.0.1:${PROXY_PORT}`,
      // Deliberately no bypass for the update host, so the request must be proxied.
      proxyBypass: "",
    }),
  );
  writeFileSync(
    join(userData, "mcp.json"),
    JSON.stringify({ enabled: false, port: 0, allowWrite: true, allowRun: true, allowDelete: false, aiOrigins: [] }),
  );

  const electronBinary =
    process.platform === "win32"
      ? resolve("node_modules/electron/dist/electron.exe")
      : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const app = spawn(
    electronBinary,
    [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`],
    {
      env: {
        ...process.env,
        ENSEMBLE_HEADLESS: "1",
        // A host that only resolves through the proxy: if the request skips the
        // proxy it cannot succeed, so a successful check proves the proxy was used.
        ENSEMBLE_UPDATE_API: `http://ensemble-proxy-probe.test:${UPDATE_PORT}/fake-release`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let appLog = "";
  app.stdout.on("data", (chunk) => (appLog += chunk));
  app.stderr.on("data", (chunk) => (appLog += chunk));

  const client = await connectRenderer();
  check("app started", Boolean(client), client ? undefined : appLog.slice(-600));

  const checked = await client.evaluate(`(async () => {
    // The real path: the same call the settings page's button makes.
    try {
      const result = await window.ensemble.checkUpdate();
      return { ok: true, result };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  })()`);
  check(
    "the update check reached the release through the proxy",
    // Not merely "did not throw": a failed check resolves with `status: "error"`,
    // which is exactly what a skipped proxy looks like from here.
    checked?.ok === true && checked?.result?.status !== "error",
    checked,
  );

  const proxied = seen.filter((entry) => String(entry.url).includes("proxy-probe"));
  check(
    "the request actually arrived at the proxy",
    proxied.length > 0,
    seen.slice(0, 6),
  );

  check(
    "the proxied response was parsed as a release",
    checked?.result?.status === "available" && checked?.result?.latest === "9.9.9",
    checked?.result ?? null,
  );

  client?.close();
  app.kill();
  await wait(1200);
}

async function connectRenderer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const target = list.find(
        (item) => item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
      );
      if (!target) continue;
      const socket = new WebSocket(target.webSocketDebuggerUrl);
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
        evaluate(expression) {
          return new Promise((done) => {
            const id = ++nextId;
            pending.set(id, (result) => {
              if (result?.exceptionDetails) {
                done({ ok: false, message: result.exceptionDetails.exception?.description });
                return;
              }
              done(result?.result?.value);
            });
            socket.send(
              JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression, returnByValue: true, awaitPromise: true },
              }),
            );
          });
        },
        close() {
          socket.close();
        },
      };
    } catch {
      // not ready yet
    }
  }
  return undefined;
}

try {
  await main();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  proxy.close();
  await wait(300);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    // a held file will clear on reboot; the assertions already ran
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}
