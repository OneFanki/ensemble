import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { embeddedSlotCount } from "@shared/embedded";
import type { RunningInstance, SettingsPatch } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EmbeddedSurface,
  loadMcpSettings,
  McpServer,
  redactMcpArgs,
} from "../src/main/mcp/server";

let dir: string;
let service: WorkspaceService;
let server: McpServer;
let port: number;

const TOKEN = "test-token-value-1234567890";

function makeServer(
  overrides: Partial<{ allowWrite: boolean; allowRun: boolean; allowDelete: boolean }> = {},
) {
  const settingsPath = join(dir, "mcp.json");
  const instance = new McpServer({
    settingsPath,
    auditPath: join(dir, "mcp-audit.log"),
    service,
    appVersion: "test",
  });
  return { instance, settingsPath, overrides };
}

async function rpc(
  body: unknown,
  options: { token?: string | null; host?: string; origin?: string } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.origin) headers.origin = options.origin;
  const response = await fetch(options.host ?? `http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

/** MCP tool results carry a JSON string in `content[0].text`. */
function toolPayload(json: any): unknown {
  return JSON.parse(json.result.content[0].text);
}

/** Rebuilds the server with injected collaborators; the token and port persist. */
async function restartServer(extra: {
  embedded?: EmbeddedSurface;
  updateSettings?: (patch: SettingsPatch) => SettingsPatch | Promise<SettingsPatch>;
}): Promise<void> {
  await server.stop();
  server = new McpServer({
    settingsPath: join(dir, "mcp.json"),
    auditPath: join(dir, "mcp-audit.log"),
    service,
    appVersion: "test",
    ...extra,
  });
  await server.start();
  port = server.status().port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-mcp-"));
  service = new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
  });
  await service.initialize();

  const { instance, settingsPath } = makeServer();
  // Pin the token and an ephemeral-free but unused port.
  const existing = loadMcpSettings(settingsPath);
  const { saveMcpSettings } = await import("../src/main/mcp/server");
  saveMcpSettings(settingsPath, { ...existing, enabled: true, port: 0, token: TOKEN });
  // port 0 is invalid by design; assign a real free port below.
  const probe = 48_000 + Math.floor(Math.random() * 900);
  saveMcpSettings(settingsPath, { ...existing, enabled: true, port: probe, token: TOKEN });
  server = new McpServer({
    settingsPath,
    auditPath: join(dir, "mcp-audit.log"),
    service,
    appVersion: "test",
  });
  await server.start();
  port = server.status().port;
  expect(server.status().running).toBe(true);
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP handshake", () => {
  it("answers initialize with a protocol version and server info", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(status).toBe(200);
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.serverInfo.name).toBe("ensemble");
  });

  it("tells the client what the product is, in one short paragraph", async () => {
    // An MCP client hands the model the endpoint config and nothing else, so
    // `instructions` is the only place the product can introduce itself. Without
    // it the model sees a list of verbs and has to guess what they drive.
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const instructions: string = json.result.instructions ?? "";
    expect(instructions).toContain("Ensemble");
    // The workflow that names the core model, not just the product name.
    expect(instructions).toMatch(/site/i);
    expect(instructions).toMatch(/identit/i);
    expect(instructions).toMatch(/view/i);
    // The one rule a model would otherwise learn by being refused.
    expect(instructions).toMatch(/origin/i);
    // And a hard budget: this text is prepended to every session, so it has to
    // stay a summary rather than a manual. 2000 characters is already generous.
    expect(instructions.length).toBeLessThan(2000);
  });

describe("MCP authentication", () => {
  it("rejects requests without a token", async () => {
    const { status } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: null });
    expect(status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const { status } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { token: "nope" },
    );
    expect(status).toBe(401);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    // fetch() cannot forge Host, so this one goes through http.request directly.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: `evil.example:${port}`,
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
    expect(status).toBe(403);
  });

  it("rejects a non-loopback Origin", async () => {
    const { status } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { origin: "https://evil.example" },
    );
    expect(status).toBe(403);
  });
});

describe("MCP tools", () => {
  it("creates an site and identities, then reads them back", async () => {
    const env = await rpc(
      toolCall("create_site", {
        name: "订单服务-测试环境",
        baseUrl: "http://localhost:3000",
      }),
    );
    expect(env.json.result.isError).toBeUndefined();
    const site = JSON.parse(env.json.result.content[0].text);
    expect(site.id).toBeTruthy();

    const batch = await rpc(
      toolCall("create_identities", {
        siteId: site.id,
        identities: [
          { name: "管理员", username: "admin", password: "s3cret!", role: "admin" },
          { name: "审核员", username: "reviewer", password: "s3cret!", role: "reviewer" },
        ],
      }),
    );
    const created = JSON.parse(batch.json.result.content[0].text);
    expect(created.created).toHaveLength(2);
    expect(created.failures).toHaveLength(0);

    const listed = await rpc(toolCall("list_identities", { siteId: site.id }));
    const identities = JSON.parse(listed.json.result.content[0].text).identities;
    expect(identities).toHaveLength(2);
    expect(identities[0].hasPassword).toBe(true);
    // Passwords are write-only: no response may echo them.
    expect(JSON.stringify(identities)).not.toContain("s3cret!");
  });

  it("keeps a site password and per-account extra fields out of the read-back", async () => {
    const env = await rpc(
      toolCall("create_site", {
        name: "多租户后台",
        baseUrl: "http://localhost:4000",
        password: "site-default-secret",
      }),
    );
    const site = JSON.parse(env.json.result.content[0].text);
    // One call saves the site and its default password.
    expect(site.id).toBeTruthy();
    expect(site.defaultPasswordSet).toBe(true);
    expect(JSON.stringify(site)).not.toContain("site-default-secret");

    const batch = await rpc(
      toolCall("create_identities", {
        siteId: site.id,
        identities: [
          {
            name: "客户 A",
            username: "tenant-a@example.test",
            password: "tenant-a-secret",
            extraFields: [{ label: "租户名", value: "客户 A" }],
          },
        ],
      }),
    );
    const created = JSON.parse(batch.json.result.content[0].text);
    expect(created.failures).toHaveLength(0);
    // The batch schema must accept what per-identity creation accepts: without
    // it a tenant account silently inherits the site's tenant name.
    expect(created.created[0].extraFields).toEqual([{ label: "租户名", value: "客户 A" }]);
    expect(JSON.stringify(created)).not.toContain("tenant-a-secret");
  });

  it("tells a client whether a site holds the default password its accounts inherit", async () => {
    // The dead end this guards: an identity reports `passwordMode: "inherit"`,
    // every field on the site looks fine, and autofill still fails because the
    // site has no default stored. Without a site-level flag there is nothing to
    // look at, and a client can only guess.
    const created = await rpc(
      toolCall("create_site", { name: "继承站点", baseUrl: "http://localhost:5000" }),
    );
    const site = JSON.parse(created.json.result.content[0].text);
    expect(site.defaultPasswordSet).toBe(false);

    // 不传 password 的账号继承站点默认密码（创建工具不接受 passwordMode，
    // 它是返回值里的只读字段）。
    const heir = await rpc(
      toolCall("create_identity", {
        siteId: site.id,
        name: "继承账号",
        username: "heir",
      }),
    );
    expect(JSON.parse(heir.json.result.content[0].text).passwordMode).toBe("inherit");
    const before = JSON.parse(
      (await rpc(toolCall("list_sites"))).json.result.content[0].text,
    ).sites.find((item: { id: string }) => item.id === site.id);
    expect(before.defaultPasswordSet).toBe(false);

    // 旧写法 ownerKind + ownerId 仍然接受；规范写法在下一个用例里。
    await rpc(
      toolCall("set_password", {
        ownerKind: "site",
        ownerId: site.id,
        password: "later-default",
      }),
    );
    const after = JSON.parse(
      (await rpc(toolCall("list_sites"))).json.result.content[0].text,
    ).sites.find((item: { id: string }) => item.id === site.id);
    expect(after.defaultPasswordSet).toBe(true);
    // Still write-only: the flag reports existence, never the value.
    expect(JSON.stringify(after)).not.toContain("later-default");
  });

  it("set_password 用 siteId / identityId 点名密码属于谁，两种写法互斥", async () => {
    const env = await rpc(
      toolCall("create_site", { name: "点名站点", baseUrl: "http://localhost:5100" }),
    );
    const site = JSON.parse(env.json.result.content[0].text);
    const identityRaw = await rpc(
      toolCall("create_identity", {
        siteId: site.id,
        name: "点名账号",
        username: "named",
      }),
    );
    expect(identityRaw.json.result?.isError, JSON.stringify(identityRaw.json)).toBeUndefined();
    const identity = JSON.parse(identityRaw.json.result.content[0].text);

    const forIdentity = await rpc(
      toolCall("set_password", { identityId: identity.id, password: "account-secret" }),
    );
    // 新建的账号默认继承站点密码，登录时读不到自己的密码：写入后切到「使用
    // 自己的密码」，否则这次写入永远不会被用到。
    expect(JSON.parse(forIdentity.json.result.content[0].text)).toMatchObject({
      ok: true,
      identityId: identity.id,
      passwordMode: "custom",
    });
    const stored = JSON.parse(
      (await rpc(toolCall("list_identities", { siteId: site.id }))).json.result.content[0].text,
    ).identities.find((item: { id: string }) => item.id === identity.id);
    expect(stored).toMatchObject({ passwordMode: "custom", hasPassword: true });
    const forSite = await rpc(
      toolCall("set_password", { siteId: site.id, password: "site-secret" }),
    );
    expect(JSON.parse(forSite.json.result.content[0].text)).toEqual({
      ok: true,
      siteId: site.id,
    });

    // 不点名、或两边都点名，都拒绝而不是猜一个。
    for (const args of [
      { password: "x" },
      { password: "x", siteId: site.id, identityId: identity.id },
      { password: "x", ownerId: site.id },
      { password: "x", ownerId: site.id, siteId: site.id },
    ]) {
      const refused = await rpc(toolCall("set_password", args));
      expect(refused.json.error?.code ?? refused.json.result?.isError, JSON.stringify(args)).toBeTruthy();
    }
  });

  it("advertises the same per-account fields in the batch tool as in the single one", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = json.result.tools as Array<{
      name: string;
      inputSchema: {
        properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
      };
    }>;
    const single = tools.find((tool) => tool.name === "create_identity");
    const batch = tools.find((tool) => tool.name === "create_identities");
    const batchItem = batch?.inputSchema.properties["identities"]?.items?.properties ?? {};
    // A client builds its payload from this schema. If the batch item omits a
    // field the single-call tool has, a batch of tenants silently loses it.
    for (const field of ["extraFields", "credentialFrom", "engineId"]) {
      expect(single?.inputSchema.properties[field]).toBeTruthy();
      expect(batchItem[field]).toBeTruthy();
    }
  });

  it("creates a view that references the created identities", async () => {
    const env = await rpc(
      toolCall("create_site", { name: "本地环境", baseUrl: "http://localhost:3000" }),
    );
    const site = JSON.parse(env.json.result.content[0].text);
    const batch = await rpc(
      toolCall("create_identities", {
        siteId: site.id,
        identities: [
          { name: "A", username: "a" },
          { name: "B", username: "b" },
        ],
      }),
    );
    const ids = JSON.parse(batch.json.result.content[0].text).created.map(
      (identity: { id: string }) => identity.id,
    );
    const view = await rpc(
      toolCall("create_view", {
        siteId: site.id,
        name: "双人对照",
        identityIds: ids,
        layoutId: "2x1",
      }),
    );
    const created = JSON.parse(view.json.result.content[0].text);
    expect(created.identityIds).toEqual(ids);
    expect(created.layoutId).toBe("2x1");
  });

  it("blocks writes when the write permission is disabled", async () => {
    await server.update({ allowWrite: false });
    const result = await rpc(
      toolCall("create_site", { name: "x", baseUrl: "http://localhost:3000" }),
    );
    expect(result.json.result.isError).toBe(true);
    expect(service.snapshot().sites).toHaveLength(0);
  });

  it("rewrites a bad step action into a step-numbered message", async () => {
    const env = await rpc(
      toolCall("create_site", { name: "流程校验环境", baseUrl: "http://localhost:3000" }),
    );
    const site = JSON.parse(env.json.result.content[0].text);

    const bad = await rpc(
      toolCall("save_flow", {
        siteId: site.id,
        name: "打错的动作",
        steps: [{ action: "clck", text: "创建租户" }],
      }),
    );
    expect(bad.json.result.isError).toBe(true);
    const message = bad.json.result.content[0].text;
    expect(message).toContain("第 1 步（action）只支持 navigate/fill");
    expect(message).toContain("收到 clck");
  });

  it("rewrites a bad wait condition with its step number too", async () => {
    const env = await rpc(
      toolCall("create_site", { name: "流程校验环境二", baseUrl: "http://localhost:3000" }),
    );
    const site = JSON.parse(env.json.result.content[0].text);

    const bad = await rpc(
      toolCall("save_flow", {
        siteId: site.id,
        name: "打错的条件",
        steps: [
          { action: "navigate", url: "/login" },
          { action: "wait", condition: "visable", label: "登录按钮" },
        ],
      }),
    );
    expect(bad.json.result.isError).toBe(true);
    const message = bad.json.result.content[0].text;
    expect(message).toContain("第 2 步（condition）只支持 visible/hidden");
    expect(message).toContain("收到 visable");
  });

  it("keeps delete disabled by default and requires an explicit confirm", async () => {
    const env = await rpc(
      toolCall("create_site", { name: "可删环境", baseUrl: "http://localhost:3000" }),
    );
    const site = JSON.parse(env.json.result.content[0].text);

    const blocked = await rpc(toolCall("delete_site", { id: site.id }));
    expect(blocked.json.result.isError).toBe(true);
    expect(service.snapshot().sites).toHaveLength(1);

    await server.update({ allowDelete: true });
    const noConfirm = await rpc(toolCall("delete_site", { id: site.id }));
    expect(noConfirm.json.result.isError).toBe(true);
    expect(service.snapshot().sites).toHaveLength(1);

    const confirmed = await rpc(toolCall("delete_site", { id: site.id, confirm: true }));
    expect(confirmed.json.result.isError).toBeUndefined();
    expect(service.snapshot().sites).toHaveLength(0);
  });

  it("logs tool calls but never the password", async () => {
    const env = await rpc(
      toolCall("create_site", { name: "审计环境", baseUrl: "http://localhost:3000" }),
    );
    const site = JSON.parse(env.json.result.content[0].text);
    await rpc(
      toolCall("create_identity", {
        siteId: site.id,
        name: "审计账号",
        username: "audit",
        password: "do-not-log-me",
      }),
    );
    const log = readFileSync(join(dir, "mcp-audit.log"), "utf8");
    expect(log).toContain("create_identity");
    expect(log).not.toContain("do-not-log-me");
    expect(log).toContain("[redacted]");
  });

  it("gates launches on the run permission instead of the site name", async () => {
    const env = await rpc(
      toolCall("create_site", {
        name: "会员服务-生产环境",
        baseUrl: "http://localhost:3000",
      }),
    );
    const site = JSON.parse(env.json.result.content[0].text);
    const identityResponse = await rpc(
      toolCall("create_identity", {
        siteId: site.id,
        name: "生产账号",
        username: "prod-user",
      }),
    );
    const identity = JSON.parse(identityResponse.json.result.content[0].text);

    // The name alone must not fork the launch path: no extra confirmation field
    // exists, because guessing risk from a name was both unreliable and advisory.
    const tools = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json.result.tools;
    const advertised = tools.find((item: { name: string }) => item.name === "launch_external_browser");
    expect(advertised.inputSchema.properties).not.toHaveProperty("confirmProduction");

    await server.update({ allowRun: false });
    const refused = await rpc(
      toolCall("launch_external_browser", { identityId: identity.id }),
    );
    expect(refused.json.result.isError).toBe(true);
    expect(refused.json.result.content[0].text).toMatch(/权限/);
    // A compatibility alias is gated like the tool it hands off to.
    const viaAlias = await rpc(toolCall("launch_identity", { identityId: identity.id }));
    expect(viaAlias.json.result.isError).toBe(true);
    expect(viaAlias.json.result.content[0].text).toMatch(/权限/);
  });
});

describe("launch：外部浏览器工具族与旧名字的兼容别名", () => {
  /**
   * 内置表面的最小替身：只记录 openView / createTab，其余成员给可编译的空实现。
   * createTab 沿用真实桥的关键约定：带 identityId 落账号分区，不带则是一次性
   * 干净身份（clean: true）。
   */
  function launchProbeSurface() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    let seq = 0;
    const surface: EmbeddedSurface = {
      state: () => ({ tabs: [], views: [] }),
      createTab: async (input) => {
        calls.push({ method: "createTab", args: [input] });
        seq += 1;
        return {
          id: `tab-${seq}`,
          label: input.label ?? "新标签页",
          url: input.url ?? "about:blank",
          title: "",
          ...(input.identityId ? { identityId: input.identityId } : {}),
          ...(input.identityId ? {} : { clean: true }),
        };
      },
      openView: async (viewId, options) => {
        calls.push({ method: "openView", args: [viewId, options] });
        return {
          tabs: [],
          views: [
            { id: `container-${viewId}`, name: "视图", layoutId: "2x2", viewDefinitionId: viewId },
          ],
        };
      },
      navigate: async () => ({}),
      back: () => undefined,
      forward: () => undefined,
      reload: () => undefined,
      closeTab: () => undefined,
      activate: () => undefined,
      snapshotDom: async () => ({}),
      click: async () => ({}),
      hover: async () => ({}),
      scroll: async () => ({}),
      pressKeys: async () => ({}),
      dialogStatus: () => ({ dialog: null }),
      handleDialog: async () => ({}),
      setFiles: async () => ({}),
      drag: async () => ({}),
      setChecked: async () => ({}),
      elementInfo: async () => ({}),
      findElements: async () => ({}),
      attributes: async () => ({}),
      type: async () => ({}),
      fillForm: async () => ({}),
      runFlow: async (_tabId, steps) => ({
        ok: true,
        steps: steps.map((step, index) => ({ index, action: step.action, ok: true })),
      }),
      evaluate: async () => ({}),
      screenshot: async () => ({ path: "", bytes: 0 }),
      visibility: async () => ({}),
      wait: async () => ({ ok: true, waitedMs: 0 }),
      setLayout: () => undefined,
      setViewport: () => undefined,
      pinTab: () => undefined,
      moveTab: () => undefined,
      fillLogin: async () => ({}),
      defaultTabId: () => "",
      defaultViewId: () => undefined,
      layoutTargetView: () => undefined,
      surfaceName: () => "embedded",
    };
    return { surface, calls };
  }

  /**
   * 把 service 的三个外部启动替换成记录桩：外部路径只断言「调了谁、传了什么」，
   * 不在测试进程里真的拉起系统浏览器。
   */
  function stubExternalLaunches() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const bag = service as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    // 引擎列表同样与机器上装了什么无关：工具入口会核对点名的 engineId，
    // 用例里写的 edge-stable 得在表里，否则在有 Edge 的机器上才过。
    (service as unknown as { engines: Array<{ id: string }> }).engines = [{ id: "edge-stable" }];
    bag.launchView = async (...args) => {
      calls.push({ method: "launchView", args });
      return { instance: { id: "inst-view", label: "视图实例" }, identities: [] };
    };
    bag.launchIdentity = async (...args) => {
      calls.push({ method: "launchIdentity", args });
      return { instance: { id: "inst-identity", label: "账号实例" } };
    };
    bag.launchCleanSession = async (...args) => {
      calls.push({ method: "launchCleanSession", args });
      return { instance: { id: "inst-clean", label: "干净身份" } };
    };
    return calls;
  }

  /**
   * 经 service 直接建站点、账号、视图，返回各 id；loginPath / startPath 用于
   * 断言内置起始地址。不走 HTTP：重启后的端点会复用同一路径，造数请求留在
   * 连接池里的旧连接会被 stop() 销毁，下一次请求就会撞上 ECONNRESET。
   */
  async function seedWorkspace() {
    const site = await service.saveSite({
      name: "启动站点",
      baseUrl: "http://localhost:3000",
      loginPath: "/login",
      autoSubmit: false,
    });
    const identity = await service.saveIdentity({
      siteId: site.id,
      name: "示例账号",
      username: "user-a",
      role: "member",
      color: "teal",
      passwordMode: "inherit",
      startPath: "/dashboard",
    });
    const view = await service.saveView({
      siteId: site.id,
      name: "示例视图",
      identityIds: [identity.id],
      layoutId: "2x2",
      slotAssignments: {},
      paths: {},
    });
    return { siteId: site.id, identityId: identity.id, viewId: view.id };
  }

  it("对外只广播 launch_external_browser，它的入参里没有 external 开关", async () => {
    const tools = (
      await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    ).json.result.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, { type: string }>; required?: string[] };
    }>;
    const names = tools.map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith("launch_"))).toEqual(["launch_external_browser"]);
    // 旧的三个名字不再出现在工具列表里：它们与 open_browser_* 重复的那一半
    // 正是让模型选错表面的原因。
    for (const legacy of ["launch_view", "launch_identity", "launch_clean_session"]) {
      expect(names).not.toContain(legacy);
    }
    const tool = tools.find((item) => item.name === "launch_external_browser");
    expect(tool, "launch_external_browser 未注册").toBeTruthy();
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "engineId",
      "identityId",
      "siteId",
      "viewId",
    ]);
  });

  it("旧名字的内置路径照旧：不传 external 时走内置表面，不触发外部浏览器启动", async () => {
    const ids = await seedWorkspace();
    const probe = launchProbeSurface();
    const externalCalls = stubExternalLaunches();
    await restartServer({ embedded: probe.surface });

    const viewPayload = toolPayload(
      (await rpc(toolCall("launch_view", { viewId: ids.viewId }))).json,
    ) as { views: Array<{ viewDefinitionId?: string }> };
    expect(viewPayload.views[0]?.viewDefinitionId).toBe(ids.viewId);

    const identityPayload = toolPayload(
      (await rpc(toolCall("launch_identity", { identityId: ids.identityId }))).json,
    ) as { identityId?: string; url?: string; clean?: boolean };
    expect(identityPayload.identityId).toBe(ids.identityId);
    // 起始地址按账号自己的 startPath 推导，与界面上点账号卡片落点一致。
    expect(identityPayload.url).toBe("http://localhost:3000/dashboard");
    expect(identityPayload.clean).toBeUndefined();

    const cleanPayload = toolPayload(
      (await rpc(toolCall("launch_clean_session", { siteId: ids.siteId }))).json,
    ) as { url?: string; clean?: boolean; identityId?: string };
    expect(cleanPayload.url).toBe("http://localhost:3000/login");
    expect(cleanPayload.clean).toBe(true);
    expect(cleanPayload.identityId).toBeUndefined();

    // 三个工具恰好各产生一次内置调用：一次 openView、两次 createTab。
    expect(probe.calls).toEqual([
      { method: "openView", args: [ids.viewId, { muted: true }] },
      {
        method: "createTab",
        args: [
          {
            url: "http://localhost:3000/dashboard",
            identityId: ids.identityId,
            siteId: ids.siteId,
            label: "示例账号",
            color: "teal",
            muted: true,
          },
        ],
      },
      {
        method: "createTab",
        args: [{ url: "http://localhost:3000/login", siteId: ids.siteId, muted: true }],
      },
    ]);
    expect(externalCalls).toEqual([]);
  });

  it("launch_external_browser 三种开法都返回同一种窗口列表，不碰内置表面", async () => {
    const ids = await seedWorkspace();
    const probe = launchProbeSurface();
    const externalCalls = stubExternalLaunches();
    // 视图的每个成员一个窗口：窗口 id 取自启动后的实时登记表，这里塞一条进去。
    const live = (service as unknown as { liveInstances: Map<string, RunningInstance> })
      .liveInstances;
    live.set("inst-view-member", {
      id: "inst-view-member",
      label: "示例账号",
      siteId: ids.siteId,
      identityId: ids.identityId,
      engineId: "chromium:test",
      pid: 0,
      profileDir: join(dir, "profiles/view-member"),
      mode: "cdp",
      startedAt: new Date().toISOString(),
    });
    (service as unknown as { launchView: (...args: unknown[]) => Promise<unknown> }).launchView =
      async (...args) => {
        externalCalls.push({ method: "launchView", args });
        return {
          instance: { id: "inst-view", label: "视图实例" },
          identities: [{ id: ids.identityId, name: "示例账号" }],
        };
      };
    await restartServer({ embedded: probe.surface });

    const view = toolPayload(
      (await rpc(toolCall("launch_external_browser", { viewId: ids.viewId }))).json,
    );
    expect(view).toEqual({
      instances: [
        {
          instanceId: "inst-view-member",
          identityId: ids.identityId,
          name: "示例账号",
          label: "示例账号",
        },
      ],
    });

    const identity = toolPayload(
      (await rpc(
        toolCall("launch_external_browser", {
          identityId: ids.identityId,
          engineId: "edge-stable",
        }),
      )).json,
    );
    expect(identity).toEqual({
      instances: [{ instanceId: "inst-identity", identityId: ids.identityId, name: "示例账号", label: "账号实例" }],
    });

    const clean = toolPayload(
      (await rpc(toolCall("launch_external_browser", { siteId: ids.siteId }))).json,
    );
    expect(clean).toEqual({ instances: [{ instanceId: "inst-clean", label: "干净身份" }] });

    expect(externalCalls.map((call) => call.method)).toEqual([
      "launchView",
      "launchIdentity",
      "launchCleanSession",
    ]);
    expect(externalCalls[0]?.args).toEqual([ids.viewId, undefined]);
    expect(externalCalls[1]?.args).toEqual([ids.identityId, undefined, "edge-stable"]);
    expect(externalCalls[2]?.args).toEqual([ids.siteId, undefined]);
    expect(probe.calls).toEqual([]);

    // identityId 与 viewId 各说一种开法，同给是歧义。
    const both = await rpc(
      toolCall("launch_external_browser", { identityId: ids.identityId, viewId: ids.viewId }),
    );
    expect(both.json.result.isError).toBe(true);
    expect(both.json.result.content[0].text).toContain("只能给一个");
    live.delete("inst-view-member");
  });

  it("launch_external_browser 拒绝互相矛盾的入参，不静默替换调用方点名的站点与引擎", async () => {
    const ids = await seedWorkspace();
    // 桩打在 service 实例上，端点持有的是同一个实例，不必重建服务。
    const externalCalls = stubExternalLaunches();

    // siteId 只属于「干净窗口」这一种开法。不拦的话它被静默丢掉：窗口照常
    // 开在账号或视图上，调用方却以为打开的是自己点名的站点登录页。
    for (const args of [
      { identityId: ids.identityId, siteId: ids.siteId },
      { viewId: ids.viewId, siteId: ids.siteId },
      { identityId: ids.identityId, viewId: ids.viewId, siteId: ids.siteId },
    ]) {
      const refused = await rpc(toolCall("launch_external_browser", args));
      expect(refused.json.result.isError, JSON.stringify(args)).toBe(true);
      expect(refused.json.result.content[0].text).toContain("只能给一个");
    }

    // 核心层对一个找不到的引擎 id 会退回默认引擎——对账号上存的偏好这是对的
    // （引擎被卸载后仍能开窗）。对调用方刚写下的参数不是：写错一个字母，窗口就
    // 开在它没有选的浏览器里，而返回里看不出任何异常。所以必须在入口拦下。
    const wrongEngine = await rpc(
      toolCall("launch_external_browser", {
        identityId: ids.identityId,
        engineId: "no-such-engine",
      }),
    );
    expect(wrongEngine.json.result.isError).toBe(true);
    expect(wrongEngine.json.result.content[0].text).toContain("no-such-engine");
    expect(wrongEngine.json.result.content[0].text).toContain("list_browser_engines");
    expect(externalCalls).toEqual([]);

    // 点名一个存在的引擎照常启动，engineId 原样传下去。
    const named = await rpc(
      toolCall("launch_external_browser", { identityId: ids.identityId, engineId: "edge-stable" }),
    );
    expect(named.json.result.isError).toBeUndefined();
    expect(externalCalls.map((call) => call.args)).toEqual([
      [ids.identityId, undefined, "edge-stable"],
    ]);
  });

  it("旧名字传 external: true 时转交给 launch_external_browser", async () => {
    const ids = await seedWorkspace();
    const probe = launchProbeSurface();
    const externalCalls = stubExternalLaunches();
    await restartServer({ embedded: probe.surface });

    const view = toolPayload(
      (await rpc(toolCall("launch_view", { viewId: ids.viewId, external: true }))).json,
    ) as { instances: unknown[] };
    expect(view.instances).toEqual([]);

    const identity = toolPayload(
      (await rpc(
        toolCall("launch_identity", {
          identityId: ids.identityId,
          external: true,
          engineId: "edge-stable",
        }),
      )).json,
    ) as { instances: Array<{ instanceId?: string }> };
    expect(identity.instances[0]?.instanceId).toBe("inst-identity");

    const clean = toolPayload(
      (await rpc(toolCall("launch_clean_session", { siteId: ids.siteId, external: true }))).json,
    ) as { instances: Array<{ instanceId?: string }> };
    expect(clean.instances[0]?.instanceId).toBe("inst-clean");

    expect(externalCalls.map((call) => call.method)).toEqual([
      "launchView",
      "launchIdentity",
      "launchCleanSession",
    ]);
    expect(externalCalls[1]?.args).toEqual([ids.identityId, undefined, "edge-stable"]);
    expect(probe.calls).toEqual([]);
  });

  /*
    回归：external 只认布尔值。它曾经对 "true"、1 这类值静默走内置路径，
    调用方以为开的是外部窗口。失败方向虽然安全，但结果是错的。
  */
  it("external 不是布尔值时报错，内置表面与外部浏览器都不动", async () => {
    const ids = await seedWorkspace();
    const probe = launchProbeSurface();
    const externalCalls = stubExternalLaunches();
    await restartServer({ embedded: probe.surface });

    const calls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["launch_view", { viewId: ids.viewId }],
      ["launch_identity", { identityId: ids.identityId }],
      ["launch_clean_session", {}],
    ];
    for (const bad of ["true", 1, "yes", null]) {
      for (const [name, args] of calls) {
        const json = (await rpc(toolCall(name, { ...args, external: bad }))).json;
        expect(json.result.isError, `${name} external=${String(bad)}`).toBe(true);
        expect(json.result.content[0].text).toContain("external 必须是布尔值");
      }
    }
    expect(probe.calls).toEqual([]);
    expect(externalCalls).toEqual([]);
  });

  /*
    回归：resolve_browser_target 只在「地址匹配到了站点，而指定的账号不属于它」
    时提醒。地址没匹配到任何站点时，指定的账号与地址之间没有矛盾可言——曾经
    这时也提醒「账号不属于任何已录入站点」，还建议改开干净身份，等于让调用方
    放弃自己明确指定的账号。
  */
  it("resolve_browser_target：地址没匹配到站点时沿用指定的账号，不报矛盾", async () => {
    const ids = await seedWorkspace();
    const otherSite = await service.saveSite({
      name: "另一环境",
      baseUrl: "http://localhost:4000",
      loginPath: "/login",
      autoSubmit: false,
    });
    const otherIdentity = await service.saveIdentity({
      siteId: otherSite.id,
      name: "另一账号",
      username: "user-b",
      role: "member",
      color: "slate",
      passwordMode: "inherit",
    });
    const resolve = async (args: Record<string, unknown>) =>
      toolPayload((await rpc(toolCall("resolve_browser_target", args))).json) as {
        matched: boolean;
        site?: { id: string };
        identities: Array<{ id: string }>;
        recommendedIdentityId?: string;
        nextStep: string;
        warning?: string;
      };

    // 地址不匹配任何站点 + 指定了存在的账号：沿用该账号，不提醒
    const unmatched = await resolve({
      url: "http://localhost:9999/path",
      identityId: otherIdentity.id,
    });
    expect(unmatched.matched).toBe(false);
    expect(unmatched.site).toBeUndefined();
    expect(unmatched.identities).toEqual([]);
    expect(unmatched.recommendedIdentityId).toBe(otherIdentity.id);
    expect(unmatched.nextStep).toContain(otherIdentity.id);
    expect(unmatched.warning).toBeUndefined();

    // 地址不匹配 + 没指定账号：才是干净身份的建议
    const bare = await resolve({ url: "http://localhost:9999/path" });
    expect(bare.recommendedIdentityId).toBeUndefined();
    expect(bare.nextStep).toContain("干净身份");

    // 地址匹配到站点 A，指定的账号却属于站点 B：这才是矛盾
    const mismatched = await resolve({
      url: "http://localhost:3000/dashboard",
      identityId: otherIdentity.id,
    });
    expect(mismatched.matched).toBe(true);
    expect(mismatched.site?.id).toBe(ids.siteId);
    expect(mismatched.warning).toContain("不属于站点 启动站点");
    expect(mismatched.recommendedIdentityId).toBe(ids.identityId);
    // 下一步把两条路都摆出来：换用该站点的账号，或者坚持用点名的那个。只指
    // 向前者，等于替调用方把它点名的账号换掉了——与上面那句「请确认」自相矛盾。
    expect(mismatched.nextStep).toContain(ids.identityId);
    expect(mismatched.nextStep).toContain(otherIdentity.id);

    // 账号确属匹配站点：回显，不提醒
    const own = await resolve({
      url: "http://localhost:3000/dashboard",
      identityId: ids.identityId,
    });
    expect(own.recommendedIdentityId).toBe(ids.identityId);
    expect(own.warning).toBeUndefined();
  });
});

describe("MCP 返回体瘦身", () => {
  /**
   * AI 的上下文是稀缺资源：一个 base64 图标几千 token，一段脚本可以返回一兆
   * 字节。这里守住四个出口形状：书签不带图标内容、流程步骤值截断、流程列表
   * 封顶，以及超长步骤列表的截断标注。
   */

  it("list_bookmarks 用 hasFavicon 报告图标存在，不回传图标内容", async () => {
    const site = await rpc(
      toolCall("create_site", { name: "书签环境", baseUrl: "http://localhost:3000" }),
    );
    const created = JSON.parse(site.json.result.content[0].text) as { id: string };
    const saved = await rpc(
      toolCall("save_bookmark", { name: "示例页", url: "http://localhost:3000/app" }),
    );
    const bookmark = JSON.parse(saved.json.result.content[0].text) as { id: string };
    service.setBookmarkFavicon(bookmark.id, "data:image/png;base64,AAAA" + "B".repeat(4000));

    const listed = await rpc(toolCall("list_bookmarks"));
    const text = listed.json.result.content[0].text;
    expect(text).not.toContain("data:image");
    const payload = JSON.parse(text) as { bookmarks: Array<Record<string, unknown>> };
    const found = payload.bookmarks.find((item) => item.id === bookmark.id);
    expect(found?.hasFavicon).toBe(true);
    // 存储层不受影响：favicon 仍在工作区里，渲染层照常显示。
    expect(service.snapshot().bookmarks.find((item) => item.id === bookmark.id)?.favicon).toBe(
      "data:image/png;base64,AAAA" + "B".repeat(4000),
    );
    expect(created.id).toBeTruthy();
  });

  it("save_bookmark 返回同形状投影（更新带图标的书签也不回传内容）", async () => {
    const saved = await rpc(
      toolCall("save_bookmark", { name: "示例页", url: "http://localhost:3000/app" }),
    );
    const bookmark = JSON.parse(saved.json.result.content[0].text) as { id: string };
    service.setBookmarkFavicon(bookmark.id, "data:image/png;base64,CCCC");

    const renamed = await rpc(
      toolCall("save_bookmark", { id: bookmark.id, name: "示例页·改", url: "http://localhost:3000/app" }),
    );
    const text = renamed.json.result.content[0].text;
    expect(text).not.toContain("data:image");
    const payload = JSON.parse(text) as { name: string; hasFavicon: boolean };
    expect(payload.name).toBe("示例页·改");
    expect(payload.hasFavicon).toBe(true);
  });

  it("list_flows 截断超长步骤值并标注省略长度", async () => {
    const site = await rpc(
      toolCall("create_site", { name: "流程环境", baseUrl: "http://localhost:3000" }),
    );
    const created = JSON.parse(site.json.result.content[0].text) as { id: string };
    await rpc(
      toolCall("save_flow", {
        siteId: created.id,
        name: "长值流程",
        steps: [{ action: "fill", label: "备注", value: "y".repeat(800) }],
      }),
    );
    const listed = await rpc(toolCall("list_flows"));
    const payload = JSON.parse(listed.json.result.content[0].text) as {
      flows: Array<{ steps: Array<{ value?: string }> }>;
      total: number;
      truncated?: boolean;
    };
    expect(payload.truncated).toBeUndefined();
    expect(payload.total).toBe(1);
    const step = payload.flows[0]?.steps[0];
    expect(step?.value).toContain("…（省略");
    expect((step?.value ?? "").length).toBeLessThan(300);
    // 保存的完整定义不受预览截断影响。
    expect(service.snapshot().flows[0]?.steps[0]?.value).toHaveLength(800);
  });

  it("list_flows 封顶 50 条流程，超出时报 total 与 truncated", async () => {
    const site = await rpc(
      toolCall("create_site", { name: "流程封顶环境", baseUrl: "http://localhost:3000" }),
    );
    const created = JSON.parse(site.json.result.content[0].text) as { id: string };
    for (let index = 0; index < 52; index += 1) {
      await rpc(
        toolCall("save_flow", {
          siteId: created.id,
          name: `流程 ${index}`,
          steps: [{ action: "navigate", url: "/" }],
        }),
      );
    }
    const listed = await rpc(toolCall("list_flows"));
    const payload = JSON.parse(listed.json.result.content[0].text) as {
      flows: unknown[];
      total: number;
      truncated?: boolean;
    };
    expect(payload.total).toBe(52);
    expect(payload.truncated).toBe(true);
    expect(payload.flows).toHaveLength(50);
  });

  it("save_flow 返回投影形状，超 60 步截断并标 stepsTruncated", async () => {
    const site = await rpc(
      toolCall("create_site", { name: "步骤封顶环境", baseUrl: "http://localhost:3000" }),
    );
    const created = JSON.parse(site.json.result.content[0].text) as { id: string };
    const steps = Array.from({ length: 70 }, (_, index) => ({
      action: "fill" as const,
      label: `字段 ${index}`,
      value: "z".repeat(30),
    }));
    const saved = await rpc(
      toolCall("save_flow", { siteId: created.id, name: "长流程", steps }),
    );
    const payload = JSON.parse(saved.json.result.content[0].text) as {
      steps: unknown[];
      stepsTotal: number;
      stepsTruncated?: boolean;
    };
    expect(payload.stepsTotal).toBe(70);
    expect(payload.stepsTruncated).toBe(true);
    expect(payload.steps).toHaveLength(60);
    // 存储仍是完整 70 步。
    expect(service.snapshot().flows[0]?.steps).toHaveLength(70);
  });
});

describe("account bundle tools", async () => {
  /**
   * The bundle tools need file IO, which lives in the main process, so they are
   * injected. Rebuild the server with fakes to observe exactly what the tool
   * passes down: the path handling and the passphrase never leaving the call
   * are the parts an AI depends on.
   */
  async function restartWith(extra: {
    exportAccounts: (input: {
      siteIds: string[];
      identityIds: string[];
      passphrase?: string;
      note?: string;
    }) => Promise<{ path: string; counts: { sites: number; accounts: number; withPasswords: number } }>;
    previewAccounts: (path: string) => unknown;
    importAccounts: (path: string, passphrase?: string) => unknown;
  }): Promise<void> {
    await server.stop();
    server = new McpServer({
      settingsPath: join(dir, "mcp.json"),
      auditPath: join(dir, "mcp-audit.log"),
      service,
      appVersion: "test",
      ...extra,
    });
    await server.start();
    port = server.status().port;
  }

  it("passes the selection through and reports where the file landed", async () => {
    const seen: unknown[] = [];
    await restartWith({
      exportAccounts: async (input) => {
        seen.push(input);
        return {
          path: "C:\\temp\\accounts.json",
          counts: { sites: 1, accounts: 2, withPasswords: 2 },
        };
      },
      previewAccounts: () => ({}),
      importAccounts: () => ({}),
    });
    const { json } = await rpc(
      toolCall("export_identities", {
        siteIds: ["site-1"],
        identityIds: ["id-1", "id-2"],
        passphrase: "share-pass-123",
        note: "给测试组",
      }),
    );
    expect(json.result.isError).toBeUndefined();
    expect(toolPayload(json)).toMatchObject({ path: "C:\\temp\\accounts.json" });
    expect(seen[0]).toEqual({
      siteIds: ["site-1"],
      identityIds: ["id-1", "id-2"],
      passphrase: "share-pass-123",
      note: "给测试组",
    });
    // The passphrase unlocks every password in the file; the audit log is a
    // plain text file anyone can read.
    const audit = readFileSync(join(dir, "mcp-audit.log"), "utf8");
    expect(audit).toContain("export_identities");
    expect(audit).not.toContain("share-pass-123");
  });

  it("imports a bundle without echoing its contents", async () => {
    const seen: Array<{ path: string; passphrase?: string }> = [];
    await restartWith({
      exportAccounts: async () => ({ path: "", counts: { sites: 0, accounts: 0, withPasswords: 0 } }),
      previewAccounts: () => ({}),
      importAccounts: (path, passphrase) => {
        seen.push({ path, ...(passphrase ? { passphrase } : {}) });
        return {
          sitesAdded: 1,
          sitesMatched: 0,
          identitiesAdded: 2,
          identitiesUpdated: 0,
          skipped: 0,
        };
      },
    });
    const { json } = await rpc(
      toolCall("import_identities", {
        path: "C:\\temp\\accounts.json",
        passphrase: "share-pass-123",
      }),
    );
    expect(toolPayload(json)).toMatchObject({ identitiesAdded: 2 });
    expect(seen).toEqual([{ path: "C:\\temp\\accounts.json", passphrase: "share-pass-123" }]);
  });

  it("previews without needing the passphrase", async () => {
    let previewed = "";
    await restartWith({
      exportAccounts: async () => ({ path: "", counts: { sites: 0, accounts: 0, withPasswords: 0 } }),
      previewAccounts: (path) => {
        previewed = path;
        return { sites: 1, accounts: 3, withPasswords: true, existingSites: [] };
      },
      importAccounts: () => ({}),
    });
    const { json } = await rpc(toolCall("preview_identities", { path: "C:\\temp\\a.json" }));
    expect(toolPayload(json)).toMatchObject({ accounts: 3, withPasswords: true });
    expect(previewed).toBe("C:\\temp\\a.json");
  });

  it("reports a missing path as an invalid call, not a crash", async () => {
    await restartWith({
      exportAccounts: async () => ({ path: "", counts: { sites: 0, accounts: 0, withPasswords: 0 } }),
      previewAccounts: () => ({}),
      importAccounts: () => ({}),
    });
    const { json } = await rpc(toolCall("preview_identities", {}));
    expect(json.error.code).toBe(-32602);
  });
});

describe("update_settings", async () => {
  it("applies a whitelisted setting through the injected applier", async () => {
    // The applier is what carries the main-process side effects (theme, locale,
    // zoom, proxy, broadcast). A tool that wrote settings directly would return
    // "updated" while the running app still shows the old theme.
    const seen: SettingsPatch[] = [];
    await restartServer({
      updateSettings: (patch) => {
        seen.push(patch);
        return service.saveSettings(patch);
      },
    });

    const { json } = await rpc(toolCall("update_settings", { theme: "light" }));
    expect(json.result.isError).toBeUndefined();
    expect(toolPayload(json)).toEqual({ updated: { theme: "light" } });
    // Persisted through the applier, not around it.
    expect(seen).toEqual([{ theme: "light" }]);
    expect(service.settingsSnapshot().theme).toBe("light");
  });

  it("rejects a non-whitelisted key and leaves settings untouched", async () => {
    const before = service.settingsSnapshot();
    const mcpBefore = server.status();

    const { json } = await rpc(
      toolCall("update_settings", { theme: "light", allowDelete: true, mcpPort: 12_345 }),
    );
    expect(json.result.isError).toBe(true);
    const message: string = json.result.content[0].text;
    // The refusal names the offending keys and what is allowed, so a model can
    // correct itself instead of retrying blindly.
    expect(message).toContain("allowDelete");
    expect(message).toContain("mcpPort");
    expect(message).toContain("browserZoom");

    // Neither the app settings nor the MCP endpoint's own permissions moved:
    // a partial application would be worse than a refusal.
    expect(service.settingsSnapshot().theme).toBe(before.theme);
    expect(server.status().allowDelete).toBe(mcpBefore.allowDelete);
    expect(server.status().port).toBe(mcpBefore.port);
    expect(server.status().running).toBe(true);
  });

  it("refuses a proxy address that carries a credential, and keeps it out of the log", async () => {
    // `proxyUrl` is stored in plain settings.json and echoed into the audit log,
    // where redaction worked by field name — a `user:pass@host` inside the URL
    // would be written in clear even when the call is refused.
    const before = service.settingsSnapshot();
    const { json } = await rpc(
      toolCall("update_settings", { proxyUrl: "http://user:hunter2@127.0.0.1:7890" }),
    );
    expect(json.result.isError).toBe(true);
    expect(service.settingsSnapshot().proxyUrl).toBe(before.proxyUrl);
    const audit = readFileSync(join(dir, "mcp-audit.log"), "utf8");
    expect(audit).toContain("update_settings");
    expect(audit).not.toContain("hunter2");
  });

  it("accepts an ordinary proxy address", async () => {
    const { json } = await rpc(
      toolCall("update_settings", { proxyMode: "manual", proxyUrl: "http://127.0.0.1:7890" }),
    );
    expect(json.result.isError).toBeUndefined();
    expect(service.settingsSnapshot()).toMatchObject({
      proxyMode: "manual",
      proxyUrl: "http://127.0.0.1:7890",
    });
  });
});

describe("compose_view", async () => {
  const notUsed = () => {
    throw new Error("测试替身没有实现这个方法");
  };

  /**
   * In-memory surface: records which page landed in which cell of which view.
   *
   * Everything the tool can legitimately call is implemented, so a failure in a
   * test is the behaviour under test rather than an unimplemented stub.
   */
  function fakeSurface(
    input: Array<{
      id: string;
      identityId?: string;
      siteId?: string;
      instanceId?: string;
      viewId?: string;
    }>,
    options: { failPinAt?: number } = {},
  ) {
    const tabs = input.map((tab) => ({
      label: tab.id,
      url: "about:blank",
      title: "",
      instanceId: tab.id,
      ...tab,
    }));
    const views = new Map<
      string,
      { id: string; name: string; layoutId: string; slotTabs: Array<string | null> }
    >();
    const moves: Array<{ tabId: string; to: string; slot?: number }> = [];
    // One-shot: a transient failure is the interesting case. A permanently
    // failing stub would also break the rollback, which is a different failure
    // mode than the one these tests are about.
    let pinFailurePending = options.failPinAt !== undefined;
    const surface = {
      state: () => ({
        tabs: tabs.map((tab) => ({ ...tab })),
        views: [...views.values()].map((view) => ({
          id: view.id,
          name: view.name,
          layoutId: view.layoutId,
          slotTabs: [...view.slotTabs],
        })),
      }),
      openViewContainer: (viewDefinitionId: string) => {
        const definition = service.findView(viewDefinitionId);
        if (!definition) throw new Error("视图定义没保存");
        const id = `container-${viewDefinitionId}`;
        views.set(id, {
          id,
          name: definition.name,
          layoutId: definition.layoutId,
          slotTabs: new Array(embeddedSlotCount(definition.layoutId)).fill(null),
        });
        return id;
      },
      pinTab: (slotIndex: number, tabId: string | null, viewId?: string) => {
        if (pinFailurePending && slotIndex === options.failPinAt) {
          pinFailurePending = false;
          throw new Error("注入的格位失败");
        }
        const view = views.get(viewId ?? "");
        if (!view) throw new Error(`视图不存在：${viewId ?? ""}`);
        if (tabId) {
          // Pinning is also how a page joins a container, so the real surface
          // detaches it from whichever view held it before — and moves it out of
          // any other cell of the same view. Mirroring both keeps rollback
          // assertions about real positions, not stale ones.
          for (const other of views.values()) {
            other.slotTabs = other.slotTabs.map((id) => (id === tabId ? null : id));
          }
        }
        view.slotTabs[slotIndex] = tabId;
        if (tabId) moves.push({ tabId, to: view.id, slot: slotIndex });
        return {};
      },
      moveTab: (
        tabId: string,
        target:
          | { kind: "tab"; tabId: string; edge: "before" | "after" | "middle" }
          | { kind: "view"; viewId: string }
          | { kind: "loose" },
      ) => {
        if (target.kind === "loose") {
          // Leaving a view clears the cell it occupied; a stale entry there
          // would make the surface keep showing a page it no longer claims.
          for (const view of views.values()) {
            view.slotTabs = view.slotTabs.map((id) => (id === tabId ? null : id));
          }
          moves.push({ tabId, to: "loose" });
          return { tabId, joined: false };
        }
        if (target.kind !== "view") throw new Error("测试只覆盖进/出视图的移动");
        const view = views.get(target.viewId);
        if (!view) throw new Error(`视图不存在：${target.viewId}`);
        for (const other of views.values()) {
          other.slotTabs = other.slotTabs.map((id) => (id === tabId ? null : id));
        }
        // Joining a view takes the first free cell, exactly like `assignView`
        // does; a full grid leaves the page joined but off stage.
        const free = view.slotTabs.indexOf(null);
        if (free >= 0) view.slotTabs[free] = tabId;
        moves.push({ tabId, to: target.viewId });
        return { tabId, joined: true };
      },
      createTab: notUsed,
      navigate: notUsed,
      back: notUsed,
      forward: notUsed,
      reload: notUsed,
      closeTab: notUsed,
      activate: notUsed,
      snapshotDom: notUsed,
      click: notUsed,
      hover: notUsed,
      scroll: notUsed,
      pressKeys: notUsed,
      dialogStatus: notUsed,
      handleDialog: notUsed,
      setFiles: notUsed,
      drag: notUsed,
      setChecked: notUsed,
      elementInfo: notUsed,
      findElements: notUsed,
      attributes: notUsed,
      type: notUsed,
      fillForm: notUsed,
      runFlow: notUsed,
      evaluate: notUsed,
      screenshot: notUsed,
      visibility: notUsed,
      wait: notUsed,
      setViewport: (tabId: string, size: { width: number; height: number } | null) => size,
      setLayout: notUsed,
      fillLogin: notUsed,
      defaultTabId: notUsed,
      defaultViewId: notUsed,
      layoutTargetView: notUsed,
      openView: notUsed,
    } satisfies EmbeddedSurface;
    return { surface, views, moves };
  }

  /** A site with three identities, so every test starts from the same shape. */
  async function seedWorkspace() {
    const site = await service.saveSite({
      name: "本地环境",
      baseUrl: "http://localhost:3000",
      loginPath: "/login",
      autoSubmit: false,
    });
    const identities = await Promise.all(
      ["管理员", "审核员", "访客"].map(async (name, index) =>
        service.saveIdentity({
          siteId: site.id,
          name,
          username: `user-${index}`,
          role: "member",
          color: "teal",
          passwordMode: "inherit",
          startPath: "/",
        }),
      ),
    );
    return { site, identities };
  }

  it("combines two open tabs into a 2x1 view in argument order", async () => {
    const { site, identities } = await seedWorkspace();
    // Deliberately not the identity order, and given out of order: the slots
    // must follow `tabIds`, which is the order the caller asked for.
    const [first, second] = identities;
    const { surface, views } = fakeSurface([
      { id: "tab-b", identityId: second!.id, siteId: site.id },
      { id: "tab-a", identityId: first!.id, siteId: site.id },
    ]);
    await restartServer({ embedded: surface });

    const { json } = await rpc(
      toolCall("compose_view", { name: "双人对照", tabIds: ["tab-a", "tab-b"] }),
    );
    expect(json.result.isError).toBeUndefined();
    const result = toolPayload(json) as {
      viewId: string;
      layoutId: string;
      siteId: string;
      slots: Array<{ tabId: string; identityId: string; slotIndex: number | null }>;
    };
    // Two pages side by side is the default; the site came from the tabs.
    expect(result.layoutId).toBe("2x1");
    expect(result.siteId).toBe(site.id);
    expect(result.slots).toEqual([
      { tabId: "tab-a", identityId: first!.id, slotIndex: 0 },
      { tabId: "tab-b", identityId: second!.id, slotIndex: 1 },
    ]);

    // The definition records the same order and cell assignment.
    const definition = service.findView(result.viewId);
    expect(definition?.identityIds).toEqual([first!.id, second!.id]);
    expect(definition?.slotAssignments).toEqual({ [first!.id]: 0, [second!.id]: 1 });
    // And the surface actually holds them in those cells.
    expect(views.get(`container-${result.viewId}`)?.slotTabs).toEqual(["tab-a", "tab-b"]);
  });

  it("refuses fewer than two tabs and creates nothing", async () => {
    const { site, identities } = await seedWorkspace();
    const { surface } = fakeSurface([
      { id: "tab-a", identityId: identities[0]!.id, siteId: site.id },
    ]);
    await restartServer({ embedded: surface });

    const { json } = await rpc(toolCall("compose_view", { name: "只有一个", tabIds: ["tab-a"] }));
    expect(json.result.isError).toBe(true);
    expect(service.snapshot().views).toHaveLength(0);
  });

  it("refuses a tab id that is not open and creates nothing", async () => {
    const { site, identities } = await seedWorkspace();
    const { surface } = fakeSurface([
      { id: "tab-a", identityId: identities[0]!.id, siteId: site.id },
      { id: "tab-b", identityId: identities[1]!.id, siteId: site.id },
    ]);
    await restartServer({ embedded: surface });

    const { json } = await rpc(
      toolCall("compose_view", { name: "含幽灵页", tabIds: ["tab-a", "tab-ghost"] }),
    );
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("tab-ghost");
    // Validation happens before anything is written: no half-built view.
    expect(service.snapshot().views).toHaveLength(0);
  });

  it("packs beyond the grid, puts the surplus in the view but off stage, and says so", async () => {
    // A 2x2 has four cells; five pages cannot fit. Silently dropping the fifth
    // would look like the tab vanished, so it joins the view off stage and the
    // result states that.
    const site = await service.saveSite({
      name: "本地环境",
      baseUrl: "http://localhost:3000",
      loginPath: "/login",
      autoSubmit: false,
    });
    const identities = await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        service.saveIdentity({
          siteId: site.id,
          name: `账号 ${index}`,
          username: `user-${index}`,
          role: "member",
          color: "teal",
          passwordMode: "inherit",
          startPath: "/",
        }),
      ),
    );
    const tabIds = identities.map((_, index) => `tab-${index}`);
    const { surface, views } = fakeSurface(
      identities.map((identity, index) => ({
        id: tabIds[index]!,
        identityId: identity.id,
        siteId: site.id,
      })),
    );
    await restartServer({ embedded: surface });

    const { json } = await rpc(
      toolCall("compose_view", { name: "五页对照", tabIds, layoutId: "2x2" }),
    );
    expect(json.result.isError).toBeUndefined();
    const result = toolPayload(json) as {
      viewId: string;
      layoutId: string;
      slots: Array<{ tabId: string; slotIndex: number | null }>;
      note?: string;
    };
    expect(result.layoutId).toBe("2x2");
    expect(result.slots.map((slot) => slot.slotIndex)).toEqual([0, 1, 2, 3, null]);
    // The container agrees: four cells in argument order, the fifth only joined.
    expect(views.get(`container-${result.viewId}`)?.slotTabs).toEqual([
      "tab-0",
      "tab-1",
      "tab-2",
      "tab-3",
    ]);
    // The fifth is still a member of the definition.
    expect(service.snapshot().views[0]?.identityIds).toHaveLength(5);
    expect(result.note).toContain("4");
  });
  it("rolls back the pages and the definition when a cell cannot be filled", async () => {
    // The second pin fails: the first page is already in the new container and
    // the definition is already saved. What must not survive is a definition
    // that disagrees with the screen, or pages stranded in a half-built view.
    const { site, identities } = await seedWorkspace();
    const { surface, views, moves } = fakeSurface(
      [
        { id: "tab-a", identityId: identities[0]!.id, siteId: site.id },
        { id: "tab-b", identityId: identities[1]!.id, siteId: site.id },
      ],
      { failPinAt: 1 },
    );
    await restartServer({ embedded: surface });

    const { json } = await rpc(
      toolCall("compose_view", { name: "会失败的组合", tabIds: ["tab-a", "tab-b"] }),
    );
    expect(json.result.isError).toBe(true);
    // No definition is left behind...
    expect(service.snapshot().views).toHaveLength(0);
    // ...the page already placed was sent back to the loose strip...
    expect(moves).toContainEqual({ tabId: "tab-a", to: "loose" });
    // ...and the abandoned container shows nothing instead of a page it no
    // longer owns.
    const containers = [...views.values()];
    expect(containers.every((view) => view.slotTabs.every((id) => id === null))).toBe(true);
  });

  it("puts a tab back into the cell it occupied when the compose fails", async () => {
    // A page that already sat in another view must return to that view *and*
    // that cell. Re-joining alone would land it in the first free cell, which is
    // a silent re-arrangement of a screen the person had set up.
    const { site, identities } = await seedWorkspace();
    const { surface, views, moves } = fakeSurface(
      [
        { id: "tab-a", identityId: identities[0]!.id, siteId: site.id, viewId: "container-old" },
        // Loose, so it is never restored anywhere and cannot fill a cell first.
        { id: "tab-b", identityId: identities[1]!.id, siteId: site.id },
      ],
      { failPinAt: 1 },
    );
    // Pre-existing 3 × 1 container with tab-a in the middle cell.
    views.set("container-old", {
      id: "container-old",
      name: "旧视图",
      layoutId: "3x1",
      slotTabs: [null, "tab-a", null],
    });
    await restartServer({ embedded: surface });

    const { json } = await rpc(
      toolCall("compose_view", { name: "会失败的组合", tabIds: ["tab-a", "tab-b"] }),
    );
    expect(json.result.isError).toBe(true);
    expect(service.snapshot().views).toHaveLength(0);
    expect(moves.some((move) => move.tabId === "tab-a" && move.to === "container-old")).toBe(
      true,
    );
    // Cell 1, not the first free cell 0.
    expect(views.get("container-old")?.slotTabs).toEqual([null, "tab-a", null]);
  });
});

describe("MCP lifecycle", () => {
  it("releases the port on stop so nothing is left behind", async () => {
    const status = server.status();
    expect(status.running).toBe(true);
    await server.stop();
    expect(server.status().running).toBe(false);
    await expect(
      fetch(`http://127.0.0.1:${status.port}/mcp`, { method: "POST", body: "{}" }),
    ).rejects.toBeTruthy();
  });

  it("redacts secrets from audit arguments at any depth", () => {
    const redacted = redactMcpArgs({
      name: "x",
      password: "p",
      nested: { identities: [{ username: "u", password: "q", passphrase: "z" }] },
    }) as Record<string, unknown>;
    expect(redacted["password"]).toBe("[redacted]");
    const nested = redacted["nested"] as { identities: Array<Record<string, unknown>> };
    expect(nested.identities[0]?.["password"]).toBe("[redacted]");
    expect(nested.identities[0]?.["passphrase"]).toBe("[redacted]");
    expect(nested.identities[0]?.["username"]).toBe("u");
  });

  it("redacts a credential carried inside a URL, whatever the field is called", () => {
    // Field-name redaction cannot see `http://user:pass@host`, and that shape is
    // legal in both a proxy address and a navigation target.
    const redacted = redactMcpArgs({
      proxyUrl: "http://user:hunter2@127.0.0.1:7890",
      url: "https://alice:s3cret@example.test/path?q=1",
      plain: "http://127.0.0.1:7890",
    }) as Record<string, string>;
    expect(redacted["proxyUrl"]).toBe("http://[redacted]@127.0.0.1:7890");
    expect(redacted["url"]).toBe("https://[redacted]@example.test/path?q=1");
    // An address without a credential is left readable: the log has to stay
    // useful for "which host did the AI touch".
    expect(redacted["plain"]).toBe("http://127.0.0.1:7890");
  });
});
});
