#!/usr/bin/env node
/**
 * End-to-end check of the three pointer/keyboard actions the tool surface lacked.
 *
 * Each assertion proves the *page* reacted, not that the tool returned `ok`:
 *
 * - `hover` must open a menu that only exists under `:hover` and `mouseenter`.
 * - `scroll` must move a nested container (not the page) and report `moved: false`
 *   at the end of its range.
 * - `press` of a key combination must reach the page's own `keydown` handler with
 *   the modifier bits set.
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
const TOKEN = "e2e-actions-token-123456789";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-actions-"));

/*
 * The page has three things to prove, one per action:
 *
 * 1. A menu that is `display: none` until `:hover` — the shape every hover-driven
 *    dropdown has, and the thing a click-only tool surface cannot open.
 * 2. A scrollable box whose own scrollTop is what moves, so "scrolled the page"
 *    and "scrolled the container" are distinguishable.
 * 3. A keydown listener that records the modifier flags, so a combination that
 *    was only labelled with modifiers but not actually pressed with them shows up
 *    as `none`.
 */
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>动作验证</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  #menu-host { position: relative; display: inline-block; margin: 40px; }
  #menu-trigger { padding: 8px 16px; border: 1px solid #ccc; }
  #menu { display: none; position: absolute; top: 100%; left: 0; width: 160px;
          border: 1px solid #999; background: #fff; }
  #menu-host:hover #menu { display: block; }
  #scroller { height: 120px; width: 300px; overflow-y: auto; margin: 40px; border: 1px solid #ccc; }
  #scroller-inner { height: 1200px; background: linear-gradient(#eef, #99f); }
  #keylog { margin: 40px; font-family: monospace; }
</style></head><body>
<div id="menu-host">
  <button id="menu-trigger" type="button">菜单</button>
  <div id="menu"><div>选项一</div><div>选项二</div></div>
</div>
<div id="scroller"><div id="scroller-inner"></div></div>
<input id="keyfield" placeholder="点这里再按键">
<div id="keylog">none</div>
<script>
  // Recorded so the test can prove the page's own handler saw the modifiers, not
  // just that some key event happened.
  document.addEventListener('keydown', (event) => {
    const bits = [];
    if (event.altKey) bits.push('alt');
    if (event.ctrlKey) bits.push('ctrl');
    if (event.metaKey) bits.push('meta');
    if (event.shiftKey) bits.push('shift');
    document.getElementById('keylog').textContent =
      event.key + ':' + (bits.length ? bits.join('+') : 'none');
  });
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
  // The tool returns the tab record itself, not a wrapper with a `tabId` field.
  // Taking the wrong guess here silently falls back to the default tab (the
  // blank page the app starts with), and every later call then drives a page
  // that has none of this suite's elements.
  const tabId = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
  check("a page was opened for the actions", Boolean(tabId), { tabId, tab });

  // Let the first document settle; the menu's :hover rule and the scroll box are
  // static, but the page still has to finish loading before either exists.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const visible = await call("check_element_visible", { tabId, selector: "#menu-trigger" });
    if (visible.visible) break;
    await wait(200);
  }

  // --- hover opens a menu that a click-only surface cannot ------------------
  const menuBefore = await call("check_element_visible", { tabId, selector: "#menu" });
  check(
    "the menu is closed before hovering",
    menuBefore.visible === false,
    menuBefore,
  );

  const hovered = await call("hover_browser_element", { tabId, selector: "#menu-trigger" });
  check("hover found its target", hovered.ok === true && hovered.tag !== undefined, hovered);
  // `:hover` is applied synchronously on the next style recalc, but the reveal is
  // a separate paint; one frame is the honest wait.
  await wait(120);
  const menuAfter = await call("check_element_visible", { tabId, selector: "#menu" });
  check(
    "hovering the trigger opens the menu",
    menuAfter.visible === true,
    menuAfter,
  );

  // --- scroll moves the container, and says so ------------------------------
  const containerBefore = await call("evaluate_browser_page", {
    tabId,
    expression: `({ top: document.querySelector('#scroller').scrollTop,
                    page: window.scrollY })`,
  });
  const scrolled = await call("scroll_browser_page", {
    tabId,
    selector: "#scroller",
    deltaY: 200,
  });
  check(
    "scrolling a container reports that it moved",
    scrolled.ok === true && scrolled.moved === true,
    scrolled,
  );
  const containerAfter = await call("evaluate_browser_page", {
    tabId,
    expression: `({ top: document.querySelector('#scroller').scrollTop,
                    page: window.scrollY })`,
  });
  check(
    "the wheel moved the container, not the page",
    containerAfter.top > containerBefore.top && containerAfter.page === containerBefore.page,
    { before: containerBefore, after: containerAfter },
  );

  // A container already at its end must report `moved: false` rather than
  // pretending the scroll happened — that is what stops a flow from waiting for
  // content that a no-op scroll will never reveal.
  await call("scroll_browser_page", { tabId, selector: "#scroller", deltaY: 5000 });
  const atEnd = await call("scroll_browser_page", { tabId, selector: "#scroller", deltaY: 500 });
  check(
    "scrolling past the end reports moved: false",
    atEnd.moved === false,
    atEnd,
  );

  // --- a key combination reaches the page's modifier flags ------------------
  // The field is clicked first, for the same reason a person clicks a field
  // before typing: a guest routes key events to whatever the last real pointer
  // event landed on, and a key pressed with nothing focused reaches nothing.
  // Without this the assertions below fail for a reason that has nothing to do
  // with the key dispatch itself.
  await call("click_browser_element", { tabId, selector: "#keyfield" });
  await wait(120);

  const pressed = await call("press_browser_keys", { tabId, keys: "Control+Shift+K" });
  check("a combination reports the mask it used", pressed.modifiers === 10, pressed);
  await wait(120);
  const keylog = await call("evaluate_browser_page", {
    tabId,
    expression: `document.getElementById('keylog').textContent`,
  });
  check(
    "the page's keydown handler saw ctrl and shift held",
    /ctrl/.test(keylog) && /shift/.test(keylog),
    keylog,
  );

  // A single named key must still work through the same tool.
  await call("press_browser_keys", { tabId, keys: "Enter" });
  await wait(120);
  const enterLog = await call("evaluate_browser_page", {
    tabId,
    expression: `document.getElementById('keylog').textContent`,
  });
  check("a named key with no modifier arrives unmodified", /^Enter:none$/.test(enterLog), enterLog);

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
