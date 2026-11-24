import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLOW_ACTIONS, WAIT_CONDITIONS } from "../src/shared/flows";
import { resolveDefaultTabId } from "../src/shared/embedded";
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
 *
 * `personPages` seed the pages a person opened; the last of them is the active
 * page, as after any click in the chrome.
 */
function fakeSurface(personPages: string[] = []): EmbeddedSurface {
  let tabs: Array<{
    id: string;
    label: string;
    url: string;
    title: string;
    identityId?: string;
    clean?: boolean;
    partition?: string;
    profileId?: string;
    origin: "view" | "manual" | "ai";
    aiOpenSeq?: number;
  }> = personPages.map((id) => ({
    id,
    label: id,
    url: "http://example.test/",
    title: "",
    origin: "manual",
  }));
  /**
   * The person's active page. Mirrors the real surface: an AI-opened page never
   * claims it (a background page must not take the stage away), so only the
   * seed and an explicit `activate` ever set it.
   */
  let active: string | undefined = personPages.at(-1);
  let aiSeq = 0;
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
        id: `tab-${++aiSeq}`,
        label: input.label ?? "新标签页",
        url: input.url ?? "about:blank",
        title: "",
        ...(input.identityId ? { identityId: input.identityId } : {}),
        ...(input.siteId ? { siteId: input.siteId } : {}),
        // Mirrors the real bridge: an identity-less tab opened by the AI is a
        // clean session, never a page in the user's daily profile.
        ...(input.identityId ? {} : { clean: true }),
        partition: input.identityId ? "persist:embedded-identity" : "embedded-clean-test",
        // Every page this fake opens is an AI page, as in the real bridge.
        origin: "ai" as const,
        aiOpenSeq: aiSeq,
      };
      tabs = [...tabs, tab];
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
      // 与真实桥同一形状：整只页记录挂在 `tab` 下，拦截信息在同级。
      return { tab: tabs.find((tab) => tab.id === tabId) };
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
      // Same rule as the real surface, down to the shared function.
      const id = requested
        ? requested
        : resolveDefaultTabId({ tabs, activeTabId: active });
      if (!id) throw new Error("没有打开的标签页");
      return id;
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
      "check_browser_element_visible",
      "click_browser_element",
      "type_browser_text",
      "fill_browser_login",
      "screenshot_browser_tab",
      "evaluate_browser_page",
      "set_browser_layout",
      "pin_browser_tab",
      "move_browser_tab",
      "activate_browser_tab",
      "close_browser_tab",
      "pop_out_browser_tab",
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

  it("没有 identityId 时按地址归属复用已录入站点的第一个账号", async () => {
    await startServer(fakeSurface());
    const site = await service.saveSite({
      name: "本地开发环境",
      baseUrl: "http://127.0.0.1:9527",
      loginPath: "/login",
    });
    const first = await service.saveIdentity({
      siteId: site.id,
      name: "管理员 · 主账号",
      username: "admin",
      role: "管理员",
      color: "amber",
      passwordMode: "custom",
    });
    await service.saveIdentity({
      siteId: site.id,
      name: "运营 · 副账号",
      username: "ops",
      role: "运营",
      color: "teal",
      passwordMode: "custom",
    });
    const { json } = await rpc(
      toolCall("open_browser_tab", { url: "http://127.0.0.1:9527/dashboard" }),
    );
    const payload = toolPayload(json) as {
      identityId?: string;
      identityName?: string;
      resolvedBy?: string;
    };
    // 打开的是已录入站点，复用该站点的第一个账号：登录态与手动打开一致。
    expect(payload.identityId).toBe(first.id);
    expect(payload.identityName).toBe("管理员 · 主账号");
    expect(payload.resolvedBy).toBe("explicit-url-match");
    const created = calls.find((call) => call.method === "createTab");
    expect(created?.args[0]).toMatchObject({
      identityId: first.id,
      siteId: site.id,
      label: "管理员 · 主账号",
      color: "amber",
    });
  });

  it("地址与 siteId 都匹配不到时维持一次性干净身份", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(
      toolCall("open_browser_tab", { url: "https://elsewhere.example.test/page" }),
    );
    const payload = toolPayload(json) as { identityId?: string; clean?: boolean; resolvedBy?: string };
    expect(payload.identityId).toBeUndefined();
    expect(payload.clean).toBe(true);
    expect(payload.resolvedBy).toBeUndefined();
  });

  it("rejects an unknown identity instead of opening an unowned tab", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("open_browser_tab", { identityId: "nope" }));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("账号不存在");
    expect(calls).toHaveLength(0);
  });

  it("routes calls with no tabId to the page the AI opened most recently", async () => {
    // The person's page is the active one throughout: an AI-opened page never
    // takes the stage. An omitted id still has to mean the AI's own page —
    // answering with the active page sent id-less reads and clicks to a page
    // nobody asked the AI to touch.
    await startServer(fakeSurface(["person-page"]));
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/a", label: "A" }));
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/b", label: "B" }));
    const { json } = await rpc(toolCall("read_browser_page", {}));
    expect(json.result.isError).toBeUndefined();
    const snapshot = toolPayload(json) as { nodes: unknown[] };
    expect(snapshot.nodes).toHaveLength(1);
    const read = calls.find((call) => call.method === "snapshotDom");
    expect(read?.args[0]).toBe("tab-2");
  });

  it("keeps meaning the person's active page once the AI's own pages are closed", async () => {
    // "Do this to the page I'm looking at" is the one case where the omitted id
    // must reach the person's page: the AI has nothing of its own to mean.
    await startServer(fakeSurface(["person-page"]));
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/a" }));
    await rpc(toolCall("close_browser_tab", { tabId: "tab-1" }));
    const { json } = await rpc(toolCall("read_browser_page", {}));
    expect(json.result.isError).toBeUndefined();
    const read = calls.find((call) => call.method === "snapshotDom");
    expect(read?.args[0]).toBe("person-page");
  });

  it("names an explicit tabId over every default", async () => {
    await startServer(fakeSurface(["person-page"]));
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/a" }));
    await rpc(toolCall("read_browser_page", { tabId: "person-page" }));
    const read = calls.find((call) => call.method === "snapshotDom");
    expect(read?.args[0]).toBe("person-page");
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

  it("passes a handle through wait_browser_condition and check_browser_element_visible unchanged", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const waited = await rpc(
      toolCall("wait_browser_condition", { condition: "hidden", handle: "el-1-ab12" }),
    );
    expect(waited.json.result.isError).toBeUndefined();
    const probe = await rpc(
      toolCall("check_browser_element_visible", { handle: "el-1-ab12", nth: 1 }),
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
      toolCall("wait_browser_condition", {
        condition: "hidden",
        handle: "el-1-ab12",
        selector: "#toast",
      }),
    );
    expect(waitJson.json.result.isError).toBe(true);
    expect(waitJson.json.result.content[0].text).toContain("只能给一个");
    const probeJson = await rpc(
      toolCall("check_browser_element_visible", { handle: "el-1-ab12", label: "用户名" }),
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
    await rpc(toolCall("wait_browser_condition", { condition: "text", expect: "租户管理", timeoutMs: 8000 }));
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toEqual({ condition: "text", text: "租户管理", timeoutMs: 8000 });
  });

  it("waits for an element named by its label", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    await rpc(toolCall("wait_browser_condition", { condition: "visible", label: "创建租户" }));
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toMatchObject({
      condition: "visible",
      target: { label: "创建租户" },
      timeoutMs: 5000,
    });
  });

  it("rejects a wait condition that has nothing to compare", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("wait_browser_condition", { condition: "text" }));
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
      toolCall("wait_browser_condition", { condition: "network-idle", quietMs: 800 }),
    );
    expect(json.result.isError).toBeUndefined();
    const waited = calls.find((call) => call.method === "wait");
    expect(waited?.args[1]).toMatchObject({ condition: "network-idle", quietMs: 800 });
  });

  it("waits for a response by URL substring with an exact status", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const { json } = await rpc(
      toolCall("wait_browser_condition", { condition: "response", expect: "/api/save", status: 200 }),
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
    const { json } = await rpc(toolCall("wait_browser_condition", { condition: "load" }));
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

  it("runs emulation under the run permission alone: closed writes do not block it, a closed run does", async () => {
    // 模拟改的是页面所处的环境，与视口同族，不碰工作区数据。它曾归 write：
    // 一个只关心「AI 能不能动我的浏览器」的用户关掉写入，却发现时区模拟
    // 被一起关掉；而开着写入、关掉运行时，断网模拟却还能做。
    await startServer(fakeSurface());
    await server.update({ allowWrite: false, allowRun: true });
    const opened = await rpc(toolCall("open_browser_tab", { url: "http://example.test/" }));
    const tabId = (toolPayload(opened.json) as { id: string }).id;
    const allowed = await rpc(toolCall("set_browser_emulation", { tabId, timezone: "Asia/Tokyo" }));
    expect(allowed.json.result.isError).toBeUndefined();
    expect(calls.find((call) => call.method === "setEmulation")).toBeDefined();

    await server.update({ allowWrite: true, allowRun: false });
    const refused = await rpc(
      toolCall("set_browser_emulation", { tabId, timezone: "Europe/Berlin" }),
    );
    // The permission gate is a tool-level refusal (`isError`), not a protocol error.
    expect(refused.json.result.isError).toBe(true);
    expect(refused.json.result.content[0].text).toContain("运行权限");
    expect(calls.filter((call) => call.method === "setEmulation")).toHaveLength(1);
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
      toolCall("move_browser_tab", { tabId: "tab-2", anchorTabId: "tab-1", edge: "before" }),
    );
    expect(json.result.isError).toBeUndefined();
    const move = calls.find((call) => call.method === "moveTab");
    expect(move?.args).toEqual(["tab-2", { kind: "tab", tabId: "tab-1", edge: "before" }]);
    // 旧名字 beforeOrAfter 装的也是参照标签页的 id，照常接受。
    const viaAlias = await rpc(
      toolCall("move_browser_tab", { tabId: "tab-2", beforeOrAfter: "tab-1", edge: "after" }),
    );
    expect(viaAlias.json.result.isError).toBeUndefined();
    expect(calls.filter((call) => call.method === "moveTab").at(-1)?.args).toEqual([
      "tab-2",
      { kind: "tab", tabId: "tab-1", edge: "after" },
    ]);
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
    expect(json.result.content[0].text).toMatch(/anchorTabId|viewId|loose/);
    expect(calls).toHaveLength(0);
  });

  it("switches which page an instance shows", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc(toolCall("activate_browser_tab", { pageId: "tab-3" }));
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
      noteAiActivity: () => {},
      setMuted: () => ({}),
      muteForAi: () => {},
      restoreAfterAi: () => {},
      openViewContainer: () => "view-1",
      popOutTab: async () => ({}),
      dockTab: async () => ({}),
      closeView: () => ({}),
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
      noteAiActivity: false,
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

  it("tab 投影不回传图标、几何与缩放，保留决策字段", async () => {
    // 表面给出的页记录带着渲染层需要的全部字段（图标 data: URL、窗口几何、
    // 分区、缩放）；MCP 出口只应放行 AI 决策需要的那些。渲染层形状见
    // shared/embedded.ts 的 EmbeddedTab，这里取它的代表字段。
    const heavyTab = {
      id: "tab-1",
      label: "页面",
      url: "https://example.test/",
      title: "示例",
      favicon: "data:image/png;base64,AAAA" + "B".repeat(4000),
      partition: "persist:embedded-identity",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      cell: { x: 0, y: 0, width: 400, height: 300 },
      zoom: 100,
      devtoolsWidth: 300,
      loading: false,
    };
    const heavy: EmbeddedSurface = {
      ...fakeSurface(),
      state: () => ({ tabs: [heavyTab], views: [] }),
    };
    await startServer(heavy);
    const { json } = await rpc(toolCall("list_browser_tabs", {}));
    const text = json.result.content[0].text;
    for (const forbidden of ["favicon", "data:image", "bounds", "partition", "zoom", "devtoolsWidth"]) {
      expect(text).not.toContain(forbidden);
    }
    const payload = JSON.parse(text) as { tabs: Array<Record<string, unknown>> };
    expect(payload.tabs[0]).toMatchObject({ id: "tab-1", url: "https://example.test/", title: "示例" });
  });

  it("navigate 返回的 tab 也是投影，拦截标记原样保留", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "https://example.test/", label: "页面" }));
    const { json } = await rpc(toolCall("navigate_browser_tab", { tabId: "tab-1", url: "https://example.test/next" }));
    const text = json.result.content[0].text;
    expect(text).not.toContain("partition");
    const payload = JSON.parse(text) as { tab: { url?: string } };
    expect(payload.tab.url).toBe("https://example.test/next");
  });

  it("evaluate 返回超过 64KB 时拒绝并提示缩法", async () => {
    const big: EmbeddedSurface = {
      ...fakeSurface(),
      evaluate: async () => ({ rows: "x".repeat(120_000) }),
    };
    await startServer(big);
    await rpc(toolCall("open_browser_tab", { url: "https://example.test/", label: "页面" }));
    const { json } = await rpc(
      toolCall("evaluate_browser_page", { tabId: "tab-1", expression: "scrape()" }),
    );
    expect(json.result.isError).toBe(true);
    const message = json.result.content[0].text as string;
    expect(message).toContain("64KB");
    expect(message).toContain("聚合或分页");
    // 丢弃的结果一个字节都不进上下文。
    expect(JSON.stringify(json.result)).not.toContain("xxxxx");
  });

  it("evaluate 正常大小的返回不受护栏影响", async () => {
    await startServer(fakeSurface());
    await rpc(toolCall("open_browser_tab", { url: "https://example.test/", label: "页面" }));
    const { json } = await rpc(
      toolCall("evaluate_browser_page", { tabId: "tab-1", expression: "1 + 1" }),
    );
    expect(json.result.isError).toBeUndefined();
    const payload = JSON.parse(json.result.content[0].text) as { value: number };
    expect(payload.value).toBe(42);
  });
});

