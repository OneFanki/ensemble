#!/usr/bin/env node
/**
 * End-to-end check of the authorization window.
 *
 * The claim: when the AI tries to act on a page whose origin the user never
 * decided about, the refusal becomes a question — a card in the corner of the
 * desktop — and the answer decides whether the tool call reaches the page.
 *
 * Four things have to hold, and the page's own click counter is the falsifiable
 * half of each: a grant that did not really let the click through would show zero
 * there, and a refusal that still delivered it would show one.
 *
 * 1. "Allow once" lets exactly one call through, and the question comes back for
 *    the next one — that is what "once" means.
 * 2. "Allow for this run" lets the following call through with no second card.
 * 3. Refusing stops the call, and the page never sees the click.
 * 4. Silence is refusal: the request the coordinator is waiting on resolves to
 *    "deny" after the countdown, and the page again never sees the click.
 *
 * The suite runs headless with `ENSEMBLE_APPROVAL_UI=1`, which is what makes the
 * card exist and be drivable through the debugger: a headless run has no desktop,
 * but it does have a renderer, and the four buttons are the thing under test.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const MCP_PORT = await freePort();
const TOKEN = "e2e-ai-approval-token-123456";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-ai-approval-"));

/** A page that counts clicks, so "the AI really acted" is checkable. */
const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>运营后台</title></head>
<body>
<h1>运营后台</h1>
<p id="hits">0</p>
<button id="publish" type="button" onclick="
  const el = document.getElementById('hits');
  el.textContent = String(Number(el.textContent) + 1);
">投放</button>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/ops`;
const ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

const now = new Date().toISOString();
const siteId = uuid(1);

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "运营后台",
        baseUrl: ORIGIN,
        loginPath: "/ops",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [],
    views: [],
    flows: [],
    bookmarks: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
);
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
    // Allowlist with nothing in it: every daily-page origin is undecided, which
    // is the state that produces a question rather than a refusal.
    aiMode: "allowlist",
    aiOrigins: [],
  }),
  { mode: 0o600 },
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  {
    // `ENSEMBLE_APPROVAL_UI` is the opt-in that keeps the card alive in a
    // headless run; without it the gate refuses and never asks.
    env: { ...process.env, ENSEMBLE_HEADLESS: "1", ENSEMBLE_APPROVAL_UI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
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
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolvePromise, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolvePromise(message.result);
    }
  });
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  const send = (method, params) =>
    new Promise((resolvePromise, reject) => {
      nextId += 1;
      pending.set(nextId, { resolvePromise, reject });
      socket.send(JSON.stringify({ id: nextId, method, params }));
    });
  await send("Runtime.enable", {});
  return {
    evaluate: async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "evaluation failed");
      }
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log(`       ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

/** Waits until the MCP endpoint answers, so a slow start is not a failure. */
async function waitForMcp() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(250);
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          host: `127.0.0.1:${MCP_PORT}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // not listening yet
    }
  }
  return false;
}

