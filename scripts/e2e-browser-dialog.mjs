#!/usr/bin/env node
/**
 * End-to-end check of JavaScript dialog handling.
 *
 * The premise was measured before this suite existed, and it is the reason the
 * feature is worth having at all: while a `confirm()` is up, the
 * `Input.dispatchMouseEvent` that opened it **never returns**. A click tool then
 * reports a 30-second timeout on a page that is merely waiting for an answer, and
 * every later read fails the same way. `Page.handleJavaScriptDialog` still
 * answers during that window, so knowing a dialog exists is enough to unblock
 * the page.
 *
 * What the assertions prove, in order:
 *
 * 1. A dialog nobody knows about makes the click fail — the defect, reproduced.
 * 2. `read_browser_dialog` reports the type and message while the page is blocked
 *    (it reads main's event record, not the page, so it cannot hang).
 * 3. `handle_browser_dialog` unblocks the page and the page's own code sees the
 *    answer it should.
 * 4. Answering a dialog that is not there reports `handled: false`, not an error.
 * 5. A dialog left alone is auto-dismissed, so the page comes back by itself.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const MCP_PORT = await freePort();
const TOKEN = "e2e-dialog-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-dialog-"));

/*
 * Four buttons, one per assertion:
 *
 * - `#confirm` writes the answer into the page, so "the page saw `true`" is a
 *   fact rather than an inference from the tool's own return value.
 * - `#prompt` does the same with the typed text.
 * - `#idle` opens a confirm the suite never answers, for the auto-dismiss check.
 * - `#plain` is a button that opens nothing, so the "no dialog" path has a page
 *   that is definitely alive.
 */
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>弹窗验证</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  button { display: block; margin: 30px; padding: 12px 20px; font-size: 15px; }
  #out { margin: 30px; font-family: monospace; }
</style></head><body>
<button id="confirm" type="button">确认删除</button>
<button id="prompt" type="button">输入名称</button>
<button id="alert" type="button">只有一个确定</button>
<button id="idle" type="button">无人处理的确认</button>
<button id="plain" type="button">没有弹窗</button>
<div id="out">none</div>
<script>
  const out = (text) => { document.getElementById('out').textContent = text; };
  document.getElementById('confirm').onclick = () => {
    out('answered:' + confirm('确定删除这一项吗？'));
  };
  document.getElementById('prompt').onclick = () => {
    out('prompt:' + prompt('给这个视图起个名字', '默认视图'));
  };
  // An alert has one button, so it is the case where the answer cannot be wrong.
  document.getElementById('alert').onclick = () => {
    alert('只有确定');
    out('alert-returned');
  };
  document.getElementById('idle').onclick = () => {
    confirm('这个没人会回答');
    out('idle-returned');
  };
