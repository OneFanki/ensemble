#!/usr/bin/env node
/**
 * End-to-end check of how a tool call reports "the page did not answer".
 *
 * The claim: a timeout is not a failure. Three separate facts used to arrive
 * under the same shape, and a client could not act on any of them:
 *
 * 1. `evaluate_browser_page` timed out after a hard 30 seconds that could not be
 *    changed, and reported it as `isError` — so a caller retried a script that
 *    was still running.
 * 2. `wait_browser` said `evaluate-timeout` whether the condition genuinely did
 *    not hold or the page never answered at all. Those need different responses.
 * 3. `screenshot_browser_tab` could hang with no diagnosis at all.
 *
 * Everything below is checked as a *fact about the result*, not as a string
 * match on an implementation: a timed-out evaluate must come back as a normal
 * result carrying `stillRunning`, and the script must actually still be running.
 *
 * The last group covers pre-document injection, which is only interesting if it
 * survives the session lifecycle — the registration lives in a CDP session that
 * is released after 1.5 seconds idle, so "it worked once" is not the claim. It
 * has to work across a navigation, which is the whole point of the feature.
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
const TOKEN = "e2e-mcp-timeouts-token-123456";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-mcp-timeouts-"));

/**
 * A page that can be made slow, and that records what the page's own script saw.
 *
 * `slow` parks for five seconds without touching the DOM; `probe` reports what a
 * pre-document script would have installed, read as a plain value so the MCP
 * layer can return it without any page code running at read time.
 */
const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>慢页面</title>
<script>
  // What an init script would have installed before this line ran.
  window.__probe = window.__probe || "unset";
