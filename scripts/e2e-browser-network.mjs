#!/usr/bin/env node
/**
 * End-to-end check of the fourth batch of browser actions: network observation
 * and environment emulation.
 *
 * Every assertion proves the *page* reacted, not that the tool returned `ok`:
 *
 * - `read_browser_requests` must see a real `fetch` the page made, filtered by
 *   URL, and a later `read_browser_console` must still see the same entry — the
 *   request tool peeks, it does not consume.
 * - `wait_browser` with `response` must release when a delayed request comes
 *   back; with `load` it must release on a fresh tab reaching readyState
 *   "complete".
 * - Timezone emulation must move the page's own `getTimezoneOffset()` and move
 *   it back on clear.
 * - Media emulation must flip `matchMedia("print")` inside the page.
 * - Offline emulation must make the page's own `fetch` reject, and the same
 *   request must succeed again after restoring.
 * - Geolocation is asserted as "applied and cleared, echoed back correctly":
 *   coordinates without a permission grant never reach the page's API by design,
 *   so that is the honest thing to prove here.
 *
 * The page under test is a local server written for this suite. Everything is
 * driven through MCP, the same surface an AI client uses.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const MCP_PORT = await freePort();
const TOKEN = "e2e-network-token-123456789";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-network-"));

/*
 * Three routes: the page itself, a cheap JSON-ish answer for ordinary requests,
 * and a delayed one so a `response` wait has something real to wait for.
 */
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/x") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("x-data");
    return;
  }
  if (url === "/slow") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("slow-data");
    }, 700);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>网络验证</title>
<style>body { margin: 40px; font-family: sans-serif; }</style></head><body>
<h1 id="title">网络与环境验证页</h1>
<div id="status">ready</div>
</body></html>`);
});
await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

mkdirSync(userData, { recursive: true });
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
  }),
  { mode: 0o600 },
);

const electron = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const app = spawn(electron, [join(process.cwd(), "out", "main", "index.js")], {
  env: { ...process.env, ENSEMBLE_USER_DATA: userData, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
async function call(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content[0].text}`);
  const text = json.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

async function waitForMcp() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // Still starting.
    }
    await wait(400);
  }
  return false;
}

