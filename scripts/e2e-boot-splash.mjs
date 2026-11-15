#!/usr/bin/env node
/**
 * The opening splash must cover a fully laid-out shell, not share the window
 * with it.
 *
 * Regression: the splash used to be a flex row beside the shell, so during
 * initialization the window was split — logo above, a half-height new tab
 * below — and the layout snapped into place when the boot row disappeared.
 * The splash is now an absolute overlay; this suite samples it while it is up
 * and asserts the shell underneath already has the full window height.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-boot-"));
mkdirSync(join(userData, "profiles"), { recursive: true });
// An empty workspace keeps the first frame about the shell itself. The guide is
// marked read: it opens over everything and would hide the splash timing.
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [],
    views: [],
    flows: [],
    bookmarks: [],
    bookmarkFolders: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
);

const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(electron, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

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
  await new Promise((resolvePromise) => socket.addEventListener("open", resolvePromise));
  return {
    send(method, params = {}) {
      return new Promise((resolvePromise) => {
        const id = ++nextId;
        pending.set(id, resolvePromise);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

const SAMPLE = `(() => {
  const boot = document.querySelector('.boot');
  const shell = document.querySelector('.app-shell > .shell');
  const rect = (element) => element ? element.getBoundingClientRect().toJSON() : null;
  return {
    boot: boot
      ? { position: getComputedStyle(boot).position, rect: rect(boot) }
      : null,
    shell: rect(shell),
    viewport: { width: innerWidth, height: innerHeight },
  };
})()`;

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`PASS ${label} ${detail === undefined ? "" : JSON.stringify(detail)}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label} ${detail === undefined ? "" : JSON.stringify(detail)}`);
  }
}

let code = 0;
try {
  const port = await waitForDebugPort(userData);
  let target;
  for (let attempt = 0; attempt < 200 && !target; attempt += 1) {
    await wait(50);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" &&
          !item.url.startsWith("devtools") &&
          item.url.includes("index.html") &&
          !item.url.includes("#"),
      );
    } catch {
      // The window has not opened its debugging port yet.
    }
  }
  if (!target) throw new Error("the app window never appeared");

  const client = await connect(target.webSocketDebuggerUrl);
  // Sample as soon as the splash exists. It stays for at least half a second,
  // which is the window this check has to observe.
  let early = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    early = await client.evaluate(SAMPLE);
    if (early?.boot) break;
    await wait(50);
  }
  check(
    "the splash is an overlay covering the whole window",
    early?.boot?.position === "absolute" &&
      early?.boot?.rect?.width === early?.viewport?.width &&
      early?.boot?.rect?.height === early?.viewport?.height,
    early?.boot,
  );
  check(
    "the shell is already full height while the splash is up",
    Math.abs(Number(early?.shell?.height) - Number(early?.viewport?.height)) <= 1,
    { shell: early?.shell, viewport: early?.viewport },
  );

  await wait(1400);
  const late = await client.evaluate(SAMPLE);
  check("the splash leaves once initialization settles", late?.boot === null, late);
  client.close();
} catch (error) {
  console.error(error);
  console.error(appLog);
  code = 1;
} finally {
  app.kill();
  await wait(500);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    // The app may still hold a file; the OS cleans the temp directory later.
  }
}

console.log(`\nSUMMARY ${passed}/${passed + failed} passed`);
process.exitCode = failed > 0 ? 1 : code;
