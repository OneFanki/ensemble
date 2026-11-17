#!/usr/bin/env node
/**
 * End-to-end check of the pointer/keyboard actions and their honest returns.
 *
 * Each assertion proves the *page* reacted, not that the tool returned `ok`:
 *
 * - `hover` must open a menu that only exists under `:hover` and `mouseenter`.
 * - `click` on a button whose handler replaces itself must still report
 *   `hit.onTarget: true` (the press landed) while `hitAfter` shows the swap.
 * - `scroll` must move a nested container (not the page) and report the real
 *   displacement read back from it, `moved: false` at the end of its range.
 * - `press` of a key combination must reach the page's own `keydown` handler with
 *   the modifier bits set, and Ctrl+A must produce a live selection that typing
 *   replaces rather than appends to.
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
 * The page has five things to prove, one per action:
 *
 * 1. A menu that is `display: none` until `:hover` — the shape every hover-driven
 *    dropdown has, and the thing a click-only tool surface cannot open.
 * 2. A button whose click handler *synchronously replaces itself* — the shape
 *    that made the post-release hit read-back report misses for clicks that
 *    landed. The hit verdict must come from the press instant.
 * 3. A scrollable box whose own scrollTop is what moves, so "scrolled the page"
 *    and "scrolled the container" are distinguishable, and the reported
 *    displacement is the real delta read back from the container.
 * 4. A keydown listener that records the modifier flags, so a combination that
 *    was only labelled with modifiers but not actually pressed with them shows up
 *    as `none`.
 * 5. A text field for the select-all chain: Ctrl+A must really select (selection
 *    collapsed to nothing after Delete proves it), and typing right after must
 *    replace — not append after — the old value.
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
<button id="swap" type="button">换我</button>
<div id="scroller"><div id="scroller-inner"></div></div>
<input id="keyfield" placeholder="点这里再按键">
<div id="keylog">none</div>
<script>
  // The click handler swaps the button out in the same tick the click runs in,
  // so any read-back after the release sees the replacement, not the target.
  window.__swapClicks = 0;
  document.getElementById('swap').addEventListener('click', () => {
    window.__swapClicks += 1;
    const next = document.createElement('button');
    next.id = 'swap';
    next.type = 'button';
    next.textContent = '换我（第' + window.__swapClicks + '次）';
    document.getElementById('swap').replaceWith(next);
  });

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

  // --- click survives a handler that replaces the target in the same tick ---
  const swap = await call("click_browser_element", { tabId, selector: "#swap" });
  const swapClicks = await call("evaluate_browser_page", {
    tabId,
    expression: `window.__swapClicks`,
  });
  check(
    "the click ran even though the handler replaced the element",
    swapClicks === 1,
    { swapClicks, swap },
  );
  check(
    "the hit verdict stays true when the page swapped itself after the press",
    swap.ok === true && swap.hit?.onTarget === true,
    swap,
  );
  check(
    "the post-release read saw the replacement element, reported separately",
    swap.hitAfter?.onTarget === false,
    swap,
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
  check(
    "scrolled is the real displacement read back, matching the wheel delta",
    scrolled.scrolled?.y === 200 && scrolled.scrolled?.x === 0,
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
  check(
    "a no-op scroll reports a zero displacement rather than the resting position",
    atEnd.scrolled?.x === 0 && atEnd.scrolled?.y === 0,
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

  // --- select-all chain: Ctrl+A must select, and typing must replace --------
  // The field is focused first, exactly as a caller would. Ctrl+A's verdict is
  // read from the selection itself; then a real Delete (an editing command that
  // follows the selection) emptying the field is the hard proof the selection
  // was there and usable, not just an event with modifier bits set.
  await call("type_browser_text", { tabId, selector: "#keyfield", text: "abc" });
  await call("press_browser_keys", { tabId, keys: "Control+a" });
  await wait(150);
  const selected = await call("evaluate_browser_page", {
    tabId,
    expression: `({ s: document.getElementById('keyfield').selectionStart,
                    e: document.getElementById('keyfield').selectionEnd,
                    v: document.getElementById('keyfield').value })`,
  });
  check(
    "Ctrl+A really selects the field's contents",
    selected.s === 0 && selected.e === 3 && selected.v === "abc",
    selected,
  );
  await call("press_browser_keys", { tabId, keys: "Delete" });
  await wait(120);
  const emptied = await call("evaluate_browser_page", {
    tabId,
    expression: `document.getElementById('keyfield').value`,
  });
  check(
    "Delete right after Ctrl+A empties the field, proving the selection is live",
    emptied === "",
    emptied,
  );

  // The full chain a caller actually runs: select all, then type. The typed
  // character must replace the selection — an append would mean the combination
  // never reached the editing pipeline.
  await call("type_browser_text", { tabId, selector: "#keyfield", text: "abc" });
  await call("press_browser_keys", { tabId, keys: "Control+a" });
  await wait(150);
  await call("type_browser_text", { tabId, selector: "#keyfield", text: "X" });
  const replaced = await call("evaluate_browser_page", {
    tabId,
    expression: `document.getElementById('keyfield').value`,
  });
  check(
    "typing after Ctrl+A replaces the content instead of appending",
    replaced === "X",
    replaced,
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
