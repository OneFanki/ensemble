#!/usr/bin/env node
/**
 * AI 活跃页必须满帧出图，端到端。
 *
 * 缺陷：停放页的 `<webview>` 节点被停在窗外，合成器不为窗外节点出帧，页内
 * rAF 被压到约 1fps；AI 命令（滚轮投递、动画后读取）依赖合成帧，宽限期内
 * 必须满帧。这个事实只能对真实合成器断言：窗口必须真实可见地摆在桌面上
 * （遮挡节流与窗外 cull 都是合成器行为，隐藏窗口测不出差异），所以本套件
 * 与 `run-all-e2e.mjs` 的可见窗口套件一样是 opt-in，不进默认全量。
 *
 * 时序（宽限与扫描由 `ENSEMBLE_SLEEP_TEST` 缩到秒级）：
 * 1. AI 打开一个无台页（必然停放），等 sweep 把它冻结；
 * 2. 一条 AI 命令装 rAF 采样器（唤醒页面并刷新宽限），随即返回；
 * 3. 宽限期内、无命令在飞时读采样：间隔必须是帧级，而不是约 1 秒；
 * 4. 宽限过后页面回到冻结（省资源行为不因修复而丢失）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";
import { openRail } from "./lib/e2e-nav.mjs";

const GRACE_MS = 1_500;
const SWEEP_MS = 200;
const MCP_PORT = await freePort();
const TOKEN = "ai-frames-check-token-0123456789";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-ai-frames-"));

const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>frames${req.url}</title></head>` +
      `<body><h1 id="head">frames${req.url}</h1><p>a parked page with an animation loop</p></body></html>`,
  );
});
const pagePort = await freePort();
await new Promise((done) => page.listen(pagePort, "127.0.0.1", done));
const pageUrl = `http://127.0.0.1:${pagePort}/animated`;

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
    bookmarks: [],
    bookmarkFolders: [],
    instances: [],
    manualEngines: [],
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
    aiMode: "allow-all",
  }),
  { mode: 0o600 },
);

const electron =
  process.env.ENSEMBLE_ELECTRON_BIN ??
  (process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
const app = spawn(electron, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: {
    ...process.env,
    ENSEMBLE_SLEEP_TEST: "1",
    ENSEMBLE_SLEEP_GRACE_MS: String(GRACE_MS),
    ENSEMBLE_SLEEP_SWEEP_MS: String(SWEEP_MS),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function callTool(name, args = {}) {
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

try {
  let client;
  try {
    client = await waitForWindow({ userData, waitForDebugPort });
  } catch (error) {
    check("app window appeared", false, appLog.slice(-600));
    throw error;
  }
  check("app window appeared", true);
  await client.evaluate(openRail());
  await wait(3000);

  let mcpReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(250);
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) {
        mcpReady = true;
        break;
      }
    } catch {
      // 还在启动。
    }
  }
  check("MCP endpoint came up", mcpReady, mcpReady ? undefined : appLog.slice(-600));
  if (!mcpReady) throw new Error("no MCP endpoint");

  // AI 打开的页落在自己的实例里：没有台位、没有被选中，必然停放。
  const opened = await callTool("open_browser_tab", { url: pageUrl });
  const tabId = opened?.id ?? opened?.tabId;
  check("an AI-opened page returns its id", Boolean(tabId), opened);
  if (!tabId) throw new Error("no tab id");

  // 等 sweep 把它冻结：之后的第一条 AI 命令走的是「唤醒 + 刷宽限」全路径。
  let slept = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(250);
    const state = await client.evaluate(`(async () => {
      const state = await window.ensemble.getEmbeddedState();
      const tab = state.tabs.find((item) => item.id === ${JSON.stringify(tabId)});
      return { sleeping: tab?.sleeping === true, sleepExempt: tab?.sleepExempt ?? null };
    })()`);
    slept = state;
    if (state?.sleeping) break;
  }
  check("the parked page falls asleep once idle", slept?.sleeping === true, slept);

  // 装 rAF 采样器：这条命令唤醒冻页并刷新宽限。采样器记录相邻两帧的间隔，
  // 立即返回，让「宽限期内、无命令在飞」的间隔留在样本里。
  const armed = await callTool("evaluate_browser_page", {
    tabId,
    expression: `(() => {
      window.__rafGaps = [];
      let last = performance.now();
      const tick = (t) => {
        window.__rafGaps.push(Math.round(t - last));
        last = t;
        if (window.__rafGaps.length < 8) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return "armed";
    })()`,
    timeoutMs: 15_000,
  });
  check("the sampler armed on the woken page", armed === "armed", armed);

  // 轮询读采样：每条读数命令自己也会刷新宽限，所以轮询期间页面始终处于
  // 「AI 刚操作过」的状态——正是用户反馈里「AI 操作完还没到 60s」的持续形态。
  // 节点位置与休眠状态从宿主侧读（evaluate 在 guest 页里执行，看不到 webview
  // 节点）：间隔不对时，一眼能看出是页面被冻了（sleeping）还是节点停在窗外
  // （left 为负）。
  const readProbe = "JSON.stringify({ gaps: window.__rafGaps ?? [] })";
  let gaps = [];
  let probeDetail = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(250);
    const probe = await callTool("evaluate_browser_page", {
      tabId,
      expression: readProbe,
      timeoutMs: 15_000,
    });
    gaps = JSON.parse(probe).gaps ?? [];
    probeDetail = await client.evaluate(`(() => {
      const node = document.querySelector('webview[data-tab-id="${tabId}"]');
      const style = node ? node.style : null;
      const state = window.ensemble.getEmbeddedState();
      return state.then((next) => {
        const tab = next.tabs.find((item) => item.id === ${JSON.stringify(tabId)});
        return {
          gaps: ${JSON.stringify(gaps)},
          left: style ? Number.parseFloat(style.left) : null,
          width: style ? Number.parseFloat(style.width) : null,
          sleeping: tab?.sleeping === true,
          sleepExempt: tab?.sleepExempt ?? null,
        };
      });
    })()`);
    if (gaps.length >= 5) break;
  }
  // 满帧在 16-33ms 一帧；被窗外 cull 压制时一帧约 1016ms。阈值取 250ms，
  // 两种状态之间隔着四倍以上，不会互相误判。
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : Infinity;
  check(
    "rAF runs at frame rate while the AI grace holds",
    gaps.length >= 5 && median < 250,
    { gaps, median, node: probeDetail },
  );

  // 宽限一过，省资源行为必须照旧：页面回到冻结。
  let backAsleep = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(250);
    const state = await client.evaluate(`(async () => {
      const state = await window.ensemble.getEmbeddedState();
      const tab = state.tabs.find((item) => item.id === ${JSON.stringify(tabId)});
      return { sleeping: tab?.sleeping === true, sleepExempt: tab?.sleepExempt ?? null };
    })()`);
    backAsleep = state;
    if (state?.sleeping) break;
  }
  check(
    "the page returns to sleep once the grace lapses",
    backAsleep?.sleeping === true && backAsleep?.sleepExempt === null,
    backAsleep,
  );

  // 冻结后的页面仍要能被 AI 读回：唤醒路径不被本次改动破坏。
  const afterSleep = await callTool("evaluate_browser_page", {
    tabId,
    expression: "document.title",
    timeoutMs: 15_000,
  });
  check("a frozen page still answers after a wake", afterSleep === `frames/animated`, afterSleep);

  client.close();
} catch (error) {
  check("run completed", false, error?.stack ?? String(error));
} finally {
  app.kill();
  page.close();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
