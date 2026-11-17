#!/usr/bin/env node
/**
 * End-to-end check of JavaScript dialog handling, along the path a real user
 * (and a real AI session) takes.
 *
 * 测得的引擎事实（Electron 45.2.1），也是本套件的前提：
 *
 * - 弹窗打开的那条输入命令在 CDP 层永远等不到回应：`Input.dispatchMouseEvent`
 *   不 ack，`Runtime.evaluate` 也不返回。打断等待的唯一及时信号是
 *   `Page.javascriptDialogOpening` 事件——所以「点击触发弹窗」的正确行为是
 *   点击命令在事件到达时立刻返回结构化的 dialog 信息，而不是等满命令上限。
 * - `Page.handleJavaScriptDialog` 在弹窗打开期间仍能应答，这是唯一的解法。
 * - beforeunload 不走 CDP 弹窗事件：Electron 改发 `will-prevent-unload`，且
 *   Chromium 只在页面拿到过用户激活后才执行 beforeunload 拦截——所以用例先
 *   真实点击页面再导航，与人的操作顺序一致。
 * - `prompt()` 在 Electron 里同步抛错（`prompt() is not supported.`）：点击
 *   返回、页面继续回答，事件循环不会停摆。真正会停摆的是页面自己的死循环，
 *   read_browser_page 的事件循环探针负责把它认出来。
 *
 * 用例顺序即真实会话顺序：点击 →（立即拿到弹窗信息）→ 读弹窗 → 应答 → 页面继续。
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
 * 一个页面覆盖弹窗用例，另一个覆盖 beforeunload，最后一个专门把循环卡死。
 *
 * - `#confirm` 把 confirm 的返回值写进页面，所以「页面看到了 true/false」是
 *   页面自己记下的事实，不是从工具返回值反推的。
 * - `#prompt` 用 try/catch 记录 prompt 的真实结局（本环境是同步抛错）。
 * - `#idle` 打开一个没人应答的 confirm，验证 30 秒兜底。
 * - `#tap` 在 beforeunload 页面上提供真实点击，拿用户激活。
 * - `#wedge` 把事件循环真正卡死，验证探针。
 */
const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (path === "/bu") {
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>离开确认</title>
<style>body { margin: 0; font-family: sans-serif; } button, a { display: inline-block; margin: 30px; padding: 12px 20px; font-size: 15px; }
#out { margin: 30px; font-family: monospace; }</style></head><body>
<button id="tap" type="button">先点这里</button>
<a id="gone" href="/elsewhere">站内链接</a>
<div id="out">init</div>
<script>
  const out = (t) => { document.getElementById('out').textContent = t; };
  window.addEventListener('beforeunload', (e) => {
    e.preventDefault();
    e.returnValue = '确认离开本页？';
    out('handler-ran');
  });
  document.getElementById('tap').onclick = () => out('clicked');
  out('ready');
</script></body></html>`);
    return;
  }
  if (path === "/wedge") {
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>卡死页</title></head><body>
<button id="wedge" type="button">卡死循环</button>
<div id="out">init</div>
<script>
  const out = (t) => { document.getElementById('out').textContent = t; };
  document.getElementById('wedge').onclick = () => {
    out('wedging');
    // 延迟 400ms 再卡死：让点击命令自己的收尾读取先跑完，卡死只留给
    // 之后的页面读取去发现——真实世界里「点了之后页面才卡死」也是这样。
    setTimeout(() => { while (true) {} }, 400);
  };
</script></body></html>`);
    return;
  }
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
    try {
      out('prompt:' + prompt('给这个视图起个名字', '默认视图'));
    } catch (e) {
      out('prompt-threw:' + e.message);
    }
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
</script></body></html>`);
});
await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;
const BU_URL = `${PAGE_URL}bu`;
const AWAY_URL = `${PAGE_URL}elsewhere`;
const WEDGE_URL = `${PAGE_URL}wedge`;

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
     * 弹窗在本套件里大都会被主动应答，唯一的例外是自动取消用例：它要等满
     * 这个预算，证明「无人应答时页面自己恢复」。8 秒给其他用例里的应答留了
     * 几倍余量，又不必让套件为一条断言等 20 秒。
     */
    ENSEMBLE_DIALOG_AUTO_DISMISS_MS: "8000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
async function call(name, args = {}, options = {}) {
  const started = Date.now();
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
  const ms = Date.now() - started;
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content[0].text}`);
  const text = json.result.content[0].text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ms, body };
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
 * 一条被打断的点击在弹窗应答后才真正落进页面，之后才能点下一条：这里先把
 * 挂着的弹窗清掉，再用一次真跑在页面里的 evaluate 证明页面已经空闲。
 */