</script>
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
  env: {
    ...process.env,
    ENSEMBLE_USER_DATA: userData,
    ENSEMBLE_HEADLESS: "1",
    /*
     * Long enough that the auto-dismiss cannot race any other assertion here.
     *
     * Two earlier attempts got this wrong: at 3 seconds and at 8 seconds the
     * "the dialog is up" checks passed only sometimes, because a stalled click
     * waits out its own multi-second budget first and the dialog was dismissed
     * underneath the assertion. The auto-dismiss case below waits out whatever
     * this is set to, so the only cost of a large value is one slow assertion —
     * far cheaper than a suite that passes or fails by timing.
     */
    ENSEMBLE_DIALOG_AUTO_DISMISS_MS: "20000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
async function call(name, args = {}, options = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
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

/** A call that is expected to fail or hang; reports how it ended. */
async function callExpectingTrouble(name, args, timeoutMs) {
  try {
    const value = await call(name, args, { timeoutMs });
    return { kind: "returned", value };
  } catch (error) {
    const message = String(error);
    if (/abort|timeout|TimeoutError/i.test(message)) return { kind: "hung" };
    return { kind: "failed", message };
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

/**
 * Waits until the page has no dialog and answers reads again.
 *
 * A suspended click lands as soon as its dialog is answered, and it can open the
 * *next* dialog. Without this, a step's click queues behind that one and the
 * assertion sees the previous dialog — which is exactly how an earlier version of
 * this suite reported "the prompt did not open" while a confirm from two steps
 * back was still up.
 */
async function waitForQuietPage(tabId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let answered = false;
  while (Date.now() < deadline) {
    const status = await call("read_browser_dialog", { tabId });
    if (status.dialog) {
      // Whatever is up was opened by a click this suite already made; answer it
      // so the page can move on.
      await call("handle_browser_dialog", { tabId, accept: false });
      answered = false;
      await wait(400);
      continue;
    }
    /*
     * No dialog is reported, but that alone does not mean the page is usable: a
     * queued click can still be in flight. Only a command that actually runs in
     * the page proves it is idle, so the probe is a real evaluate with a short
     * deadline.
     */
    const probe = await callExpectingTrouble(
      "evaluate_browser_page",
      { tabId, expression: "1", timeoutMs: 2000 },
      5000,
    );
    if (probe.kind === "returned") {
      // Two consecutive answers: one click landing can block the page again
      // between the read and the probe.
      if (answered) return true;
      answered = true;
    } else {
      answered = false;
    }
    await wait(300);
  }
  return false;
}

/** Reads the page's own record of what happened, tolerating a blocked page. */
async function readOut(tabId, timeoutMs = 3000) {
  try {
    return await call(
      "evaluate_browser_page",
      { tabId, expression: "document.getElementById('out').textContent", timeoutMs },
      { timeoutMs: timeoutMs + 2000 },
    );
  } catch {
    return "（页面没有应答）";
  }
}

try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const tab = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
  check("a page was opened", Boolean(tabId), { tabId });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const visible = await call("check_element_visible", { tabId, selector: "#confirm" });
    if (visible.visible) break;
    await wait(200);
  }

  /*
   * --- 1. a dialog nobody knows about blocks the page ------------------------
   *
   * The click that opens a confirm does not come back: the reply to
   * `Input.dispatchMouseEvent` is what the dialog is holding. The tool call is
   * given 6 seconds — well under the 30-second command ceiling — so "it stalled"
   * is distinguishable from "it was slow", while still wide enough that a loaded
   * machine cannot produce a false pass.
   *
   * `#confirm` is clicked exactly once here. A second click while the dialog is
   * up would queue behind the first and land as soon as it is answered, opening a
   * *second* dialog — a real behaviour this suite ran into, and the reason the
   * checks below are ordered rather than fired off together.
   */
  const lonely = await callExpectingTrouble(
    "click_browser_element",
    { tabId, selector: "#confirm" },
    6000,
  );
  check(
    "clicking an unhandled confirm does not come back promptly",
    lonely.kind !== "returned",
    lonely,
  );

  // --- 2. the dialog is readable while the page is blocked -------------------
  const whileOpen = await call("read_browser_dialog", { tabId });
  check(
    "the open dialog is reported with its type and message",
    whileOpen?.dialog?.type === "confirm" && /确定删除/.test(whileOpen.dialog.message ?? ""),
    whileOpen,
  );

  // The page itself answers nothing — a read that has to run inside it times out.
  const blocked = await readOut(tabId, 2500);
  check(
    "the page answers nothing while the dialog is up",
    typeof blocked !== "string" && blocked?.timedOut === true,
    blocked,
  );

  /*
   * And a tool must name the dialog instead of waiting out a timeout.
   *
   * The check is on a read, which is the cheapest way to reach a blocked page.
   * It has to fail *fast*: the record of the dialog is in main, so refusing
   * before sending anything is possible, and a tool that instead waited 30
   * seconds and then blamed `CDP Runtime.evaluate` would leave the caller looking
   * at selectors. A 8-second window is the assertion: an error well inside it,
   * naming the dialog, is the behaviour; a stall is the old one.
   */
  const explainedAt = Date.now();
  const explained = await callExpectingTrouble(
    "check_element_visible",
    { tabId, selector: "#confirm" },
    8000,
  );
  const explainedMs = Date.now() - explainedAt;
  check(
    "a blocked read fails fast and names the dialog",
    explained.kind === "failed" && /弹窗/.test(explained.message ?? "") && explainedMs < 3000,
    { ...explained, explainedMs },
  );

  // --- 3. answering unblocks the page, and the page sees the answer ----------
  const dismissed = await call("handle_browser_dialog", { tabId, accept: false });
  check(
    "dismissing reports that it handled a dialog",
    dismissed.ok === true && dismissed.handled === true,
    dismissed,
  );
  /*
   * The click from step 1 was only suspended, not cancelled: it lands now, so
   * the page's handler runs and records `answered:false`. Asserting on it here is
   * what proves the queued command completed rather than silently vanishing.
   */
  await wait(600);
  const afterDismiss = await readOut(tabId);
  check(
    "the suspended click landed, and the page's code saw `false`",
    afterDismiss === "answered:false",
    afterDismiss,
  );
  const afterClose = await call("read_browser_dialog", { tabId });
  check("no dialog is reported once it is answered", afterClose.dialog === null, afterClose);

  // --- 4. accepting a confirm, an alert, and a page that cannot prompt ------
  check("the page went quiet before the next click", await waitForQuietPage(tabId));
  const acceptClick = await callExpectingTrouble(
    "click_browser_element",
    { tabId, selector: "#confirm" },
    6000,
  );
  const acceptOpen = await call("read_browser_dialog", { tabId });
  const accepted = await call("handle_browser_dialog", { tabId, accept: true });
  await wait(600);
  const afterAccept = await readOut(tabId);
  check(
    "accepting a confirm makes the page's code see `true`",
    acceptClick.kind !== "returned" &&
      acceptOpen?.dialog?.type === "confirm" &&
      accepted.handled === true &&
      afterAccept === "answered:true",
    { acceptClick, acceptOpen, accepted, afterAccept },
  );

  // An alert has one button, so this is the case where `accept` cannot be wrong;
  // what it proves is that the same handling works for the simplest dialog type.
  check("the page went quiet before the alert", await waitForQuietPage(tabId));
  const alertClick = await callExpectingTrouble(
    "click_browser_element",
    { tabId, selector: "#alert" },
    6000,
  );
  const alertOpen = await call("read_browser_dialog", { tabId });
  const alertAnswered = await call("handle_browser_dialog", { tabId, accept: true });
  await wait(600);
  const afterAlert = await readOut(tabId);
  check(
    "an alert is reported as an alert and answering it lets the page continue",
    alertClick.kind !== "returned" &&
      alertOpen?.dialog?.type === "alert" &&
      alertAnswered.handled === true &&
      afterAlert === "alert-returned",
    { alertClick, alertOpen, alertAnswered, afterAlert },
  );

  check("the page went quiet before the prompt", await waitForQuietPage(tabId));
  /*
   * A prompt is *not* expected to open, because Electron does not implement it:
   * `prompt()` throws `prompt() is not supported.` and returns nothing, so the
   * page's handler dies where it stands and `#out` keeps whatever it said before
   * (measured on 45.2.1, reproduced through `evaluate_browser_page`).
   *
   * Asserting that a prompt opens would be asserting against the engine rather
   * than against this app. What matters here is that a page calling an
   * unimplemented dialog does not wedge: the click returns, no dialog is
   * recorded, and the page still answers.
   */
  const beforePrompt = await readOut(tabId);
  const promptClick = await call("click_browser_element", { tabId, selector: "#prompt" });
  await wait(300);
  const promptDialog = await call("read_browser_dialog", { tabId });
  const afterPrompt = await readOut(tabId);
  check(
    "a page that calls the unsupported prompt() does not wedge",
    promptClick.ok === true &&
      promptDialog.dialog === null &&
      typeof afterPrompt === "string" &&
      !/页面没有应答/.test(afterPrompt) &&
      afterPrompt === beforePrompt,
    { promptClick, promptDialog, beforePrompt, afterPrompt },
  );

  // --- 5. answering when nothing is showing is a fact, not an error ----------
  const nothing = await call("handle_browser_dialog", { tabId, accept: true });
  check(
    "no dialog reports handled: false instead of failing",
    nothing.ok === true && nothing.handled === false,
    nothing,
  );

  // --- 6. an unanswered dialog is dismissed on its own -----------------------
  /*
   * The budget is set to 20 seconds through the environment. Without an escape
   * hatch a page that receives a stray confirm stays unusable until the tab is
   * closed — no read, no click, no screenshot.
   */
  await waitForQuietPage(tabId);
  const idleClick = await callExpectingTrouble(
    "click_browser_element",
    { tabId, selector: "#idle" },
    6000,
  );
  const idleOpen = await call("read_browser_dialog", { tabId });
  check(
    "the unanswered dialog is up",
    idleClick.kind !== "returned" && idleOpen?.dialog?.type === "confirm",
    { idleClick, idleOpen },
  );
  await wait(22000);
  const idleGone = await call("read_browser_dialog", { tabId });
  const idlePage = await readOut(tabId);
  check(
    "the dialog is dismissed on its own, and the page comes back",
    idleGone.dialog === null && idlePage === "idle-returned",
    { idleGone, idlePage },
  );

  // A page that has just been unblocked still answers the ordinary tools.
  const plain = await call("click_browser_element", { tabId, selector: "#plain" });
  check("the page is usable again after all of it", plain.ok === true, plain);
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
