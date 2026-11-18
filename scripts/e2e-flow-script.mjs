#!/usr/bin/env node
/**
 * End-to-end check of a flow's script step (编排层，方案 B).
 *
 * What needs proving is not that JavaScript runs — it is that the script can
 * only orchestrate the same action primitives a step list could, and that the
 * page actually changed:
 *
 * 1. A script loops fill/click/wait three times and skips a fourth on a `vars`
 *    condition; the page ends with exactly three rows and the right texts.
 * 2. `vars` flows both ways: a `read` step feeds the script, the script's own
 *    `read(..., as)` writes through, and the step's `as` captures the return
 *    value for later steps.
 * 3. `save_flow` refuses an empty script body and an over-long one.
 * 4. A script that outlives its budget fails with「脚本超时」at the step budget,
 *    not the flow-wide default.
 * 5. The UI lists the script step (label + body textarea) without breaking.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow } from "./lib/e2e-cdp.mjs";

const PAGE_PORT = await freePort();
const MCP_PORT = await freePort();
const TOKEN = "e2e-flow-script-token-1234567890";
const siteId = "22222222-2222-4222-8222-222222222222";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-flow-script-"));

// 一个输入框 + 添加按钮 + 异步渲染的列表：script 步骤要编排的「真实控制台」。
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PAGE_PORT}`);
  if (req.method === "POST" && url.pathname === "/api/add") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // Name is echoed back by the list render below; the request itself is the
      // point — a click that did not reach the button never posts here.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: new URLSearchParams(body).get("name") }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>批量添加</title></head>
<body>
<input id="item" />
<button id="addBtn" type="button">添加</button>
<p>共 <span id="count">0</span> 项</p>
<ul id="list"></ul>
<script>
  document.getElementById("addBtn").addEventListener("click", async () => {
    const name = document.getElementById("item").value.trim();
    if (!name) return;
    await fetch("/api/add", { method: "POST", body: new URLSearchParams({ name }) });
    // The real console renders the row after its request returns.
    setTimeout(() => {
      const li = document.createElement("li");
      li.textContent = name;
      document.getElementById("list").appendChild(li);
      document.getElementById("count").textContent =
        String(document.querySelectorAll("#list li").length);
      document.getElementById("item").value = "";
    }, 400);
  });
</script>
</body></html>`);
});
await new Promise((done) => server.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "编排脚本站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/",
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
  JSON.stringify({ theme: "dark", locale: "zh", guideVersion: GUIDE_SEEN }),
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

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function tryCall(name, args = {}) {
  try {
    return { ok: true, value: await call(name, args) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/** Saves a flow and runs it on a fresh page, the way an AI caller would. */
async function runSteps(steps, runArgs = {}) {
  const saved = await call("save_flow", {
    siteId,
    name: `编排脚本检查 ${(runSteps.seq = (runSteps.seq ?? 0) + 1)}`,
    description: "",
    params: [],
    steps,
  });
  const tab = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
  await wait(600);
  const outcome = await call("run_flow", { id: saved.id, tabId, ...runArgs });
  // run_flow returns { flowId, tabId, run }; the suites assert on the run itself.
  return { saved, tabId, run: outcome.run };
}

