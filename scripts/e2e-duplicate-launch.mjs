#!/usr/bin/env node
/**
 * Starting Ensemble a second time while one instance runs opens a new window.
 *
 * The instance lock used to make a second start exit with a log line, which
 * read as "the app refuses to start". Now the second start is another way of
 * asking for a spawned window: the second process seeds a sibling directory
 * from the running instance's files, hands a detached child over, and quits.
 * The window then lives on its own — its own lockfile, own library, own
 * identity list — while the first instance keeps the workspace and the tray.
 *
 * What this suite pins:
 *
 *   1. The second process exits (it does not linger as a second workspace).
 *   2. A `window-*` directory appears beside the primary's, seeded with the
 *      primary's workspace and settings — and the seeded settings carry the
 *      guide-read flag, so a window opened after the fact never replays the
 *      tour.
 *   3. The new window comes up and acquires its own instance lock — which is
 *      also what the tray's window list reads.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-dup-"));

const now = new Date().toISOString();
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
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "browser",
    guideVersion: GUIDE_SEEN,
    autoFillOnLaunch: false,
  }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const env = { ...process.env, ENSEMBLE_HEADLESS: "1" };

/** Launches one app process against `userData`; port 0 lets Chromium pick and
 * publish, which is what `waitForDebugPort` reads back. */
function startApp() {
  return spawn(electronBinary, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const first = startApp();
let firstLog = "";
first.stdout.on("data", (c) => (firstLog += c));
first.stderr.on("data", (c) => (firstLog += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

try {
  let client;
  try {
    client = await waitForWindow({ userData, waitForDebugPort });
  } catch (error) {
    check("first instance appeared", false, firstLog.slice(-600));
    throw error;
  }
  check("first instance appeared", true);
  client.close();
  await wait(400);

  // --- The duplicate start hands over a new window and quits ----------------
  const windowsRoot = `${userData}-windows`;
  const second = startApp();
  let secondLog = "";
  second.stdout.on("data", (c) => (secondLog += c));
  second.stderr.on("data", (c) => (secondLog += c));

  const exitCode = await new Promise((done) => second.on("exit", (code) => done(code)));
  check("the duplicate start exits once it has handed over", exitCode === 0, { exitCode, secondLog: secondLog.slice(-300) });

  await wait(1_500);
  const dirs = existsSync(windowsRoot) ? readdirSync(windowsRoot).filter((n) => n.startsWith("window-")) : [];
  check("a spawned window directory exists beside the primary", dirs.length === 1, { dirs });

  const childDir = dirs[0] ? join(windowsRoot, dirs[0]) : "";
  const seededWorkspace = childDir && existsSync(join(childDir, "workspace.json"))
    ? JSON.parse(readFileSync(join(childDir, "workspace.json"), "utf8"))
    : null;
  check("the spawned window inherited the workspace seed", Boolean(seededWorkspace), {
    hasWorkspace: Boolean(seededWorkspace),
  });

  const seededSettings = childDir && existsSync(join(childDir, "settings.json"))
    ? JSON.parse(readFileSync(join(childDir, "settings.json"), "utf8"))
    : null;
  check(
    "the spawned window has the guide-read flag, not a fresh tour",
    seededSettings?.guideVersion === GUIDE_SEEN,
    { guideVersion: seededSettings?.guideVersion ?? null },
  );

  // The child holds its own lock — the same fact the tray's window list reads.
  // Boot takes seconds in headless, so poll rather than check once.
  let childLock = null;
  for (let waited = 0; waited < 15_000; waited += 300) {
    if (childDir && existsSync(join(childDir, "lockfile"))) {
      childLock = JSON.parse(readFileSync(join(childDir, "lockfile"), "utf8"));
      break;
    }
    await wait(300);
  }
  check("the spawned window acquired its own instance lock", typeof childLock?.pid === "number", {
    pid: childLock?.pid ?? null,
  });

  if (childLock?.pid) {
    let childAlive = true;
    try {
      process.kill(childLock.pid, 0);
    } catch {
      childAlive = false;
    }
    check("the spawned window process is still running", childAlive);
    if (childAlive) {
      spawn("taskkill", ["/F", "/T", "/PID", String(childLock.pid)], { stdio: "ignore" });
    }
  }
} catch (error) {
  check("run completed", false, String(error));
} finally {
  try {
    first.kill();
  } catch {}
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(`${userData}-windows`, { recursive: true, force: true });
  } catch {
    console.log("note: windows dir left behind at", `${userData}-windows`);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