async function waitForQuietPage(tabId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let answered = false;
  while (Date.now() < deadline) {
    const status = await call("read_browser_dialog", { tabId });
    if (status.body.dialog) {
      // Whatever is up was opened by a click this suite already made; answer it
      // so the page can move on.
      await call("handle_browser_dialog", { tabId, accept: false });
      answered = false;
      await wait(400);
      continue;
    }
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
    const r = await call(
      "evaluate_browser_page",
      { tabId, expression: "document.getElementById('out').textContent", timeoutMs },
      { timeoutMs: timeoutMs + 2000 },
    );
    return r.body;
  } catch {
    return "（页面没有应答）";
  }
}

try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const tab = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = tab.body.id ?? tab.body.tabId ?? tab.body.tabs?.at(-1)?.id;
  check("a page was opened", Boolean(tabId), { tabId });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const visible = await call("check_element_visible", { tabId, selector: "#confirm" });
    if (visible.body.visible) break;
    await wait(200);
  }

  /*
   * --- 1. click → 弹窗信息立刻返回（alert 全链路） ---------------------------
   *
   * 真实路径：点击触发 alert，那条点击命令靠事件信号在弹窗打开的瞬间返回，
   * 返回体带着弹窗的类型与内容。断言的上限 2.5 秒：事件在几十毫秒内到达，
   * 剩下的余量是给慢机器的；旧实现要等满 30 秒命令上限。
   */
  const alertClick = await call("click_browser_element", { tabId, selector: "#alert" }, { timeoutMs: 15000 });
  check(
    "a click that opens an alert returns promptly with the dialog facts",
    alertClick.body.ok === true &&
      alertClick.body.dialog?.type === "alert" &&
      /只有确定/.test(alertClick.body.dialog?.message ?? "") &&
      /read_browser_dialog/.test(alertClick.body.hint ?? "") &&
      alertClick.ms < 2500,
    { ms: alertClick.ms, dialog: alertClick.body.dialog },
  );

  // --- 2. the dialog record answers reads while the page is blocked ----------
  const whileOpen = await call("read_browser_dialog", { tabId });
  check(
    "the open dialog is reported with its type and message",
    whileOpen.body.dialog?.type === "alert" &&
      whileOpen.body.dialog?.pageBlocked === true &&
      /只有确定/.test(whileOpen.body.dialog?.message ?? ""),
    whileOpen.body,
  );

  // The page itself answers nothing — a read that has to run inside it times out.
  const blocked = await readOut(tabId, 2500);
  check(
    "the page answers nothing while the dialog is up",
    typeof blocked !== "string" && blocked?.timedOut === true,
    blocked,
  );

  /*
   * And a read issued to a blocked page fails fast and names the dialog, instead
   * of waiting out its ceiling. 3 秒是断言：毫秒级的前置检查是行为，等满上限是
   * 旧行为。
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

  // --- 3. answering unblocks the page, and the page saw the answer ----------
  const dismissed = await call("handle_browser_dialog", { tabId, accept: false });
  check(
    "dismissing reports that it handled a dialog",
    dismissed.body.ok === true && dismissed.body.handled === true,
    dismissed.body,
  );
  /*
   * 被打断的点击只是不再等待，事件本身还在：弹窗应答后 mouseReleased 落进
   * 页面，处理器跑完记录 `answered:false`。这条断言证明挂起的命令完成了，
   * 而不是凭空消失。
   */
  await wait(600);
  const afterDismiss = await readOut(tabId);
  check(
    "the suspended click landed, and the page's code saw `false`",
    afterDismiss === "alert-returned" || afterDismiss === "answered:false",
    afterDismiss,
  );

  // --- 4. confirm 全链路：取消与确定各一条 ------------------------------------
  check("the page went quiet before the next click", await waitForQuietPage(tabId));
  const confirmClick = await call("click_browser_element", { tabId, selector: "#confirm" }, { timeoutMs: 15000 });
  const confirmOpen = await call("read_browser_dialog", { tabId });
  const confirmAnswered = await call("handle_browser_dialog", { tabId, accept: true });
  await wait(600);
  const afterAccept = await readOut(tabId);
  check(
    "a confirm click surfaces the dialog, and accepting it makes the page see `true`",
    confirmClick.body.dialog?.type === "confirm" &&
      /确定删除/.test(confirmClick.body.dialog?.message ?? "") &&
      confirmOpen.body.dialog?.type === "confirm" &&
      confirmAnswered.body.handled === true &&
      afterAccept === "answered:true",
    {
      clickDialog: confirmClick.body.dialog,
      clickMs: confirmClick.ms,
      record: confirmOpen.body.dialog,
      handled: confirmAnswered.body.handled,
      afterAccept,
    },
  );

  /*
   * --- 5. 工具超时不动弹窗 ---------------------------------------------------
   *
   * 真实路径里最像事故的形态：弹窗开着，另一个工具自己超时。 evaluate 在
   * 弹窗期间不会返回（它自己的预算到了就报 timedOut）；断言的关键是这次
   * 超时之后弹窗记录原样还在——超时只报错，不允许顺手应答。
   */
  check("the page went quiet before the timeout case", await waitForQuietPage(tabId));
  const timeoutClick = await call("click_browser_element", { tabId, selector: "#confirm" }, { timeoutMs: 15000 });
  const stalled = await callExpectingTrouble(
    "evaluate_browser_page",
    { tabId, expression: "1", timeoutMs: 2000 },
    8000,
  );
  const dialogAfterTimeout = await call("read_browser_dialog", { tabId });
  check(
    "a tool that times out leaves the dialog untouched for the caller to answer",
    timeoutClick.body.dialog?.type === "confirm" &&
      stalled.kind === "returned" &&
      stalled.value?.body?.timedOut === true &&
      dialogAfterTimeout.body.dialog?.type === "confirm" &&
      /确定删除/.test(dialogAfterTimeout.body.dialog?.message ?? ""),
    {
      clickDialog: timeoutClick.body.dialog,
      stalled: stalled.kind === "returned" ? stalled.value : stalled,
      dialogAfterTimeout: dialogAfterTimeout.body.dialog,
    },
  );
  await call("handle_browser_dialog", { tabId, accept: false });
  await wait(400);

  // --- 6. prompt：本环境同步抛错，页面不停摆，探针也不误报 --------------------
  check("the page went quiet before the prompt", await waitForQuietPage(tabId));
  const promptClick = await call("click_browser_element", { tabId, selector: "#prompt" }, { timeoutMs: 15000 });
  await wait(300);
  const promptDialog = await call("read_browser_dialog", { tabId });
  const afterPrompt = await readOut(tabId);
  const promptPage = await call("read_browser_page", { tabId }, { timeoutMs: 30000 });
  check(
    "the unsupported prompt() throws in-page without wedging anything",
    promptClick.body.ok === true &&
      promptClick.body.dialog === undefined &&
      promptDialog.body.dialog === null &&
      afterPrompt === "prompt-threw:prompt() is not supported." &&
      promptPage.body.loop === undefined,
    {
      promptClick: promptClick.body.ok,
      promptDialog: promptDialog.body.dialog,
      afterPrompt,
      probe: promptPage.body.loop,
    },
  );

  // --- 7. answering when nothing is showing is a fact, not an error ----------
  const nothing = await call("handle_browser_dialog", { tabId, accept: true });
  check(
    "no dialog reports handled: false instead of failing",
    nothing.body.ok === true && nothing.body.handled === false,
    nothing.body,
  );

  // --- 8. 弹窗挂起期间，CDP 会话保持附加 -------------------------------------
  /*
   * 闲置分离（1.5 秒无命令）会把被抑制的弹窗交还给 Electron 的原生对话框
   * 兜底——一个真弹窗会漏到用户桌面上。所以弹窗从登记到应答之间，会话必须
   * 一直钉住。这里的等待（3 秒）远超闲置分离时长：超过之后 read 仍能读到、
   * handle 仍能应答，就是「会话没断」的间接证据——断了的话 handle 会被
   * Chromium 以无弹窗可答拒绝（handled: false）。
   */
  await waitForQuietPage(tabId);
  const idleClick = await call("click_browser_element", { tabId, selector: "#idle" }, { timeoutMs: 15000 });
  const idleOpen = await call("read_browser_dialog", { tabId });
  check(
    "the unanswered dialog is up, and the interrupted click already reported it",
    idleClick.body.dialog?.type === "confirm" && idleClick.ms < 2500 && idleOpen.body.dialog?.type === "confirm",
    { clickMs: idleClick.ms, clickDialog: idleClick.body.dialog, record: idleOpen.body.dialog },
  );
  await wait(3000);
  const stillUp = await call("read_browser_dialog", { tabId });
  const idleAnswered = await call("handle_browser_dialog", { tabId, accept: true }, { timeoutMs: 15000 });
  await wait(600);
  const idleOut = await readOut(tabId);
  check(
    "the session stays attached past the idle-detach window while a dialog is up",
    stillUp.body.dialog?.type === "confirm" &&
      idleAnswered.body.handled === true &&
      idleOut === "idle-returned",
    { stillUp: stillUp.body.dialog, handled: idleAnswered.body.handled, idleOut },
  );

  // --- 9. an unanswered dialog is dismissed on its own -----------------------
  /*
   * 没有这个兜底，一个没人理的 confirm 会让页面一直不可用；有了它，代价是
   * 一次被自动取消的 confirm。
   */
  await waitForQuietPage(tabId);
  const idleClick2 = await call("click_browser_element", { tabId, selector: "#idle" }, { timeoutMs: 15000 });
  check("the second idle dialog is up", idleClick2.body.dialog?.type === "confirm", {
    dialog: idleClick2.body.dialog,
  });
  await wait(10500);
  const idleGone = await call("read_browser_dialog", { tabId });
  const idlePage = await readOut(tabId);
  check(
    "the dialog is dismissed on its own, and the page comes back",
    idleGone.body.dialog === null && idlePage === "idle-returned",
    { idleGone: idleGone.body.dialog, idlePage },
  );

  // A page that has just been unblocked still answers the ordinary tools.
  const plain = await call("click_browser_element", { tabId, selector: "#plain" }, { timeoutMs: 15000 });
  check("the page is usable again after all of it", plain.body.ok === true, plain.body);

  /*
   * --- 9. beforeunload：可见、可答，accept 真的离开 ---------------------------
   *
   * Chromium 只在页面拿过用户激活后执行 beforeunload 拦截，所以先真实点击
   * 一次再导航——这正是人会做的事。拦下后：navigate 返回体明说
   * cancelled:"beforeunload"（不再假装成功），页面留在原地且可继续操作；
   * dismiss（accept:false）留下；accept:true 重新发起导航，页面真的走。
   */
  await call("navigate_browser_tab", { tabId, url: BU_URL }, { timeoutMs: 20000 });
  await wait(1000);
  const tap = await call("click_browser_element", { tabId, selector: "#tap" }, { timeoutMs: 15000 });
  const tapOut = await readOut(tabId);
  check(
    "the beforeunload page is activated by a real click",
    tap.body.ok === true && tapOut === "clicked",
    { ok: tap.body.ok, tapOut },
  );

  const blockedNav = await call("navigate_browser_tab", { tabId, url: AWAY_URL }, { timeoutMs: 20000 });
  check(
    "a blocked navigation says so instead of pretending success",
    blockedNav.body.cancelled === "beforeunload" &&
      /beforeunload|离开/.test(blockedNav.body.note ?? "") &&
      blockedNav.body.tab?.url === BU_URL &&
      blockedNav.ms < 5000,
    { ms: blockedNav.ms, cancelled: blockedNav.body.cancelled, note: blockedNav.body.note, url: blockedNav.body.tab?.url },
  );

  const buDialog = await call("read_browser_dialog", { tabId });
  const buLocation = await call(
    "evaluate_browser_page",
    { tabId, expression: "location.pathname", timeoutMs: 3000 },
    { timeoutMs: 8000 },
  );
  check(
    "the interception is readable, and the page stayed put and alive",
    buDialog.body.dialog?.type === "beforeunload" &&
      buDialog.body.dialog?.pageBlocked === false &&
      buLocation.body === "/bu",
    { dialog: buDialog.body.dialog, location: buLocation.body },
  );

  await call("handle_browser_dialog", { tabId, accept: false });
  const stayed = await call(
    "evaluate_browser_page",
    { tabId, expression: "location.pathname", timeoutMs: 3000 },
    { timeoutMs: 8000 },
  );
  check("dismissing the interception keeps the page where it was", stayed.body === "/bu", stayed.body);

  const secondNav = await call("navigate_browser_tab", { tabId, url: AWAY_URL }, { timeoutMs: 20000 });
  const acceptAnswer = await call("handle_browser_dialog", { tabId, accept: true }, { timeoutMs: 20000 });
  await wait(600);
  const moved = await call(
    "evaluate_browser_page",
    { tabId, expression: "location.pathname", timeoutMs: 3000 },
    { timeoutMs: 8000 },
  );
  check(
    "accepting the interception re-dispatches the navigation and the page moves",
    secondNav.body.cancelled === "beforeunload" &&
      acceptAnswer.body.handled === true &&
      moved.body === "/elsewhere",
    { cancelled: secondNav.body.cancelled, handled: acceptAnswer.body.handled, moved: moved.body },
  );

  /*
   * --- 10. 事件循环探针：页面把自己卡死时，读取报出真正的原因 -----------------
   *
   * 用一个独立标签页：卡死的循环没有恢复的路，主页面还要继续做断言。
   */
  const wedgeTab = await call("open_browser_tab", { url: WEDGE_URL }, { timeoutMs: 20000 });
  const wedgeTabId = wedgeTab.body.id ?? wedgeTab.body.tabId;
  await wait(1200);
  const wedgeClick = await call("click_browser_element", { tabId: wedgeTabId, selector: "#wedge" }, { timeoutMs: 15000 });
  check(
    "the click that arms the wedge still completes",
    wedgeClick.body.ok === true,
    { ok: wedgeClick.body.ok, ms: wedgeClick.ms },
  );
  await wait(800);
  const wedgeReadAt = Date.now();
  const wedgeRead = await callExpectingTrouble(
    "read_browser_page",
    { tabId: wedgeTabId },
    30000,
  );
  const wedgeReadMs = Date.now() - wedgeReadAt;
  check(
    "a wedged event loop is reported as such, not as a slow read",
    wedgeRead.kind === "failed" &&
      /事件循环/.test(wedgeRead.message ?? "") &&
      /关闭标签页/.test(wedgeRead.message ?? "") &&
      wedgeReadMs < 5000,
    { read: wedgeRead, ms: wedgeReadMs },
  );

  // 卡死页面上的后续命令明确报「没等到」，而不是假装成功。
  const stalledAfterWedge = await callExpectingTrouble(
    "evaluate_browser_page",
    { tabId: wedgeTabId, expression: "1", timeoutMs: 2000 },
    10000,
  );
  check(
    "further driving of the wedged page reports the stall instead of success",
    stalledAfterWedge.kind === "returned" && stalledAfterWedge.value?.body?.timedOut === true,
    stalledAfterWedge.kind === "returned" ? stalledAfterWedge.value?.body : stalledAfterWedge,
  );
} catch (error) {
  check("run completed", false, String(error));
  console.log("appLog tail:", appLog.slice(-1200));
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
