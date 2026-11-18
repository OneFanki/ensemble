#!/usr/bin/env node
/**
 * Proves the update dialog summarizes every release in the update range, not
 * just the latest one.
 *
 * The stub release server answers with a list of versions above the running
 * app's own version — more of them than the dialog renders — so a pass means:
 * the check returned the whole newer-than-installed range oldest first, the
 * dialog shows one section per version in that order, a version equal to the
 * installed one never appears, the count of folded-away older releases is
 * announced, and a release without a body renders its placeholder instead of
 * an empty section.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { waitForWindow } from "./lib/e2e-cdp.mjs";

const RELEASE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-update-notes-"));

// The range under test is built around the version the suite actually runs, so
// bumping the package version does not silently invalidate the assertions.
const currentVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
const [major, minor, patch] = currentVersion.split(".").map((part) => Number.parseInt(part, 10));
const rangeVersion = (offset) => `${major}.${minor}.${patch + offset}`;

// One release above the cap, so the "older releases folded away" line has a
// real count to show. The release whose patch offset equals EMPTY_NOTES_INDEX
// publishes no body on purpose.
const RANGE_SIZE = 12;
const EMPTY_NOTES_INDEX = 4;
const releases = Array.from({ length: RANGE_SIZE }, (_, index) => ({
  tag_name: `v${rangeVersion(index + 1)}`,
  html_url: `https://github.com/OneFanki/ensemble/releases/tag/v${rangeVersion(index + 1)}`,
  ...(index === EMPTY_NOTES_INDEX
    ? {}
    : { body: `### 中文\n- 版本 ${index + 1} 的变更\n### English\n- change ${index + 1}` }),
  assets: [],
}));

const server = createServer((req, res) => {
  if (String(req.url).includes("ensemble-releases")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(releases));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(client, expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

async function main() {
  await new Promise((done) => server.listen(RELEASE_PORT, "127.0.0.1", done));

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
      bookmarkFolders: [],
    }),
  );
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify({ theme: "dark", locale: "zh", lastView: "sites", guideVersion: GUIDE_SEEN }),
  );
  writeFileSync(
    join(userData, "mcp.json"),
    JSON.stringify({
      enabled: false,
      port: 0,
      allowWrite: true,
      allowRun: true,
      allowDelete: false,
      aiOrigins: [],
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
        ENSEMBLE_UPDATE_API: `http://127.0.0.1:${RELEASE_PORT}/ensemble-releases`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let appLog = "";
  app.stdout.on("data", (chunk) => (appLog += chunk));
  app.stderr.on("data", (chunk) => (appLog += chunk));

  let client;
  try {
    client = await waitForWindow({ userData, waitForDebugPort });
  } catch {
    check("app started", false, appLog.slice(-600));
    throw new Error("app window never appeared");
  }
  check("app started", true);
  await wait(2000);

  // ---- data path: the check itself returns the whole range ----
  const checked = await client.evaluate(`(async () => {
    const result = await window.ensemble.checkUpdate();
    return {
      status: result.status,
      latest: result.latest,
      versions: (result.releases ?? []).map((item) => item.version),
      omitted: result.omittedReleases,
    };
  })()`);

  const expectedVersions = Array.from({ length: RANGE_SIZE }, (_, index) =>
    rangeVersion(index + 1),
  );
  const shownVersions = expectedVersions.slice(RANGE_SIZE - 10);
  check(
    "the check reported an update",
    checked?.status === "available" && checked?.latest === rangeVersion(RANGE_SIZE),
    checked,
  );
  check(
    "the range is capped and keeps the newest releases",
    checked?.versions?.length === 10 &&
      checked?.versions?.[0] === shownVersions[0] &&
      checked?.versions?.at(-1) === rangeVersion(RANGE_SIZE),
    checked?.versions,
  );
  check(
    "the range is sorted oldest first",
    JSON.stringify(checked?.versions) === JSON.stringify([...checked?.versions].sort(compareDotted)),
    checked?.versions,
  );
  check(
    "the installed version is not in the range",
    !checked?.versions?.includes(currentVersion) &&
      checked?.versions?.every((version) => Number(version.split(".")[2]) > patch),
    { currentVersion, versions: checked?.versions },
  );
  check(
    "the folded-away count matches the cap",
    checked?.omitted === RANGE_SIZE - 10,
    checked?.omitted,
  );

  // ---- UI path: the dialog renders one section per release ----
  await client.evaluate(openNav("settings-about"));
  const opened = await waitFor(
    client,
    `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '检查更新')`,
  );
  check("the about section shows the check button", opened);

  await client.evaluate(
    `[...document.querySelectorAll('button')]
       .find((b) => b.textContent.trim() === '检查更新')
       ?.click()`,
  );
  const dialogShown = await waitFor(client, `document.querySelector('.release-version')`);
  check("the update dialog opened", dialogShown);

  const dialog = await client.evaluate(`(() => {
    const versions = [...document.querySelectorAll('.release-version')].map((el) => el.textContent.trim());
    const summary = document.body.textContent;
    return {
      versions,
      omittedLine: summary.includes('另有 ${RANGE_SIZE - 10} 个更早版本未列出'),
      emptyNotes: summary.includes('这个版本没有提供摘要。'),
      latestTitle: summary.includes('发现新版本'),
    };
  })()`);
  check(
    "the dialog shows one section per release, oldest first",
    JSON.stringify(dialog?.versions) === JSON.stringify(shownVersions),
    dialog?.versions,
  );
  check(
    "the dialog announces the folded-away releases",
    dialog?.omittedLine === true,
    dialog?.omittedLine,
  );
  check("the release without notes shows its placeholder", dialog?.emptyNotes === true);
  check("the dialog names the newest version", dialog?.latestTitle === true);

  client?.close();
  app.kill();
  await wait(1200);
}

/** Dotted-numeric compare, matching the app's own version ordering. */
function compareDotted(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

try {
  await main();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  server.close();
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
