#!/usr/bin/env node
/**
 * 拆窗（pop out）端到端检查。
 *
 * 一个页面拆到独立 OS 窗口后，验收六件事：
 *
 * 0. 空白页拒绝拆出：没有内容可搬，主进程直接拒绝并给出原因，该页不受影响。
 * 1. 登录态保留：会话分区（persist:）在 session 层，与承载窗口无关；拆出即
 *    页面重载，localStorage 标记必须原样读回。
 * 2. 主窗口照常工作：拆出一页不影响表面打开新页、广播状态。
 * 3. 关闭弹窗（点 X）后实例回到主舞台，MCP 仍可操作该标签页；**主窗口与主
 *    渲染层必须同时存活**，应用进程不能退出。
 * 4. 截图在弹窗模式下可用，哪怕弹窗最小化——最小化时 CDP 快路会挂起，必须
 *    退到 capturePage 渲染路径（与主窗口最小化同一分支）。
 * 5. 弹窗不挂 `parent`：两个窗口的生命周期互不牵连，孤儿回收由显式登记承担
 *    （主窗口销毁时 dockAll，断言见 chrome 关闭路径的独立检查）。
 *
 * 驱动方式与 minimize 套件一致：MCP 工具做页面操作，主进程 Node inspector
 * 做真实的窗口动作（最小化、关闭——与点 X 走同一条 close 语义）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, findRendererTarget } from "./lib/e2e-cdp.mjs";

const PAGE_PORT = await freePort();
const INSPECT_PORT = await freePort();
const MCP_PORT = await freePort();
// ≥20 chars: the MCP settings loader rejects shorter tokens and falls back to
// a generated one, which would make every authorised call 401.
const TOKEN = "popout-suite-token-20";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-popout-"));

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>拆窗测试</title></head>
<body><h1 id="title">拆窗测试页</h1>
<script>
  // 登录态代理：写在 localStorage（persist: 分区），拆出重载后必须还在。
  if (!localStorage.getItem("popoutMarker")) {
    localStorage.setItem("popoutMarker", "logged-in");
  }
</script>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;
const SECOND_URL = `http://127.0.0.1:${PAGE_PORT}/second`;

const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [],
    views: [],
    flows: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
    bookmarkFolders: [],
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
  }),
  { mode: 0o600 },
);

const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
// Not headless: the point is a real window pair — the popout has to be
// minimisable, and a headless run parks windows off every display where
// `minimize()` is a no-op.
const app = spawn(
  electron,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`, `--inspect=${INSPECT_PORT}`],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (c) => (appLog += c));
app.stderr.on("data", (c) => (appLog += c));
// `=0` 让 Chromium 自己挑端口；套件通过 MCP 与 inspect 端口驱动，不直连它，
// 但等它发布完成能避免首连被冷启动拒绝。
void waitForDebugPort(userData);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

let seq = 0;
async function call(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++seq,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  const result = json.result;
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? "failed"}`);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

async function listTabs() {
  return call("list_browser_tabs");
}

/** Polls `read` until `predicate` says done; a tab swap is a few broadcasts. */
async function pollUntil(read, predicate, { attempts = 40, everyMs = 250 } = {}) {
  let value;
  for (let i = 0; i < attempts; i += 1) {
    value = await read();
    if (predicate(value)) return value;
    await wait(everyMs);
  }
  return value;
}

async function findTarget(port, predicate, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const found = list.find(predicate);
      if (found) return found;
    } catch {
      /* 启动中 */
    }
  }
  return null;
}

