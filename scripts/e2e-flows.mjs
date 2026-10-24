#!/usr/bin/env node
/**
 * End-to-end check of flows: the reusable step sequence.
 *
 * The point of a flow is that an AI works something out once and the next run is
 * one call, so this drives the real app through the real MCP endpoint and checks
 * the three things that make that true:
 *
 *   1. A flow saved through `save_flow` actually runs — the page it drives ends
 *      up with the data, not just a report claiming it did.
 *   2. Parameters reach the page, and a step can consume a value an earlier step
 *      read out of the page.
 *   3. A failing step stops the run and says which step and why, instead of
 *      carrying on and writing half-finished data.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 3997;
const MCP_PORT = 49795;
const DEBUG_PORT = 9807;
const TOKEN = "e2e-flows-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-flows-"));

/** Created rows, as the mock console recorded them. */
const created = [];

// A component-library-shaped console: labels and inputs in different subtrees,
// a select, and a list that fills in asynchronously after submit.
const page = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PAGE_PORT}`);
  if (req.method === "POST" && url.pathname === "/api/tenant") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      created.push({
        name: params.get("tname") ?? "",
        kind: params.get("tkind") ?? "",
        note: params.get("tnote") ?? "",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (url.pathname === "/admin") {
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>租户管理</title>
<style>
  body { font: 14px sans-serif; }
  .n-form-item { border: 1px solid #ddd; padding: 6px; margin: 6px 0; }
  .n-form-item-label { font-size: 12px; color: #666; }
</style></head>
<body>
<h1>租户管理</h1>
<p id="order">ORD-2026-0001</p>
<form id="create">
  <div class="n-form-item">
    <div class="n-form-item-label">租户名称</div>
    <div class="n-form-item-blank"><div class="n-input"><input id="tname" name="tname" /></div></div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">套餐</div>
    <div class="n-form-item-blank">
      <select id="tkind" name="tkind">
        <option value="standard">标准版</option>
        <option value="pro">专业版</option>
      </select>
    </div>
  </div>
  <div class="n-form-item">
    <div class="n-form-item-label">备注</div>
    <div class="n-form-item-blank"><div class="n-input"><input id="tnote" name="tnote" /></div></div>
  </div>
  <button id="createBtn" type="button">创建租户</button>
</form>
<ul id="list"><li>默认租户</li></ul>
<script>
  document.getElementById("createBtn").addEventListener("click", async () => {
    const body = new URLSearchParams({
      tname: document.getElementById("tname").value,
      tkind: document.getElementById("tkind").value,
      tnote: document.getElementById("tnote").value,
    });
    await fetch("/api/tenant", { method: "POST", body });
    // The real console renders the new row after its request returns.
    setTimeout(() => {
      const item = document.createElement("li");
      item.textContent = document.getElementById("tname").value;
      document.getElementById("list").appendChild(item);
      document.getElementById("tname").value = "";
      document.getElementById("tnote").value = "";
    }, 600);
  });
</script>
</body></html>`);
    return;
  }
  res.end("<!doctype html><title>—</title>");
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${PAGE_PORT}`;

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
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "flows", onboardingVersion: 1 }),
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
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    handler(message.result);
  });
  await new Promise((done) => socket.addEventListener("open", done));
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
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

  // 1. A site and an account to run as.
  const site = await call("create_site", {
    name: "流程测试站点",
    baseUrl: BASE,
    loginPath: "/admin",
  });
  const identity = await call("create_identity", {
    siteId: site.id,
    name: "运营 · 主账号",
    username: "ops@example.test",
  });
  check("site and identity are ready", Boolean(site.id && identity.id));

  // 2. Save the flow the way an AI would after working the page out once. Note
  //    the two things that make this reusable: a parameter, and a value read
  //    from the page feeding a later step.
  const flow = await tryCall("save_flow", {
    siteId: site.id,
    name: "创建租户",
    description: "打开租户管理，建一个指定名称与套餐的租户，备注里带上当前订单号",
    params: [
      { name: "tenant", label: "租户名", required: true },
      { name: "kind", label: "套餐", default: "标准版" },
    ],
    steps: [
      { action: "navigate", url: "/admin" },
      { action: "wait", condition: "visible", text: "创建租户", timeoutMs: 8000 },
      { action: "read", text: "ORD-2026-0001", as: "order" },
      { action: "fill", label: "租户名称", value: "{{tenant}}" },
      { action: "select", label: "套餐", option: "{{kind}}" },
      { action: "fill", label: "备注", value: "订单 {{order}}" },
      { action: "click", text: "创建租户" },
      { action: "wait", condition: "text", expect: "{{tenant}}", timeoutMs: 8000 },
    ],
  });
  check("save_flow stores the definition", flow.ok && Boolean(flow.value?.id), flow);
  if (!flow.ok) throw new Error("cannot continue without a saved flow");
  const flowId = flow.value.id;

  const listed = await call("list_flows", { siteId: site.id });
  check("list_flows returns it with its steps", listed.length === 1 && listed[0].steps.length === 8, {
    flows: listed.length,
    steps: listed[0]?.steps?.length,
  });

  // 3. Run it. No tabId: the tool opens one as the site's first account.
  const run = await tryCall("run_flow", {
    id: flowId,
    params: { tenant: "客户 A", kind: "专业版" },
  });
  check("run_flow runs the saved steps", run.ok && run.value?.run?.ok === true, run);
  check(
    "run_flow reports every step",
    run.ok && run.value?.run?.steps?.length === 8,
    run.ok ? { steps: run.value.run.steps?.length } : run,
  );
  check(
    "a step can consume the value an earlier step read",
    run.ok && run.value?.run?.vars?.order === "ORD-2026-0001",
    run.ok ? run.value.run.vars : run,
  );
  check(
    "run_flow opens a tab the user can watch",
    run.ok && typeof run.value?.tabId === "string" && run.value.tabId.length > 0,
    run.ok ? { tabId: run.value.tabId } : run,
  );

  // 4. The page, not the report, is the proof. Read the row list from the tab.
  await wait(1000);
  const tabId = run.ok ? run.value.tabId : "";
  const rendered = tabId
    ? await call("evaluate_browser_page", {
        tabId,
        expression: `(() => ({
          rows: [...document.querySelectorAll("#list li")].map((el) => el.textContent),
          kind: document.getElementById("tkind").value,
        }))()`,
      })
    : null;
  check(
    "the page actually shows the created tenant",
    Boolean(rendered?.rows?.includes("客户 A")),
    rendered,
  );
  check("the select step changed the control's value", rendered?.kind === "pro", rendered);

  const recorded = created.find((item) => item.name === "客户 A");
  check(
    "the console received the parameters and the read value",
    recorded?.kind === "pro" && recorded?.note === "订单 ORD-2026-0001",
    recorded,
  );

  // 5. A failing step must stop the run and name the step.
  await call("save_flow", {
    id: flowId,
    siteId: site.id,
    name: "创建租户",
    params: [{ name: "tenant", label: "租户名", required: true }],
    steps: [
      { action: "navigate", url: "/admin" },
      { action: "fill", label: "不存在的字段", value: "{{tenant}}" },
      { action: "click", text: "创建租户" },
    ],
  });
  const failed = await tryCall("run_flow", { id: flowId, params: { tenant: "客户 B" } });
  check(
    "a failing step stops the run",
    failed.ok && failed.value?.run?.ok === false,
    failed.ok ? failed.value.run : failed,
  );
  check(
    "the failure names the step and the reason",
    failed.ok &&
      failed.value.run.failedAt === 1 &&
      /第 2 步/.test(failed.value.run.reason ?? "") &&
      /not-found/.test(failed.value.run.reason ?? ""),
    failed.ok ? failed.value.run.reason : failed,
  );
  check(
    "the step after the failure did not run",
    !created.some((item) => item.name === "客户 B"),
    created.map((item) => item.name),
  );

  // 6. Validation happens at save time, with a message that names the field.
  const invalid = await tryCall("save_flow", {
    siteId: site.id,
    name: "缺值流程",
    steps: [{ action: "fill", label: "租户名称" }],
  });
  check(
    "an incomplete step is refused when saving",
    !invalid.ok && /第 1 步（fill）需要 value/.test(invalid.error),
    invalid,
  );

  // 7. A parameter typo is caught before it can create a tenant called "".
  const typo = await tryCall("save_flow", {
    siteId: site.id,
    name: "变量名打错",
    params: [{ name: "tenant", label: "租户名" }],
    steps: [{ action: "fill", label: "租户名称", value: "{{tenat}}" }],
  });
  check("a mistyped variable is refused when saving", !typo.ok && /tenat/.test(typo.error), typo);

  // 8. Undeclared run parameters are refused rather than silently ignored.
  const extraParam = await tryCall("run_flow", {
    id: flowId,
    params: { tenant: "客户 C", tenat: "typo" },
  });
  check(
    "run_flow rejects an undeclared parameter",
    !extraParam.ok && /未声明的参数/.test(extraParam.error),
    extraParam,
  );

  // 9. Deleting requires the explicit confirm, like every other danger tool.
  const noConfirm = await tryCall("delete_flow", { id: flowId });
  check("delete_flow requires confirm", !noConfirm.ok, noConfirm);
  await (async () => {
    const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++seq,
        method: "tools/call",
        params: { name: "update_mcp", arguments: { allowDelete: true } },
      }),
    });
    await response.json();
  })().catch(() => {});
  const noDelete = await tryCall("delete_flow", { id: flowId, confirm: true });
  check(
    "delete stays gated by the delete permission",
    !noDelete.ok && /权限/.test(noDelete.error),
    noDelete,
  );

  // 10. The UI shows the flows page with the flow in it.
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const renderer = targets.find(
    (item) => item.type === "page" && item.url.includes("index.html"),
  );
  check("app window is a debug target", Boolean(renderer));
  if (renderer) {
    const client = await connect(renderer.webSocketDebuggerUrl);
    await client.evaluate(`(() => {
      document.querySelector('[data-nav="flows"]')?.click();
      return true;
    })()`);
    await wait(700);
    const pageState = await client.evaluate(`(() => {
      const section = document.querySelector('.flows');
      const sub = section?.querySelector('.detail-sub')?.textContent ?? '';
      return {
        present: Boolean(section),
        heading: section?.querySelector('h1')?.textContent.trim() ?? "",
        rows: section?.querySelectorAll('.flow-row').length ?? 0,
        navCount: document.querySelector('[data-nav="flows"] .nav-tail')?.textContent.trim() ?? "",
        // The detail pane's own counts; the editor must agree with them. Read
        // from the page rather than hard-coding the fixture, because an earlier
        // step rewrote this flow.
        detailSteps: Number((sub.match(/(\\d+)\\s*步/) ?? [])[1] ?? -1),
        detailParams: section?.querySelectorAll('.param-chip').length ?? 0,
      };
    })()`);
    check(
      "the rail opens a flows page listing the saved flow",
      pageState?.present === true && pageState?.rows === 1 && pageState?.navCount === "1",
      pageState,
    );

    // The editor renders labels the list view never touches. A message that
    // fails to compile — a literal `{{var}}` in an i18n string is parsed as a
    // nested placeholder and does — leaves the overlay painted with no dialog in
    // it, so assert the dialog's own content rather than that a click happened.
    await client.evaluate(`(() => {
      document.querySelector('.detail-actions .icon-btn')?.click();
      return true;
    })()`);
    await wait(700);
    const editorState = await client.evaluate(`(() => {
      const content = document.querySelector('[role="dialog"]');
      if (!content) return { dialog: false };
      const rect = content.getBoundingClientRect();
      const valueInput = [...content.querySelectorAll('input')].find((el) =>
        (el.placeholder || '').includes('{{'),
      );
      return {
        dialog: true,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        steps: content.querySelectorAll('.step-editor').length,
        params: content.querySelectorAll('.param-row').length,
        valueHint: valueInput?.placeholder ?? '',
      };
    })()`);
    check(
      "the editor opens with every step and parameter",
      editorState?.dialog === true &&
        editorState?.steps === pageState?.detailSteps &&
        editorState?.params === pageState?.detailParams &&
        editorState?.height > 300,
      { editor: editorState, detail: pageState },
    );
    check(
      "a literal placeholder survives translation",
      editorState?.valueHint?.includes("{{") === true,
      editorState?.valueHint,
    );

    // A dropdown's list is teleported to <body> so a scrolling dialog cannot clip
    // it — which used to make the dialog read the click as "outside" and close,
    // throwing away the whole form. Choosing an option must keep the dialog.
    const dropdown = await client.evaluate(`(async () => {
      const content = document.querySelector('[role="dialog"]');
      if (!content) return { dialog: false };
      // A step's action list, not the site picker: this workspace has one site,
      // so the site select would have a single option and prove nothing.
      const trigger = content.querySelector('.step-editor .select-trigger');
      if (!trigger) return { dialog: true, trigger: false };
      const before = [...content.querySelectorAll('.step-editor')].length;
      trigger.click();
      await new Promise((r) => setTimeout(r, 200));
      const panel = document.querySelector('.select-panel');
      const options = [...(panel?.querySelectorAll('.option') ?? [])];
      const target = options.find((el) => !el.classList.contains('selected')) ?? options[0];
      const label = target?.textContent?.trim() ?? "";
      target?.click();
      await new Promise((r) => setTimeout(r, 350));
      const still = document.querySelector('[role="dialog"]');
      return {
        dialog: Boolean(still),
        trigger: true,
        options: options.length,
        picked: label,
        // Same dialog, still fully rendered: nothing was torn down and remounted.
        stepsAfter: [...(still?.querySelectorAll('.step-editor') ?? [])].length,
        stepsBefore: before,
        panelClosed: !document.querySelector('.select-panel'),
      };
    })()`);
    check(
      "choosing a dropdown option keeps the dialog open",
      dropdown?.dialog === true &&
        dropdown?.trigger === true &&
        (dropdown?.options ?? 0) > 1 &&
        dropdown?.stepsAfter === dropdown?.stepsBefore &&
        dropdown?.panelClosed === true,
      dropdown,
    );
    client.close();
  }
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  page.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) console.log("app log tail:", appLog.slice(-800));
  process.exitCode = failed.length > 0 ? 1 : 0;
}
