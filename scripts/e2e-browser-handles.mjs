#!/usr/bin/env node
/**
 * End-to-end check of the element handle layer: `find_browser_element` plus the
 * five action tools' optional `handle` argument.
 *
 * Every assertion proves the *page* reacted, not that a tool said ok:
 *
 * - Narrowed find (`text` + `hasNotText`) must report the true match count, and
 *   clicking the handle with `nth` must increment exactly the target button's own
 *   counter on the page.
 * - The handle must survive a full re-render that reverses the list (the nodes
 *   are destroyed and recreated via innerHTML): clicking the same handle again
 *   still increments the same button's counter, not whatever now sits at that
 *   position.
 * - After a navigation the old handle must be refused with an error that says to
 *   find again.
 * - A handle registered from an ambiguous match set (no narrowing, no nth) must
 *   refuse to act with the "matched N" error instead of guessing.
 * - The observation tools share the same handle path: `wait_browser` (hidden)
 *   with the handle resolves once the page hides the element, and
 *   `check_element_visible` with the handle flips to `visible: false`. Giving
 *   both a handle and a locator field is refused for these two as well.
 * - A find that never matches must time out into a clear error.
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
const TOKEN = "e2e-handles-token-123456789";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-handles-"));

/*
 * Three similar buttons, each with its own counter. Reversing the list rewrites
 * the container's innerHTML, so the button nodes are destroyed and recreated —
 * a locator-plus-position alone cannot survive that; the handle's trait
 * alignment has to.
 */
const LIST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>句柄验证</title>
<style>
  body { margin: 20px; font-family: sans-serif; }
  li { margin: 6px 0; list-style: none; }
  .count { margin-left: 8px; font-family: monospace; }
</style></head><body>
<ul id="list">
  <li><button data-name="A" type="button">删除 A</button><span class="count" id="count-a">0</span></li>
  <li><button data-name="B" type="button">删除 B</button><span class="count" id="count-b">0</span></li>
  <li><button data-name="C" type="button">删除 C</button><span class="count" id="count-c">0</span></li>
</ul>
<button id="reverse" type="button">反转列表</button>
<p id="hide-target">要被隐藏的说明文字</p>
<button id="hide" type="button">隐藏目标</button>
<script>
  function bind() {
    document.querySelectorAll('#list button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = document.getElementById('count-' + btn.dataset.name.toLowerCase());
        el.textContent = String(Number(el.textContent) + 1);
      });
    });
  }
  bind();
  document.getElementById('reverse').addEventListener('click', () => {
    const ul = document.getElementById('list');
    ul.innerHTML = Array.from(ul.children).reverse().map((li) => li.outerHTML).join('');
    bind();
  });
  // 隐藏走 CSS（节点留在 DOM 里）：句柄解析要求定位仍能命中，
  // 「被移出 DOM」在句柄路径下会报找不到，那是另一条语义。
  document.getElementById('hide').addEventListener('click', () => {
    document.getElementById('hide-target').style.display = 'none';
  });
</script>
</body></html>`;

const SECOND_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>第二页</title></head>
<body><p id="second-marker">第二页内容</p></body></html>`;

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(path === "/second" ? SECOND_PAGE : LIST_PAGE);
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

