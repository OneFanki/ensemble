import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { aiNavigationAllowed, aiOriginOf, aiWriteDenial } from "@shared/ai-policy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmbeddedSurface } from "../src/main/mcp/server";
import { McpServer, loadMcpSettings, saveMcpSettings } from "../src/main/mcp/server";

const TOKEN = "ai-policy-token-1234567890";

let dir: string;
let service: WorkspaceService;
let server: McpServer;
let port: number;

async function rpc(name: string, args: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = (await response.json()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  return {
    isError: Boolean(json.result?.isError),
    text: String(json.result?.content?.[0]?.text ?? ""),
  };
}

/**
 * A surface whose single tab can be told which world it belongs to.
 *
 * Everything the origin gate looks at lives here: identity, clean marker, url.
 * The input methods record whether they were reached, which is how the tests
 * prove a refusal happened *before* the click rather than after it.
 */
function surfaceFor(tab: { identityId?: string; clean?: boolean; url: string }) {
  const touched: string[] = [];
  const surface: EmbeddedSurface = {
    state: () => ({
      tabs: [{ id: "tab-1", label: "页面", title: "", ...tab }],
      activeTabId: "tab-1",
    }),
    aiPageContext: () => {
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
    createTab: async () => ({ id: "tab-1" }),
    navigate: async (_id, url) => {
      touched.push(`navigate:${url}`);
      tab.url = url;
      return { ok: true };
    },
    closeTab: () => ({}),
    activate: () => ({}),
    snapshotDom: async () => ({ nodes: [] }),
    click: async () => {
      touched.push("click");
      return { ok: true };
    },
    type: async () => {
      touched.push("type");
      return { ok: true };
    },
    fillForm: async () => {
      touched.push("fillForm");
      return { ok: true };
    },
    runFlow: async () => {
      touched.push("runFlow");
      return { ok: true, steps: [] };
    },
    evaluate: async () => {
      touched.push("evaluate");
      return { value: 1 };
    },
    screenshot: async () => ({ path: "x.png", bytes: 1 }),
    visibility: async () => ({ exists: true, visible: true }),
    wait: async () => ({ ok: true, waitedMs: 1 }),
    setViewport: (tabId: string, size: { width: number; height: number } | null) => size,
    setLayout: () => ({}),
    pinTab: () => ({}),
    moveTab: () => ({}),
    fillLogin: async () => {
      touched.push("fillLogin");
      return { ok: true };
    },
    defaultTabId: () => "tab-1",
    defaultViewId: () => "view-1",
    layoutTargetView: () => "view-1",
    openView: async () => ({}),
  };
  return { surface, touched };
}

async function startServer(embedded: EmbeddedSurface): Promise<void> {
  const settingsPath = join(dir, "mcp.json");
  saveMcpSettings(settingsPath, {
    ...loadMcpSettings(settingsPath),
    enabled: true,
    port: 0,
    token: TOKEN,
  });
  server = new McpServer({
    settingsPath,
    auditPath: join(dir, "mcp-audit.log"),
    service,
    appVersion: "test",
    embedded,
  });
  await server.update({ allowRun: true });
  await server.start();
  port = server.status().port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-ai-policy-"));
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
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("origin policy", () => {
  it("reads the origin of a page and refuses non-web schemes", () => {
    expect(aiOriginOf("https://admin.example.com/a?b=1")).toBe("https://admin.example.com");
    expect(aiOriginOf("http://127.0.0.1:3000/login")).toBe("http://127.0.0.1:3000");
    expect(aiOriginOf("about:blank")).toBe("");
    expect(aiOriginOf("file:///C:/x")).toBe("");
    expect(aiOriginOf("not a url")).toBe("");
  });

  /*
   * The three cases are the whole design. If any of them changes, either the
   * user's own browsing becomes driveable by an AI, or the product's main use —
   * driving a test account — stops working.
   */
  it("allows an identity page", () => {
    expect(
      aiWriteDenial(
        { identityId: "id-1", origin: "https://admin.example.com" },
        { authorizedOrigins: [], knownUrls: [] },
      ),
    ).toBeUndefined();
  });

  it("allows a clean session", () => {
    expect(
      aiWriteDenial(
        { clean: true, origin: "https://admin.example.com" },
        { authorizedOrigins: [], knownUrls: [] },
      ),
    ).toBeUndefined();
  });

  it("denies a daily page until its origin is authorized", () => {
    const page = { origin: "https://bank.example.com" };
    expect(aiWriteDenial(page, { authorizedOrigins: [], knownUrls: [] })).toBe(
      "daily-origin-unauthorized",
    );
    expect(
      aiWriteDenial(page, { authorizedOrigins: ["https://bank.example.com"], knownUrls: [] }),
    ).toBeUndefined();
  });

  it("denies a page with no web origin", () => {
    expect(
      aiWriteDenial({ origin: "" }, { authorizedOrigins: [], knownUrls: [] }),
    ).toBe("unknown-origin");
  });

  it("does not treat a lookalike origin as authorized", () => {
    // Exact string comparison, not a prefix: a subdomain or a port change is a
    // different origin and must be granted on its own.
    expect(
      aiWriteDenial(
        { origin: "https://evil.bank.example.com" },
        { authorizedOrigins: ["https://bank.example.com"], knownUrls: [] },
      ),
    ).toBe("daily-origin-unauthorized");
    expect(
      aiWriteDenial(
        { origin: "https://bank.example.com:8443" },
        { authorizedOrigins: ["https://bank.example.com"], knownUrls: [] },
      ),
    ).toBe("daily-origin-unauthorized");
  });
});

describe("navigation policy", () => {
  const policy = {
    authorizedOrigins: [],
    knownUrls: ["http://127.0.0.1:3000", "https://docs.example.com/guide"],
  };

  it("allows the first navigation from a blank tab", () => {
    expect(
      aiNavigationAllowed({ currentUrl: "", targetUrl: "https://any.example.com", policy }),
    ).toBe(true);
  });

  it("allows same-origin links, which is how the AI follows a page", () => {
    expect(
      aiNavigationAllowed({
        currentUrl: "https://admin.example.com",
        targetUrl: "https://admin.example.com/orders/7",
        policy,
      }),
    ).toBe(true);
  });

  it("allows an address the workspace already knows", () => {
    expect(
      aiNavigationAllowed({
        currentUrl: "https://admin.example.com",
        targetUrl: "http://127.0.0.1:3000/login",
        policy,
      }),
    ).toBe(true);
  });

  it("refuses a cross-origin target nobody named", () => {
    expect(
      aiNavigationAllowed({
        currentUrl: "https://admin.example.com",
        targetUrl: "https://attacker.example.net/pay",
        policy,
      }),
    ).toBe(false);
  });

  it("refuses a target that is not a web address at all", () => {
    expect(
      aiNavigationAllowed({ currentUrl: "", targetUrl: "file:///C:/Windows/win.ini", policy }),
    ).toBe(false);
  });
});

describe("gate at the tool boundary", () => {
  it("lets an AI drive its own clean tab", async () => {
    const { surface, touched } = surfaceFor({
      clean: true,
      url: "https://admin.example.com/console",
    });
    await startServer(surface);
    const result = await rpc("click_browser_element", { text: "创建租户" });
    expect(result.isError).toBe(false);
    expect(touched).toContain("click");
  });

  it("lets an AI drive an identity page", async () => {
    const { surface, touched } = surfaceFor({
      identityId: "id-1",
      url: "https://admin.example.com/console",
    });
    await startServer(surface);
    const result = await rpc("type_browser_text", { label: "用户名", text: "abc" });
    expect(result.isError).toBe(false);
    expect(touched).toContain("type");
  });

  /*
   * Each of these is an input path, and all of them have to be closed at once:
   * leaving one open means a page that cannot be clicked can still be filled,
   * or run through a flow, or driven by raw script.
   */
  it("refuses every input path on a daily page", async () => {
    const { surface, touched } = surfaceFor({ url: "https://bank.example.com/transfer" });
    await startServer(surface);

    const calls: Array<[string, Record<string, unknown>]> = [
      ["click_browser_element", { text: "确认转账" }],
      ["type_browser_text", { label: "金额", text: "1000" }],
      ["fill_browser_form", { fields: [{ label: "金额", value: "1000" }] }],
      ["fill_browser_login", {}],
      ["evaluate_browser_page", { expression: "document.forms[0].submit()" }],
    ];
    for (const [name, args] of calls) {
      const result = await rpc(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toContain("只读");
    }
    // Nothing reached the page: the refusal is a decision, not a failed attempt.
    expect(touched).toEqual([]);
  });

  it("refuses a flow aimed at a daily page", async () => {
    const site = service.saveSite({
      name: "站",
      baseUrl: "https://bank.example.com",
      loginPath: "/login",
      autoSubmit: false,
    });
    const flow = service.saveFlow({
      siteId: site.id,
      name: "转账",
      steps: [{ action: "click", text: "确认" }],
    });
    const { surface, touched } = surfaceFor({ url: "https://bank.example.com/transfer" });
    await startServer(surface);
    const result = await rpc("run_flow", { id: flow.id, tabId: "tab-1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("只读");
    expect(touched).toEqual([]);
  });

  it("stays read-only for reads and screenshots", async () => {
    const { surface } = surfaceFor({ url: "https://bank.example.com/transfer" });
    await startServer(surface);
    // Read access in the daily profile is the point of the feature: it is how an
    // AI can still look at a page without being able to act on it.
    for (const name of ["read_browser_page", "check_element_visible", "screenshot_browser_tab"]) {
      const result = await rpc(
        name,
        name === "check_element_visible" ? { text: "余额" } : {},
      );
      expect(result.isError, name).toBe(false);
    }
  });

  it("grants input once the origin is authorized, and revokes it again", async () => {
    const { surface, touched } = surfaceFor({ url: "https://ops.example.com/panel" });
    await startServer(surface);

    const before = await rpc("click_browser_element", { text: "投放" });
    expect(before.isError).toBe(true);

    await server.update({ aiOrigin: { origin: "https://ops.example.com", allowed: true } });
    const allowed = await rpc("click_browser_element", { text: "投放" });
    expect(allowed.isError).toBe(false);
    expect(touched).toEqual(["click"]);

    await server.update({ aiOrigin: { origin: "https://ops.example.com", allowed: false } });
    const after = await rpc("click_browser_element", { text: "投放" });
    expect(after.isError).toBe(true);
    expect(touched).toEqual(["click"]);
  });

  it("cannot be sidestepped by an AI creating its own identity-less tab", async () => {
    // The bridge turns this into a clean session; the gate then allows input.
    // What must never happen is an identity-less AI tab landing in the daily
    // profile, which would hand the AI a signed-in page it may drive.
    const { surface } = surfaceFor({ url: "" });
    await startServer(surface);
    const opened = await rpc("open_browser_tab", { url: "https://bank.example.com" });
    expect(opened.isError).toBe(false);
  });

  it("rejects a malformed origin instead of storing one that never matches", async () => {
    const { surface } = surfaceFor({ url: "" });
    await startServer(surface);
    await expect(
      server.update({ aiOrigin: { origin: "bank.example.com", allowed: true } }),
    ).rejects.toThrow();
    await expect(
      server.update({ aiOrigin: { origin: "file:///C:/", allowed: true } }),
    ).rejects.toThrow();
  });

  it("refuses a cross-origin navigation the workspace never named", async () => {
    const { surface, touched } = surfaceFor({ url: "https://admin.example.com/console" });
    await startServer(surface);
    const result = await rpc("navigate_browser_tab", { url: "https://attacker.example.net/pay" });
    expect(result.isError).toBe(true);
    expect(touched).toEqual([]);
  });

  it("allows navigating to a bookmark the user saved", async () => {
    service.saveBookmark({ name: "后台", url: "https://ops.example.com/panel" });
    const { surface, touched } = surfaceFor({ url: "https://admin.example.com/console" });
    await startServer(surface);
    const result = await rpc("navigate_browser_tab", { url: "https://ops.example.com/panel" });
    expect(result.isError).toBe(false);
    expect(touched).toEqual(["navigate:https://ops.example.com/panel"]);
  });
});