try {
  const mainTarget = await findTarget(INSPECT_PORT, () => true, 60);
  if (!mainTarget) throw new Error(`no main inspector\n${appLog.slice(-800)}`);
  const main = await connectToWindow(mainTarget.webSocketDebuggerUrl);

  let ready = false;
  let lastProbe = "";
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await wait(250);
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list" }),
      });
      lastProbe = `status ${response.status}`;
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (error) {
      lastProbe = `fetch: ${error?.cause?.code ?? error?.message}`;
    }
  }
  if (!ready) throw new Error(`MCP endpoint never came up (${lastProbe})\n${appLog.slice(-900)}`);

  // ---- 0. 空白页拒绝拆出（主进程是裁决者） ----
  //
  // 空白页没有可搬的像素，换代只会多出一个空窗口。菜单里那一行禁用，但界面
  // 禁用只是提示：动作从任何入口送进来时，主进程必须自己拒绝。
  const blank = await call("open_browser_tab", {});
  const blankId = blank?.tabId ?? blank?.id;
  check("a blank page opens", Boolean(blankId), blank);
  if (blankId) {
    let blankError = null;
    try {
      await call("pop_out_browser_tab", { tabId: blankId });
    } catch (error) {
      blankError = String(error?.message ?? error);
    }
    check(
      "popping out a blank page is refused with a reason",
      typeof blankError === "string" && blankError.includes("空白页"),
      { blankError },
    );
    const blankState = await pollUntil(
      async () => (await listTabs())?.tabs?.find((tab) => tab.id === blankId),
      () => true,
      { attempts: 4, everyMs: 250 },
    );
    check(
      "the refused blank page never gets a popout flag",
      blankState?.popout !== true,
      blankState,
    );
    // 拒绝之后该页仍然可正常使用，不能被半套窗口拖坏。
    const blankAlive = await call("evaluate_browser_page", {
      tabId: blankId,
      expression: "location.href",
    }).catch(() => undefined);
    check("the blank page still works after the refusal", blankAlive === "about:blank", blankAlive);
    await call("close_browser_tab", { tabId: blankId }).catch(() => undefined);
  }

  // ---- 准备：打开页面，写入登录态标记 ----
  const opened = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = opened?.tabId ?? opened?.id;
  check("a page is open through MCP", Boolean(tabId), opened);
  if (!tabId) throw new Error(`no tab id in ${JSON.stringify(opened)}`);
  await pollUntil(
    () => call("evaluate_browser_page", { tabId, expression: "localStorage.getItem('popoutMarker')" }),
    (v) => v === "logged-in",
  );

  // ---- 1. 拆出 ----
  const popped = await call("pop_out_browser_tab", { tabId });
  check(
    "pop_out_browser_tab reports the new window id",
    Number.isInteger(popped?.windowId),
    popped,
  );
  const windowId = popped?.windowId;

  const realWindow = await main.evaluate(`(async () => {
    const electron = require("electron");
    const win = electron.BrowserWindow.fromId(${windowId});
    if (!win || win.isDestroyed()) return { error: "no popout window" };
    await new Promise((r) => setTimeout(r, 400));
    return {
      visible: win.isVisible(),
      parented: Boolean(win.getParentWindow()),
      backdrop: win.getBackgroundColor(),
    };
  })()`);
  check("the popout is a real OS window", realWindow?.visible === true, realWindow);
  // 不挂 parent 是拆窗语义的一部分：挂上之后主窗口最小化会连带弹窗不可见，
  // 而「主窗口收起来、这一页还在」正是拆窗的用途。孤儿问题由主窗口销毁时的
  // dockAll 承担（下面的断言覆盖）。
  check(
    "the popout is not owned by the main window",
    realWindow?.parented === false,
    realWindow,
  );

  // 拆出即页面重载；等状态广播带上 popout 标记。
  const tabState = await pollUntil(async () => {
    const tabs = await listTabs();
    return (tabs?.tabs ?? []).find((tab) => tab.id === tabId);
  }, (tab) => tab?.popout === true);
  check("the broadcast marks the tab as popped out", tabState?.popout === true, tabState);

  // ---- 2. 登录态保留 + MCP 仍可操作 ----
  const marker = await call("evaluate_browser_page", {
    tabId,
    expression: "localStorage.getItem('popoutMarker')",
  });
  check(
    "session state survives the pop-out reload (partition kept)",
    marker === "logged-in",
    marker,
  );

  const navigated = await call("navigate_browser_tab", { tabId, url: SECOND_URL });
  const navigatedUrl = await call("evaluate_browser_page", {
    tabId,
    expression: "location.href",
  });
  check(
    "MCP still drives the popped-out page",
    Boolean(navigated) && String(navigatedUrl ?? "").includes("/second"),
    { navigatedUrl },
  );
  await call("navigate_browser_tab", { tabId, url: PAGE_URL });
  await pollUntil(
    () => call("evaluate_browser_page", { tabId, expression: "document.readyState" }),
    (v) => v === "complete",
  );

  // ---- 3. 弹窗可见时的截图 ----
  const shotVisible = await call("screenshot_browser_tab", { tabId });
  check(
    "a screenshot works while the popout is visible",
    Boolean(shotVisible?.path),
    shotVisible,
  );

  // ---- 4. 最小化弹窗后的截图 ----
  const minimized = await main.evaluate(`(async () => {
    const electron = require("electron");
    const win = electron.BrowserWindow.fromId(${windowId});
    if (!win || win.isDestroyed()) return { error: "no popout window" };
    win.minimize();
    await new Promise((r) => setTimeout(r, 1200));
    return { minimized: win.isMinimized(), visible: win.isVisible() };
  })()`);
  check("the popout really is minimised", minimized?.minimized === true, minimized);

  const shotMinimized = await call("screenshot_browser_tab", { tabId });
  check(
    "a screenshot still works while the popout is minimised",
    Boolean(shotMinimized?.path),
    shotMinimized,
  );

  // ---- 4b. 激活已拆出的标签 = 唤起弹窗 ----
  //
  // 标签条点击已拆出的页面走 activateEmbeddedTab：弹窗必须被还原并可见。
  // restore/show 只保证「可见」——压在主窗口后面的弹窗，show() 是空操作，
  // Windows 的 focus() 又常被前台策略拒绝，所以主进程还要 moveTop()。这条
  // 断言守护最小化情形（可还原可断言）；被遮挡情形没有可读的 z 序 API，
  // 由主进程侧的 moveTop 承担。
  const chromiumPort = await waitForDebugPort(userData);
  let renderer = null;
  for (let i = 0; i < 40 && !renderer; i += 1) {
    await wait(250);
    const target = await findRendererTarget(chromiumPort).catch(() => null);
    if (target) renderer = await connectToWindow(target.webSocketDebuggerUrl);
  }
  const raised = renderer
    ? await renderer
        .evaluate(`window.ensemble.activateEmbeddedTab(${JSON.stringify(tabId)}).then(() => true).catch((e) => String(e))`)
        .catch((e) => `evaluate failed: ${e}`)
    : "no renderer target";
  check("the strip's activate channel answers on a popped tab", raised === true, { raised });
  await wait(600);
  const afterRaise = await main.evaluate(`(async () => {
    const electron = require("electron");
    const win = electron.BrowserWindow.fromId(${windowId});
    if (!win || win.isDestroyed()) return { error: "no popout window" };
    return { minimized: win.isMinimized(), visible: win.isVisible() };
  })()`);
  check(
    "activating a popped tab brings the popout back (minimised one is restored)",
    afterRaise?.minimized === false && afterRaise?.visible === true,
    afterRaise,
  );

  await main.evaluate(`(async () => {
    const electron = require("electron");
    const win = electron.BrowserWindow.fromId(${windowId});
    if (win && !win.isDestroyed()) win.restore();
  })()`);

  // ---- 5. 主窗口照常工作 ----
  const second = await call("open_browser_tab", { url: SECOND_URL });
  const secondId = second?.tabId ?? second?.id;
  check("the main surface still opens new pages", Boolean(secondId), second);
  const stateStill = await call("list_browser_tabs");
  check(
    "the surface state still lists both pages",
    (stateStill?.tabs ?? []).some((tab) => tab.id === secondId),
    stateStill,
  );

  // ---- 6. 点 X 关闭弹窗 → 实例回主舞台，MCP 仍可操作 ----
  await main.evaluate(`(async () => {
    const electron = require("electron");
    const win = electron.BrowserWindow.fromId(${windowId});
    if (win && !win.isDestroyed()) win.close();
  })()`);
  const redocked = await pollUntil(async () => {
    const tabs = await listTabs();
    return (tabs?.tabs ?? []).find((tab) => tab.id === tabId);
  }, (tab) => tab && tab.popout !== true);
  check(
    "closing the popout window docks the page back to the stage",
    redocked?.popout !== true,
    redocked,
  );

  // 登记撤销（popout 标记消失）先于新节点挂载完成；等 MCP 能真正驱动页面
  // 再断言会话状态，这才是「实例回到主舞台且可操作」的完整含义。
  const markerAfterDock = await pollUntil(
    () =>
      call("evaluate_browser_page", {
        tabId,
        expression: "localStorage.getItem('popoutMarker')",
      }).catch(() => undefined),
    (v) => v === "logged-in",
  );
  check(
    "MCP still drives the page after it docked back (login state intact)",
    markerAfterDock === "logged-in",
    markerAfterDock,
  );

  const gone = await main.evaluate(`(() => {
    const electron = require("electron");
    const win = electron.BrowserWindow.fromId(${windowId});
    return { destroyed: !win || win.isDestroyed() };
  })()`);
  check("the popout window is really gone", gone?.destroyed === true, gone);

  // ---- 7. 关弹窗没有波及主窗口 ----
  //
  // 行为契约：关掉拆出的窗口只结束那一个窗口。主窗口必须还在、还可见，主
  // 渲染层还要能执行 JavaScript（窗口对象存活但渲染进程崩掉是另一种失败），
  // 应用进程不能退出。逐条断言，避免「窗口还在但已经不可用」被判成通过。
  const survived = await main.evaluate(`(async () => {
    const electron = require("electron");
    const windows = electron.BrowserWindow.getAllWindows();
    const main = windows.find((w) => !w.getParentWindow()) ?? windows[0];
    if (!main || main.isDestroyed()) return { windows: windows.length, main: false };
    let alive = "n/a";
    try {
      alive = String(await main.webContents.executeJavaScript("1 + 1"));
    } catch (error) {
      alive = "THREW: " + error.message;
    }
    return {
      windows: windows.length,
      main: true,
      visible: main.isVisible(),
      crashed: main.webContents.isCrashed(),
      alive,
      url: main.webContents.getURL(),
    };
  })()`);
  check(
    "the main window survives closing the popout",
    survived?.main === true && survived?.visible === true && survived?.crashed === false,
    survived,
  );
  check(
    "the main renderer still runs JavaScript",
    survived?.alive === "2" && String(survived?.url ?? "").includes("index.html"),
    survived,
  );
  // 平台层证据：进程没有在关窗后退出。这里看的是子进程本身，不是 MCP 还答不
  // 答得上来——退出的进程也可能留下一个已经失效的监听被系统回收前的残影。
  check("the app process is still running", app.exitCode === null && !app.killed, {
    exitCode: app.exitCode,
    signalCode: app.signalCode,
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  main.close();
  app.kill();
  page.close();
  await wait(1200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  process.exit(failed.length ? 1 : 0);
} catch (error) {
  console.error(error?.stack || error);
  console.error(`\napp log tail:\n${appLog.slice(-1200)}`);
  app.kill();
  await wait(1200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  process.exit(2);
}
