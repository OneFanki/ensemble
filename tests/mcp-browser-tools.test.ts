import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLOW_ACTIONS, WAIT_CONDITIONS } from "../src/shared/flows";
import type { EmbeddedSurface } from "../src/main/mcp/server";
import {
  describeToolAction,
  loadMcpSettings,
  McpServer,
  previewActivityResult,
  saveMcpSettings,
  withoutPartition,
} from "../src/main/mcp/server";

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
    partition?: string;
    profileId?: string;
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
        partition: input.identityId ? "persist:embedded-identity" : "embedded-clean-test",
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
    back: (tabId) => {
      calls.push({ method: "back", args: [tabId] });
    },
    forward: (tabId) => {
      calls.push({ method: "forward", args: [tabId] });
    },
    reload: (tabId, options) => {
      calls.push({ method: "reload", args: [tabId, options] });
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
    hover: async (tabId, target) => {
      calls.push({ method: "hover", args: [tabId, target] });
      return { ok: true };
    },
    scroll: async (tabId, options) => {
      calls.push({ method: "scroll", args: [tabId, options] });
      return { ok: true, scrolled: { x: 0, y: 0 }, moved: true };
    },
    pressKeys: async (tabId, keys) => {
      calls.push({ method: "pressKeys", args: [tabId, keys] });
      return { ok: true, keys, modifiers: 0 };
    },
    dialogStatus: (tabId) => {
      calls.push({ method: "dialogStatus", args: [tabId] });
      return { dialog: null };
    },
    handleDialog: async (tabId, options) => {
      calls.push({ method: "handleDialog", args: [tabId, options] });
      return { ok: true, handled: true };
    },
    setFiles: async (tabId, target, paths) => {
      calls.push({ method: "setFiles", args: [tabId, target, paths] });
      return { ok: true, count: paths.length, multiple: true };
    },
    drag: async (tabId, from, to) => {
      calls.push({ method: "drag", args: [tabId, from, to] });
      return { ok: true };
    },
    setChecked: async (tabId, target, checked) => {
      calls.push({ method: "setChecked", args: [tabId, target, checked] });
      return { ok: true, checked, changed: true };
    },
    elementInfo: async (tabId, target) => {
      calls.push({ method: "elementInfo", args: [tabId, target] });
      return { ok: true, tag: "button" };
    },
    findElements: async (tabId, locator, options) => {
      calls.push({ method: "findElements", args: [tabId, locator, options] });
      return {
        ok: true,
        handleId: "el-1-ab12",
        count: 2,
        index: 0,
        resolved: false,
        matches: [
          {
            tag: "button",
            text: "删除 A",
            visible: true,
            rect: { x: 0, y: 0, width: 80, height: 24 },
          },
          {
            tag: "button",
            text: "删除 C",
            visible: true,
            rect: { x: 0, y: 30, width: 80, height: 24 },
          },
        ],
      };
    },
    attributes: async (tabId, target, names) => {
      calls.push({ method: "attributes", args: [tabId, target, names] });
      return { ok: true, attributes: {} };
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
      return {
        path: join(dir, "shot.png"),
        bytes: 2048,
        ...(options?.inline
          ? { data: "iVBORw0KGgo=", mimeType: "image/png" }
          : {}),
      };
    },
    readPageActivity: async (tabId: string) => {
      calls.push({ method: "readPageActivity", args: [tabId] });
      return {
        url: "http://example.test/",
        title: "页面",
        logs: [{ at: "2026-01-01T00:00:00.000Z", level: "error", text: "boom" }],
        inflight: [],
        recent: [],
        installed: true,
        dropped: 0,
      };
    },
    readRequests: async (
      tabId: string,
      options?: { url?: string; method?: string; status?: number; limit?: number },
    ) => {
      calls.push({ method: "readRequests", args: [tabId, options] });
      return {
        requests: [
          { at: "2026-01-01T00:00:00.000Z", method: "GET", url: "/api/tenants", status: 200, ms: 12, failed: false },
        ],
        inflight: [],
        installed: true,
      };
    },
    setEmulation: async (
      tabId: string,
      patch: {
        timezone?: string | null;
        mediaType?: string | null;
        offline?: boolean | null;
        geolocation?: { latitude: number; longitude: number; accuracy?: number } | null;
      },
    ) => {
      calls.push({ method: "setEmulation", args: [tabId, patch] });
      const now: Record<string, unknown> = {};
      if (patch.timezone) now.timezone = patch.timezone;
      if (patch.mediaType) now.mediaType = patch.mediaType;
      if (patch.offline) now.offline = true;
      if (patch.geolocation) now.geolocation = patch.geolocation;
      return now;
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
    surfaceName: () => "embedded",
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

async function startServer(
  embedded?: EmbeddedSurface,
  onPageAction?: (event: Record<string, unknown>) => void,
): Promise<void> {
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
    ...(onPageAction ? { onPageAction } : {}),
  });
  // Browser tools are `run` in part, so the suite needs the run permission on.
  await server.update({ allowRun: true });
  await server.start();
  port = server.status().port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-browser-tools-"));
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
      "read_browser_capabilities",
      "open_browser_tab",
      "navigate_browser_tab",
      "read_browser_page",
      "read_browser_console",
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
    const identity = await service.saveIdentity({
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

  it("find_browser_element carries the narrowing fields and timeout through", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("find_browser_element", {
        text: "删除",
        hasNotText: "B",
        visible: true,
        nth: 1,
        timeoutMs: 2000,
      }),
    );
    expect(json.result.isError).toBeUndefined();
    const payload = toolPayload(json) as { handleId: string; count: number; matches: unknown[] };
    expect(payload.handleId).toBe("el-1-ab12");
    expect(payload.count).toBe(2);
    expect(payload.matches).toHaveLength(2);
    const found = calls.find((call) => call.method === "findElements");
    expect(found?.args[0]).toBe("tab-1");
    expect(found?.args[1]).toEqual({
      text: "删除",
      hasNotText: "B",
      visible: true,
      nth: 1,
    });
    expect(found?.args[2]).toEqual({ timeoutMs: 2000 });
  });

  it("refuses a find locator that narrows without naming anything", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(toolCall("find_browser_element", { hasText: "删除" }));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/selector|label|text|role/);
    // The refusal must happen before the surface is touched: no poll started.
    expect(calls.some((call) => call.method === "findElements")).toBe(false);
  });

  it("passes a handle through to the action unchanged", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("click_browser_element", { handle: "el-1-ab12", nth: 1 }));
    const clicked = calls.find((call) => call.method === "click");
    // The surface receives the descriptor pair as-is; resolving the handle is
    // the surface's job (it owns the per-tab handle table).
    expect(clicked?.args[1]).toEqual({ handle: "el-1-ab12", nth: 1 });
  });

  it("rejects a call that gives both a handle and a locator field", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("click_browser_element", { handle: "el-1-ab12", text: "删除" }),
    );
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("只能给一个");
    expect(calls.some((call) => call.method === "click")).toBe(false);
  });

  it("passes a handle through wait_browser and check_element_visible unchanged", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const waited = await rpc(
      toolCall("wait_browser", { condition: "hidden", handle: "el-1-ab12" }),
    );
    expect(waited.json.result.isError).toBeUndefined();
    const probe = await rpc(
      toolCall("check_element_visible", { handle: "el-1-ab12", nth: 1 }),
    );
    expect(probe.json.result.isError).toBeUndefined();
    // The surface receives the descriptor as-is; resolving the handle is the
    // surface's job, same as for the action tools.
    const wait = calls.find((call) => call.method === "wait");
    expect(wait?.args[1]).toEqual({
      condition: "hidden",
      target: { handle: "el-1-ab12" },
      timeoutMs: 5000,
    });
    const visibility = calls.find((call) => call.method === "visibility");
    expect(visibility?.args[1]).toEqual({ handle: "el-1-ab12", nth: 1 });
  });

  it("rejects wait and visibility calls that give both a handle and a locator", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const waitJson = await rpc(
      toolCall("wait_browser", {
        condition: "hidden",
        handle: "el-1-ab12",
        selector: "#toast",
      }),
    );
    expect(waitJson.json.result.isError).toBe(true);
    expect(waitJson.json.result.content[0].text).toContain("只能给一个");
    const probeJson = await rpc(
      toolCall("check_element_visible", { handle: "el-1-ab12", label: "用户名" }),
    );
    expect(probeJson.json.result.isError).toBe(true);
    expect(probeJson.json.result.content[0].text).toContain("只能给一个");
    // The refusal happens at the entrance: neither surface method is reached.
    expect(calls.some((call) => call.method === "wait")).toBe(false);
    expect(calls.some((call) => call.method === "visibility")).toBe(false);
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

  /**
   * A remote client cannot open a file path. The image has to travel inside the
   * result for those clients, and only when asked, because base64 is paid for in
   * tokens on every client including the local one.
   */
  it("returns the image itself when inline is asked for", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(toolCall("screenshot_browser_tab", { inline: true }));
    const blocks = json.result.content as Array<{ type: string; text?: string; data?: string }>;
    expect(blocks[0]?.type).toBe("text");
    const image = blocks.find((block) => block.type === "image");
    expect(image?.data).toBe("iVBORw0KGgo=");
    // The path stays in the text block: a person reading the transcript still
    // wants the file, and a text-only client must not get an empty result.
    expect(JSON.parse(blocks[0]!.text!)).toMatchObject({ bytes: 2048, inline: true });
  });

  it("keeps the default screenshot result free of image data", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(toolCall("screenshot_browser_tab", {}));
    expect(json.result.content).toHaveLength(1);
    expect(json.result.content[0].type).toBe("text");
    expect(json.result.content[0].text).not.toContain("iVBORw0KGgo=");
  });

  it("reads what the page logged and clears it for the next read", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(toolCall("read_browser_console", {}));
    expect(json.result.isError).toBeUndefined();
    const activity = toolPayload(json) as { logs: Array<{ text: string }>; installed: boolean };
    expect(activity.installed).toBe(true);
    expect(activity.logs[0]?.text).toBe("boom");
  });

  it("waits for network idle without needing a value to compare", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("wait_browser", { condition: "network-idle", quietMs: 800 }),
    );
    expect(json.result.isError).toBeUndefined();
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toMatchObject({ condition: "network-idle", quietMs: 800 });
  });

  it("waits for a response by URL substring with an exact status", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("wait_browser", { condition: "response", expect: "/api/save", status: 200 }),
    );
    expect(json.result.isError).toBeUndefined();
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toMatchObject({
      condition: "response",
      text: "/api/save",
      status: 200,
    });
  });

  it("waits for document load without needing a value to compare", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(toolCall("wait_browser", { condition: "load" }));
    expect(json.result.isError).toBeUndefined();
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toMatchObject({ condition: "load", timeoutMs: 5000 });
    expect(waited?.args[1]).not.toHaveProperty("text");
  });

  it("reads settled requests with filters and never consumes them", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("read_browser_requests", { url: "/api/tenants", status: 200, limit: 10 }),
    );
    expect(json.result.isError).toBeUndefined();
    const payload = toolPayload(json) as {
      requests: Array<{ url: string; status: number }>;
      installed: boolean;
    };
    expect(payload.installed).toBe(true);
    expect(payload.requests[0]?.url).toBe("/api/tenants");
    const read = calls.find((call) => call.method === "readRequests");
    expect(read?.args[1]).toEqual({ url: "/api/tenants", status: 200, limit: 10 });
  });

  it("rejects an emulation call that names nothing to change", async () => {
    await startServer(fakeSurface());
    // `set_browser_emulation` is a `write` tool; the suite starts with only the
    // run permission on, and the gate must not be bypassed by an empty patch.
    await server.update({ allowWrite: true });
    const opened = await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const tabId = (toolPayload(opened.json) as { id: string }).id;
    const { json } = await rpc(toolCall("set_browser_emulation", { tabId }));
    expect(json.result.isError).toBe(true);
    expect(calls.find((call) => call.method === "setEmulation")).toBeUndefined();
  });

  it("refuses an emulation call while the write permission is off", async () => {
    await startServer(fakeSurface());
    // The default settings leave writes on; the closed state has to be set
    // explicitly for the gate to matter.
    await server.update({ allowWrite: false });
    const opened = await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const tabId = (toolPayload(opened.json) as { id: string }).id;
    const { json } = await rpc(toolCall("set_browser_emulation", { tabId, timezone: "Asia/Tokyo" }));
    // The permission gate is a tool-level refusal (`isError`), not a protocol error.
    expect(json.result.isError).toBe(true);
    expect(calls.find((call) => call.method === "setEmulation")).toBeUndefined();
  });

  it("passes each emulation key through and distinguishes null from omission", async () => {
    await startServer(fakeSurface());
    await server.update({ allowWrite: true });
    const opened = await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const tabId = (toolPayload(opened.json) as { id: string }).id;
    await rpc(
      toolCall("set_browser_emulation", {
        tabId,
        timezone: "Asia/Tokyo",
        geolocation: { latitude: 35.68, longitude: 139.76 },
      }),
    );
    await rpc(toolCall("set_browser_emulation", { tabId, timezone: null }));
    const emulations = calls.filter((call) => call.method === "setEmulation");
    // The first call carries the keys given and leaves the others out entirely;
    // the second clears exactly the one key, which a merged object could not
    // express.
    expect(emulations[0]?.args[1]).toEqual({
      timezone: "Asia/Tokyo",
      geolocation: { latitude: 35.68, longitude: 139.76 },
    });
    expect(emulations[1]?.args[1]).toEqual({ timezone: null });
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

describe("unknown arguments are refused at the entrance", () => {
  /**
   * schema 的 `additionalProperties: false` 只有端点真正执行才有意义。这里的
   * 代表样本覆盖两类错误：把 find 专属收窄字段传给动作工具（张冠李戴，必须点名
   * 去处），以及传一个根本不存在的字段。拒绝必须是协议错误（-32602）且发生在
   * 入口——表面方法一个都不能被碰到。
   */
  it("rejects a find-only narrowing field passed to an action tool and names where it belongs", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("click_browser_element", { tabId: "tab-1", text: "删除", hasText: "A" }),
    );
    expect(json.error?.code).toBe(-32602);
    expect(json.error?.message).toContain("未知参数");
    expect(json.error?.message).toContain("hasText");
    expect(json.error?.message).toContain("find_browser_element");
    expect(calls.some((call) => call.method === "click")).toBe(false);
  });

  it("rejects a field that the tool does not declare", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("list_browser_tabs", { limit: 5 }));
    expect(json.error?.code).toBe(-32602);
    expect(json.error?.message).toContain("limit");
    expect(json.error?.message).toContain("没有这个参数");
    expect(calls.some((call) => call.method === "createTab")).toBe(false);
  });

  it("does not put update_settings behind the generic refusal (it owns its whitelist)", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("update_settings", { notASetting: true }));
    // update_settings 是唯一开放键集的工具：未知键到达工具本身，由它解释为什么
    // 不允许改。若被入口的 -32602 拦下，这条解释就到不了调用方。
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("不允许通过 MCP 修改");
  });
});

