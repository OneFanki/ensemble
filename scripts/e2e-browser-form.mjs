#!/usr/bin/env node
/**
 * End-to-end check of the three "form and drag" actions.
 *
 * Each assertion proves the *page* changed, not that the tool returned `ok`:
 *
 * - `upload` has to put the right names and sizes into the input's `FileList`,
 *   because `DOM.setFileInputFiles` succeeding means nothing if the page's own
 *   change handler never ran.
 * - `drag` has to make a drop handler reorder items, which is the shape every
 *   sortable list has, and it only fires if the pointer actually moved in steps.
 * - `check` must be idempotent: calling it twice on an already-checked box must
 *   leave it checked, which a blind click does not.
 *
 * Everything goes through MCP, the same surface an AI client uses.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const MCP_PORT = await freePort();
const TOKEN = "e2e-form-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-form-"));
const uploadDir = mkdtempSync(join(tmpdir(), "ensemble-e2e-form-files-"));

/*
 * Three files with distinct sizes, so "the page read the right file" is a fact
 * about the content rather than only the name.
 */
const FILES = [
  { name: "report.txt", bytes: "a".repeat(1200) },
  { name: "notes.txt", bytes: "b".repeat(3400) },
  { name: "数据文件.csv", bytes: "c".repeat(50) },
];
for (const file of FILES) {
  writeFileSync(join(uploadDir, file.name), file.bytes);
}
// A single-file input needs one path; the multi input takes all three.
const ONE_FILE = join(uploadDir, FILES[0].name);

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>表单与拖拽</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  section { margin: 24px; }
  #list { list-style: none; padding: 0; width: 260px; }
  #list li { padding: 10px 14px; margin: 6px 0; background: #eef; border: 1px solid #99c; }
  #list li.over { background: #fdd; }
  #log { font-family: monospace; white-space: pre-wrap; }
</style></head><body>
<section>
  <label for="single">单个文件</label>
  <input id="single" type="file">
</section>
<section>
  <label for="multi">多个文件</label>
  <input id="multi" type="file" multiple>
</section>
<section>
  <label for="agree">同意条款</label>
  <input id="agree" type="checkbox">
</section>
<section>
  <label for="locked">锁定选项</label>
  <input id="locked" type="checkbox" onclick="event.preventDefault()">
</section>
<section>
  <ul id="list">
    <li draggable="true" data-id="a">第一项</li>
    <li draggable="true" data-id="b">第二项</li>
    <li draggable="true" data-id="c">第三项</li>
  </ul>
</section>
<div id="log"></div>
<script>
  const log = (text) => { document.getElementById('log').textContent += text + '\\n'; };

  // Records what the page itself saw, so a passing upload means the input fired.
  for (const id of ['single', 'multi']) {
    document.getElementById(id).addEventListener('change', (event) => {
      const files = Array.from(event.target.files || []);
      log(id + ':' + files.map((f) => f.name + '/' + f.size).join(','));
    });
  }

  // A minimal sortable list: HTML5 drag events, the shape every library uses.
  // A drag that goes straight from press to release fires no dragover, so the
  // order stays put — which is exactly what this suite needs to detect.
  let dragged = null;
  for (const item of document.querySelectorAll('#list li')) {
    item.addEventListener('dragstart', () => { dragged = item; log('dragstart:' + item.dataset.id); });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      item.classList.add('over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('over'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('over');
      if (!dragged || dragged === item) return;
      // Move the dragged item to where it was dropped.
      const from = Array.from(item.parentElement.children).indexOf(dragged);
      const to = Array.from(item.parentElement.children).indexOf(item);
      const parent = item.parentElement;
      if (from < to) item.after(dragged); else item.before(dragged);
      log('order:' + Array.from(parent.children).map((li) => li.dataset.id).join(','));
    });
  }
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

async function readLog(tabId) {
  return call("evaluate_browser_page", {
    tabId,
    expression: "document.getElementById('log').textContent",
    timeoutMs: 5000,
  });
}