/** Same round trip, but a tool-level error comes back as a string instead of throwing. */
async function callExpectError(name, args = {}) {
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
  if (json.error) return `${name}: ${json.error.message}`;
  if (json.result?.isError) return json.result.content[0].text;
  return "no-error";
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

async function counters() {
  return call("evaluate_browser_page", {
    tabId,
    expression: `({
      a: document.getElementById('count-a').textContent,
      b: document.getElementById('count-b').textContent,
      c: document.getElementById('count-c').textContent,
    })`,
  });
}

let tabId;
try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const tab = await call("open_browser_tab", { url: PAGE_URL });
  const tabId_ = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
  tabId = tabId_;
  check("a page was opened for the handles", Boolean(tabId), { tabId });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const visible = await call("check_element_visible", { tabId, selector: "#reverse" });
    if (visible.visible) break;
    await wait(200);
  }

  // --- narrowed find reports the true count, and the handle hits one button --
  const found = await call("find_browser_element", {
    tabId,
    text: "删除",
    hasNotText: "B",
  });
  check(
    "find with hasNotText narrows three buttons down to two",
    found.count === 2 && found.matches?.length === 2,
    found,
  );
  check(
    "the preview carries tag, text and visibility for each match",
    found.matches?.every((m) => m.tag === "button" && m.visible === true && /删除/.test(m.text)),
    found?.matches,
  );
  const handle = found.handleId;
  check("a handle id was issued", typeof handle === "string" && /^el-\d+-/.test(handle), handle);

  // 配 nth 点击：hasNotText 之后剩 A、C（文档序），nth:1 是「删除 C」。
  const clicked = await call("click_browser_element", { tabId, handle, nth: 1 });
  check("clicking the handle with nth reported a click", clicked.ok === true, clicked);
  await wait(150);
  const afterNth = await counters();
  check(
    "only the nth-targeted button's counter moved (C +1, A and B untouched)",
    afterNth.c === "1" && afterNth.a === "0" && afterNth.b === "0",
    afterNth,
  );

  // --- the handle survives a full re-render that reverses the list ----------
  const orderBefore = await call("evaluate_browser_page", {
    tabId,
    expression: `document.getElementById('list').textContent.replace(/\\s+/g, ' ').trim()`,
  });
  await call("click_browser_element", { tabId, selector: "#reverse" });
  await wait(150);
  const orderAfter = await call("evaluate_browser_page", {
    tabId,
    expression: `document.getElementById('list').textContent.replace(/\\s+/g, ' ').trim()`,
  });
  check(
    "the page really re-rendered (list order reversed)",
    /C.*B.*A/.test(orderAfter) && !/C.*B.*A/.test(orderBefore),
    { orderBefore, orderAfter },
  );

  const clickedAgain = await call("click_browser_element", { tabId, handle });
  check(
    "the same handle still clicks after the re-render",
    clickedAgain.ok === true && clickedAgain.text === "删除 C",
    clickedAgain,
  );
  await wait(150);
  const afterRerender = await counters();
  check(
    "the re-render click hit the same logical element (C again, not the new occupant of its old spot)",
    afterRerender.c === "2" && afterRerender.a === "0" && afterRerender.b === "0",
    afterRerender,
  );

  // --- an ambiguous handle refuses instead of guessing -----------------------
  const ambiguous = await call("find_browser_element", { tabId, text: "删除" });
  check(
    "find without narrowing reports all three matches",
    ambiguous.count === 3 && ambiguous.resolved === false,
    { count: ambiguous.count, resolved: ambiguous.resolved },
  );
  const ambiguousError = await callExpectError("click_browser_element", {
    tabId,
    handle: ambiguous.handleId,
  });
  check(
    "clicking the ambiguous handle errors with the match count",
    /匹配 3 个/.test(ambiguousError),
    ambiguousError,
  );

  // --- hasText narrows by contained substring -------------------------------
  const hasTextFound = await call("find_browser_element", { tabId, text: "删除", hasText: "C" });
  check(
    "hasText narrows by the element's own text",
    hasTextFound.count === 1 && hasTextFound.matches?.[0]?.text === "删除 C",
    hasTextFound,
  );
  const single = await call("click_browser_element", { tabId, handle: hasTextFound.handleId });
  check(
    "a handle with a single match clicks it without extra arguments",
    single.ok === true && single.text === "删除 C",
    single,
  );
  await wait(150);
  const afterSingle = await counters();
  check(
    "the single-match handle moved only its own counter",
    afterSingle.c === "3" && afterSingle.a === "0" && afterSingle.b === "0",
    afterSingle,
  );

  // --- the observation tools accept a handle too ----------------------------
  const hideTarget = await call("find_browser_element", { tabId, selector: "#hide-target" });
  check(
    "find registers a handle for the hideable element",
    hideTarget.count === 1 && typeof hideTarget.handleId === "string",
    hideTarget,
  );
  const visibleBefore = await call("check_element_visible", { tabId, handle: hideTarget.handleId });
  check(
    "check_element_visible with the handle reports the element visible",
    visibleBefore.exists === true && visibleBefore.visible === true,
    visibleBefore,
  );
  await call("click_browser_element", { tabId, selector: "#hide" });
  const hiddenWait = await call("wait_browser", {
    tabId,
    condition: "hidden",
    handle: hideTarget.handleId,
  });
  check(
    "wait_browser hidden with the handle resolves once the element hides",
    hiddenWait.ok === true,
    hiddenWait,
  );
  const visibleAfter = await call("check_element_visible", { tabId, handle: hideTarget.handleId });
  check(
    "check_element_visible with the handle reports visible:false after hiding",
    visibleAfter.exists === true && visibleAfter.visible === false,
    visibleAfter,
  );
  const waitExclusive = await callExpectError("wait_browser", {
    tabId,
    condition: "hidden",
    handle: hideTarget.handleId,
    selector: "#hide-target",
  });
  check(
    "wait_browser refuses a call giving both a handle and a locator",
    /只能给一个/.test(waitExclusive),
    waitExclusive,
  );
  const probeExclusive = await callExpectError("check_element_visible", {
    tabId,
    handle: hideTarget.handleId,
    selector: "#hide-target",
  });
  check(
    "check_element_visible refuses a call giving both a handle and a locator",
    /只能给一个/.test(probeExclusive),
    probeExclusive,
  );

  // --- navigation invalidates every handle of the tab -----------------------
  await call("navigate_browser_tab", { tabId, url: `${PAGE_URL}second` });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const visible = await call("check_element_visible", { tabId, selector: "#second-marker" });
    if (visible.visible) break;
    await wait(200);
  }
  const staleError = await callExpectError("click_browser_element", { tabId, handle });
  check(
    "a handle used after navigation says the page moved and to find again",
    /重新 find/.test(staleError),
    staleError,
  );

  // --- a find that never matches times out into a clear error ---------------
  const timeoutError = await callExpectError("find_browser_element", {
    tabId,
    text: "不存在的按钮",
    timeoutMs: 1200,
  });
  check(
    "a find with no match at all reports not-found after its timeout",
    /找不到匹配/.test(timeoutError),
    timeoutError,
  );

  // --- handle and locator fields are mutually exclusive ----------------------
  const exclusiveError = await callExpectError("click_browser_element", {
    tabId,
    handle,
    text: "删除",
  });
  check(
    "giving both a handle and a locator field is refused at the entrance",
    /只能给一个/.test(exclusiveError),
    exclusiveError,
  );
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