</script>
</head>
<body>
<h1>慢页面</h1>
<p id="probe"></p>
<button id="later" type="button">稍后出现</button>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/slow`;
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
        name: "慢页面",
        baseUrl: ORIGIN,
        loginPath: "/slow",
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
    // The origin is allowed outright, so nothing below is a question about
    // authorization. This suite is only about timeouts.
    aiMode: "allowlist",
    aiOrigins: [ORIGIN],
  }),
  { mode: 0o600 },
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(electronBinary, [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
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

/**
 * One tool call, flattened to what the assertions read.
 *
 * `value` is the parsed JSON body when the tool returns an object rather than
 * prose — that is what lets a timeout be checked as structure rather than as
 * text that happens to contain a word.
 */
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
  /*
   * A missing tool is a protocol error, not a result.
   *
   * Without this the suite read `{}` for four steps and passed the ones that
   * only look at "no error" — a green run that had never executed the feature it
   * was checking. An unknown tool answers with `error`, and that has to fail the
   * call rather than become an empty value.
   */
  if (body.error) {
    return {
      isError: true,
      text: String(body.error.message ?? "protocol error"),
      value: undefined,
    };
  }
  const result = body.result ?? {};
  const text = Array.isArray(result.content)
    ? result.content.map((item) => item.text ?? "").join("\n")
    : "";
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return { isError: result.isError === true, text, value };
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

/** Reads a value out of the embedded page's own window. */
async function pageValue(expression) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const target = (await debugTargets()).find(
      (item) =>
        (item.type === "page" || item.type === "webview" || item.type === "iframe") &&
        item.url.startsWith(`${ORIGIN}/`),
    );
    if (target) {
      const pageClient = await connect(target.webSocketDebuggerUrl);
      try {
        return await pageClient.evaluate(expression);
      } finally {
        pageClient.close();
      }
    }
    await wait(150);
  }
  return undefined;
}

let client;
try {
  const ready = await waitForMcp();
  check("app started", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP endpoint never came up");

  client = await connectRenderer();
  check("renderer reachable", Boolean(client));

  const opened = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = opened.value?.id ?? opened.value?.tabId ?? "";
  check("a tab is open on the test page", Boolean(tabId), opened.text.slice(0, 200));
  await wait(700);

  // --- 1) A timed-out evaluate is a normal result, not a failure ---
  //
  // The script starts a marker and then parks for five seconds. With a budget of
  // one second the call has to come back *before* the script finishes, saying it
  // may still be running. If the deadline were still a plain error, `isError`
  // would be true and the caller would have no way to tell that from a throw.
  const started = Date.now();
  const slowRun = await call("evaluate_browser_page", {
    tabId,
    expression: `(async () => {
      window.__slowStarted = Date.now();
      await new Promise((done) => setTimeout(done, 5000));
      window.__slowDone = true;
      return "finished";
    })()`,
    timeoutMs: 1_000,
  });
  const elapsed = Date.now() - started;
  check("a timed-out evaluate is not an error", slowRun.isError === false, slowRun.text.slice(0, 200));
  check(
    "it reports the timeout as a structured fact",
    slowRun.value?.timedOut === true && slowRun.value?.stillRunning === true,
    slowRun.value,
  );
  check("it honours the caller's budget rather than the default", elapsed < 3_500, { elapsed });
  // The claim behind `stillRunning`: the script really is still going. Checking
  // it is what separates an honest report from a lucky one.
  const stillGoing = await pageValue(`Boolean(window.__slowStarted) && !Boolean(window.__slowDone)`);
  check("the script really was still running after the deadline", stillGoing === true, { stillGoing });

  // Let it finish so the next steps are not racing it.
  await wait(4_500);

  // --- 2) `wait_browser` says which layer ran out ---
  //
  // Waiting for a URL that never arrives: the in-page loop reaches its own
  // deadline, so the reason is the condition itself and `timedOutAt` is "page".
  const urlWait = await call("wait_browser", {
    tabId,
    condition: "url",
    expect: "never-going-to-appear",
    timeoutMs: 1_200,
  });
  check("a wait that simply does not match reports the page layer", urlWait.value?.timedOutAt === "page", urlWait.value);
  check(
    "and it names the condition that did not hold",
    urlWait.value?.reason === "url-mismatch",
    urlWait.value,
  );

  // A page-side script that never returns leaves the poll loop unable to answer,
  // so this side's own deadline fires. That is a different diagnosis and now has
  // a different name — retrying the same condition would not help.
  const hang = call("evaluate_browser_page", {
    tabId,
    expression: `(() => { const end = Date.now() + 6000; while (Date.now() < end) {} })()`,
    timeoutMs: 6_500,
  });
  await wait(300);
  const bridgeWait = await call("wait_browser", {
    tabId,
    condition: "text",
    expect: "anything at all",
    timeoutMs: 400,
  });
  check(
    "a page that cannot answer reports the bridge layer",
    bridgeWait.value?.timedOutAt === "bridge",
    bridgeWait.value,
  );
  check(
    "and says the bridge was the thing that timed out",
    bridgeWait.value?.reason === "bridge-timeout",
    bridgeWait.value,
  );
  await hang;

  // --- 3) Aborting is offered and does something ---
  const busy = call("evaluate_browser_page", {
    tabId,
    expression: `(() => { const end = Date.now() + 30000; while (Date.now() < end) {} })()`,
    timeoutMs: 4_000,
  });
  await wait(400);
  const cancel = await call("cancel_browser_script", { tabId });
  check("cancel_browser_script is accepted", !cancel.isError, cancel.text.slice(0, 200));
  check(
    "it is described as best-effort rather than a guarantee",
    String(cancel.value?.note ?? "").includes("Promise"),
    cancel.value,
  );
  const busyResult = await busy;
  // The busy loop is exactly the case terminateExecution can actually abort, so
  // the evaluate either fails fast or times out early — both mean the loop died.
  check(
    "killing a busy loop lets the page answer again",
    busyResult.isError === true || busyResult.value?.timedOut === true,
    busyResult.text.slice(0, 200),
  );
  const aliveAgain = await pageValue("1 + 1");
  check("the page still responds afterwards", aliveAgain === 2, { aliveAgain });

  // --- 4) Screenshot names "page busy" instead of failing blankly ---
  //
  // The capture path is bounded now, so an impossible budget has to produce a
  // diagnosis rather than an empty result with an undefined path.
  const shot = await call("screenshot_browser_tab", { tabId, timeoutMs: 1_000 });
  // Either it succeeds (a headless window can still paint) or it reports
  // page-busy. What must not happen is a result that claims success with no path.
  const shotOk = shot.value?.path || shot.value?.reason === "page-busy";
  check("a screenshot either produces a path or names the reason", Boolean(shotOk), shot.value ?? shot.text);
  if (shot.value?.reason === "page-busy") {
    check("the busy diagnosis is a normal result, not an error", shot.isError === false);
  }

  // --- 5) Pre-document injection, including the session lifecycle ---
  //
  // The registration lives in a CDP session that is released after 1.5 seconds
  // idle. So the assertion is not "it ran once" — it is "it runs on the next
  // navigation", which is the only version of this feature worth having.
  const added = await call("add_browser_init_script", {
    tabId,
    script: `window.__probe = "installed";`,
  });
  check("an init script can be registered", !added.isError && Boolean(added.value?.scriptId), added.text.slice(0, 200));
  check(
    "it says it does not affect the current document",
    added.value?.affects === "next-navigation",
    added.value,
  );
  // The current document was already parsed, so it must still be unset.
  const beforeNav = await pageValue("window.__probe");
  check("the current document is untouched", beforeNav === "unset", { beforeNav });

  const listed = await call("list_browser_init_scripts", { tabId });
  check(
    "it shows up in the list",
    Array.isArray(listed.value?.scripts) && listed.value.scripts.length === 1,
    listed.value,
  );

  // Wait past the idle release before navigating: this is the window in which a
  // session-level registration would be wiped, so the replay has to carry it.
  await wait(2_200);
  await call("navigate_browser_tab", { tabId, url: `${PAGE_URL}?again=1` });
  await wait(900);
  const afterNav = await pageValue("window.__probe");
  check("it runs before the page's own script on the next navigation", afterNav === "installed", {
    afterNav,
  });

  // A refresh is a navigation too — the same registration has to survive it
  // rather than only the first one after registration.
  await wait(2_200);
  await call("navigate_browser_tab", { tabId, url: PAGE_URL });
  await wait(900);
  const afterSecond = await pageValue("window.__probe");
  check("it survives a second navigation as well", afterSecond === "installed", { afterSecond });

  // Removing it stops the next document, and only the next one: the document
  // that already ran it is not retroactively repaired.
  const scripts = (await call("list_browser_init_scripts", { tabId })).value?.scripts ?? [];
  const scriptId = scripts[0]?.scriptId;
  const removed = await call("remove_browser_init_script", { tabId, scriptId });
  check("a script can be removed", !removed.isError, removed.text.slice(0, 200));
  const empty = await call("list_browser_init_scripts", { tabId });
  check("the list is empty afterwards", (empty.value?.scripts ?? []).length === 0, empty.value);
  await call("navigate_browser_tab", { tabId, url: `${PAGE_URL}?after=1` });
  await wait(900);
  const afterRemove = await pageValue("window.__probe");
  check("the next document no longer runs it", afterRemove === "unset", { afterRemove });
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
  console.log(`\nSUMMARY ${passed}/${passed + failed} passed`);
  process.exit(failed > 0 ? 1 : 0);
}
