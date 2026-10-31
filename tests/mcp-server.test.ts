import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { embeddedSlotCount } from "@shared/embedded";
import type { SettingsPatch } from "@shared/types";
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

  it("advertises the renamed tag tools once, not the old aliases too", async () => {
    // The old names stay callable so an already-configured client keeps working,
    // but repeating them in the list costs every session context for no gain:
    // the model cannot usefully prefer one of two identical verbs.
    const { json } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("save_tag");
    expect(names).toContain("delete_tag");
    expect(names).not.toContain("save_site_tag");
    expect(names).not.toContain("delete_site_tag");
  });

  it("lets an old alias still be called even though it is not advertised", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "save_site_tag", arguments: { name: "旧名字", color: "teal" } },
    });
    expect(json.result?.isError ?? false).toBe(false);
    const tags = JSON.parse(json.result.content[0].text);
    expect(tags).toMatchObject({ name: "旧名字", color: "teal" });
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

    await rpc(
      toolCall("create_identity", {
        siteId: site.id,
        name: "继承账号",
        username: "heir",
        passwordMode: "inherit",
      }),
    );
    const before = JSON.parse(
      (await rpc(toolCall("list_sites"))).json.result.content[0].text,
    ).find((item: { id: string }) => item.id === site.id);
    expect(before.defaultPasswordSet).toBe(false);

    await rpc(
      toolCall("set_password", {
        ownerKind: "site",
        ownerId: site.id,
        password: "later-default",
      }),
    );
    const after = JSON.parse(
      (await rpc(toolCall("list_sites"))).json.result.content[0].text,
    ).find((item: { id: string }) => item.id === site.id);
    expect(after.defaultPasswordSet).toBe(true);
    // Still write-only: the flag reports existence, never the value.
    expect(JSON.stringify(after)).not.toContain("later-default");
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
    // "Resolvable" is asserted by the calls below, not by the list: the aliases
    // are deliberately not advertised, because two identical verbs in the list
    // cost every session context while the model gains nothing from the choice.
    for (const alias of ["save_site_tag", "delete_site_tag"]) {
      expect(tools.some((tool) => tool.name === alias)).toBe(false);
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

describe("update_settings", () => {
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

describe("compose_view", () => {
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
      closeTab: notUsed,
      activate: notUsed,
      snapshotDom: notUsed,
      click: notUsed,
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
  function seedWorkspace() {
    const site = service.saveSite({
      name: "本地环境",
      baseUrl: "http://localhost:3000",
      loginPath: "/login",
      autoSubmit: false,
    });
    const identities = ["管理员", "审核员", "访客"].map((name, index) =>
      service.saveIdentity({
        siteId: site.id,
        name,
        username: `user-${index}`,
        role: "member",
        color: "teal",
        passwordMode: "inherit",
        startPath: "/",
      }),
    );
    return { site, identities };
  }

  it("combines two open tabs into a 2x1 view in argument order", async () => {
    const { site, identities } = seedWorkspace();
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
    const { site, identities } = seedWorkspace();
    const { surface } = fakeSurface([
      { id: "tab-a", identityId: identities[0]!.id, siteId: site.id },
    ]);
    await restartServer({ embedded: surface });

    const { json } = await rpc(toolCall("compose_view", { name: "只有一个", tabIds: ["tab-a"] }));
    expect(json.result.isError).toBe(true);
    expect(service.snapshot().views).toHaveLength(0);
  });

  it("refuses a tab id that is not open and creates nothing", async () => {
    const { site, identities } = seedWorkspace();
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
    const site = service.saveSite({
      name: "本地环境",
      baseUrl: "http://localhost:3000",
      loginPath: "/login",
      autoSubmit: false,
    });
    const identities = Array.from({ length: 5 }, (_, index) =>
      service.saveIdentity({
        siteId: site.id,
        name: `账号 ${index}`,
        username: `user-${index}`,
        role: "member",
        color: "teal",
        passwordMode: "inherit",
        startPath: "/",
      }),
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
    const { site, identities } = seedWorkspace();
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
    const { site, identities } = seedWorkspace();
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
