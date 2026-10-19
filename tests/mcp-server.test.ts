import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";
import { McpServer, loadMcpSettings, redactMcpArgs } from "../src/main/mcp/server";

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
    expect(names).toContain("create_environment");
    expect(names).toContain("create_identities");
    expect(names).toContain("launch_scene");
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
  it("creates an environment and identities, then reads them back", async () => {
    const env = await rpc(
      toolCall("create_environment", {
        name: "订单服务-测试环境",
        baseUrl: "http://localhost:3000",
      }),
    );
    expect(env.json.result.isError).toBeUndefined();
    const environment = JSON.parse(env.json.result.content[0].text);
    expect(environment.id).toBeTruthy();

    const batch = await rpc(
      toolCall("create_identities", {
        environmentId: environment.id,
        identities: [
          { name: "管理员", username: "admin", password: "s3cret!", role: "admin" },
          { name: "审核员", username: "reviewer", password: "s3cret!", role: "reviewer" },
        ],
      }),
    );
    const created = JSON.parse(batch.json.result.content[0].text);
    expect(created.created).toHaveLength(2);
    expect(created.failures).toHaveLength(0);

    const listed = await rpc(toolCall("list_identities", { environmentId: environment.id }));
    const identities = JSON.parse(listed.json.result.content[0].text);
    expect(identities).toHaveLength(2);
    expect(identities[0].hasPassword).toBe(true);
    // Passwords are write-only: no response may echo them.
    expect(JSON.stringify(identities)).not.toContain("s3cret!");
  });

  it("creates a scene that references the created identities", async () => {
    const env = await rpc(
      toolCall("create_environment", { name: "本地环境", baseUrl: "http://localhost:3000" }),
    );
    const environment = JSON.parse(env.json.result.content[0].text);
    const batch = await rpc(
      toolCall("create_identities", {
        environmentId: environment.id,
        identities: [
          { name: "A", username: "a" },
          { name: "B", username: "b" },
        ],
      }),
    );
    const ids = JSON.parse(batch.json.result.content[0].text).created.map(
      (identity: { id: string }) => identity.id,
    );
    const scene = await rpc(
      toolCall("create_scene", {
        environmentId: environment.id,
        name: "双人对照",
        identityIds: ids,
        layoutId: "2x1",
      }),
    );
    const created = JSON.parse(scene.json.result.content[0].text);
    expect(created.identityIds).toEqual(ids);
    expect(created.layoutId).toBe("2x1");
  });

  it("blocks writes when the write permission is disabled", async () => {
    await server.update({ allowWrite: false });
    const result = await rpc(
      toolCall("create_environment", { name: "x", baseUrl: "http://localhost:3000" }),
    );
    expect(result.json.result.isError).toBe(true);
    expect(service.snapshot().environments).toHaveLength(0);
  });

  it("keeps delete disabled by default and requires an explicit confirm", async () => {
    const env = await rpc(
      toolCall("create_environment", { name: "可删环境", baseUrl: "http://localhost:3000" }),
    );
    const environment = JSON.parse(env.json.result.content[0].text);

    const blocked = await rpc(toolCall("delete_environment", { id: environment.id }));
    expect(blocked.json.result.isError).toBe(true);
    expect(service.snapshot().environments).toHaveLength(1);

    await server.update({ allowDelete: true });
    const noConfirm = await rpc(toolCall("delete_environment", { id: environment.id }));
    expect(noConfirm.json.result.isError).toBe(true);
    expect(service.snapshot().environments).toHaveLength(1);

    const confirmed = await rpc(
      toolCall("delete_environment", { id: environment.id, confirm: true }),
    );
    expect(confirmed.json.result.isError).toBeUndefined();
    expect(service.snapshot().environments).toHaveLength(0);
  });

  it("logs tool calls but never the password", async () => {
    const env = await rpc(
      toolCall("create_environment", { name: "审计环境", baseUrl: "http://localhost:3000" }),
    );
    const environment = JSON.parse(env.json.result.content[0].text);
    await rpc(
      toolCall("create_identity", {
        environmentId: environment.id,
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

  it("requires confirmProduction for a production-named environment", async () => {
    const env = await rpc(
      toolCall("create_environment", {
        name: "会员服务-生产环境",
        baseUrl: "http://localhost:3000",
      }),
    );
    const environment = JSON.parse(env.json.result.content[0].text);
    const identityResponse = await rpc(
      toolCall("create_identity", {
        environmentId: environment.id,
        name: "生产账号",
        username: "prod-user",
      }),
    );
    const identity = JSON.parse(identityResponse.json.result.content[0].text);
    const refused = await rpc(toolCall("launch_identity", { identityId: identity.id }));
    expect(refused.json.result.isError).toBe(true);
    expect(refused.json.result.content[0].text).toMatch(/生产环境/);
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