try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const tab = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
  check("a page was opened for the network suite", Boolean(tabId), { tabId, tab });

  // Let the document finish: the request collector is installed on load, and a
  // fetch made before that would go unwrapped.
  await call("wait_browser", { tabId, condition: "load", timeoutMs: 10_000 });
  const readyState = await call("evaluate_browser_page", {
    tabId,
    expression: "document.readyState",
  });
  check("the first document reached readyState complete", readyState === "complete", readyState);

  // --- the request tool sees a real fetch, and peeks instead of consuming ----
  const fetchStatus = await call("evaluate_browser_page", {
    tabId,
    expression: `fetch('/x').then((response) => response.status)`,
  });
  check("the page's own fetch of /x returned 200", fetchStatus === 200, fetchStatus);

  const requests = await call("read_browser_requests", { tabId, url: "/x" });
  const hit = requests.requests?.find((entry) => entry.url.endsWith("/x"));
  check(
    "read_browser_requests filters /x by URL and reports its status",
    hit?.status === 200 && hit?.method === "GET" && typeof hit?.ms === "number",
    requests,
  );

  const consoleRead = await call("read_browser_console", { tabId });
  const stillThere = consoleRead.recent?.find((entry) => entry.url.endsWith("/x"));
  check(
    "read_browser_console still sees the same request after the peek",
    stillThere?.status === 200,
    consoleRead,
  );

  // --- a response wait releases only when the delayed request lands ----------
  await call("evaluate_browser_page", {
    tabId,
    expression: `setTimeout(() => { fetch('/slow'); }, 600), 'scheduled'`,
  });
  const waited = await call("wait_browser", {
    tabId,
    condition: "response",
    expect: "/slow",
    status: 200,
    timeoutMs: 8000,
  });
  check("wait response released on the delayed request", waited.ok === true, waited);
  check(
    "the wait reports which request matched",
    typeof waited.matched === "string" && waited.matched.includes("/slow"),
    waited,
  );

  // --- a load wait works on a second tab from the moment it opens ------------
  const second = await call("open_browser_tab", { url: PAGE_URL });
  const secondId = second.id ?? second.tabId;
  check("a second page was opened for the load wait", Boolean(secondId), { secondId });
  const loadWait = await call("wait_browser", {
    tabId: secondId,
    condition: "load",
    timeoutMs: 10_000,
  });
  const secondReady = await call("evaluate_browser_page", {
    tabId: secondId,
    expression: "document.readyState",
  });
  check(
    "wait load released and the new page is really complete",
    loadWait.ok === true && secondReady === "complete",
    { loadWait, secondReady },
  );
  // `matched` carries the readyState for a load hit, not the URL: a url
  // condition reports the URL in the same field, so a caller must be able to
  // tell which condition released the wait.
  check(
    "a load hit reports the readyState as matched, distinct from a url hit",
    loadWait.matched === "complete" && loadWait.matched !== PAGE_URL,
    loadWait,
  );

  // --- timezone moves the page's clock, and clearing moves it back -----------
  const baselineOffset = await call("evaluate_browser_page", {
    tabId,
    expression: "new Date().getTimezoneOffset()",
  });
  const tzSet = await call("set_browser_emulation", {
    tabId,
    timezone: "Asia/Tokyo",
  });
  check(
    "setting a timezone echoes it as in force",
    tzSet.timezone === "Asia/Tokyo",
    tzSet,
  );
  const tokyoOffset = await call("evaluate_browser_page", {
    tabId,
    expression: "new Date().getTimezoneOffset()",
  });
  check(
    "the page's own clock moved to UTC+9",
    tokyoOffset === -540,
    { baselineOffset, tokyoOffset },
  );
  const tzCleared = await call("set_browser_emulation", { tabId, timezone: null });
  check(
    "clearing the timezone leaves it out of the in-force set",
    tzCleared.timezone === undefined,
    tzCleared,
  );
  const restoredOffset = await call("evaluate_browser_page", {
    tabId,
    expression: "new Date().getTimezoneOffset()",
  });
  check(
    "the page's clock is back where it started",
    restoredOffset === baselineOffset,
    { baselineOffset, restoredOffset },
  );

  // --- print media flips matchMedia inside the page --------------------------
  await call("set_browser_emulation", { tabId, mediaType: "print" });
  const printMatches = await call("evaluate_browser_page", {
    tabId,
    expression: `matchMedia('print').matches`,
  });
  check("matchMedia('print') is true while print is emulated", printMatches === true, printMatches);
  const screenCleared = await call("set_browser_emulation", { tabId, mediaType: null });
  check(
    "clearing the media type echoes nothing in force for it",
    screenCleared.mediaType === undefined,
    screenCleared,
  );
  const screenMatches = await call("evaluate_browser_page", {
    tabId,
    expression: `matchMedia('print').matches`,
  });
  check("matchMedia('print') is false again after clearing", screenMatches === false, screenMatches);

  // --- offline cuts the page's own fetch; restoring reconnects it ------------
  await call("set_browser_emulation", { tabId, offline: true });
  const offlineResult = await call("evaluate_browser_page", {
    tabId,
    expression: `fetch('/x').then(() => 'online', (error) => 'offline:' + String(error && error.message || error))`,
  });
  check("the page's fetch rejected while offline", String(offlineResult).startsWith("offline:"), offlineResult);
  await call("set_browser_emulation", { tabId, offline: false });
  const onlineResult = await call("evaluate_browser_page", {
    tabId,
    expression: `fetch('/x').then((response) => 'online:' + response.status, (error) => 'offline:' + String(error && error.message || error))`,
  });
  check("the same request succeeds again after restoring", onlineResult === "online:200", onlineResult);

  // --- geolocation is asserted as applied + cleared, not as coordinates ------
  // Coordinates never reach a page the user has not granted permission to; the
  // grant itself is deliberately out of reach. So the honest assertions are the
  // ones the tool actually owns: the override applies, echoes, and clears.
  const geoSet = await call("set_browser_emulation", {
    tabId,
    geolocation: { latitude: 35.6812, longitude: 139.7671, accuracy: 10 },
  });
  check(
    "the geolocation override echoes exactly what was set",
    geoSet.geolocation?.latitude === 35.6812 &&
      geoSet.geolocation?.longitude === 139.7671 &&
      geoSet.geolocation?.accuracy === 10,
    geoSet,
  );
  const geoCleared = await call("set_browser_emulation", { tabId, geolocation: null });
  check(
    "clearing geolocation leaves nothing in force",
    geoCleared.geolocation === undefined,
    geoCleared,
  );

  clientDone();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  server.close();
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

/** No client socket to close here; kept so the success path reads the same. */
function clientDone() {}
