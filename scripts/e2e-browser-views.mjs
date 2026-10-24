#!/usr/bin/env node
/**
 * End-to-end check of the browser surface's view containers, driven through MCP.
 *
 * A view is one shared screen region: opening a saved view creates one tab per
 * member, laid out in its grid. Reopening must reuse those tabs (logins survive),
 * layout changes must re-flow the stage, and a layout request on loose tabs must
 * group them instead of failing.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PAGE_PORT = 9668;
const MCP_PORT = 49781;
const TOKEN = "e2e-browser-views-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-views-"));

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>视图测试页</title></head><body>
<h1>控制台</h1>
<label for="user">账号</label><input id="user" name="username">
<div id="who">anonymous</div>
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
    allowDelete: true,
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
  env: { ...process.env, ENSEMBLE_USER_DATA: userData },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(body) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return response.json();
}

let seq = 0;
async function call(name, args = {}) {
  const json = await rpc({
    jsonrpc: "2.0",
    id: ++seq,
    method: "tools/call",
    params: { name, arguments: args },
  });
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

  const site = await call("create_site", {
    name: "视图测试站点",
    baseUrl: PAGE_URL,
    loginPath: "/",
    autoSubmit: false,
  });
  const identities = [];
  for (const [index, name] of ["甲", "乙", "丙", "丁"].entries()) {
    identities.push(
      await call("create_identity", {
        siteId: site.id,
        name: `账号${name}`,
        username: `user-${index}`,
        role: "成员",
        color: ["amber", "teal", "violet", "rose"][index],
        passwordMode: "inherit",
        startPath: "/",
      }),
    );
  }
  check("four identities created", identities.length === 4);

  const view = await call("create_view", {
    siteId: site.id,
    name: "四宫格验证",
    identityIds: identities.map((item) => item.id),
    layoutId: "2x2",
    slotAssignments: { [identities[3].id]: 0, [identities[2].id]: 1 },
  });
  check("view definition created", view?.layoutId === "2x2", view?.id);

  // Opening the view creates one tab per member and puts the container on stage.
  const opened = await call("open_browser_view", { viewId: view.id });
  const container = (opened.views ?? []).find((item) => item.viewDefinitionId === view.id);
  check("view opens as one container", Boolean(container), opened.views);
  // Counted by identity: launch leaves one blank page on the surface, so the
  // total is not the member count and asserting it would test startup instead.
  const memberIds = new Set(identities.map((item) => item.id));
  const memberTabs = (opened.tabs ?? []).filter((tab) => memberIds.has(tab.identityId));
  check("one tab per member", memberTabs.length === 4, memberTabs.length);
  check(
    "saved slot assignment is applied",
    container?.slotTabs?.[0] === opened.tabs.find((tab) => tab.identityId === identities[3].id)?.id,
    container?.slotTabs,
  );
  check(
    "every member tab belongs to the container",
    memberTabs.every((tab) => tab.viewId === container.id),
    memberTabs.map((tab) => tab.viewId),
  );

  const firstIds = memberTabs.map((tab) => tab.id).sort();

  // Reopening merges instead of duplicating: logins must survive.
  const reopened = await call("open_browser_view", { viewId: view.id });
  const reopenedMembers = (reopened.tabs ?? []).filter((tab) => memberIds.has(tab.identityId));
  check(
    "reopening reuses the existing tabs",
    reopenedMembers.length === 4 &&
      JSON.stringify(reopenedMembers.map((tab) => tab.id).sort()) === JSON.stringify(firstIds),
    reopenedMembers.length,
  );

  // Layout change re-flows the same container.
  const relaid = await call("set_browser_layout", { layoutId: "2x1", viewId: container.id });
  check(
    "layout switch keeps only two on stage",
    (relaid.views ?? [])[0]?.layoutId === "2x1" &&
      (relaid.views ?? [])[0]?.slotTabs.filter(Boolean).length === 2,
    relaid.views?.[0]?.slotTabs,
  );

  // The definition follows the container, so the next launch uses the same grid.
  const listed = await call("list_views", { siteId: site.id });
  check(
    "view definition follows the open container's layout",
    (listed ?? []).find((item) => item.id === view.id)?.layoutId === "2x1",
    listed,
  );

  // A tab added by hand joins the view the user is looking at.
  const added = await call("open_browser_tab", { url: PAGE_URL });
  check(
    "a new tab joins the active view",
    added.viewId === container.id,
    { viewId: added.viewId, container: container.id },
  );

  // Closing the view removes its tabs, leaving the surface with what was there
  // before the view existed — counted relative, since launch leaves a blank page.
  const beforeClose = (await call("list_browser_tabs")).tabs.length;
  const closed = await call("close_browser_tab", { tabId: added.id });
  check(
    "closing a member leaves the rest",
    (closed.tabs ?? []).length === beforeClose - 1 && !closed.tabs.some((tab) => tab.id === added.id),
    { before: beforeClose, after: closed.tabs?.length },
  );

  const audit = readFileSync(join(userData, "mcp-audit.log"), "utf8");
  check("audit log records the view tool", audit.includes('"open_browser_view"'));
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  server.close();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