describe("capability reporting", () => {
  /**
   * The shared fake plus every optional member. This is the "all present"
   * pole of the report; the plain `fakeSurface()` is the other pole, because
   * it only implements the optional methods some of its tests actually drive.
   */
  function fullSurface(): EmbeddedSurface {
    return {
      ...fakeSurface(),
      actionFacts: () => ({ origin: "", title: "" }),
      measurePerformance: async () => ({}),
      readPerfHistory: async () => ({}),
      setMuted: () => ({}),
      muteForAi: () => {},
      restoreAfterAi: () => {},
      openViewContainer: () => "view-1",
      addInitScript: async () => ({ scriptId: "s1" }),
      listInitScripts: () => [],
      removeInitScript: async () => {},
      cancelScript: async () => {},
    };
  }

  it("answers the static enums without touching the surface when no tabId is given", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("read_browser_capabilities", {}));
    const payload = toolPayload(json) as Record<string, unknown>;
    // Compared against the imported constants, not a copied literal: the enum
    // lists are allowed to grow, and this assertion follows them.
    expect(payload).toEqual({
      waitConditions: [...WAIT_CONDITIONS],
      flowActions: [...FLOW_ACTIONS],
      flowCdpStep: { available: true, gatedTierSetting: "flowCdpExtended" },
    });
    expect(payload).not.toHaveProperty("surface");
    expect(payload).not.toHaveProperty("capabilities");
    // No tab resolved, no surface method asked for: the static half has no
    // page to answer for.
    expect(calls).toHaveLength(0);
  });

  it("answers the static enums on a host with no surface at all", async () => {
    await startServer();
    const { json } = await rpc(toolCall("read_browser_capabilities", {}));
    expect(json.result.isError).toBeUndefined();
    const payload = toolPayload(json) as { waitConditions: string[]; flowActions: string[] };
    expect(payload.waitConditions).toEqual([...WAIT_CONDITIONS]);
    expect(payload.flowActions).toEqual([...FLOW_ACTIONS]);
  });

  it("reports the surface name and measured capabilities for a tab", async () => {
    await startServer(fullSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(toolCall("read_browser_capabilities", { tabId: "tab-1" }));
    const payload = toolPayload(json) as {
      surface: string;
      capabilities: Record<string, boolean>;
      waitConditions: string[];
    };
    expect(payload.surface).toBe("embedded");
    expect(Object.values(payload.capabilities).every(Boolean)).toBe(true);
    // Existence checks on the surface object only: a capability report must
    // not drive the page it names.
    expect(calls.filter((call) => call.method !== "createTab")).toHaveLength(0);
  });

  it("reports false for the optional methods the host did not implement", async () => {
    // The shared fake implements readPageActivity / readRequests / setEmulation
    // and none of the other optional members — the shape of a surface whose
    // carrier cannot sample, emulate or inject.
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("read_browser_capabilities", { tabId: "tab-1" }),
    );
    const payload = toolPayload(json) as {
      surface: string;
      capabilities: Record<string, boolean>;
    };
    expect(payload.surface).toBe("embedded");
    expect(payload.capabilities).toMatchObject({
      readPageActivity: true,
      readRequests: true,
      setEmulation: true,
      measurePerformance: false,
      readPerfHistory: false,
      setMuted: false,
      openViewContainer: false,
      addInitScript: false,
      listInitScripts: false,
      removeInitScript: false,
      cancelScript: false,
    });
  });

  it("reports the surface as unknown when the host does not name itself", async () => {
    // `surfaceName` is optional: a host that skips it still gets a full and
    // usable report, only without a label to tell built-in from external.
    const { surfaceName: _unnamed, ...rest } = fullSurface();
    await startServer(rest as EmbeddedSurface);
    const { json } = await rpc(toolCall("read_browser_capabilities", { tabId: "tab-1" }));
    const payload = toolPayload(json) as { surface: string; capabilities: Record<string, boolean> };
    expect(payload.surface).toBe("unknown");
    expect(payload.capabilities).toBeTruthy();
  });
});