/*
 * 调用方没读文档时凭习惯写出的调用。
 *
 * 每一条都对应一个曾经会被拒绝、或者给出误导性结果的形状：描述承诺的字段不在
 * 返回里、别的工具都叫 text 的字段这里叫 elementText、对不存在的窗口回「已停止」。
 * 这里守住的是这些调用现在按调用方的直觉工作，并且歧义在入口就被拒。
 */
describe("calls written from habit", () => {
  const open = async (args: Record<string, unknown> = { url: "https://example.test/" }) => {
    await rpc(toolCall("open_browser_tab", args));
  };
  const callOf = (method: string) => calls.find((call) => call.method === method);

  it("carries tabId at the top of a page-first result, next to id", async () => {
    await startServer(fakeSurface());
    const opened = toolPayload((await rpc(toolCall("open_browser_tab", { url: "https://example.test/" }))).json) as {
      id: string;
      tabId: string;
    };
    // The description says "returns tabId"; only `id` sent the client hunting.
    expect(opened.tabId).toBe(opened.id);
    const moved = toolPayload(
      (await rpc(toolCall("navigate_browser_tab", { tabId: opened.tabId, url: "https://example.test/next" }))).json,
    ) as { tabId: string; tab: { id: string } };
    expect(moved.tabId).toBe(opened.id);
    expect(moved.tab.id).toBe(opened.id);
  });

  it("opens a signed-out page on a recorded site's address when clean is asked", async () => {
    // Without `clean` an address that matches a recorded site always adopts that
    // site's account, so no tool could show the site signed out.
    await startServer(fakeSurface());
    const site = await service.saveSite({
      name: "本地开发环境",
      baseUrl: "http://127.0.0.1:9527",
      loginPath: "/login",
    });
    await service.saveIdentity({
      siteId: site.id,
      name: "管理员 · 主账号",
      username: "admin",
      role: "管理员",
      color: "amber",
      passwordMode: "custom",
    });
    const { json } = await rpc(
      toolCall("open_browser_tab", { url: "http://127.0.0.1:9527/dashboard", clean: true }),
    );
    expect(json.result.isError).toBeUndefined();
    const payload = toolPayload(json) as {
      id: string;
      tabId: string;
      identityId?: string;
      identityName?: string;
      clean?: boolean;
    };
    // 没有账号可归属：返回里既没有 identity，也没有「用了谁」的说明。
    expect(payload.clean).toBe(true);
    expect(payload.identityId).toBeUndefined();
    expect(payload.identityName).toBeUndefined();
    expect(payload.tabId).toBe(payload.id);
    expect(callOf("createTab")?.args[0]).not.toHaveProperty("identityId");
  });

  it("refuses clean together with identityId, and a clean that is not a boolean", async () => {
    await startServer(fakeSurface());
    const site = await service.saveSite({
      name: "本地开发环境",
      baseUrl: "http://127.0.0.1:9527",
      loginPath: "/login",
    });
    const identity = await service.saveIdentity({
      siteId: site.id,
      name: "管理员 · 主账号",
      username: "admin",
      role: "管理员",
      color: "amber",
      passwordMode: "custom",
    });
    const both = await rpc(
      toolCall("open_browser_tab", { url: "http://127.0.0.1:9527/", clean: true, identityId: identity.id }),
    );
    expect(both.json.result.isError).toBe(true);
    expect(both.json.result.content[0].text).toContain("clean 与 identityId 只能给一个");
    const notBoolean = await rpc(toolCall("open_browser_tab", { clean: "yes" }));
    expect(notBoolean.json.result.isError).toBe(true);
    expect(notBoolean.json.result.content[0].text).toContain("clean 必须是布尔值");
    expect(calls).toHaveLength(0);
  });

  it("reads wait_browser_condition's text as the value to compare, or as the element's text", async () => {
    await startServer(fakeSurface());
    await open();
    await rpc(toolCall("wait_browser_condition", { condition: "text", text: "租户管理" }));
    await rpc(toolCall("wait_browser_condition", { condition: "visible", selector: "#status", text: "已就绪" }));
    // `value` needs both an element and a value to compare: the element is named
    // by the locator fields, so `text` is the value.
    await rpc(
      toolCall("wait_browser_condition", { condition: "value", selector: "#code", text: "123456" }),
    );
    const waits = calls.filter((call) => call.method === "wait").map((call) => call.args[1]);
    expect(waits[0]).toMatchObject({ condition: "text", text: "租户管理" });
    expect(waits[1]).toMatchObject({ condition: "visible", target: { text: "已就绪" } });
    expect(waits[2]).toMatchObject({ condition: "value", target: { selector: "#code" }, text: "123456" });
  });

  it("refuses a wait whose text shorthand argues with the full field", async () => {
    await startServer(fakeSurface());
    await open();
    const asValue = await rpc(toolCall("wait_browser_condition", { condition: "text", text: "a", expect: "b" }));
    expect(asValue.json.result.isError).toBe(true);
    expect(asValue.json.result.content[0].text).toContain("text 与 expect 只能给一个");
    const asLocator = await rpc(
      toolCall("wait_browser_condition", { condition: "visible", elementText: "a", text: "b" }),
    );
    expect(asLocator.json.result.isError).toBe(true);
    expect(asLocator.json.result.content[0].text).toContain("text 与 elementText 只能给一个");
    expect(calls.filter((call) => call.method === "wait")).toHaveLength(0);
  });

  it("names the locator field wait_browser_condition actually takes when none is given", async () => {
    // The refusal used to list `text`, which this tool does not declare: the
    // client followed it into a second refusal, for an unknown argument.
    await startServer(fakeSurface());
    await open();
    const { json } = await rpc(toolCall("wait_browser_condition", { condition: "visible" }));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("elementText");
    expect(json.result.content[0].text).not.toContain("label、text 或");
  });

  it("crops a screenshot to an element named by label or by the text shorthand", async () => {
    await startServer(fakeSurface());
    await open();
    await rpc(toolCall("screenshot_browser_tab", { label: "账号" }));
    await rpc(toolCall("screenshot_browser_tab", { text: "登录" }));
    const targets = calls
      .filter((call) => call.method === "screenshot")
      .map((call) => (call.args[1] as { target?: unknown }).target);
    expect(targets).toEqual([{ label: "账号" }, { text: "登录" }]);
  });

  it("says an external window is not running instead of reporting it closed", async () => {
    // `stopped: true` for an unknown id hid the likely mistake: passing an
    // embedded tab's instanceId, which this tool never closes.
    await startServer();
    const { json } = await rpc(toolCall("stop_external_browser", { instanceId: "tab-1" }));
    expect(json.result.isError).toBeUndefined();
    expect(toolPayload(json)).toEqual({
      ok: false,
      instanceId: "tab-1",
      reason: "not-running",
      note: expect.stringContaining("close_browser_tab"),
    });
    expect(toolPayload((await rpc(toolCall("stop_all_external_browsers", {}))).json)).toEqual({
      ok: true,
      stopped: 0,
    });
  });

  it("explains a failed credential fill in words, keeping the reason code", async () => {
    const failing: EmbeddedSurface = {
      ...fakeSurface(),
      fillLogin: async () => ({ ok: false, reason: "no-identity" }),
    };
    await startServer(failing);
    // 干净身份是 AI 自己的页面，输入门放行；没开页就填会被门先拦下。
    await open();
    const payload = toolPayload((await rpc(toolCall("fill_browser_login", { tabId: "tab-1" }))).json);
    expect(payload).toMatchObject({ ok: false, reason: "no-identity" });
    expect((payload as { note: string }).note).toContain("open_browser_tab");
  });
});

