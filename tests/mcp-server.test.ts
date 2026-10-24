import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpSettings, McpServer, redactMcpArgs } from "../src/main/mcp/server";

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

  it("exposes insertion tools but no read-back tool for secrets", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("create_site");
    expect(names).toContain("create_identities");
    expect(names).toContain("launch_view");
    // Writing a password is allowed; reading one back is not.
    expect(
      names.some((name: string) => /(get|read|copy|reveal)_(password|secret)/i.test(name)),
    ).toBe(false);
  });
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
    const identities = JSON.parse(listed.json.result.content[0].text);
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
        extraFields: [{ label: "租户名", value: "默认租户" }],
      }),
    );
    const site = JSON.parse(env.json.result.content[0].text);
    // One call saves the site and its default password.
    expect(site.id).toBeTruthy();
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

  it("creates a site tag and lists it on the site", async () => {
    const created = await rpc(toolCall("save_site_tag", { name: "后台系统", color: "teal" }));
    expect(created.json.result.isError).toBeUndefined();
    const tag = JSON.parse(created.json.result.content[0].text) as { id: string };

    const site = service.saveSite({
      name: "本地站点",
      baseUrl: "http://localhost:3000",
      loginPath: "/login",
      autoSubmit: false,
      tagIds: [tag.id],
    });

    const listed = await rpc(toolCall("list_sites", {}));
    const sites = JSON.parse(listed.json.result.content[0].text) as Array<{
      id: string;
      tags: string[];
    }>;
    // The list reports tag names, not ids: the AI should not have to join tables.
    expect(sites.find((item) => item.id === site.id)?.tags).toEqual(["后台系统"]);
  });

  it("requires confirmation before deleting a tag", async () => {
    const tag = service.saveTag({ name: "后台系统", color: "teal" });
    await server.update({ allowDelete: true });

    const refused = await rpc(toolCall("delete_site_tag", { id: tag.id }));
    expect(refused.json.result.isError).toBe(true);
    expect(service.snapshot().tags).toHaveLength(1);

    const confirmed = await rpc(toolCall("delete_site_tag", { id: tag.id, confirm: true }));
    expect(confirmed.json.result.isError).toBeUndefined();
    expect(service.snapshot().tags).toHaveLength(0);
  });

  it("exposes the tag tools under their new names and keeps the old ones working", async () => {
    const tools = (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" })).json.result
      .tools as Array<{ name: string; description: string }>;
    for (const name of ["save_tag", "delete_tag"]) {
      expect(tools.some((tool) => tool.name === name)).toBe(true);
    }
    // Names that were already released stay resolvable: a client configured
    // against them must not break because the UI moved tags out of Settings.
    for (const alias of ["save_site_tag", "delete_site_tag"]) {
      const tool = tools.find((item) => item.name === alias);
      expect(tool?.description).toContain("旧名称");
    }

    const created = await rpc(toolCall("save_tag", { name: "客户环境", color: "amber" }));
    const tag = JSON.parse(created.json.result.content[0].text) as { id: string };
    const renamed = await rpc(
      toolCall("save_site_tag", { id: tag.id, name: "客户环境 · 预发", color: "rose" }),
    );
    expect(JSON.parse(renamed.json.result.content[0].text)).toMatchObject({
      id: tag.id,
      name: "客户环境 · 预发",
      color: "rose",
    });
    expect(service.snapshot().tags).toHaveLength(1);
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
    for (const name of ["launch_view", "launch_identity", "launch_clean_session"]) {
      const tool = tools.find((item: { name: string }) => item.name === name);
      expect(tool.inputSchema.properties).not.toHaveProperty("confirmProduction");
    }

    await server.update({ allowRun: false });
    const refused = await rpc(toolCall("launch_identity", { identityId: identity.id }));
    expect(refused.json.result.isError).toBe(true);
    expect(refused.json.result.content[0].text).toMatch(/权限/);
  });
});

describe("account bundle tools", () => {
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
    }) => { path: string; counts: { sites: number; accounts: number; withPasswords: number } };
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
      exportAccounts: (input) => {
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
      toolCall("export_accounts", {
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
    expect(audit).toContain("export_accounts");
    expect(audit).not.toContain("share-pass-123");
  });

  it("imports a bundle without echoing its contents", async () => {
    const seen: Array<{ path: string; passphrase?: string }> = [];
    await restartWith({
      exportAccounts: () => ({ path: "", counts: { sites: 0, accounts: 0, withPasswords: 0 } }),
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
      toolCall("import_accounts", {
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
      exportAccounts: () => ({ path: "", counts: { sites: 0, accounts: 0, withPasswords: 0 } }),
      previewAccounts: (path) => {
        previewed = path;
        return { sites: 1, accounts: 3, withPasswords: true, existingSites: [] };
      },
      importAccounts: () => ({}),
    });
    const { json } = await rpc(toolCall("preview_accounts", { path: "C:\\temp\\a.json" }));
    expect(toolPayload(json)).toMatchObject({ accounts: 3, withPasswords: true });
    expect(previewed).toBe("C:\\temp\\a.json");
  });

  it("reports a missing path as an invalid call, not a crash", async () => {
    await restartWith({
      exportAccounts: () => ({ path: "", counts: { sites: 0, accounts: 0, withPasswords: 0 } }),
      previewAccounts: () => ({}),
      importAccounts: () => ({}),
    });
    const { json } = await rpc(toolCall("preview_accounts", {}));
    expect(json.error.code).toBe(-32602);
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
});