describe("MCP result projection", () => {
  it("removes storage partitions without touching the semantic fields", () => {
    const projected = withoutPartition({
      tabs: [
        {
          id: "t1",
          clean: false,
          profileId: "default",
          partition: "persist:embedded-clean",
        },
      ],
    }) as { tabs: Array<Record<string, unknown>> };
    expect(projected.tabs[0]).toEqual({ id: "t1", clean: false, profileId: "default" });
  });

  it("keeps a page's partition out of every tab-list result", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "https://example.test/", label: "页面" }));
    const { json } = await rpc(toolCall("list_browser_tabs", {}));
    expect(json.result.content[0].text).not.toContain("partition");
    expect(json.result.content[0].text).not.toContain("embedded-clean-test");
  });

  it("redacts a typed secret in the activity detail, not just the summary", async () => {
    const events: Array<Record<string, unknown>> = [];
    await startServer(fakeSurface(), (event) => events.push(event));
    await rpc(
      toolCall("open_browser_tab", {
        url: "https://example.test/",
        label: "测试页",
      }),
    );
    await rpc(
      toolCall("type_browser_text", {
        tabId: "tab-1",
        selector: "#password",
        text: "hunter2",
      }),
    );
    const detail = (
      events.at(-1)?.details as Array<{ args?: Record<string, unknown> }> | undefined
    )?.[0];
    expect(detail?.args?.["text"]).toBe("[redacted]");
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });

  it("previews a script and never echoes a typed value", () => {
    expect(
      describeToolAction("evaluate_browser_page", { expression: "return document.title" }),
    ).toBe("执行脚本：return document.title");
    const typed = describeToolAction("type_browser_text", {
      selector: "#password",
      text: "hunter2",
    });
    expect(typed).toBe("在「#password」输入");
    expect(typed).not.toContain("hunter2");
  });

  it("truncates a large result instead of storing it whole", () => {
    const preview = previewActivityResult("x".repeat(10_000));
    expect(preview?.length).toBeLessThanOrEqual(4_001);
    expect(preview?.endsWith("…")).toBe(true);
  });
});