try {
  let up = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(250);
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) {
        up = true;
        break;
      }
    } catch {
      // Still starting.
    }
  }
  check("MCP endpoint came up", up);
  if (!up) throw new Error("endpoint never answered");
  await wait(1200);

  // --- 1. the orchestration run: loop three times, skip a fourth -------------
  const script = [
    'console.log("编排开始，初始", vars.count);',
    "const start = Number(vars.count);",
    "for (let i = 1; i <= 3; i++) {",
    '  await fill("#item", "项目" + i);',
    '  await click("#addBtn");',
    '  await wait("text", "项目" + i, 8000);',
    "}",
    "if (start > 0) {",
    '  await fill("#item", "多余项");',
    '  await click("#addBtn");',
    "}",
    'return await read("#count", "final");',
  ].join("\n");
  const main = await runSteps([
    { action: "navigate", url: PAGE_URL },
    { action: "wait", condition: "visible", selector: "#addBtn", timeoutMs: 8000 },
    { action: "read", selector: "#count", as: "count" },
    { action: "script", value: script, as: "result" },
  ]);
  check(
    "the scripted orchestration run finishes",
    main.run?.ok === true && main.run.steps?.length === 4,
    { ok: main.run?.ok, reason: main.run?.reason, steps: main.run?.steps?.length },
  );
  check(
    "the read step fed vars and the script's read wrote through",
    main.run?.vars?.count === "0" && main.run?.vars?.final === "3",
    main.run?.vars,
  );
  check(
    "the step's as captured the script's return value",
    main.run?.vars?.result === "3",
    main.run?.vars,
  );
  const scriptStep = main.run?.steps?.[3];
  check(
    "the script step logs its console output and its result",
    /console 1 行/.test(scriptStep?.detail ?? "") && /result = 3/.test(scriptStep?.detail ?? ""),
    scriptStep?.detail,
  );

  // The page, not the report, is the proof: exactly three rows, exact texts,
  // and the fourth (conditional) add never happened.
  await wait(800);
  const rendered = main.tabId
    ? await call("evaluate_browser_page", {
        tabId: main.tabId,
        expression: `(() => ({
          items: [...document.querySelectorAll("#list li")].map((el) => el.textContent),
          count: document.getElementById("count").textContent,
        }))()`,
      })
    : null;
  check(
    "the page ends with exactly the three looped rows",
    JSON.stringify(rendered?.items) === JSON.stringify(["项目1", "项目2", "项目3"]) &&
      rendered?.count === "3",
    rendered,
  );

  // --- 2. save-time validation ----------------------------------------------
  const empty = await tryCall("save_flow", {
    siteId,
    name: "空脚本",
    steps: [{ action: "script", value: "" }],
  });
  check("an empty script body is refused when saving", !empty.ok && /需要 value/.test(empty.error), {
    error: empty.error,
  });

  const tooLong = await tryCall("save_flow", {
    siteId,
    name: "超长脚本",
    steps: [{ action: "script", value: "x".repeat(10_001) }],
  });
  check(
    "an over-long script body is refused when saving",
    !tooLong.ok && /超过 10000/.test(tooLong.error),
    { error: tooLong.error },
  );

  // --- 3. the step budget is what interrupts a hung script -------------------
  const hung = await runSteps([
    { action: "navigate", url: PAGE_URL },
    { action: "script", value: 'await wait("text", "永远不会出现", 30000);', timeoutMs: 1200 },
  ]);
  check(
    "a script past its budget fails as a script timeout",
    hung.run?.ok === false && hung.run?.failedAt === 1 && /脚本超时/.test(hung.run?.reason ?? ""),
    { ok: hung.run?.ok, failedAt: hung.run?.failedAt, reason: hung.run?.reason },
  );

  // --- 4. the UI lists the script step without breaking ----------------------
  const port = await waitForDebugPort(userData);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const renderer = targets.find(
    (item) => item.type === "page" && item.url.includes("index.html"),
  );
  check("app window is a debug target", Boolean(renderer));
  if (renderer) {
    const client = await connectToWindow(renderer.webSocketDebuggerUrl);
    await client.evaluate(openNav("flows"));
    await wait(700);
    const listState = await client.evaluate(`(() => {
      const section = document.querySelector('.flows');
      const labels = [...(section?.querySelectorAll('.step-action') ?? [])].map(
        (el) => el.textContent.trim(),
      );
      return {
        present: Boolean(section),
        rows: section?.querySelectorAll('.flow-row').length ?? 0,
        stepLabels: labels,
        hasScriptLabel: labels.includes('脚本'),
      };
    })()`);
    check(
      "the flows page lists both flows and labels the script step",
      listState?.present === true &&
        listState?.rows === 2 &&
        listState?.hasScriptLabel === true,
      listState,
    );

    await client.evaluate(
      `document.querySelector('.detail-actions .icon-btn')?.click(); true;`,
    );
    await wait(700);
    const editorState = await client.evaluate(`(() => {
      // A modal's own box, not any dialog role: the management layer is one too.
      const dialog = document.querySelector('[role="dialog"].content');
      if (!dialog) return { dialog: false };
      const editors = [...dialog.querySelectorAll('.step-editor')];
      // Which flow the detail pane had selected is not worth pinning; what
      // matters is that a script row renders its action label and body field.
      const scriptEditors = editors.filter(
        (el) => el.querySelector('.select-trigger')?.textContent.trim() === "脚本",
      ).length;
      return {
        dialog: true,
        steps: editors.length,
        scriptEditors,
        hasScriptBody: Boolean(dialog.querySelector('.script-value')),
      };
    })()`);
    check(
      "the editor renders the script step with its body field",
      editorState?.dialog === true &&
        editorState?.scriptEditors >= 1 &&
        editorState?.hasScriptBody === true,
      editorState,
    );
    client.close();
  }
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1200);
  server.close();
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) console.log("app log tail:", appLog.slice(-800));
  process.exitCode = failed.length > 0 ? 1 : 0;
}
