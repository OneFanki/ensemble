import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddedSurface } from "../src/main/mcp/server";
import { loadMcpSettings, McpServer, saveMcpSettings } from "../src/main/mcp/server";

const TOKEN = "browser-tools-token-1234567890";

let dir: string;
let service: WorkspaceService;
let server: McpServer;
let port: number;
let calls: Array<{ method: string; args: unknown[] }>;

/**
 * Stands in for the Electron-backed surface so the MCP contract can be tested
 * in plain Node. It records calls and returns the shapes the real manager does.
 */
function fakeSurface(): EmbeddedSurface {
  let tabs: Array<{
    id: string;
    label: string;
    url: string;
    title: string;
    identityId?: string;
    clean?: boolean;
  }> = [];
  let active: string | undefined;
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return undefined;
    };
  return {
    state: () => ({
      tabs,
      ...(active ? { activeTabId: active } : {}),
      views: [{ id: "view-1", name: "视图", layoutId: "2x2" }],
      activeViewId: "view-1",
    }),
    createTab: async (input) => {
      calls.push({ method: "createTab", args: [input] });
      const tab = {
        id: `tab-${tabs.length + 1}`,
        label: input.label ?? "新标签页",
        url: input.url ?? "about:blank",
        title: "",
        ...(input.identityId ? { identityId: input.identityId } : {}),
        // Mirrors the real bridge: an identity-less tab opened by the AI is a
        // clean session, never a page in the user's daily profile.
        ...(input.identityId ? {} : { clean: true }),
      };
      tabs = [...tabs, tab];
      active = tab.id;
      return tab;
    },
    /**
     * The gate's view of a page, derived from the fake tab list including the
     * `clean` marker, so these tests cover the same three cases the real surface
     * reports.
     */
    aiPageContext: (tabId) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return { origin: "" };
      let origin = "";
      try {
        const parsed = new URL(tab.url);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin;
      } catch {
        origin = "";
      }
      return {
        ...(tab.identityId ? { identityId: tab.identityId } : {}),
        ...(tab.clean ? { clean: true } : {}),
        origin,
      };
    },
    navigate: async (tabId, url) => {
      calls.push({ method: "navigate", args: [tabId, url] });
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, url } : tab));
      return tabs.find((tab) => tab.id === tabId);
    },
    closeTab: (tabId) => {
      calls.push({ method: "closeTab", args: [tabId] });
      tabs = tabs.filter((tab) => tab.id !== tabId);
      return { tabs, layoutId: "2x2" };
    },
    activate: (tabId) => {
      calls.push({ method: "activate", args: [tabId] });
      active = tabId;
      return { tabs, activeTabId: tabId, layoutId: "2x2" };
    },
    snapshotDom: async (tabId, options) => {
      calls.push({ method: "snapshotDom", args: [tabId, options] });
      return {
        url: "http://example.test/",
        title: "页面",
        viewport: { width: 800, height: 600 },
        nodes: [
          {
            role: "heading",
            name: "标题",
            tag: "h1",
            selector: "h1",
            bounds: { x: 0, y: 0, width: 10, height: 10 },
          },
        ],
        total: 1,
        truncated: false,
      };
    },
    click: async (tabId, target) => {
      calls.push({ method: "click", args: [tabId, target] });
      return { ok: true };
    },
    type: async (tabId, target, text, options) => {
      calls.push({ method: "type", args: [tabId, target, text, options] });
      // Mirrors the real manager: only a password field reports `secret`.
      const hint = typeof target === "string" ? target : JSON.stringify(target);
      return /pass/i.test(hint) ? { ok: true, secret: true } : { ok: true };
    },
    fillForm: async (tabId, fields) => {
      calls.push({ method: "fillForm", args: [tabId, fields] });
      return {
        ok: true,
        filled: fields.map((field) => {
          const hint =
            typeof field.target === "string" ? field.target : JSON.stringify(field.target);
          return {
            field: hint,
            ...(/密码|pass/i.test(hint) ? { secret: true } : {}),
          };
        }),
      };
    },
    evaluate: async (tabId, expression) => {
      calls.push({ method: "evaluate", args: [tabId, expression] });
      return { value: 42 };
    },
    runFlow: async (tabId, steps, options) => {
      calls.push({ method: "runFlow", args: [tabId, steps, options] });
      return {
        ok: true,
        steps: steps.map((step, index) => ({ index, action: step.action, ok: true })),
      };
    },
    screenshot: async (tabId, options) => {
      calls.push({ method: "screenshot", args: [tabId, options] });
      return { path: join(dir, "shot.png"), bytes: 2048 };
    },
    visibility: async (tabId, target) => {
      calls.push({ method: "visibility", args: [tabId, target] });
      return { exists: true, visible: true };
    },
    wait: async (tabId, input) => {
      calls.push({ method: "wait", args: [tabId, input] });
      return { ok: true, waitedMs: 120 };
    },
    setViewport: (tabId: string, size: { width: number; height: number } | null) => {
      calls.push({ method: "setViewport", args: [tabId, size] });
      return size;
    },
    setLayout: (layoutId) => {
      calls.push({ method: "setLayout", args: [layoutId] });
      return { tabs, views: [{ id: "view-1", name: "视图", layoutId }] };
    },
    pinTab: (slotIndex, tabId) => {
      calls.push({ method: "pinTab", args: [slotIndex, tabId] });
      return { tabs, views: [{ id: "view-1", name: "视图", layoutId: "2x2" }] };
    },
    moveTab: (tabId, target) => {
      calls.push({ method: "moveTab", args: [tabId, target] });
      return { tabs, views: [{ id: "view-1", name: "视图", layoutId: "2x2" }] };
    },
    fillLogin: async (tabId) => {
      calls.push({ method: "fillLogin", args: [tabId] });
      return { ok: true, submitted: false, missingFields: [] };
    },
    defaultTabId: (requested) => {
      if (requested) return requested;
      if (active) return active;
      const first = tabs[0];
      if (!first) throw new Error("没有打开的标签页");
      return first.id;
    },
    defaultViewId: () => "view-1",
    layoutTargetView: () => "view-1",
    openView: async (viewId) => {
      calls.push({ method: "openView", args: [viewId] });
      return { views: [{ id: "view-1", name: "视图", layoutId: "2x2" }] };
    },
  };
}

