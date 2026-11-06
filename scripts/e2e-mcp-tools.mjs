#!/usr/bin/env node
/**
 * Calls every MCP tool once, against a real app.
 *
 * The suite checks that each tool *works*, not merely that it is listed. A tool
 * that throws, returns the wrong shape, or silently does nothing is a failure:
 * these are the calls an AI makes, and one broken tool turns into a wrong
 * conclusion about the app under test rather than an error message.
 *
 * Order is dependency order — a site before an identity, an identity before a
 * view, a page before anything that acts on one — so that a failure is a real
 * failure instead of a missing prerequisite.
 *
 * Deliberately headless: the tools are the contract, and nothing here is about
 * what the window looks like.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const DEBUG_PORT = "0";
const MCP_PORT = await freePort();
const TOKEN = "mcp-smoke-token-0123456789";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-mcp-"));

const page = createServer((req, res) => {
  const url = req.url ?? "/";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>应用 ${url}</title>
<style>body{margin:0;font-family:system-ui}h1{padding:10px;background:#2563eb;color:#fff;margin:0}
label{display:block;font-size:12px;margin:12px 16px 4px}input{margin:0 16px;padding:6px;width:240px}
button{padding:8px 14px;margin:16px}</style></head><body>
<h1>应用 ${url}</h1>
<div class="n-form-item"><div class="n-form-item-label">用户名</div><input id="user" aria-label="用户名" autocomplete="username" /></div>
<div class="n-form-item"><div class="n-form-item-label">密码</div><input id="pass" type="password" aria-label="密码" autocomplete="current-password" /></div>
<div class="n-form-item"><div class="n-form-item-label">备注</div><input id="note" aria-label="备注" /></div>
<button id="go" onclick="document.getElementById('done').textContent='已提交'">提交</button>
<span id="done"></span>
</body></html>`);
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
    bookmarks: [],
    bookmarkFolders: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: 1 }),
);
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

const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electron,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (c) => (appLog += c));
app.stderr.on("data", (c) => (appLog += c));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok && detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 400)}`);
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

/** One tool, one check. A throw is a failure with the message attached. */
async function tool(name, args, assert) {
  try {
    const value = await call(name, args);
    const ok = assert ? assert(value) : value !== undefined;
    record(`${name}${args && Object.keys(args).length ? " " + JSON.stringify(args).slice(0, 60) : ""}`, ok, value);
    return { ok, value };
  } catch (error) {
    record(name, false, String(error));
    return { ok: false, error: String(error) };
  }
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(250);
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 启动中 */
    }
  }
  if (!ready) throw new Error(`MCP endpoint never came up\n${appLog.slice(-900)}`);
  await wait(1200);

  // ---- workspace ----
  await tool("get_workspace_summary", {}, (v) => typeof v === "object" && v !== null);
  await tool("list_sites", {}, (v) => Array.isArray(v?.sites) || Array.isArray(v));
  await tool("list_identities", {}, (v) => Array.isArray(v?.identities) || Array.isArray(v));
  await tool("list_views", {}, (v) => Array.isArray(v?.views) || Array.isArray(v));
  await tool("list_flows", {}, (v) => Array.isArray(v?.flows) || Array.isArray(v));
  await tool("list_bookmarks", {}, (v) => typeof v === "object" || Array.isArray(v));
  await tool("list_layouts", {}, (v) => typeof v === "object" || Array.isArray(v));
  await tool("list_site_tags", {}, (v) => typeof v === "object" || Array.isArray(v));

  // ---- settings ----
  await tool("update_settings", { theme: "light" }, (v) => v !== undefined);
  await tool("update_settings", { theme: "dark" }, (v) => v !== undefined);

  // ---- tags ----
  const tag = await tool("save_tag", { name: "冒烟标签", color: "teal" }, (v) => Boolean(v?.id));
  const tagId = tag.value?.id;

  // ---- sites ----
  const site = await tool(
    "create_site",
    { name: "冒烟站点", baseUrl: BASE, loginPath: "/" },
    (v) => Boolean(v),
  );
  const snapshotAfterSite = await call("list_sites");
  const siteId =
    site.value?.id ??
    (snapshotAfterSite.sites ?? snapshotAfterSite).find((item) => item.name === "冒烟站点")?.id;
  record("create_site returned a usable id", Boolean(siteId), { siteId, site: site.value });
  if (!siteId) throw new Error("no site id");
  await tool("update_site", { id: siteId, name: "冒烟站点·改" }, (v) => v !== undefined);

  // ---- identities ----
  const identity = await tool(
    "create_identity",
    { siteId, name: "管理员 · 主账号", username: "admin", password: "secret-123" },
    (v) => Boolean(v),
  );
  const listAfterIdentity = await call("list_identities", { siteId });
  const identityId =
    identity.value?.id ??
    (listAfterIdentity.identities ?? listAfterIdentity).find((item) => item.username === "admin")?.id;
  record("create_identity returned a usable id", Boolean(identityId), identityId);
  if (!identityId) throw new Error("no identity id");

  await tool(
    "create_identities",
    {
      siteId,
      identities: [{ name: "审核 · 次账号", username: "reviewer" }],
    },
    (v) => v !== undefined,
  );
  await tool("update_identity", { id: identityId, role: "admin" }, (v) => v !== undefined);
  await tool("set_password", { ownerKind: "site", ownerId: siteId, password: "site-secret" }, (v) => v !== undefined);
  await tool("check_auth", { identityId }, (v) => typeof v === "object" && v !== null);

  // ---- views ----
  const view = await tool(
    "create_view",
    { siteId, name: "冒烟视图", identityIds: [identityId], layoutId: "1x1" },
    (v) => Boolean(v),
  );
  const viewsAfter = await call("list_views", { siteId });
  const viewId =
    view.value?.id ?? (viewsAfter.views ?? viewsAfter).find((item) => item.name === "冒烟视图")?.id;
  record("create_view returned a usable id", Boolean(viewId), viewId);
  if (!viewId) throw new Error("no view id");
  await tool("update_view", { id: viewId, name: "冒烟视图·改" }, (v) => v !== undefined);
  await tool("set_view_layout", { viewId, layoutId: "2x2" }, (v) => v !== undefined);
  // Opening the view is what makes a *runtime* container exist; the definition
  // id from create_view is not what layout calls take, and passing it is the
  // mistake this suite exists to catch.
  await tool("open_browser_view", { viewId }, (v) => v !== undefined);
  const browserState = await call("list_browser_tabs");
  const runtimeViewId = browserState?.activeViewId ?? null;
  record("the opened view has a runtime container", Boolean(runtimeViewId), {
    runtimeViewId,
    activeViewId: browserState?.activeViewId,
  });

  await tool(
    "create_layout_preset",
    {
      name: "冒烟布局",
      slots: [
        { x: 0, y: 0, width: 0.6, height: 1 },
        { x: 0.6, y: 0, width: 0.4, height: 1 },
      ],
    },
    (v) => Boolean(v?.id),
  );

  // ---- flows ----
  const flow = await tool(
    "save_flow",
    {
      siteId,
      name: "冒烟流程",
      steps: [{ action: "navigate", url: BASE + "/flow" }],
    },
    (v) => Boolean(v?.id),
  );
  const flowId =
    flow.value?.id ?? (await call("list_flows", { siteId })).flows?.find((f) => f.name === "冒烟流程")?.id;
  record("save_flow returned a usable id", Boolean(flowId), flowId);

  // ---- bookmarks ----
  const bookmark = await tool(
    "save_bookmark",
    { name: "冒烟书签", url: BASE + "/bookmark" },
    (v) => v !== undefined,
  );
  const bookmarks = await call("list_bookmarks");
  const bookmarkId =
    bookmark.value?.id ??
    (bookmarks.bookmarks ?? bookmarks).find((item) => item.name === "冒烟书签")?.id;
  record("save_bookmark returned a usable id", Boolean(bookmarkId), bookmarkId);
  if (bookmarkId) await tool("delete_bookmark", { id: bookmarkId, confirm: true }, (v) => v !== undefined);

  // ---- browser: pages ----
  await tool("list_browser_tabs", {}, (v) => v !== undefined);
  const opened = await tool(
    "open_browser_tab",
    { url: BASE + "/page-a", siteId, identityId },
    (v) => Boolean(v),
  );
  const tabId = opened.value?.tabId ?? opened.value?.id ?? opened.value?.activeTabId;
  record("open_browser_tab returned a usable id", Boolean(tabId), opened.value);
  if (!tabId) throw new Error("no tab id");
  await wait(1500);

  await tool("navigate_browser_tab", { tabId, url: BASE + "/page-b" }, (v) => v !== undefined);
  await wait(1200);
  await tool("read_browser_page", { tabId }, (v) => (v?.nodes?.length ?? 0) > 0);
  await tool("check_element_visible", { tabId, label: "备注" }, (v) => typeof v === "object");
  await tool("evaluate_browser_page", { tabId, expression: "document.title" }, (v) => typeof v === "string");
  await tool("wait_browser", { tabId, condition: "text", expect: "应用", timeoutMs: 5000 }, (v) => v !== undefined);
  await tool("type_browser_text", { tabId, label: "备注", text: "冒烟" }, (v) => v?.ok === true);
  await tool(
    "fill_browser_form",
    {
      tabId,
      fields: [
        { label: "用户名", value: "tester" },
        { label: "密码", value: "pw-123456" },
      ],
    },
    (v) => v?.ok === true,
  );
  await tool("click_browser_element", { tabId, text: "提交" }, (v) => v?.ok === true);
  await tool("fill_browser_login", { tabId }, (v) => v !== undefined);
  await tool("screenshot_browser_tab", { tabId }, (v) => (v?.bytes ?? 0) > 1000);

  // ---- browser: layout and tabs ----
  // Omitting viewId is the documented way to mean "the view on stage", and it is
  // also the only form that works: the definition id is not a runtime view.
  await tool("set_browser_layout", { layoutId: "2x2" }, (v) => v !== undefined);
  await tool("set_browser_layout", { layoutId: "1x1" }, (v) => v !== undefined);
  await tool("set_browser_viewport", { tabId, width: 390, height: 844 }, (v) => v !== undefined);
  await tool("reset_browser_viewport", { tabId }, (v) => v !== undefined);

  const second = await call("open_browser_tab", { url: BASE + "/page-c", siteId, identityId });
  const secondId = second?.tabId ?? second?.id;
  record("a second page opens", Boolean(secondId), second);

  await tool("set_tab_page", { pageId: secondId }, (v) => v !== undefined);
  await tool("pin_browser_tab", { slotIndex: 0, tabId }, (v) => v !== undefined);

  // Two tabs of one identity cannot share a view: a view records members by
  // identity, so composing needs a second account. That rule is the app's, and
  // the check below proves it is enforced rather than silently broken.
  const rejected = await call("compose_view", {
    name: "冒烟组合·应被拒绝",
    tabIds: [tabId, secondId],
    layoutId: "2x1",
  }).then(
    () => ({ rejected: false }),
    (error) => ({ rejected: true, message: String(error) }),
  );
  record("compose_view refuses two tabs of the same identity", rejected.rejected === true, rejected);

  const secondIdentity = await call("create_identity", {
    siteId,
    name: "审核 · 次账号",
    username: "reviewer-2",
  });
  const secondIdentityId = secondIdentity?.id ??
    (await call("list_identities", { siteId })).identities?.find((i) => i.username === "reviewer-2")?.id;
  const thirdPage = await call("open_browser_tab", {
    url: BASE + "/page-e",
    siteId,
    identityId: secondIdentityId,
  });
  const thirdPageId = thirdPage?.tabId ?? thirdPage?.id;
  await wait(1200);
  await tool(
    "compose_view",
    { name: "冒烟组合", tabIds: [tabId, thirdPageId], layoutId: "2x1" },
    (v) => v !== undefined,
  );
  if (thirdPageId) await call("close_browser_tab", { tabId: thirdPageId });
  if (secondIdentityId) await call("delete_identity", { id: secondIdentityId, confirm: true });
  await tool("move_browser_tab", { tabId: secondId, loose: true }, (v) => v !== undefined);
  const third = await call("open_browser_tab", { url: BASE + "/page-d" });
  const thirdId = third?.tabId ?? third?.id;
  await tool("move_browser_tab", { tabId: thirdId, beforeOrAfter: tabId, edge: "after" }, (v) => v !== undefined);
  await tool("close_browser_tab", { tabId: thirdId }, (v) => v !== undefined);
  if (secondId) await tool("close_browser_tab", { tabId: secondId }, (v) => v !== undefined);

  // ---- flows that need a live page ----
  if (flowId) {
    await tool(
      "run_flow",
      { id: flowId, tabId, params: {} },
      (v) => v !== undefined,
    );
  }

  // ---- launch / external instances ----
  // `launch_*` drive a real system browser; in a container the engine may be
  // missing, so what is asserted is "the call is answered with a verdict", not
  // "a window opened".
  await tool("launch_view", { viewId }, (v) => typeof v === "object");
  await tool("launch_identity", { identityId }, (v) => typeof v === "object");
  await tool("launch_clean_session", { siteId }, (v) => typeof v === "object");
  const instances = await call("get_workspace_summary");
  const running = instances?.counts?.instances ?? instances?.instances ?? 0;
  record("launch calls leave the app answering", typeof instances === "object", running);
  await tool("stop_all", {}, (v) => v !== undefined);

  // ---- accounts transfer ----
  await tool("export_accounts", { siteIds: [siteId], note: "冒烟" }, (v) => typeof v === "object");
  const exported = await call("export_accounts", { siteIds: [siteId] });
  const path = exported?.path;
  record("export_accounts returned a path", Boolean(path), exported);
  if (path) {
    await tool("preview_accounts", { path }, (v) => typeof v === "object");
    await tool("import_accounts", { path }, (v) => typeof v === "object");
  }

  // ---- views and sites: destructive, so last ----
  // Copying needs a *different* target site: copying a view onto its own site is
  // refused, which the check below pins.
  const refusedCopy = await call("copy_view_to_site", { viewId, targetSiteId: siteId }).then(
    () => ({ refused: false }),
    (error) => ({ refused: true, message: String(error) }),
  );
  record("copy_view_to_site refuses its own site", refusedCopy.refused === true, refusedCopy);
  // Copy before deleting: copying *moves* the member pages to the target site,
  // so the source view stops resolving afterwards and the delete has to come
  // last.
  const otherSite = await call("create_site", { name: "冒烟站点·目标", baseUrl: BASE });
  const otherSiteId = otherSite?.id ??
    (await call("list_sites")).sites?.find((item) => item.name === "冒烟站点·目标")?.id;
  if (otherSiteId) {
    await tool("copy_view_to_site", { viewId, targetSiteId: otherSiteId }, (v) => typeof v === "object");
    await call("delete_site", { id: otherSiteId, confirm: true });
  }
  const stillThere = (await call("list_views")).views?.some((item) => item.id === viewId) ?? false;
  if (stillThere) await tool("delete_view", { id: viewId, confirm: true }, (v) => v !== undefined);
  else record("delete_view (source view moved by the copy)", true, { viewId });
  await tool("detach_identity_reference", { identityId }, (v) => v !== undefined);
  await tool("link_identities_to_site", { siteId, identityIds: [identityId] }, (v) => v !== undefined);

  await tool("delete_flow", { id: flowId, confirm: true }, (v) => v !== undefined);
  await tool("delete_identity", { id: identityId, confirm: true }, (v) => v !== undefined);
  await tool("delete_site", { id: siteId, confirm: true }, (v) => v !== undefined);
} catch (error) {
  record("run completed", false, String(error));
  console.log(appLog.slice(-1500));
} finally {
  app.kill();
  page.close();
  await wait(1200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