try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const tab = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
  check("a page was opened", Boolean(tabId), { tabId });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const visible = await call("check_element_visible", { tabId, selector: "#single" });
    if (visible.visible) break;
    await wait(200);
  }

  // --- upload: the page's own change handler must see the files -------------
  const uploaded = await call("upload_browser_files", { tabId, selector: "#single", files: [ONE_FILE] });
  check(
    "an upload reports how many files it placed",
    uploaded.ok === true && uploaded.count === 1,
    uploaded,
  );
  await wait(300);
  const singleLog = await readLog(tabId);
  check(
    "the page saw the file, with its real size",
    /single:report\.txt\/1200/.test(singleLog),
    singleLog,
  );

  // Multiple files into a `multiple` input, in one call.
  const multiPaths = FILES.map((file) => join(uploadDir, file.name));
  const multi = await call("upload_browser_files", { tabId, selector: "#multi", files: multiPaths });
  check(
    "a multiple input accepts every file in one call",
    multi.ok === true && multi.count === 3 && multi.multiple === true,
    multi,
  );
  await wait(300);
  const multiLog = await readLog(tabId);
  check(
    "the page saw all three names, including a non-ASCII one",
    /multi:report\.txt\/1200,notes\.txt\/3400,数据文件\.csv\/50/.test(multiLog),
    multiLog,
  );

  /*
   * A single-file input given three paths is refused, not truncated: a form that
   * received one of three files reports success, and a caller then asserts
   * against a half-uploaded record.
   */
  let truncated = null;
  try {
    await call("upload_browser_files", { tabId, selector: "#single", files: multiPaths });
    truncated = "no-error";
  } catch (error) {
    truncated = String(error);
  }
  check(
    "a single-file input refuses several files instead of silently keeping one",
    /只能收一个/.test(truncated),
    { truncated },
  );

  // A target that is not a file input is reported as such rather than ignored.
  let notInput = null;
  try {
    await call("upload_browser_files", { tabId, selector: "#log", files: [ONE_FILE] });
    notInput = "no-error";
  } catch (error) {
    notInput = String(error);
  }
  check(
    "a non-file target is named as the reason",
    /not-a-file-input|not-found/.test(notInput),
    { notInput },
  );

  // --- check: idempotent, and honest about a box that will not move ----------
  const firstCheck = await call("set_browser_checkbox", { tabId, selector: "#agree", checked: true });
  check(
    "checking a box reports that it changed",
    firstCheck.ok === true && firstCheck.checked === true && firstCheck.changed === true,
    firstCheck,
  );
  const againCheck = await call("set_browser_checkbox", { tabId, selector: "#agree", checked: true });
  check(
    "checking an already-checked box changes nothing",
    againCheck.checked === true && againCheck.changed === false,
    againCheck,
  );
  const boxState = await call("evaluate_browser_page", {
    tabId,
    expression: "document.getElementById('agree').checked",
  });
  check("the box is still checked after the second call", boxState === true, boxState);

  const uncheck = await call("set_browser_checkbox", { tabId, selector: "#agree", checked: false });
  check(
    "unchecking reports the state it reached",
    uncheck.checked === false && uncheck.changed === true,
    uncheck,
  );

  /*
   * A box whose click handler calls `preventDefault` cannot be moved by a click.
   * Reporting the unchanged state is the point: a caller that assumed success
   * would go on to submit a form whose terms were never accepted.
   */
  const stuck = await call("set_browser_checkbox", { tabId, selector: "#locked", checked: true });
  check(
    "a box that refuses the click reports stuckAt instead of pretending",
    stuck.checked === false && stuck.changed === false && stuck.stuckAt === false,
    stuck,
  );

  // --- drag: the drop handler has to see a real drag ------------------------
  const before = await call("evaluate_browser_page", {
    tabId,
    expression: `Array.from(document.querySelectorAll('#list li')).map((li) => li.dataset.id).join(',')`,
  });
  check("the list starts in its declared order", before === "a,b,c", before);

  const dragged = await call("drag_browser_element", {
    tabId,
    fromSelector: '#list li[data-id="a"]',
    toSelector: '#list li[data-id="c"]',
  });
  check(
    "the drag reports the elements it moved between",
    dragged.ok === true && dragged.fromTag === "li" && dragged.toTag === "li",
    dragged,
  );
  check(
    "the drag reports the drop as received, near the target, with a real coordinate",
    dragged.dropped === true &&
      dragged.droppedAtTarget === true &&
      typeof dragged.dropAt?.x === "number" &&
      typeof dragged.dropAt?.y === "number",
    dragged,
  );
  await wait(400);
  const after = await call("evaluate_browser_page", {
    tabId,
    expression: `Array.from(document.querySelectorAll('#list li')).map((li) => li.dataset.id).join(',')`,
  });
  check(
    "the page's own drop handler reordered the list",
    after === "b,c,a",
    { before, after },
  );
  check(
    "the drag hints that the element changed places",
    dragged.reordered === true,
    dragged,
  );
  const dragLog = await readLog(tabId);
  check(
    "the drag emitted dragstart, so the page recognised it as a drag",
    /dragstart:a/.test(dragLog) && /order:b,c,a/.test(dragLog),
    dragLog,
  );
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  server.close();
  for (const dir of [userData, uploadDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      console.log("note: temp dir left behind at", dir);
    }
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