async function rpc(body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

/** MCP tool results carry a JSON string in `content[0].text`. */
function toolPayload(json: any): unknown {
  return JSON.parse(json.result.content[0].text);
}

async function startServer(embedded?: EmbeddedSurface): Promise<void> {
  const settingsPath = join(dir, "mcp.json");
  saveMcpSettings(settingsPath, {
    ...loadMcpSettings(settingsPath),
    enabled: true,
    // Port 0 lets the OS assign one: a fixed random port in the ephemeral range
    // collides with ordinary TCP connections often enough to fail intermittently.
    port: 0,
    token: TOKEN,
  });
  server = new McpServer({
    settingsPath,
    auditPath: join(dir, "mcp-audit.log"),
    service,
    appVersion: "test",
    ...(embedded ? { embedded } : {}),
  });
  // Browser tools are `run` in part, so the suite needs the run permission on.
  await server.update({ allowRun: true });
  await server.start();
  port = server.status().port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-browser-mcp-"));
  calls = [];
  service = new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
  });
  await service.initialize();
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("browser tools are advertised", () => {
  it("reports the port the socket is actually bound to", async () => {
    await startServer(fakeSurface());
    expect(port).toBeGreaterThan(0);
    // A fixed random port can collide with an ordinary TCP connection; when that
    // happened, status() used to report the configured number and callers posted
    // into the void. The reported port must answer a real request.
    const { status } = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(status).toBe(200);
  });

  it("lists the full browser tool set", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);
    for (const expected of [
      "list_browser_tabs",
      "open_browser_tab",
      "navigate_browser_tab",
      "read_browser_page",
      "check_element_visible",
      "click_browser_element",
      "type_browser_text",
      "fill_browser_login",
      "screenshot_browser_tab",
      "evaluate_browser_page",
      "set_browser_layout",
      "pin_browser_tab",
      "move_browser_tab",
      "set_tab_page",
      "close_browser_tab",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("never exposes a tool that returns a password", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names: string[] = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names.some((name) => /(get|read|copy|reveal)_(password|secret)/i.test(name))).toBe(
      false,
    );
    // `read_browser_page` reads the page, not the vault.
    expect(names).toContain("read_browser_page");
  });
});