/*
 * 工具面在调用方的位置上是什么样。
 *
 * `tool-surface.test.ts` 守源码层面的命名约定；这里守同一个约定落到线上之后的
 * 行为：写错的名字有指路、旧名字照常可用、入参别名与规范名等价、返回形状一致。
 */
describe("the tool surface at the wire", () => {
  const open = async () => {
    await rpc(toolCall("open_browser_tab", { url: "https://example.test/" }));
  };
  const callOf = (method: string) => calls.find((call) => call.method === method);
  const siteWithIdentity = async () => {
    const site = await service.saveSite({
      name: "本地开发环境",
      baseUrl: "http://127.0.0.1:9527",
      loginPath: "/login",
    });
    const identity = await service.saveIdentity({
      siteId: site.id,
      name: "管理员",
      username: "admin",
      role: "admin",
      color: "amber",
      passwordMode: "custom",
    });
    return { site, identity };
  };

  it("points a misspelled tool name at the closest real one", async () => {
    await startServer(fakeSurface());
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "close_tab", arguments: { tabId: "tab-1" } },
    });
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain("close_browser_tab");
    expect(json.error.message).toContain("你是不是想调用");
    // 完全对不上的名字不给建议：硬凑一个比没有更糟。
    const stray = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "frobnicate", arguments: {} },
    });
    expect(stray.json.error.message).not.toContain("你是不是想调用");
  });

  it("points a misspelled argument at the field the tool takes", async () => {
    await startServer(fakeSurface());
    await open();
    const { json } = await rpc(
      toolCall("read_browser_attribute", { tabId: "tab-1", selector: "#a", name: "href" }),
    );
    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toContain("你是不是想传 names");
    expect(callOf("attributes")).toBeUndefined();
  });

  it("treats an argument alias exactly like the canonical name, and refuses both at once", async () => {
    const { site } = await siteWithIdentity();
    await startServer(fakeSurface());
    await server.update({ allowDelete: true });
    // `id` 是旧名字；规范名字把对象写在了参数名里。
    const renamed = await rpc(toolCall("update_site", { id: site.id, name: "改过的站点" }));
    expect(toolPayload(renamed.json)).toMatchObject({ id: site.id, name: "改过的站点" });
    const canonical = await rpc(
      toolCall("update_site", { siteId: site.id, name: "规范名字的站点" }),
    );
    expect(toolPayload(canonical.json)).toMatchObject({ name: "规范名字的站点" });

    // 两个都给且都有值：各说各的才是歧义，在入口拒绝。
    const both = await rpc(
      toolCall("update_site", { siteId: site.id, id: site.id, name: "x" }),
    );
    expect(both.json.error?.message).toContain("id 是 siteId 的别名");
    const deleted = await rpc(toolCall("delete_site", { id: site.id, confirm: true }));
    expect(toolPayload(deleted.json)).toEqual({ ok: true, deleted: site.id });
  });

  it("calls a page tabId on the tool that used to call it pageId", async () => {
    await startServer(fakeSurface());
    await open();
    await rpc(toolCall("activate_browser_tab", { tabId: "tab-1" }));
    await rpc(toolCall("activate_browser_tab", { pageId: "tab-1" }));
    expect(calls.filter((call) => call.method === "activate").map((call) => call.args[0])).toEqual([
      "tab-1",
      "tab-1",
    ]);
  });

  it("answers an old tool name called with its old argument name", async () => {
    // 改动前写法的调用是整句照抄的：旧名字配旧参数。兼容别名只带规范工具的
    // schema 时不认识 pageId，这句调用就被它自己的兼容路径拒掉了。
    await startServer(fakeSurface());
    await open();
    const viaPageId = await rpc(toolCall("set_tab_page", { pageId: "tab-1" }));
    expect(viaPageId.json.result?.isError, JSON.stringify(viaPageId.json)).toBeUndefined();
    // 旧参数与规范参数同给且都有值：与规范工具一样拒绝，不替调用方挑一个。
    const both = await rpc(toolCall("set_tab_page", { pageId: "tab-1", tabId: "tab-2" }));
    expect(both.json.error?.message).toContain("别名");
    expect(calls.filter((call) => call.method === "activate").map((call) => call.args[0])).toEqual([
      "tab-1",
    ]);
  });

  it("answers a legacy tool name with the canonical tool's result", async () => {
    await startServer(fakeSurface());
    await open();
    const pairs: Array<[legacy: string, canonical: string, args: Record<string, unknown>]> = [
      ["wait_browser", "wait_browser_condition", { condition: "network-idle" }],
      [
        "check_element_visible",
        "check_browser_element_visible",
        { tabId: "tab-1", selector: "#login" },
      ],
      ["set_tab_page", "activate_browser_tab", { tabId: "tab-1" }],
      ["stop_all", "stop_all_external_browsers", {}],
      ["list_sites", "list_sites", {}],
    ];
    for (const [legacy, canonical, args] of pairs) {
      if (legacy === canonical) continue;
      const viaLegacy = toolPayload((await rpc(toolCall(legacy, args))).json);
      const viaCanonical = toolPayload((await rpc(toolCall(canonical, args))).json);
      expect(viaLegacy, `${legacy} 与 ${canonical} 的返回应当一致`).toEqual(viaCanonical);
    }
  });

  it("never hands back a bare array from a list tool", async () => {
    // 列表形状只有一种：以集合名包装的对象。裸数组没法在不破坏调用方的
    // 前提下加字段，而同一族里有的包、有的不包，调用方只能逐个记。
    await startServer(fakeSurface());
    for (const name of [
      "list_sites",
      "list_identities",
      "list_views",
      "list_flows",
      "list_bookmarks",
      "list_layouts",
      "list_browser_init_scripts",
      "list_browser_engines",
    ]) {
      const payload = toolPayload((await rpc(toolCall(name, name === "list_browser_init_scripts" ? { tabId: "tab-1" } : {}))).json);
      expect(Array.isArray(payload), name).toBe(false);
      expect(Object.values(payload as Record<string, unknown>).some(Array.isArray), name).toBe(true);
    }
  });

  it("answers an action with ok and the facts, whichever tool it was", async () => {
    const { site, identity } = await siteWithIdentity();
    await startServer(fakeSurface());
    await server.update({ allowDelete: true });
    await open();
    expect(toolPayload((await rpc(toolCall("go_back_browser_tab", { tabId: "tab-1" }))).json)).toEqual({
      ok: true,
    });
    expect(
      toolPayload(
        (await rpc(
          toolCall("link_identities_to_site", { siteId: site.id, identityIds: [identity.id] }),
        )).json,
      ),
    ).toEqual({ ok: true, siteId: site.id, linked: 0, requested: 1 });
    expect(
      toolPayload((await rpc(toolCall("delete_identity", { identityId: identity.id, confirm: true }))).json),
    ).toEqual({ ok: true, deleted: identity.id });
  });

  it("refuses to answer a JavaScript dialog without being told which way", async () => {
    // 省略「确定」是最危险的方向：对一个 confirm 少写一个参数就等于点了确定。
    await startServer(fakeSurface());
    await open();
    const omitted = await rpc(toolCall("handle_browser_dialog", { tabId: "tab-1" }));
    expect(omitted.json.error?.message).toContain("缺少必填参数：accept");
    const untyped = await rpc(toolCall("handle_browser_dialog", { tabId: "tab-1", accept: "false" }));
    expect(untyped.json.result.isError).toBe(true);
    expect(untyped.json.result.content[0].text).toContain("accept 必须是布尔值");
    expect(callOf("handleDialog")).toBeUndefined();
    await rpc(toolCall("handle_browser_dialog", { tabId: "tab-1", accept: false }));
    expect(callOf("handleDialog")?.args[1]).toEqual({ accept: false });
  });

  it("pops a page out and docks it as two actions, not as one toggle", async () => {
    // 开关的问题是脚本里的第二次调用会撤销第一次：调用方以为在重试，
    // 实际把窗口收了回去。
    const popped: string[] = [];
    const docked: string[] = [];
    await startServer({
      ...fakeSurface(),
      popOutTab: async (tabId) => {
        popped.push(tabId);
        return { windowId: 7 };
      },
      dockTab: async (tabId) => {
        docked.push(tabId);
        return { docked: true };
      },
    });
    await open();
    await rpc(toolCall("pop_out_browser_tab", { tabId: "tab-1" }));
    await rpc(toolCall("pop_out_browser_tab", { tabId: "tab-1" }));
    expect(popped).toEqual(["tab-1", "tab-1"]);
    expect(docked).toEqual([]);
    const back = await rpc(toolCall("dock_browser_tab", { tabId: "tab-1" }));
    expect(toolPayload(back.json)).toEqual({ docked: true });
    expect(docked).toEqual(["tab-1"]);
  });

  it("tells a layout call with no view and no page of its own to name one", async () => {
    // 没有台上的视图、调用方也没开过页面：这里没有东西可以编排。
    await startServer({ ...fakeSurface(), layoutTargetView: () => undefined, defaultViewId: () => undefined });
    const { json } = await rpc(toolCall("set_browser_layout", { layoutId: "2x1" }));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("请传 viewId");
    expect(callOf("setLayout")).toBeUndefined();
  });

  it("keeps screenshots in the read tier and page input behind the run permission", async () => {
    await startServer(fakeSurface());
    await open();
    // 读取档没有开关：观察类工具永远可用，这正是「只读」的含义。
    await server.update({ allowWrite: false, allowRun: false, allowDelete: false });
    const shot = await rpc(toolCall("screenshot_browser_tab", { tabId: "tab-1" }));
    expect(shot.json.result.isError).toBeUndefined();
    const reloaded = await rpc(toolCall("reload_browser_tab", { tabId: "tab-1" }));
    expect(reloaded.json.result.isError).toBe(true);
    expect(reloaded.json.result.content[0].text).toContain("运行权限");
  });

  it("shows the embedded browser in the workspace summary", async () => {
    await startServer(fakeSurface(["person-page"]));
    await open();
    const summary = toolPayload((await rpc(toolCall("get_workspace_summary", {}))).json) as {
      browser: { available: boolean; tabs: Array<{ id: string; active: boolean; url: string }> };
    };
    expect(summary.browser.available).toBe(true);
    expect(summary.browser.tabs.map((tab) => [tab.id, tab.active])).toEqual([
      ["person-page", true],
      ["tab-1", false],
    ]);
    // 没有内置浏览器的宿主如实说没有：缺一个键会被读成「什么都没开」。
    await startServer();
    const bare = toolPayload((await rpc(toolCall("get_workspace_summary", {}))).json) as {
      browser: { available: boolean };
    };
    expect(bare.browser.available).toBe(false);
  });

  it("edits a identity's extra login fields, and clears them with an empty list", async () => {
    const { identity } = await siteWithIdentity();
    await startServer(fakeSurface());
    const set = await rpc(
      toolCall("update_identity", {
        identityId: identity.id,
        extraFields: [{ label: "租户名", value: "acme" }],
      }),
    );
    expect(toolPayload(set.json)).toMatchObject({
      extraFields: [{ label: "租户名", value: "acme" }],
    });
    // 省略表示不动。
    const kept = await rpc(toolCall("update_identity", { identityId: identity.id, note: "只改备注" }));
    expect(toolPayload(kept.json)).toMatchObject({
      extraFields: [{ label: "租户名", value: "acme" }],
      note: "只改备注",
    });
    const cleared = await rpc(
      toolCall("update_identity", { identityId: identity.id, extraFields: [] }),
    );
    expect(toolPayload(cleared.json)).toMatchObject({ extraFields: [] });
  });

  it("routes the old set_view_layout to update_view", async () => {
    const { site, identity } = await siteWithIdentity();
    await startServer(fakeSurface());
    const created = toolPayload(
      (await rpc(
        toolCall("create_view", {
          siteId: site.id,
          name: "示例视图",
          identityIds: [identity.id],
          layoutId: "2x2",
        }),
      )).json,
    ) as { id: string };
    const viaLegacy = toolPayload(
      (await rpc(
        toolCall("set_view_layout", { viewId: created.id, layoutId: "2x1" }),
      )).json,
    ) as { id: string; layoutId: string };
    expect(viaLegacy).toMatchObject({ id: created.id, layoutId: "2x1" });
  });

  it("lists the browsers a window can be launched into", async () => {
    await startServer(fakeSurface());
    const payload = toolPayload((await rpc(toolCall("list_browser_engines", {}))).json) as {
      engines: Array<{ id: string; brand: string; status: string }>;
    };
    expect(Array.isArray(payload.engines)).toBe(true);
    for (const engine of payload.engines) {
      expect(typeof engine.id).toBe("string");
      expect(["ready", "unverified", "blocked"]).toContain(engine.status);
    }
  });

  it("closes a view, and by default only the pages the AI side opened", async () => {
    const closed: unknown[][] = [];
    const base = fakeSurface();
    await startServer({
      ...base,
      // 第二个容器是由保存的视图「saved-view」打开的：用定义 id 也该找得到它。
      state: () => ({
        ...base.state(),
        views: [
          { id: "view-1", name: "视图", layoutId: "2x2" },
          { id: "container-2", name: "示例视图", layoutId: "2x2", viewDefinitionId: "saved-view" },
        ],
      }),
      closeView: (viewId, mode) => {
        closed.push([viewId, mode]);
        return { tabs: [] };
      },
    });
    const byContainer = await rpc(toolCall("close_browser_view", { viewId: "view-1" }));
    expect(byContainer.json.result.isError).toBeUndefined();
    expect(toolPayload(byContainer.json)).toMatchObject({ tabs: [] });
    await rpc(toolCall("close_browser_view", { viewId: "saved-view", mode: "all" }));
    expect(closed).toEqual([
      ["view-1", "ai"],
      ["saved-view", "all"],
    ]);
  });

  it("refuses to close a view that is not open, instead of reporting it closed", async () => {
    let touched = 0;
    await startServer({
      ...fakeSurface(),
      closeView: () => {
        touched += 1;
        return {};
      },
    });
    const { json } = await rpc(toolCall("close_browser_view", { viewId: "no-such-view" }));
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("视图不存在");
    expect(touched).toBe(0);
  });

  it("tells the caller what the sign-in step is doing on the page it just opened", async () => {
    // 页面在返回之后还可能被登录流程带走；不说的话，调用方下一步读到的
    // 就是一个自己没要求打开的页面。
    const { identity } = await siteWithIdentity();
    for (const [state, expected] of [
      ["signed-in", "可以直接操作"],
      ["signing-in", "wait_browser_condition"],
      ["login-form", "click_browser_element"],
      ["unknown", "判断不了登录状态"],
    ] as const) {
      await startServer({
        ...fakeSurface(),
        createTab: async (input) => ({
          id: "tab-1",
          label: "页面",
          url: input.url ?? "about:blank",
          title: "",
          ...(input.identityId ? { identityId: input.identityId } : {}),
          login: state,
        }),
      });
      const payload = toolPayload(
        (await rpc(
          toolCall("open_browser_tab", {
            url: "https://example.test/",
            identityId: identity.id,
          }),
        )).json,
      ) as { tabId: string; login: { state: string; note: string } };
      expect(payload.tabId, state).toBe("tab-1");
      expect(payload.login.state, state).toBe(state);
      expect(payload.login.note, state).toContain(expected);
    }
    // 不带账号打开的页面没有登录这一步：不编一个状态出来。
    await startServer({
      ...fakeSurface(),
      createTab: async () => ({ id: "tab-1", label: "页面", url: "about:blank", title: "" }),
    });
    const bare = toolPayload((await rpc(toolCall("open_browser_tab", { url: "about:blank" }))).json);
    expect(bare).not.toHaveProperty("login");
  });

  it("shows the open views in the workspace summary", async () => {
    await startServer(fakeSurface(["person-page"]));
    const summary = toolPayload((await rpc(toolCall("get_workspace_summary", {}))).json) as {
      browser: { views: Array<{ id: string }> };
    };
    expect(summary.browser.views.map((view) => view.id)).toEqual(["view-1"]);
  });
});
