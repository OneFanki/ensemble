import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  environmentDraftSchema,
  identityDraftSchema,
  layoutPresetDraftSchema,
  sceneDraftSchema,
} from "@shared/schemas";
import { isProductionName } from "@shared/environments";
import type {
  Environment,
  EnvironmentDraft,
  Identity,
  IdentityDraft,
  McpSettings,
  McpStatus,
  Scene,
  SceneDraft,
} from "@shared/types";
import type { WorkspaceService } from "@core/service";
import { JsonStore } from "@core/storage/json-store";

const DEFAULT_PORT = 47_821;
const MAX_BODY_BYTES = 1_000_000;
const AUDIT_FILE = "mcp-audit.log";

type ToolKind = "read" | "write" | "run" | "danger";

interface ToolDefinition {
  name: string;
  description: string;
  kind: ToolKind;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const string = (description: string) => ({ type: "string", description });
const integer = (description: string) => ({ type: "integer", description });

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export function defaultMcpSettings(): McpSettings {
  return {
    enabled: false,
    port: DEFAULT_PORT,
    token: newMcpToken(),
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
  };
}

export function newMcpToken(): string {
  return randomBytes(24).toString("base64url");
}

function clampPort(value: unknown): number {
  const port = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("MCP 端口必须在 1024–65535 之间");
  }
  return port;
}

/**
 * Loads and repairs the MCP settings file. A missing token is regenerated, and an
 * invalid port falls back to the default instead of leaving the server unstartable.
 */
export function loadMcpSettings(path: string): McpSettings {
  const store = new JsonStore<McpSettings>(path, defaultMcpSettings);
  let raw: Partial<McpSettings>;
  try {
    raw = store.read();
  } catch {
    raw = {};
  }
  const defaults = defaultMcpSettings();
  const port =
    typeof raw.port === "number" && raw.port >= 1024 && raw.port <= 65_535
      ? raw.port
      : defaults.port;
  const settings: McpSettings = {
    enabled: raw.enabled === true,
    port,
    token: typeof raw.token === "string" && raw.token.length >= 20 ? raw.token : defaults.token,
    allowWrite: raw.allowWrite !== false,
    allowRun: raw.allowRun !== false,
    allowDelete: raw.allowDelete === true,
  };
  store.write(settings);
  return settings;
}

export function saveMcpSettings(path: string, settings: McpSettings): void {
  const store = new JsonStore<McpSettings>(path, defaultMcpSettings);
  store.write(settings);
}

/** Strips secrets before anything is written to the audit log. */
export function redactMcpArgs(args: unknown): unknown {
  if (Array.isArray(args)) return args.map(redactMcpArgs);
  if (typeof args !== "object" || args === null) return args;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (/password|passphrase|token|secret/i.test(key)) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactMcpArgs(value);
    }
  }
  return result;
}

