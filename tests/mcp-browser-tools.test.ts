import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";
import { McpServer, loadMcpSettings, saveMcpSettings } from "../src/main/mcp/server";
import type { EmbeddedSurface } from "../src/main/mcp/server";

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
  let tabs: Array<{ id: string; label: string; url: string; title: string; identityId?: string }> = [];
  let active: string | undefined;
  const record = (method: string) => (...args: unknown[]) => {
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
      };
      tabs = [...tabs, tab];
      active = tab.id;
      return tab;
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
        nodes: [{ role: "heading", name: "标题", tag: "h1", selector: "h1", bounds: { x: 0, y: 0, width: 10, height: 10 } }],
        total: 1,
        truncated: false,
      };
    },
    click: async (tabId, selector) => {
      calls.push({ method: "click", args: [tabId, selector] });
      return { ok: true };
    },
    type: async (tabId, selector, text, options) => {
      calls.push({ method: "type", args: [tabId, selector, text, options] });
      return { ok: true };
    },
    evaluate: async (tabId, expression) => {
      calls.push({ method: "evaluate", args: [tabId, expression] });
      return { value: 42 };
    },
    screenshot: async (tabId, options) => {
      calls.push({ method: "screenshot", args: [tabId, options] });
      return { path: join(dir, "shot.png"), bytes: 2048 };
    },
    visibility: async (tabId, selector) => {
      calls.push({ method: "visibility", args: [tabId, selector] });
      return { exists: true, visible: true };
    },
    setLayout: (layoutId) => {
      calls.push({ method: "setLayout", args: [layoutId] });
      return { tabs, views: [{ id: "view-1", name: "视图", layoutId }] };
    },
    pinTab: (slotIndex, tabId) => {
      calls.push({ method: "pinTab", args: [slotIndex, tabId] });
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
      "close_browser_tab",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("never exposes a tool that returns a password", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names: string[] = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names.some((name) => /(get|read|copy|reveal)_(password|secret)/i.test(name))).toBe(false);
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
    expect(typed?.args).toEqual(["tab-1", "#name", "hello", { submit: true, clear: false }]);
  });

  it("defaults typing to clearing the field first", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("type_browser_text", { selector: "#name", text: "x" }));
    const typed = calls.find((call) => call.method === "type");
    expect((typed?.args[3] as { clear: boolean }).clear).toBe(true);
  });

  it("requires a selector for interactive tools", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("click_browser_element", {}));
    expect(json.error.code).toBe(-32602);
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