describe("browser tool calls", () => {
  it("opens a tab bound to an identity and returns its id", async () => {
    await startServer(fakeSurface());
    const identity = service.saveIdentity({
      siteId: (
        await service.saveSite({
          name: "本地开发环境",
          baseUrl: "http://127.0.0.1:3000",
          loginPath: "/login",
          autoSubmit: false,
        })
      ).id,
      name: "管理员 · 主账号",
      username: "admin",
      role: "管理员",
      color: "amber",
      passwordMode: "custom",
    });
    const { json } = await rpc(
      toolCall("open_browser_tab", {
        url: "http://127.0.0.1:3000/login",
        identityId: identity.id,
      }),
    );
    const payload = toolPayload(json) as { id: string; label: string; identityId: string };
    expect(payload.identityId).toBe(identity.id);
    // The tool fills in the identity's own label rather than making the AI repeat it.
    expect(payload.label).toBe("管理员 · 主账号");
  });

  it("rejects an unknown identity instead of opening an unowned tab", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("open_browser_tab", { identityId: "nope" }));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("身份不存在");
    expect(calls).toHaveLength(0);
  });

  it("routes calls with no tabId to the active tab", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/a", label: "A" }));
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/b", label: "B" }));
    const { json } = await rpc(toolCall("read_browser_page", {}));
    expect(json.result.isError).toBeUndefined();
    const snapshot = toolPayload(json) as { nodes: unknown[] };
    expect(snapshot.nodes).toHaveLength(1);
    // The second tab is active, so that is the one read.
    const read = calls.find((call) => call.method === "snapshotDom");
    expect(read?.args[0]).toBe("tab-2");
  });

  it("reports a clear error when the surface is unavailable", async () => {
    await startServer();
    const { json } = await rpc(toolCall("list_browser_tabs", {}));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("内置浏览器不可用");
  });

  it("passes typing options through, including submit", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(
      toolCall("type_browser_text", {
        selector: "#name",
        text: "hello",
        submit: true,
        clear: false,
      }),
    );
    const typed = calls.find((call) => call.method === "type");
    expect(typed?.args).toEqual([
      "tab-1",
      { selector: "#name" },
      "hello",
      { submit: true, clear: false },
    ]);
  });

  it("types into a field by its label instead of a positional selector", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("type_browser_text", { label: "用户名", text: "admin", exact: true }),
    );
    expect(json.result.isError).toBeUndefined();
    const typed = calls.find((call) => call.method === "type");
    // No selector at all: the page resolves "用户名" to its own input. This is
    // the shape a component-library form needs — its DOM has no stable paths.
    expect(typed?.args[1]).toEqual({ label: "用户名", exact: true });
  });

  it("pins a tab to a fixed viewport and hands reset through untouched", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));

    const set = await rpc(toolCall("set_browser_viewport", { width: 390, height: 844 }));
    expect(set.json.result.isError).toBeUndefined();
    const applied = calls.find((call) => call.method === "setViewport");
    expect(applied?.args).toEqual(["tab-1", { width: 390, height: 844 }]);

    const reset = await rpc(toolCall("reset_browser_viewport", {}));
    expect(reset.json.result.isError).toBeUndefined();
    const cleared = calls.filter((call) => call.method === "setViewport").at(-1);
    expect(cleared?.args).toEqual(["tab-1", null]);
  });

  it("refuses an out-of-range viewport with the usable range in the message", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const refused = await rpc(toolCall("set_browser_viewport", { width: 200, height: 844 }));
    expect(refused.json.result.isError).toBe(true);
    expect(refused.json.result.content[0].text).toMatch(/320/);
    // The refusal must not have reached the surface: a half-applied viewport
    // would leave the page somewhere neither adaptive nor the requested size.
    expect(calls.some((call) => call.method === "setViewport")).toBe(false);
  });

  it("clicks an element by its text", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("click_browser_element", { text: "创建租户" }));
    const clicked = calls.find((call) => call.method === "click");
    expect(clicked?.args[1]).toEqual({ text: "创建租户" });
  });

  it("fills a whole form in one call", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("fill_browser_form", {
        fields: [
          { label: "租户名称", value: "客户 A" },
          { label: "管理员账号", value: "admin-a@example.test" },
          { label: "初始密码", value: "Temp-Secret-1", submit: true },
        ],
      }),
    );
    expect(json.result.isError).toBeUndefined();
    const fill = calls.find((call) => call.method === "fillForm");
    expect(fill?.args[1]).toEqual([
      { target: { label: "租户名称" }, value: "客户 A", submit: false, clear: true },
      {
        target: { label: "管理员账号" },
        value: "admin-a@example.test",
        submit: false,
        clear: true,
      },
      { target: { label: "初始密码" }, value: "Temp-Secret-1", submit: true, clear: true },
    ]);
  });

  it("keeps only the password field of a form out of the audit log", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(
      toolCall("fill_browser_form", {
        fields: [
          { label: "租户名称", value: "客户 A" },
          { label: "初始密码", value: "Temp-Secret-1" },
        ],
      }),
    );
    const audit = readFileSync(join(dir, "mcp-audit.log"), "utf8");
    const line = audit.split("\n").find((entry) => entry.includes("fill_browser_form"));
    expect(line).toBeTruthy();
    expect(line).not.toContain("Temp-Secret-1");
    expect(line).toContain("[redacted]");
    // The non-secret field is still readable: the log has to stay useful.
    expect(line).toContain("客户 A");
  });

  it("waits page-side instead of sleeping between round trips", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("wait_browser", { condition: "text", expect: "租户管理", timeoutMs: 8000 }));
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toEqual({ condition: "text", text: "租户管理", timeoutMs: 8000 });
  });

  it("waits for an element named by its label", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("wait_browser", { condition: "visible", label: "创建租户" }));
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toMatchObject({
      condition: "visible",
      target: { label: "创建租户" },
      timeoutMs: 5000,
    });
  });

  it("rejects a wait condition that has nothing to compare", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("wait_browser", { condition: "text" }));
    expect(json.result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("defaults typing to clearing the field first", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("type_browser_text", { selector: "#name", text: "x" }));
    const typed = calls.find((call) => call.method === "type");
    expect((typed?.args[3] as { clear?: boolean } | undefined)?.clear).toBe(true);
  });

  it("keeps a password typed into a password field out of the audit log", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("type_browser_text", { selector: "#tpass", text: "tenant-secret" }));
    const audit = readFileSync(join(dir, "mcp-audit.log"), "utf8");
    const typedLine = audit.split("\n").find((line) => line.includes("type_browser_text"));
    expect(typedLine).toBeTruthy();
    // The parameter is called `text`, so name-based redaction cannot see it.
    expect(typedLine).not.toContain("tenant-secret");
    expect(typedLine).toContain("[redacted]");
  });

  it("leaves ordinary text in the audit log", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("type_browser_text", { selector: "#tname", text: "客户 A" }));
    const audit = readFileSync(join(dir, "mcp-audit.log"), "utf8");
    const typedLine = audit.split("\n").find((line) => line.includes("type_browser_text"));
    expect(typedLine).toContain("客户 A");
  });

  it("requires some way to name the element", async () => {
    await startServer(fakeSurface());
    // Nothing positional, no label, no text, no role: there is nothing to act on,
    // and guessing "the first element" would be worse than refusing.
    const { json } = await rpc(toolCall("click_browser_element", {}));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/selector|label|text|role/);
    expect(calls).toHaveLength(0);
  });

  it("validates the slot index before touching the layout", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("pin_browser_tab", { slotIndex: -1 }));
    expect(json.result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("passes the screenshot format through", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(toolCall("screenshot_browser_tab", { format: "jpeg" }));
    const payload = toolPayload(json) as { path: string; bytes: number };
    expect(payload.bytes).toBe(2048);
    const shot = calls.find((call) => call.method === "screenshot");
    expect(shot?.args[1]).toEqual({ format: "jpeg" });
  });

  it("moves a tab relative to another tab", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/a", label: "A" }));
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/b", label: "B" }));
    const { json } = await rpc(
      toolCall("move_browser_tab", { tabId: "tab-2", beforeOrAfter: "tab-1", edge: "before" }),
    );
    expect(json.result.isError).toBeUndefined();
    const move = calls.find((call) => call.method === "moveTab");
    expect(move?.args).toEqual(["tab-2", { kind: "tab", tabId: "tab-1", edge: "before" }]);
  });

  it("moves a tab into a view or out of every view", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/a" }));
    await rpc(toolCall("move_browser_tab", { tabId: "tab-1", viewId: "view-2" }));
    const intoView = calls.find((call) => call.method === "moveTab");
    expect(intoView?.args).toEqual(["tab-1", { kind: "view", viewId: "view-2" }]);

    calls = [];
    await rpc(toolCall("move_browser_tab", { tabId: "tab-1", loose: true }));
    const loose = calls.find((call) => call.method === "moveTab");
    expect(loose?.args).toEqual(["tab-1", { kind: "loose" }]);
  });

  it("rejects a move with no destination instead of guessing one", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("move_browser_tab", { tabId: "tab-1" }));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/beforeOrAfter|viewId|loose/);
    expect(calls).toHaveLength(0);
  });

  it("switches which page an instance shows", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("set_tab_page", { pageId: "tab-3" }));
    expect(json.result.isError).toBeUndefined();
    const activated = calls.find((call) => call.method === "activate");
    expect(activated?.args).toEqual(["tab-3"]);
  });

  it("audits browser calls with the tool name", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("list_browser_tabs", {}));
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(dir, "mcp-audit.log"), "utf8").trim().split("\n");
    const entry = JSON.parse(log[log.length - 1]!);
    expect(entry.tool).toBe("list_browser_tabs");
    expect(entry.ok).toBe(true);
  });
});