function timingSafeToken(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * A deliberately small MCP server over loopback HTTP.
 *
 * It answers the JSON-RPC subset every client needs (initialize, tools/list,
 * tools/call, ping) and stays stateless, so there is no session to leak or expire.
 * The full MCP SDK would add a dependency tree to the packaged app for very little
 * benefit here; this file is the entire protocol surface.
 */
export class McpServer {
  private server: Server | null = null;
  private running = false;
  private lastError: string | undefined;
  private settings: McpSettings;

  constructor(
    private readonly options: {
      settingsPath: string;
      auditPath: string;
      service: WorkspaceService;
      appVersion: string;
      onChange?: () => void;
    },
  ) {
    this.settings = loadMcpSettings(options.settingsPath);
  }

  settingsSnapshot(): McpSettings {
    return { ...this.settings };
  }

  status(): McpStatus {
    return {
      enabled: this.settings.enabled,
      running: this.running,
      port: this.settings.port,
      url: `http://127.0.0.1:${this.settings.port}/mcp`,
      token: this.settings.token,
      allowWrite: this.settings.allowWrite,
      allowRun: this.settings.allowRun,
      allowDelete: this.settings.allowDelete,
      toolCount: this.toolList().length,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async update(patch: {
    enabled?: boolean;
    port?: number;
    allowWrite?: boolean;
    allowRun?: boolean;
    allowDelete?: boolean;
    rotateToken?: boolean;
  }): Promise<McpStatus> {
    const next: McpSettings = { ...this.settings };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.allowWrite !== undefined) next.allowWrite = patch.allowWrite;
    if (patch.allowRun !== undefined) next.allowRun = patch.allowRun;
    if (patch.allowDelete !== undefined) next.allowDelete = patch.allowDelete;
    if (patch.rotateToken) next.token = newMcpToken();
    if (patch.port !== undefined) next.port = clampPort(patch.port);

    const portChanged = next.port !== this.settings.port;
    this.settings = next;
    saveMcpSettings(this.options.settingsPath, next);

    if (portChanged || !next.enabled) await this.stop();
    if (next.enabled) await this.start();
    this.options.onChange?.();
    return this.status();
  }

  async start(): Promise<void> {
    if (!this.settings.enabled || this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.lastError = undefined;
    await new Promise<void>((resolve) => {
      const onError = (error: Error) => {
        this.lastError = error.message;
        server.removeListener("listening", onListening);
        server.close();
        this.server = null;
        this.running = false;
        console.error("[mcp] failed to bind", this.settings.port, error.message);
        resolve();
      };
      const onListening = () => {
        server.removeListener("error", onError);
        this.server = server;
        this.running = true;
        console.log(`[mcp] listening on http://127.0.0.1:${this.settings.port}/mcp`);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.settings.port, "127.0.0.1");
    });
  }

  /**
   * Closing must release the socket before the process exits. If a client keeps a
   * connection open, `close()` alone waits for it forever, so connections are
   * destroyed first. This is what guarantees no MCP residue after quitting.
   */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.running = false;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // A second safety net for sockets registered after closeAllConnections.
      setTimeout(resolve, 1_500).unref?.();
    });
  }

  private allowedHost(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (!host) return false;
    const allowed = [`127.0.0.1:${this.settings.port}`, `localhost:${this.settings.port}`];
    return allowed.includes(host.toLowerCase());
  }

  private allowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const url = new URL(origin);
      return (
        (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") &&
        (url.protocol === "http:" || url.protocol === "https:")
      );
    } catch {
      return false;
    }
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    return timingSafeToken(header.slice(7).trim(), this.settings.token);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      const payload = body === undefined ? "" : JSON.stringify(body);
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...headers,
      });
      response.end(payload);
    };

    // Loopback plus Host/Origin checks stop a web page from reaching this endpoint
    // through a DNS-rebinding or cross-origin request.
    if (!this.allowedHost(request) || !this.allowedOrigin(request)) {
      send(403, { error: "forbidden origin" });
      return;
    }
    if (!this.authorized(request)) {
      send(401, { error: "missing or invalid token" }, { "www-authenticate": "Bearer" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.settings.port}`);
    if (url.pathname !== "/mcp" && url.pathname !== "/") {
      send(404, { error: "not found" });
      return;
    }
    if (request.method === "GET" || request.method === "DELETE") {
      send(405, { error: "stateless server: POST JSON-RPC only" }, { allow: "POST" });
      return;
    }
    if (request.method !== "POST") {
      send(405, { error: "method not allowed" }, { allow: "POST" });
      return;
    }

    let body = "";
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) throw new Error("body too large");
      }
    } catch {
      send(413, { error: "request body too large" });
      return;
    }

    let message: { id?: number | string | null; method?: string; params?: unknown };
    try {
      message = JSON.parse(body);
    } catch {
      send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }

    const id = message.id ?? null;
    const method = typeof message.method === "string" ? message.method : "";
    if (!method) {
      send(400, { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } });
      return;
    }
    // Client-to-server notifications carry no id and expect no response body.
    if (id === null && method.startsWith("notifications/")) {
      send(202);
      return;
    }

    try {
      switch (method) {
        case "initialize": {
          const params = (message.params ?? {}) as { protocolVersion?: string };
          const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
          send(200, {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: supported.includes(params.protocolVersion ?? "")
                ? params.protocolVersion
                : "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "ensemble", version: this.options.appVersion },
            },
          });
          return;
        }
        case "ping":
          send(200, { jsonrpc: "2.0", id, result: {} });
          return;
        case "tools/list":
          send(200, { jsonrpc: "2.0", id, result: { tools: this.toolList() } });
          return;
        case "resources/list":
          send(200, { jsonrpc: "2.0", id, result: { resources: [] } });
          return;
        case "prompts/list":
          send(200, { jsonrpc: "2.0", id, result: { prompts: [] } });
          return;
        case "tools/call": {
          const params = (message.params ?? {}) as {
            name?: string;
            arguments?: Record<string, unknown>;
          };
          const tool = this.tools().find((item) => item.name === params.name);
          if (!tool) {
            send(200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `unknown tool: ${params.name ?? ""}` },
            });
            return;
          }
          const gate = this.gate(tool);
          if (gate) {
            this.audit(tool.name, params.arguments, false, gate);
            send(200, {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: gate }], isError: true },
            });
            return;
          }
          try {
            const output = await tool.run(params.arguments ?? {});
            this.audit(tool.name, params.arguments, true);
            send(200, {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(output ?? null, null, 2) }],
              },
            });
          } catch (error) {
            const messageText = (error as Error).message || "tool failed";
            this.audit(tool.name, params.arguments, false, messageText);
            send(200, {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: messageText }], isError: true },
            });
          }
          return;
        }
        default:
          send(200, {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          });
      }
    } catch (error) {
      send(200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: (error as Error).message },
      });
    }
  }

  private gate(tool: ToolDefinition): string | undefined {
    if (tool.kind === "read") return undefined;
    if (tool.kind === "write" && !this.settings.allowWrite) {
      return "写入权限已关闭，请在 Ensemble 设置的「AI 接入」里开启。";
    }
    if (tool.kind === "run" && !this.settings.allowRun) {
      return "运行权限已关闭，请在 Ensemble 设置的「AI 接入」里开启。";
    }
    if (tool.kind === "danger" && !this.settings.allowDelete) {
      return "删除权限已关闭，请在 Ensemble 设置的「AI 接入」里开启。";
    }
    return undefined;
  }

  private audit(tool: string, args: unknown, ok: boolean, error?: string): void {
    try {
      mkdirSync(dirname(this.options.auditPath), { recursive: true });
      appendFileSync(
        this.options.auditPath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          tool,
          args: redactMcpArgs(args),
          ok,
          ...(error ? { error } : {}),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // Audit logging must never break a tool call.
    }
  }

  private toolList(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.tools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  private tools(): ToolDefinition[] {
    const service = this.options.service;

    const environmentSummary = (environment: Environment) => ({
      id: environment.id,
      name: environment.name,
      baseUrl: environment.baseUrl,
      loginPath: environment.loginPath,
      ...(environment.authCheckPath ? { authCheckPath: environment.authCheckPath } : {}),
      defaultEngineId: environment.defaultEngineId ?? null,
      autoSubmit: environment.autoSubmit,
      extraFields: environment.extraFields ?? [],
      identityCount: service
        .snapshot()
        .identities.filter((identity) => identity.environmentId === environment.id).length,
      sceneCount: service
        .snapshot()
        .scenes.filter((scene) => scene.environmentId === environment.id).length,
    });

    const identitySummary = (identity: Identity) => ({
      id: identity.id,
      environmentId: identity.environmentId,
      name: identity.name,
      username: identity.username,
      role: identity.role,
      color: identity.color,
      engineId: identity.engineId ?? null,
      startPath: identity.startPath ?? null,
      passwordMode: identity.passwordMode,
      hasPassword: Boolean(service.snapshot().credentials.identity[identity.id]),
      extraFields: identity.extraFields ?? [],
      note: identity.note ?? null,
    });

    const sceneSummary = (scene: Scene) => ({
      id: scene.id,
      environmentId: scene.environmentId,
      name: scene.name,
      identityIds: scene.identityIds,
      layoutId: scene.layoutId,
      slotAssignments: scene.slotAssignments,
      paths: scene.paths,
    });

    const findEnvironment = (id: unknown): Environment => {
      const environment = service.snapshot().environments.find((item) => item.id === id);
      if (!environment) throw new Error(`环境不存在：${String(id)}`);
      return environment;
    };
    const findIdentity = (id: unknown): Identity => {
      const identity = service.snapshot().identities.find((item) => item.id === id);
      if (!identity) throw new Error(`身份不存在：${String(id)}`);
      return identity;
    };
    const findScene = (id: unknown): Scene => {
      const scene = service.snapshot().scenes.find((item) => item.id === id);
      if (!scene) throw new Error(`场景不存在：${String(id)}`);
      return scene;
    };

    const requireConfirm = (args: Record<string, unknown>, field = "confirm"): void => {
      if (args[field] !== true) {
        throw new Error(`这是破坏性操作，必须显式传 ${field}: true 才会执行。请先与用户确认。`);
      }
    };

    // Launching against a production-named environment always needs an explicit
    // confirmation, even when the caller is an AI rather than the GUI.
    const guardProduction = (environment: Environment, args: Record<string, unknown>) => {
      if (!isProductionName(environment.name)) return;
      if (args["confirmProduction"] === true) return;
      throw new Error(
        `「${environment.name}」看起来是生产环境。请与用户确认后带 confirmProduction: true 再调用。`,
      );
    };

    const identityDraftFrom = (
      environmentId: string,
      item: Record<string, unknown>,
    ): IdentityDraft => {
      const draft: IdentityDraft = {
        environmentId,
        name: String(item["name"] ?? ""),
        username: String(item["username"] ?? ""),
        role: typeof item["role"] === "string" ? item["role"] : "member",
        color: (item["color"] as IdentityDraft["color"]) ?? "slate",
        passwordMode: item["password"] ? "custom" : "inherit",
        startPath: typeof item["startPath"] === "string" ? item["startPath"] : "/",
        ...(typeof item["engineId"] === "string" ? { engineId: item["engineId"] } : {}),
        ...(Array.isArray(item["extraFields"])
          ? { extraFields: item["extraFields"] as IdentityDraft["extraFields"] }
          : {}),
        ...(typeof item["note"] === "string" ? { note: item["note"] } : {}),
      };
      return identityDraftSchema.parse(draft);
    };

    return [
      {
        name: "get_workspace_summary",
        description: "查看当前 Ensemble 工作区概览：环境、身份、场景、运行中实例的数量与名称。",
        kind: "read",
        inputSchema: object({}),
        run: () => {
          const snapshot = service.snapshot();
          return {
            environments: snapshot.environments.map((environment) => ({
              id: environment.id,
              name: environment.name,
              baseUrl: environment.baseUrl,
              identityCount: snapshot.identities.filter(
                (identity) => identity.environmentId === environment.id,
              ).length,
              sceneCount: snapshot.scenes.filter((scene) => scene.environmentId === environment.id)
                .length,
            })),
            running: snapshot.instances.map((instance) => ({
              id: instance.id,
              label: instance.label,
              mode: instance.mode,
              identityId: instance.identityId ?? null,
            })),
            layoutPresets: [
              ...snapshot.layoutPresets.map((preset) => ({ id: preset.id, name: preset.name })),
              { id: "2x2", name: "2 × 2" },
            ],
          };
        },
      },
      {
        name: "list_environments",
        description: "列出所有环境（被测目标作用域）。",
        kind: "read",
        inputSchema: object({}),
        run: () => service.snapshot().environments.map(environmentSummary),
      },
      {
        name: "list_identities",
        description: "列出身份。可按 environmentId 过滤。不会返回密码。",
        kind: "read",
        inputSchema: object({ environmentId: string("只看该环境的身份") }),
        run: (args) => {
          const environmentId = args["environmentId"];
          return service
            .snapshot()
            .identities.filter(
              (identity) => !environmentId || identity.environmentId === environmentId,
            )
            .map(identitySummary);
        },
      },
      {
        name: "list_scenes",
        description: "列出场景。可按 environmentId 过滤。",
        kind: "read",
        inputSchema: object({ environmentId: string("只看该环境的场景") }),
        run: (args) => {
          const environmentId = args["environmentId"];
          return service
            .snapshot()
            .scenes.filter((scene) => !environmentId || scene.environmentId === environmentId)
            .map(sceneSummary);
        },
      },
      {
        name: "list_layouts",
        description: "列出可用窗口布局：内置预设与用户自定义预设。",
        kind: "read",
        inputSchema: object({}),
        run: () => {
          const snapshot = service.snapshot();
          return {
            builtin: [
              { id: "free", name: "Free / 无布局" },
              { id: "1x1", name: "1 × 1" },
              { id: "2x1", name: "2 × 1" },
              { id: "1x2", name: "1 × 2" },
              { id: "2x2", name: "2 × 2" },
              { id: "3x1", name: "3 × 1" },
            ],
            custom: snapshot.layoutPresets.map((preset) => ({
              id: preset.id,
              name: preset.name,
              slots: preset.slots,
            })),
          };
        },
      },
      {
        name: "create_environment",
        description:
          "创建被测环境。baseUrl 是容器或站点地址；loginPath 默认 /login。可在 extraFields 里声明租户名等额外登录字段。",
        kind: "write",
        inputSchema: object(
          {
            name: string("环境名称，例如 订单服务-测试环境"),
            baseUrl: string("站点地址，例如 http://localhost:3000"),
            loginPath: string("登录入口，默认 /login"),
            authCheckPath: string("登录态检测地址，可省略"),
            defaultEngineId: string("默认浏览器引擎 id，可省略"),
            autoSubmit: { type: "boolean", description: "填充后是否自动提交" },
            extraFields: {
              type: "array",
              description: "额外登录字段，例如租户名",
              items: object({ label: string("字段名"), value: string("字段值") }, [
                "label",
                "value",
              ]),
            },
          },
          ["name", "baseUrl"],
        ),
        run: (args) => {
          const draft = environmentDraftSchema.parse({
            name: args["name"],
            baseUrl: args["baseUrl"],
            loginPath: args["loginPath"] ?? "/login",
            autoSubmit: args["autoSubmit"] === true,
            ...(args["authCheckPath"] ? { authCheckPath: args["authCheckPath"] } : {}),
            ...(args["defaultEngineId"] ? { defaultEngineId: args["defaultEngineId"] } : {}),
            ...(Array.isArray(args["extraFields"]) ? { extraFields: args["extraFields"] } : {}),
          });
          const environment = service.saveEnvironment(draft);
          return environmentSummary(environment);
        },
      },
      {
        name: "update_environment",
        description: "修改环境。只传需要改的字段。",
        kind: "write",
        inputSchema: object(
          {
            id: string("环境 id"),
            name: string("新名称"),
            baseUrl: string("新站点地址"),
            loginPath: string("新登录入口"),
            authCheckPath: string("新检测地址"),
            defaultEngineId: string("默认引擎 id"),
            autoSubmit: { type: "boolean", description: "填充后是否自动提交" },
          },
          ["id"],
        ),
        run: (args) => {
          const existing = findEnvironment(args["id"]);
          const draft: EnvironmentDraft = {
            id: existing.id,
            name: typeof args["name"] === "string" ? args["name"] : existing.name,
            baseUrl: typeof args["baseUrl"] === "string" ? args["baseUrl"] : existing.baseUrl,
            loginPath:
              typeof args["loginPath"] === "string" ? args["loginPath"] : existing.loginPath,
            authCheckPath:
              typeof args["authCheckPath"] === "string"
                ? args["authCheckPath"]
                : existing.authCheckPath,
            defaultEngineId:
              typeof args["defaultEngineId"] === "string"
                ? args["defaultEngineId"]
                : existing.defaultEngineId,
            autoSubmit:
              typeof args["autoSubmit"] === "boolean" ? args["autoSubmit"] : existing.autoSubmit,
            extraFields: existing.extraFields,
          };
          return environmentSummary(service.saveEnvironment(environmentDraftSchema.parse(draft)));
        },
      },
      {
        name: "create_identity",
        description:
          "录入一个账号身份。password 只写入加密凭据库，不会回显；不传则继承环境默认密码。",
        kind: "write",
        inputSchema: object(
          {
            environmentId: string("所属环境 id"),
            name: string("显示名称，例如 管理员 · 主账号"),
            username: string("账号"),
            password: string("密码，写入加密凭据库后不回显"),
            role: string("角色标签，默认 member"),
            color: {
              type: "string",
              enum: ["amber", "teal", "violet", "rose", "blue", "slate"],
              description: "身份色",
            },
            engineId: string("覆盖环境默认引擎"),
            startPath: string("起始路径，默认 /"),
            note: string("备注"),
            extraFields: {
              type: "array",
              description: "该身份专用的额外登录字段",
              items: object({ label: string("字段名"), value: string("字段值") }, [
                "label",
                "value",
              ]),
            },
          },
          ["environmentId", "name", "username"],
        ),
        run: (args) => {
          const environment = findEnvironment(args["environmentId"]);
          const draft = identityDraftFrom(environment.id, args);
          const password = typeof args["password"] === "string" ? args["password"] : undefined;
          const identity = service.saveIdentity(draft, password);
          return identitySummary(identity);
        },
      },
      {
        name: "create_identities",
        description:
          "批量录入账号身份。每项字段与 create_identity 相同（不含 environmentId）。部分失败会在 failures 里返回，不影响已成功的条目。",
        kind: "write",
        inputSchema: object(
          {
            environmentId: string("所属环境 id"),
            identities: {
              type: "array",
              minItems: 1,
              items: object(
                {
                  name: string("显示名称"),
                  username: string("账号"),
                  password: string("密码，不回显"),
                  role: string("角色标签"),
                  color: {
                    type: "string",
                    enum: ["amber", "teal", "violet", "rose", "blue", "slate"],
                  },
                  startPath: string("起始路径"),
                  note: string("备注"),
                },
                ["name", "username"],
              ),
            },
          },
          ["environmentId", "identities"],
        ),
        run: (args) => {
          const environment = findEnvironment(args["environmentId"]);
          const items = Array.isArray(args["identities"]) ? args["identities"] : [];
          if (items.length === 0) throw new Error("identities 不能为空");
          const created: ReturnType<typeof identitySummary>[] = [];
          const failures: Array<{ index: number; name: unknown; error: string }> = [];
          for (const [index, item] of items.entries()) {
            try {
              const record = item as Record<string, unknown>;
              const draft = identityDraftFrom(environment.id, record);
              const password =
                typeof record["password"] === "string" ? record["password"] : undefined;
              created.push(identitySummary(service.saveIdentity(draft, password)));
            } catch (error) {
              failures.push({
                index,
                name: (item as Record<string, unknown> | null)?.["name"] ?? null,
                error: (error as Error).message,
              });
            }
          }
          return { created, failures };
        },
      },
      {
        name: "update_identity",
        description: "修改身份资料。password 只写入凭据库，不回显。",
        kind: "write",
        inputSchema: object(
          {
            id: string("身份 id"),
            name: string("显示名称"),
            username: string("账号"),
            password: string("新密码"),
            role: string("角色标签"),
            color: {
              type: "string",
              enum: ["amber", "teal", "violet", "rose", "blue", "slate"],
            },
            engineId: string("覆盖引擎"),
            startPath: string("起始路径"),
            note: string("备注"),
          },
          ["id"],
        ),
        run: (args) => {
          const existing = findIdentity(args["id"]);
          const draft: IdentityDraft = {
            id: existing.id,
            environmentId: existing.environmentId,
            name: typeof args["name"] === "string" ? args["name"] : existing.name,
            username: typeof args["username"] === "string" ? args["username"] : existing.username,
            role: typeof args["role"] === "string" ? args["role"] : existing.role,
            color: (args["color"] as IdentityDraft["color"]) ?? existing.color,
            engineId: typeof args["engineId"] === "string" ? args["engineId"] : existing.engineId,
            startPath:
              typeof args["startPath"] === "string" ? args["startPath"] : existing.startPath,
            passwordMode: typeof args["password"] === "string" ? "custom" : existing.passwordMode,
            extraFields: existing.extraFields,
            note: typeof args["note"] === "string" ? args["note"] : existing.note,
          };
          const password = typeof args["password"] === "string" ? args["password"] : undefined;
          return identitySummary(service.saveIdentity(identityDraftSchema.parse(draft), password));
        },
      },
      {
        name: "set_password",
        description:
          "单独写入密码（只写不读）。ownerKind 为 environment 时写环境默认密码，为 identity 时写身份密码。",
        kind: "write",
        inputSchema: object(
          {
            ownerKind: {
              type: "string",
              enum: ["environment", "identity"],
              description: "归属类型",
            },
            ownerId: string("环境或身份 id"),
            password: string("密码"),
          },
          ["ownerKind", "ownerId", "password"],
        ),
        run: (args) => {
          const ownerKind = args["ownerKind"] === "environment" ? "environment" : "identity";
          const ownerId = String(args["ownerId"] ?? "");
          const password = String(args["password"] ?? "");
          if (!ownerId || !password) throw new Error("ownerId 与 password 都不能为空");
          service.setPassword({ kind: ownerKind, id: ownerId }, password);
          return { ownerKind, ownerId, stored: true };
        },
      },
      {
        name: "create_scene",
        description:
          "创建场景。identityIds 按启动顺序排列；layoutId 默认 2x2，可选 free/1x1/2x1/1x2/2x2/3x1 或自定义预设 id。",
        kind: "write",
        inputSchema: object(
          {
            environmentId: string("所属环境 id"),
            name: string("场景名称"),
            identityIds: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
              description: "成员身份 id，按启动顺序",
            },
            layoutId: string("布局 id，默认 2x2"),
            slotAssignments: {
              type: "object",
              description: "identityId → 槽位下标（从 0 开始）",
              additionalProperties: { type: "integer" },
            },
          },
          ["environmentId", "name", "identityIds"],
        ),
        run: (args) => {
          const environment = findEnvironment(args["environmentId"]);
          const draft: SceneDraft = sceneDraftSchema.parse({
            environmentId: environment.id,
            name: args["name"],
            identityIds: args["identityIds"],
            layoutId: typeof args["layoutId"] === "string" ? args["layoutId"] : "2x2",
            slotAssignments: args["slotAssignments"] ?? {},
            paths: {},
          });
          return sceneSummary(service.saveScene(draft));
        },
      },
      {
        name: "update_scene",
        description: "修改场景名称、成员、布局或槽位分配。只传需要改的字段。",
        kind: "write",
        inputSchema: object(
          {
            id: string("场景 id"),
            name: string("新名称"),
            identityIds: { type: "array", items: { type: "string" }, description: "新成员列表" },
            layoutId: string("新布局 id"),
            slotAssignments: {
              type: "object",
              additionalProperties: { type: "integer" },
              description: "identityId → 槽位下标",
            },
          },
          ["id"],
        ),
        run: (args) => {
          const existing = findScene(args["id"]);
          const draft: SceneDraft = {
            id: existing.id,
            environmentId: existing.environmentId,
            name: typeof args["name"] === "string" ? args["name"] : existing.name,
            identityIds: Array.isArray(args["identityIds"])
              ? (args["identityIds"] as string[])
              : existing.identityIds,
            layoutId: typeof args["layoutId"] === "string" ? args["layoutId"] : existing.layoutId,
            slotAssignments:
              typeof args["slotAssignments"] === "object" && args["slotAssignments"] !== null
                ? (args["slotAssignments"] as Record<string, number>)
                : existing.slotAssignments,
            paths: existing.paths,
          };
          return sceneSummary(service.saveScene(sceneDraftSchema.parse(draft)));
        },
      },
      {
        name: "set_scene_layout",
        description: "只切换场景的窗口布局，不改成员。",
        kind: "write",
        inputSchema: object({ sceneId: string("场景 id"), layoutId: string("布局 id") }, [
          "sceneId",
          "layoutId",
        ]),
        run: (args) => {
          const scene = findScene(args["sceneId"]);
          service.setSceneLayout(scene.id, String(args["layoutId"] ?? "2x2"));
          return sceneSummary(findScene(scene.id));
        },
      },
      {
        name: "create_layout_preset",
        description:
          "保存自定义窗口布局。slots 使用相对坐标（0–1），例如 [{x:0,y:0,width:0.6,height:1},{x:0.6,y:0,width:0.4,height:1}]。",
        kind: "write",
        inputSchema: object(
          {
            name: string("布局名称"),
            slots: {
              type: "array",
              minItems: 1,
              items: object(
                {
                  x: { type: "number", description: "左边界比例 0–1" },
                  y: { type: "number", description: "上边界比例 0–1" },
                  width: { type: "number", description: "宽度比例" },
                  height: { type: "number", description: "高度比例" },
                },
                ["x", "y", "width", "height"],
              ),
            },
          },
          ["name", "slots"],
        ),
        run: (args) =>
          service.saveLayoutPreset(
            layoutPresetDraftSchema.parse({ name: args["name"], slots: args["slots"] }),
          ),
      },
      {
        name: "launch_scene",
        description:
          "启动场景：按布局打开成员窗口并自动填充。生产环境需要 confirmProduction: true。",
        kind: "run",
        inputSchema: object(
          {
            sceneId: string("场景 id"),
            confirmProduction: {
              type: "boolean",
              description: "生产环境必须显式确认",
            },
          },
          ["sceneId"],
        ),
        run: async (args) => {
          const scene = findScene(args["sceneId"]);
          guardProduction(findEnvironment(scene.environmentId), args);
          const result = await service.launchScene(scene.id);
          return {
            instances: result.identities.map((identity) => ({
              identityId: identity.id,
              name: identity.name,
            })),
          };
        },
      },
      {
        name: "launch_identity",
        description: "单独启动一个身份。生产环境需要 confirmProduction: true。",
        kind: "run",
        inputSchema: object(
          {
            identityId: string("身份 id"),
            confirmProduction: { type: "boolean", description: "生产环境必须显式确认" },
          },
          ["identityId"],
        ),
        run: async (args) => {
          const identity = findIdentity(args["identityId"]);
          guardProduction(findEnvironment(identity.environmentId), args);
          const result = await service.launchIdentity(identity.id);
          return { instanceId: result.instance.id, label: result.instance.label };
        },
      },
      {
        name: "stop_all",
        description: "关闭全部由 Ensemble 启动的浏览器窗口。",
        kind: "run",
        inputSchema: object({}),
        run: async () => {
          await service.stopAll();
          return { stopped: true };
        },
      },
      {
        name: "stop_instance",
        description: "关闭一个正在运行的实例。",
        kind: "run",
        inputSchema: object({ instanceId: string("实例 id") }, ["instanceId"]),
        run: async (args) => {
          await service.stopInstance(String(args["instanceId"] ?? ""));
          return { stopped: true };
        },
      },
      {
        name: "check_auth",
        description: "检测某个身份是否仍处于登录状态。",
        kind: "run",
        inputSchema: object({ identityId: string("身份 id") }, ["identityId"]),
        run: async (args) => service.checkAuth(String(args["identityId"] ?? "")),
      },
      {
        name: "delete_identity",
        description: "删除身份及其凭据。破坏性操作，必须传 confirm: true。",
        kind: "danger",
        inputSchema: object({ id: string("身份 id"), confirm: { type: "boolean" } }, [
          "id",
          "confirm",
        ]),
        run: (args) => {
          requireConfirm(args);
          const identity = findIdentity(args["id"]);
          service.deleteIdentity(identity.id);
          return { deleted: identity.id };
        },
      },
      {
        name: "delete_scene",
        description: "删除场景（不影响身份）。破坏性操作，必须传 confirm: true。",
        kind: "danger",
        inputSchema: object({ id: string("场景 id"), confirm: { type: "boolean" } }, [
          "id",
          "confirm",
        ]),
        run: (args) => {
          requireConfirm(args);
          const scene = findScene(args["id"]);
          service.deleteScene(scene.id);
          return { deleted: scene.id };
        },
      },
      {
        name: "delete_environment",
        description: "删除环境及其下全部身份、场景与凭据。破坏性操作，必须传 confirm: true。",
        kind: "danger",
        inputSchema: object({ id: string("环境 id"), confirm: { type: "boolean" } }, [
          "id",
          "confirm",
        ]),
        run: (args) => {
          requireConfirm(args);
          const environment = findEnvironment(args["id"]);
          service.deleteEnvironment(environment.id);
          return { deleted: environment.id };
        },
      },
    ];
  }
}
