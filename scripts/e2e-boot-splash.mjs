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
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

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
  // Sample as soon as the splash exists. It stays for at least half a second,
  // which is the window this check has to observe.
  let early = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    early = await client.evaluate(SAMPLE);
    if (early?.boot) break;
    await wait(50);
  }
  check(
    // Within a pixel, not exactly equal: `innerHeight` is an integer while
    // `getBoundingClientRect().height` is whatever the CSS resolution produced
    // (861.33 on this machine). Comparing them with `===` fails for a reason that
    // has nothing to do with the splash being the wrong size.
    "the splash is an overlay covering the whole window",
    early?.boot?.position === "absolute" &&
      Math.abs(Number(early?.boot?.rect?.width) - Number(early?.viewport?.width)) <= 1 &&
      Math.abs(Number(early?.boot?.rect?.height) - Number(early?.viewport?.height)) <= 1,
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