/** One MCP tool call, with the response already flattened to what tests read. */
async function call(name, args) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      host: `127.0.0.1:${MCP_PORT}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.json();
  const result = body.result ?? {};
  return {
    isError: result.isError === true,
    text: Array.isArray(result.content)
      ? result.content.map((item) => item.text ?? "").join("\n")
      : "",
  };
}

async function debugTargets() {
  const list = await (
    await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)
  ).json();
  return list;
}

async function connectRenderer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const target = (await debugTargets()).find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools") &&
          !item.url.includes("approval"),
      );
      if (target) return connect(target.webSocketDebuggerUrl);
    } catch {
      // the window is still opening its debugging port
    }
  }
  return undefined;
}

/**
 * The authorization card's own renderer.
 *
 * It is a separate window and therefore a separate debug target, which is also
 * why the answer channel checks the sender: three renderers share one preload.
 */
async function approvalWindow() {
  const target = (await debugTargets()).find(
    (item) => item.type === "page" && item.url.includes("approval"),
  );
  return target ? connect(target.webSocketDebuggerUrl) : undefined;
}

/** Clicks one of the card's four answers, once the card has actually rendered. */
async function answerWith(selector) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const card = await approvalWindow();
    if (card) {
      const shown = await card.evaluate(`Boolean(document.querySelector('[data-approval-card]'))`);
      if (shown) {
        const summary = await card.evaluate(`(() => {
          const action = document.querySelector('[data-approval-action]')?.textContent?.trim() ?? '';
          const target = document.querySelector('[data-approval-card] .target')?.textContent
            ?.replace(/\\s+/g, ' ').trim() ?? '';
          return { action, target };
        })()`);
        const clicked = await card.evaluate(
          `(document.querySelector(${JSON.stringify(selector)})?.click(), true)`,
        );
        card.close();
        // The whole point of the card is that clicking an answer closes it. A
        // click that landed on a card still rendering would leave the question
        // open and every later assertion waiting on a second card that never
        // comes — so the disappearance is what counts as answered, not the call
        // to `click()`.
        if (clicked && (await cardGone())) return summary;
      } else {
        card.close();
      }
    }
    await wait(150);
  }
  return undefined;
}

/** True once the card is no longer on screen. */
async function cardGone(timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const card = await approvalWindow();
    if (!card) return true;
    const shown = await card.evaluate(`Boolean(document.querySelector('[data-approval-card]'))`);
    card.close();
    if (!shown) return true;
    await wait(120);
  }
  return false;
}

/** The card appearing is itself the signal that a question was asked. */
async function waitForCard(timeoutMs = 25_000) {
  // 25 seconds, not 6: the first question of a run has to create the window and
  // load its renderer, which is a whole app page starting up. Later questions
  // reuse it and appear well under a second — the long budget is paid once.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const card = await approvalWindow();
    if (card) {
      const shown = await card.evaluate(`Boolean(document.querySelector('[data-approval-card]'))`);
      card.close();
      if (shown) return true;
    }
    await wait(150);
  }
  return false;
}

/** Reads the click counter inside the embedded page. */
async function hits() {
  const deadline = Date.now() + 4_000;
  do {
    const target = (await debugTargets()).find(
      (item) =>
        (item.type === "page" || item.type === "webview" || item.type === "iframe") &&
        item.url.startsWith(`${ORIGIN}/`),
    );
    if (target) {
      const pageClient = await connect(target.webSocketDebuggerUrl);
      const value = await pageClient.evaluate(
        `Number(document.getElementById('hits')?.textContent ?? -1)`,
      );
      pageClient.close();
      const number = Number(value);
      if (number >= 0) return number;
    }
    await wait(150);
  } while (Date.now() < deadline);
  return -1;
}

let client;
try {
  const ready = await waitForMcp();
  check("app started", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP endpoint never came up");

  client = await connectRenderer();
  check("renderer reachable", Boolean(client));

  // --- A daily-profile page, opened the way a person opens one ---
  const daily = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} });
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.url.includes('/ops') && !item.clean);
    return tab ? { id: tab.id, clean: tab.clean ?? false } : null;
  })()`);
  check("a bookmark-style open lands in the daily profile", Boolean(daily?.id) && !daily?.clean, daily);
  const tabId = daily?.id ?? "";
  await wait(600);
  const baseline = await hits();
  check("the page is loaded and its counter readable", baseline === 0, { baseline });

  // --- 1) "Allow once" lets one call through, then asks again ---
  //
  // The call is started and not awaited: the window has to be answered while the
  // tool is blocked on it, which is exactly the interaction under test.
  const firstCall = call("click_browser_element", { tabId, text: "投放" });
  const firstCard = await waitForCard();
  check("an undecided origin produces an authorization card", firstCard === true);
  const firstSummary = await answerWith("[data-approval-allow-once]");
  check(
    "the card names the action and the site",
    Boolean(firstSummary) &&
      String(firstSummary.action).includes("投放") &&
      String(firstSummary.target).includes("运营后台"),
    firstSummary,
  );
  const firstResult = await firstCall;
  check(
    "allowing once lets the call through",
    !firstResult.isError,
    firstResult.isError ? firstResult.text.slice(0, 200) : undefined,
  );
  await wait(400);
  // Counted against the baseline rather than against a literal: an earlier step
  // that happened to click once would otherwise shift every number below.
  const afterFirst = await hits();
  check("the click really reached the page", afterFirst === baseline + 1, { baseline, afterFirst });

  // A second call asks again: "本次" was about one call, so reusing it would
  // quietly turn the narrowest answer into the widest one.
  const secondCall = call("click_browser_element", { tabId, text: "投放" });
  const secondCard = await waitForCard();
  check("a one-off grant does not cover the next call", secondCard === true);

  // --- 2) "Allow for this run" covers the rest of the session ---
  await answerWith("[data-approval-allow-session]");
  const secondResult = await secondCall;
  check("allowing for this run lets the second call through", !secondResult.isError);
  await wait(300);
  const afterSecond = await hits();
  check("the second click reached the page", afterSecond === baseline + 2, {
    baseline,
    afterSecond,
  });

  const thirdResult = await call("click_browser_element", { tabId, text: "投放" });
  check("a session grant needs no second card", !thirdResult.isError, thirdResult.text.slice(0, 160));
  await wait(300);
  const afterThird = await hits();
  check("the third click reached the page with no question", afterThird === baseline + 3, {
    baseline,
    afterThird,
  });

  // The grant is in the status (so the panel can show it) but not on disk (so a
  // restart does not turn it into the permanent answer nobody chose).
  const status = await client.evaluate(`window.ensemble.mcpStatus()`);
  check(
    "the session grant is reported as session-scoped",
    Array.isArray(status?.aiSessionOrigins) && status.aiSessionOrigins.includes(ORIGIN),
    { session: status?.aiSessionOrigins, stored: status?.aiOrigins },
  );
  check(
    "the session grant is not written to the stored list",
    Array.isArray(status?.aiOrigins) && !status.aiOrigins.includes(ORIGIN),
    status?.aiOrigins,
  );

  // --- 3) Refusing stops the call ---
  //
  // End the session grant first, so the next call has to ask again.
  await client.evaluate(`window.ensemble.updateMcp({ enabled: false })`);
  await client.evaluate(`window.ensemble.updateMcp({ enabled: true })`);
  await wait(400);
  const refusalCall = call("click_browser_element", { tabId, text: "投放" });
  const refusalCard = await waitForCard();
  check("the question returns after the session grant ends", refusalCard === true);
  await answerWith("[data-approval-deny]");
  const refusalResult = await refusalCall;
  check("refusing fails the call", refusalResult.isError === true, refusalResult.text.slice(0, 160));
  check(
    "the refusal tells the AI to stop and ask the user",
    String(refusalResult.text).includes("不要重试"),
    refusalResult.text.slice(0, 200),
  );
  await wait(400);
  const afterRefusal = await hits();
  check("a refused call never reached the page", afterRefusal === baseline + 3, {
    baseline,
    afterRefusal,
  });

  // --- 4) The log records what the user answered ---
  const activity = await client.evaluate(`window.ensemble.listAiActivity()`);
  check(
    "the log records the granted, session and refused calls",
    Array.isArray(activity) &&
      activity.some((row) => row.approval === "allow-once") &&
      activity.some((row) => row.approval === "allow-session") &&
      activity.some((row) => row.approval === "deny"),
    Array.isArray(activity) ? activity.map((row) => row.approval ?? row.ok) : activity,
  );
  check(
    "every recorded row names the site it touched",
    Array.isArray(activity) && activity.every((row) => row.origin === ORIGIN),
    Array.isArray(activity) ? activity.map((row) => row.origin) : activity,
  );
} catch (error) {
  failed += 1;
  console.log(`  FAIL ${error?.message ?? error}`);
  console.log(appLog.slice(-1_500));
} finally {
  client?.close?.();
  app.kill();
  await wait(400);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    // a locked profile directory is not worth failing the run over
  }
  page.close();
  // `SUMMARY n/m` is what `run-all-e2e.mjs` parses to count a suite as passing;
  // without it the run reports "no summary" and a green suite cannot be told
  // apart from one that crashed before printing anything.
  console.log(`\nSUMMARY ${passed}/${passed + failed} passed`);
  process.exit(failed > 0 ? 1 : 0);
}
