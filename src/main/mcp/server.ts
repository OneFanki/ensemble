import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { WorkspaceService } from "@core/service";
import { JsonStore } from "@core/storage/json-store";
import {
  identityDraftSchema,
  layoutPresetDraftSchema,
  siteDraftSchema,
  siteTagDraftSchema,
  viewDraftSchema,
} from "@shared/schemas";
import type {
  Identity,
  IdentityDraft,
  McpSettings,
  McpStatus,
  Site,
  SiteDraft,
  View,
  ViewDraft,
} from "@shared/types";

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

/**
 * What the MCP layer needs from the in-app browser.
 *
 * Declared structurally rather than importing `EmbeddedBrowser`: that class lives
 * beside Electron, and the MCP server must stay constructible in a plain Node
 * test. When the surface is absent the browser tools report it as unavailable.
 */
export interface EmbeddedSurface {
  state(): {
    tabs: Array<{ id: string; label: string; url: string; title: string; identityId?: string }>;
    views?: Array<{ id: string; name: string; layoutId: string }>;
    activeTabId?: string;
    activeViewId?: string;
  };
  createTab(input: {
    url?: string;
    identityId?: string;
    siteId?: string;
    label?: string;
    color?: string;
  }): Promise<unknown>;
  navigate(tabId: string, url: string): Promise<unknown>;
  closeTab(tabId: string): unknown;
  activate(tabId: string): unknown;
  snapshotDom(tabId: string, options?: { maxNodes?: number }): Promise<unknown>;
  click(tabId: string, selector: string): Promise<unknown>;
  type(
    tabId: string,
    selector: string,
    text: string,
    options?: { submit?: boolean; clear?: boolean },
  ): Promise<unknown>;
  evaluate(tabId: string, expression: string): Promise<unknown>;
  screenshot(
    tabId: string,
    options?: { format?: "png" | "jpeg"; quality?: number },
  ): Promise<{ path: string; bytes: number }>;
  visibility(tabId: string, selector: string): Promise<unknown>;
  /** `viewId` omitted means the view currently on stage. */
  setLayout(layoutId: string, viewId?: string): unknown;
  pinTab(slotIndex: number, tabId: string | null, viewId?: string): unknown;
  fillLogin(tabId: string): Promise<unknown>;
  defaultTabId(requested?: string): string;
  /** Id of the view on stage, so layout tools do not need one spelled out. */
  defaultViewId(): string | undefined;
  /** View a layout call should use; may group loose tabs into a new one. */
  layoutTargetView(layoutId?: string): string | undefined;
  /** Opens a saved view definition as a container on the built-in surface. */
  openView(viewId: string): Promise<unknown>;
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
  // 0 means "let the OS pick a free port". It is not settable from the UI; the
  // end-to-end tests use it so they cannot collide with a port some other process
  // (or a previous run) already holds.
  if (port === 0) return 0;
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
  // 0 is honoured as "let the OS pick a port"; it is what tests write so they
  // never fight over a fixed number.
  const port =
    raw.port === 0 || (typeof raw.port === "number" && raw.port >= 1024 && raw.port <= 65_535)
      ? (raw.port as number)
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
  /** Port the current socket is on, kept after close so status() stays readable. */
  private cachedPort = 0;

  constructor(
    private readonly options: {
      settingsPath: string;
      auditPath: string;
      service: WorkspaceService;
      appVersion: string;
      /**
       * The in-app browser surface. Optional so the server can be constructed in
       * tests without an Electron window; when absent the browser tools report
       * that the surface is unavailable instead of crashing.
       */
      embedded?: EmbeddedSurface;
      onChange?: () => void;
    },
  ) {
    this.settings = loadMcpSettings(options.settingsPath);
  }

  settingsSnapshot(): McpSettings {
    return { ...this.settings };
  }

  /**
   * Port the socket is actually bound to.
   *
   * When the stored port is 0 the OS assigns one, and when a bind fails the
   * stored port is a lie. Reporting the live address keeps `status()` honest —
   * a client that trusted the configured number would post into the void.
   */
  private boundPort(): number | undefined {
    const address = this.server?.address();
    if (address && typeof address !== "string") return address.port;
    return this.cachedPort > 0 ? this.cachedPort : undefined;
  }

  status(): McpStatus {
    const port = this.boundPort() ?? this.settings.port;
    return {
      enabled: this.settings.enabled,
      running: this.running,
      port,
      url: `http://127.0.0.1:${port}/mcp`,
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
        const address = server.address();
        this.cachedPort =
          address && typeof address !== "string" ? address.port : this.settings.port;
        console.log(`[mcp] listening on http://127.0.0.1:${this.cachedPort}/mcp`);
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
    // The Host header must name the port the socket is really on: with a stored
    // port of 0 the configured value says nothing about where the server listens.
    const port = this.boundPort() ?? this.cachedPort;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
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
          const missing = this.missingArguments(tool, params.arguments ?? {});
          if (missing.length > 0) {
            // Validated here rather than inside each tool: a tool that silently
            // ran with an empty selector would click whatever happened to be
            // first on the page, which is worse than a protocol error.
            const messageText = `缺少必填参数：${missing.join(", ")}`;
            this.audit(tool.name, params.arguments, false, messageText);
            send(200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: messageText },
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

  /**
   * Names from the schema's `required` list that are absent or blank.
   *
   * Only presence is checked, not types: the schemas here are hand-written JSON
   * Schema fragments and every tool coerces its own arguments. This is the last
   * guard against a request that would otherwise act on an empty selector.
   */
  private missingArguments(tool: ToolDefinition, args: Record<string, unknown>): string[] {
    const required = tool.inputSchema["required"];
    if (!Array.isArray(required)) return [];
    return required.filter((name: unknown) => {
      if (typeof name !== "string") return false;
      // `confirm` is checked by the tool itself, which explains what it is for;
      // a generic "missing argument" message would be worse there.
      if (name === "confirm") return false;
      const value = args[name];
      if (value === undefined || value === null) return true;
      return typeof value === "string" && value.trim() === "";
    });
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

    const siteSummary = (site: Site) => ({
      id: site.id,
      name: site.name,
      baseUrl: site.baseUrl,
      loginPath: site.loginPath,
      ...(site.authCheckPath ? { authCheckPath: site.authCheckPath } : {}),
      defaultEngineId: site.defaultEngineId ?? null,
      autoSubmit: site.autoSubmit,
      // The origin the password was last used with; a different current origin
      // means filling will ask for confirmation first.
      lastOrigin: site.lastOrigin ?? null,
      extraFields: site.extraFields ?? [],
      identityCount: service.snapshot().identities.filter((identity) => identity.siteId === site.id)
        .length,
      viewCount: service.snapshot().views.filter((view) => view.siteId === site.id).length,
    });

    const identitySummary = (identity: Identity) => ({
      id: identity.id,
      siteId: identity.siteId,
      name: identity.name,
      username: identity.username,
      role: identity.role,
      color: identity.color,
      engineId: identity.engineId ?? null,
      startPath: identity.startPath ?? null,
      passwordMode: identity.passwordMode,
      credentialFrom: identity.credentialFrom ?? null,
      hasPassword: Boolean(service.snapshot().credentials.identity[identity.id]),
      extraFields: identity.extraFields ?? [],
      note: identity.note ?? null,
    });

    const viewSummary = (view: View) => ({
      id: view.id,
      siteId: view.siteId,
      name: view.name,
      identityIds: view.identityIds,
      layoutId: view.layoutId,
      slotAssignments: view.slotAssignments,
      paths: view.paths,
    });

    const findSite = (id: unknown): Site => {
      const site = service.snapshot().sites.find((item) => item.id === id);
      if (!site) throw new Error(`站点不存在：${String(id)}`);
      return site;
    };
    const findIdentity = (id: unknown): Identity => {
      const identity = service.snapshot().identities.find((item) => item.id === id);
      if (!identity) throw new Error(`身份不存在：${String(id)}`);
      return identity;
    };
    const findView = (id: unknown): View => {
      const view = service.snapshot().views.find((item) => item.id === id);
      if (!view) throw new Error(`视图不存在：${String(id)}`);
      return view;
    };

    const requireConfirm = (args: Record<string, unknown>, field = "confirm"): void => {
      if (args[field] !== true) {
        throw new Error(`这是破坏性操作，必须显式传 ${field}: true 才会执行。请先与用户确认。`);
      }
    };

    const identityDraftFrom = (siteId: string, item: Record<string, unknown>): IdentityDraft => {
      // An explicit credentialFrom wins over `password`: a reference reuses the
      // source identity's credentials, so a password here would be contradictory.
      const credentialFrom =
        typeof item["credentialFrom"] === "string" && item["credentialFrom"]
          ? item["credentialFrom"]
          : undefined;
      const draft: IdentityDraft = {
        siteId,
        name: String(item["name"] ?? ""),
        username: String(item["username"] ?? ""),
        role: typeof item["role"] === "string" ? item["role"] : "member",
        color: (item["color"] as IdentityDraft["color"]) ?? "slate",
        passwordMode: credentialFrom ? "reference" : item["password"] ? "custom" : "inherit",
        ...(credentialFrom ? { credentialFrom } : {}),
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
        description: "查看当前 Ensemble 工作区概览：站点、身份、视图、运行中实例的数量与名称。",
        kind: "read",
        inputSchema: object({}),
        run: () => {
          const snapshot = service.snapshot();
          return {
            sites: snapshot.sites.map((site) => ({
              id: site.id,
              name: site.name,
              baseUrl: site.baseUrl,
              identityCount: snapshot.identities.filter((identity) => identity.siteId === site.id)
                .length,
              viewCount: snapshot.views.filter((view) => view.siteId === site.id).length,
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
        name: "list_sites",
        description: "列出所有站点（被测目标作用域），含各自的标签。",
        kind: "read",
        inputSchema: object({}),
        run: () => {
          const snapshot = service.snapshot();
          const tags = new Map(snapshot.siteTags.map((tag) => [tag.id, tag.name]));
          return snapshot.sites.map((site) => ({
            ...siteSummary(site),
            tags: (site.tagIds ?? []).map((id) => tags.get(id) ?? id),
          }));
        },
      },
      {
        name: "list_site_tags",
        description: "列出站点标签。标签只用于归类展示，不影响任何业务规则。",
        kind: "read",
        inputSchema: object({}),
        run: () => service.snapshot().siteTags,
      },
      {
        name: "save_site_tag",
        description:
          "创建或重命名站点标签。标签只决定站点列表和切换器怎么分组；删除标签不会影响站点和账号。",
        kind: "write",
        inputSchema: object(
          {
            id: string("标签 id；省略表示新建"),
            name: string("标签名称"),
            color: {
              type: "string",
              enum: ["amber", "teal", "violet", "rose", "blue", "slate"],
              description: "标签颜色",
            },
          },
          ["name", "color"],
        ),
        run: (args) => {
          const draft = siteTagDraftSchema.parse({
            ...(typeof args["id"] === "string" && args["id"] ? { id: args["id"] } : {}),
            name: args["name"],
            color: args["color"],
          });
          return service.saveSiteTag(draft);
        },
      },
      {
        name: "delete_site_tag",
        description:
          "删除站点标签，并从所有站点上解除关联。站点与账号不受影响。破坏性操作，必须传 confirm: true。",
        kind: "danger",
        inputSchema: object({ id: string("标签 id"), confirm: { type: "boolean" } }, [
          "id",
          "confirm",
        ]),
        run: (args) => {
          requireConfirm(args);
          const id = String(args["id"] ?? "");
          if (!service.snapshot().siteTags.some((tag) => tag.id === id)) {
            throw new Error(`标签不存在：${id}`);
          }
          service.deleteSiteTag(id);
          return { deleted: id };
        },
      },
      {
        name: "list_identities",
        description: "列出身份。可按 siteId 过滤。不会返回密码。",
        kind: "read",
        inputSchema: object({ siteId: string("只看该站点的身份") }),
        run: (args) => {
          const siteId = args["siteId"];
          return service
            .snapshot()
            .identities.filter((identity) => !siteId || identity.siteId === siteId)
            .map(identitySummary);
        },
      },
      {
        name: "list_views",
        description: "列出视图。可按 siteId 过滤。",
        kind: "read",
        inputSchema: object({ siteId: string("只看该站点的视图") }),
        run: (args) => {
          const siteId = args["siteId"];
          return service
            .snapshot()
            .views.filter((view) => !siteId || view.siteId === siteId)
            .map(viewSummary);
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
              { id: "free", name: "Free / 无布局（等价于 1 × 1）" },
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
        name: "create_site",
        description:
          "创建被测站点。baseUrl 是容器或站点地址；loginPath 默认 /login。可在 extraFields 里声明租户名等额外登录字段。",
        kind: "write",
        inputSchema: object(
          {
            name: string("站点名称，例如 订单服务-测试站点"),
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
            tagIds: {
              type: "array",
              description: "站点标签 id 列表，只用于归类展示",
              items: { type: "string" },
            },
          },
          ["name", "baseUrl"],
        ),
        run: (args) => {
          const draft = siteDraftSchema.parse({
            name: args["name"],
            baseUrl: args["baseUrl"],
            loginPath: args["loginPath"] ?? "/login",
            autoSubmit: args["autoSubmit"] === true,
            ...(args["authCheckPath"] ? { authCheckPath: args["authCheckPath"] } : {}),
            ...(args["defaultEngineId"] ? { defaultEngineId: args["defaultEngineId"] } : {}),
            ...(Array.isArray(args["extraFields"]) ? { extraFields: args["extraFields"] } : {}),
            ...(Array.isArray(args["tagIds"]) ? { tagIds: args["tagIds"] } : {}),
          });
          const site = service.saveSite(draft);
          return siteSummary(site);
        },
      },
      {
        name: "update_site",
        description: "修改站点。只传需要改的字段。",
        kind: "write",
        inputSchema: object(
          {
            id: string("站点 id"),
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
          const existing = findSite(args["id"]);
          const draft: SiteDraft = {
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
            tagIds: Array.isArray(args["tagIds"]) ? (args["tagIds"] as string[]) : existing.tagIds,
          };
          return siteSummary(service.saveSite(siteDraftSchema.parse(draft)));
        },
      },
      {
        name: "create_identity",
        description:
          "录入一个账号身份。password 只写入加密凭据库，不会回显；不传则继承站点默认密码。",
        kind: "write",
        inputSchema: object(
          {
            siteId: string("所属站点 id"),
            name: string("显示名称，例如 管理员 · 主账号"),
            username: string("账号"),
            password: string("密码，写入加密凭据库后不回显"),
            role: string("角色标签，默认 member"),
            color: {
              type: "string",
              enum: ["amber", "teal", "violet", "rose", "blue", "slate"],
              description: "身份色",
            },
            engineId: string("覆盖站点默认引擎"),
            startPath: string("起始路径，默认 /"),
            note: string("备注"),
            credentialFrom: string(
              "引用另一个身份的凭据（跨站点复用账号）。传了就忽略 password，且被引用的身份不能再是引用。",
            ),
            extraFields: {
              type: "array",
              description: "该身份专用的额外登录字段",
              items: object({ label: string("字段名"), value: string("字段值") }, [
                "label",
                "value",
              ]),
            },
          },
          ["siteId", "name", "username"],
        ),
        run: (args) => {
          const site = findSite(args["siteId"]);
          const draft = identityDraftFrom(site.id, args);
          const password = typeof args["password"] === "string" ? args["password"] : undefined;
          const identity = service.saveIdentity(draft, password);
          return identitySummary(identity);
        },
      },
      {
        name: "create_identities",
        description:
          "批量录入账号身份。每项字段与 create_identity 相同（不含 siteId）。部分失败会在 failures 里返回，不影响已成功的条目。",
        kind: "write",
        inputSchema: object(
          {
            siteId: string("所属站点 id"),
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
          ["siteId", "identities"],
        ),
        run: (args) => {
          const site = findSite(args["siteId"]);
          const items = Array.isArray(args["identities"]) ? args["identities"] : [];
          if (items.length === 0) throw new Error("identities 不能为空");
          const created: ReturnType<typeof identitySummary>[] = [];
          const failures: Array<{ index: number; name: unknown; error: string }> = [];
          for (const [index, item] of items.entries()) {
            try {
              const record = item as Record<string, unknown>;
              const draft = identityDraftFrom(site.id, record);
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
            siteId: existing.siteId,
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
          "单独写入密码（只写不读）。ownerKind 为 site 时写站点默认密码，为 identity 时写身份密码。",
        kind: "write",
        inputSchema: object(
          {
            ownerKind: {
              type: "string",
              enum: ["site", "identity"],
              description: "归属类型",
            },
            ownerId: string("站点或身份 id"),
            password: string("密码"),
          },
          ["ownerKind", "ownerId", "password"],
        ),
        run: (args) => {
          const ownerKind = args["ownerKind"] === "site" ? "site" : "identity";
          const ownerId = String(args["ownerId"] ?? "");
          const password = String(args["password"] ?? "");
          if (!ownerId || !password) throw new Error("ownerId 与 password 都不能为空");
          service.setPassword({ kind: ownerKind, id: ownerId }, password);
          return { ownerKind, ownerId, stored: true };
        },
      },
      {
        name: "create_view",
        description:
          "创建视图。identityIds 按启动顺序排列；layoutId 默认 2x2，可选 free/1x1/2x1/1x2/2x2/3x1 或自定义预设 id。",
        kind: "write",
        inputSchema: object(
          {
            siteId: string("所属站点 id"),
            name: string("视图名称"),
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
          ["siteId", "name", "identityIds"],
        ),
        run: (args) => {
          const site = findSite(args["siteId"]);
          const draft: ViewDraft = viewDraftSchema.parse({
            siteId: site.id,
            name: args["name"],
            identityIds: args["identityIds"],
            layoutId: typeof args["layoutId"] === "string" ? args["layoutId"] : "2x2",
            slotAssignments: args["slotAssignments"] ?? {},
            paths: {},
          });
          return viewSummary(service.saveView(draft));
        },
      },
      {
        name: "update_view",
        description: "修改视图名称、成员、布局或槽位分配。只传需要改的字段。",
        kind: "write",
        inputSchema: object(
          {
            id: string("视图 id"),
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
          const existing = findView(args["id"]);
          const draft: ViewDraft = {
            id: existing.id,
            siteId: existing.siteId,
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
          return viewSummary(service.saveView(viewDraftSchema.parse(draft)));
        },
      },
      {
        name: "set_view_layout",
        description: "只切换视图的窗口布局，不改成员。",
        kind: "write",
        inputSchema: object({ viewId: string("视图 id"), layoutId: string("布局 id") }, [
          "viewId",
          "layoutId",
        ]),
        run: (args) => {
          const view = findView(args["viewId"]);
          service.setViewLayout(view.id, String(args["layoutId"] ?? "2x2"));
          return viewSummary(findView(view.id));
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
        name: "launch_view",
        description: "启动视图：按布局打开成员窗口并自动填充。",
        kind: "run",
        inputSchema: object({ viewId: string("视图 id") }, ["viewId"]),
        run: async (args) => {
          const view = findView(args["viewId"]);
          const result = await service.launchView(view.id);
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
        description: "单独启动一个身份。",
        kind: "run",
        inputSchema: object({ identityId: string("身份 id") }, ["identityId"]),
        run: async (args) => {
          const identity = findIdentity(args["identityId"]);
          const result = await service.launchIdentity(identity.id);
          return { instanceId: result.instance.id, label: result.instance.label };
        },
      },
      {
        name: "launch_clean_session",
        description:
          "打开一个干净会话窗口：不登录、关闭即删除。传 siteId 时打开该站点登录页；不传则打开不属于任何站点的空白页。",
        kind: "run",
        inputSchema: object({
          siteId: string("站点 id；省略则打开空白页"),
        }),
        run: async (args) => {
          const siteId =
            typeof args["siteId"] === "string" && args["siteId"] ? args["siteId"] : undefined;
          const result = await service.launchCleanSession(siteId);
          return { instanceId: result.instance.id, siteId: result.instance.siteId };
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
        name: "detach_identity_reference",
        description:
          "把引用别的账号的身份断开成独立副本：当前解析出的密码会写成它自己的密码，此后两边各改各的。已经是独立身份时无变化。",
        kind: "write",
        inputSchema: object({ identityId: string("身份 id") }, ["identityId"]),
        run: (args) => {
          const id = String(args["identityId"] ?? "");
          if (!service.snapshot().identities.some((item) => item.id === id)) {
            throw new Error(`身份不存在：${id}`);
          }
          return identitySummary(service.detachReference(id));
        },
      },
      {
        name: "copy_view_to_site",
        description:
          "把一个视图复制到另一个站点。成员按用户名匹配：目标站点已有同名账号就直接使用，没有就新建一个引用该账号凭据的身份（登录态各自独立）。副本与原视图独立，不会实时同步。",
        kind: "write",
        inputSchema: object(
          {
            viewId: string("要复制的视图 id"),
            targetSiteId: string("目标站点 id"),
          },
          ["viewId", "targetSiteId"],
        ),
        run: (args) =>
          service.copyViewToSite(String(args["viewId"] ?? ""), String(args["targetSiteId"] ?? "")),
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
        name: "delete_view",
        description: "删除视图（不影响身份）。破坏性操作，必须传 confirm: true。",
        kind: "danger",
        inputSchema: object({ id: string("视图 id"), confirm: { type: "boolean" } }, [
          "id",
          "confirm",
        ]),
        run: (args) => {
          requireConfirm(args);
          const view = findView(args["id"]);
          service.deleteView(view.id);
          return { deleted: view.id };
        },
      },
      {
        name: "delete_site",
        description: "删除站点及其下全部身份、视图与凭据。破坏性操作，必须传 confirm: true。",
        kind: "danger",
        inputSchema: object({ id: string("站点 id"), confirm: { type: "boolean" } }, [
          "id",
          "confirm",
        ]),
        run: (args) => {
          requireConfirm(args);
          const site = findSite(args["id"]);
          service.deleteSite(site.id);
          return { deleted: site.id };
        },
      },
      ...this.browserTools(),
    ];
  }

  /**
   * Tools that drive the in-app browser surface.
   *
   * These are what let an AI run a real flow without opening a system window:
   * open a tab per identity, read what is actually rendered, click and type with
   * real input events, and capture screenshots. Page-side reading and clicking are
   * `run` (they change the page); listing is `read`. None of them can read a
   * password — filling uses the stored credential inside the main process and
   * returns only a summary.
   */
  private browserTools(): ToolDefinition[] {
    const surface = () => {
      const embedded = this.options.embedded;
      if (!embedded) {
        throw new Error("内置浏览器不可用：这个桌面端没有提供页面表面。");
      }
      return embedded;
    };
    const tabId = (args: Record<string, unknown>): string =>
      surface().defaultTabId(
        typeof args["tabId"] === "string" && args["tabId"] ? args["tabId"] : undefined,
      );

    return [
      {
        name: "list_browser_tabs",
        description:
          "列出内置浏览器当前打开的标签页（id、所属身份、标题、地址、当前布局）。这些标签页是持续存在的，多次会话之间不会关闭，登录态也保留。",
        kind: "read",
        inputSchema: object({}),
        run: () => surface().state(),
      },
      {
        name: "open_browser_view",
        description:
          "把保存好的视图（一组身份 + 布局）在内置浏览器里打开：每个成员一个标签页，按视图的布局摆好格位。重复调用会复用已经打开的标签页，登录态保留。",
        kind: "run",
        inputSchema: object({ viewId: string("视图 id") }, ["viewId"]),
        run: (args) => surface().openView(String(args["viewId"] ?? "")),
      },
      {
        name: "open_browser_tab",
        description:
          "在内置浏览器里打开一个标签页。传 identityId 时使用该身份独立的会话分区（与其他身份隔离，登录态持久保存）；不传则用空白会话。返回 tabId，后续所有操作都用它。不会弹出任何系统窗口。",
        kind: "run",
        inputSchema: object({
          url: string("要打开的地址；省略则打开空白页"),
          identityId: string("身份 id；省略则使用不属于任何身份的空白会话"),
          siteId: string("站点 id；仅用于界面分组显示"),
          label: string("标签页显示名；通常用身份名"),
        }),
        run: async (args) => {
          const rawUrl =
            typeof args["url"] === "string" && args["url"] ? args["url"] : "about:blank";
          const identityId =
            typeof args["identityId"] === "string" && args["identityId"]
              ? args["identityId"]
              : undefined;
          const identity = identityId
            ? this.options.service.snapshot().identities.find((item) => item.id === identityId)
            : undefined;
          if (identityId && !identity) throw new Error(`身份不存在：${identityId}`);
          const siteId = (typeof args["siteId"] === "string" && args["siteId"]) || identity?.siteId;
          const label = typeof args["label"] === "string" ? args["label"] : identity?.name;
          return surface().createTab({
            url: rawUrl,
            ...(identityId ? { identityId } : {}),
            ...(siteId ? { siteId } : {}),
            ...(label ? { label } : {}),
            ...(identity?.color ? { color: identity.color } : {}),
          });
        },
      },
      {
        name: "navigate_browser_tab",
        description: "让内置浏览器的一个标签页跳到指定地址，并等待加载完成。",
        kind: "run",
        inputSchema: object(
          { tabId: string("标签页 id；省略表示当前激活的标签页"), url: string("目标地址") },
          ["url"],
        ),
        run: (args) => surface().navigate(tabId(args), String(args["url"] ?? "")),
      },
      {
        name: "read_browser_page",
        description:
          "读取标签页当前渲染出来的内容：可见元素的角色、可访问名称、稳定选择器、位置，以及页面地址和标题。隐藏元素不会被包含，所以这就是「这个账号实际能看到什么」。用返回的 selector 配合 click/type 使用。",
        kind: "read",
        inputSchema: object({
          tabId: string("标签页 id；省略表示当前激活的标签页"),
          maxNodes: integer("最多返回多少个元素，默认 400"),
        }),
        run: (args) => {
          const max = Number(args["maxNodes"]);
          return surface().snapshotDom(tabId(args), {
            ...(Number.isFinite(max) && max > 0 ? { maxNodes: Math.trunc(max) } : {}),
          });
        },
      },
      {
        name: "check_element_visible",
        description:
          "检查某个选择器对应元素是否存在、是否可见。用于权限断言：同一个选择器在不同身份的标签页里应该有不同的可见性。",
        kind: "read",
        inputSchema: object(
          {
            tabId: string("标签页 id；省略表示当前激活的标签页"),
            selector: string("CSS 选择器"),
          },
          ["selector"],
        ),
        run: (args) => surface().visibility(tabId(args), String(args["selector"] ?? "")),
      },
      {
        name: "click_browser_element",
        description:
          "点击标签页里的一个元素。发送的是真实鼠标事件（不是脚本 click），因此会触发框架的事件处理。元素会先滚动到可见区域。",
        kind: "run",
        inputSchema: object(
          {
            tabId: string("标签页 id；省略表示当前激活的标签页"),
            selector: string("CSS 选择器"),
          },
          ["selector"],
        ),
        run: (args) => surface().click(tabId(args), String(args["selector"] ?? "")),
      },
      {
        name: "type_browser_text",
        description:
          "向标签页里的输入框输入文本。先聚焦目标元素，清空原内容（除非 clear: false），再逐字输入；submit: true 会在输入后按回车。密码不要走这里——用 fill_browser_login。",
        kind: "run",
        inputSchema: object(
          {
            tabId: string("标签页 id；省略表示当前激活的标签页"),
            selector: string("CSS 选择器"),
            text: string("要输入的文本"),
            submit: { type: "boolean", description: "输入后按回车" },
            clear: { type: "boolean", description: "先清空原有内容，默认 true" },
          },
          ["selector", "text"],
        ),
        run: (args) =>
          surface().type(tabId(args), String(args["selector"] ?? ""), String(args["text"] ?? ""), {
            submit: args["submit"] === true,
            clear: args["clear"] !== false,
          }),
      },
      {
        name: "fill_browser_login",
        description:
          "用该标签页所属身份保存的账号密码填充登录表单。密码始终留在主进程，不会出现在返回值里。跨域页面会被拒绝。",
        kind: "run",
        inputSchema: object({ tabId: string("标签页 id；省略表示当前激活的标签页") }),
        run: (args) => surface().fillLogin(tabId(args)),
      },
      {
        name: "screenshot_browser_tab",
        description:
          "给标签页截图，返回保存到磁盘的路径。窗口最小化时也能拿到画面；完全隐藏的窗口不行。",
        kind: "run",
        inputSchema: object({
          tabId: string("标签页 id；省略表示当前激活的标签页"),
          format: { type: "string", enum: ["png", "jpeg"], description: "默认 png" },
        }),
        run: (args) =>
          surface().screenshot(tabId(args), {
            format: args["format"] === "jpeg" ? "jpeg" : "png",
          }),
      },
      {
        name: "evaluate_browser_page",
        description:
          "在标签页里执行一段 JavaScript 表达式并返回结果。用于读取页面数据或做快照/对比脚本；表达式必须自己返回可序列化的值。",
        kind: "run",
        inputSchema: object(
          {
            tabId: string("标签页 id；省略表示当前激活的标签页"),
            expression: string("要执行的表达式"),
          },
          ["expression"],
        ),
        run: (args) => surface().evaluate(tabId(args), String(args["expression"] ?? "")),
      },
      {
        name: "set_browser_layout",
        description:
          "设置内置浏览器某个视图的分屏布局：free（单页，等价于 1x1）/ 2x1 / 1x2 / 2x2 / 3x1。省略 viewId 表示当前在台上的视图。",
        kind: "run",
        inputSchema: object(
          {
            layoutId: string("布局 id：free / 2x1 / 1x2 / 2x2 / 3x1"),
            viewId: string("视图 id；省略表示当前在台上的视图"),
          },
          ["layoutId"],
        ),
        run: (args) => {
          const layoutId = String(args["layoutId"] ?? "");
          const viewId =
            typeof args["viewId"] === "string" && args["viewId"]
              ? args["viewId"]
              : surface().layoutTargetView(layoutId);
          if (!viewId) throw new Error("当前没有打开的标签页");
          return surface().setLayout(layoutId, viewId);
        },
      },
      {
        name: "pin_browser_tab",
        description:
          "把某个标签页固定到视图的指定格位，或清空格位（tabId 传空）。省略 viewId 表示当前在台上的视图。",
        kind: "run",
        inputSchema: object(
          {
            slotIndex: integer("格位序号，从 0 开始"),
            tabId: string("标签页 id；省略或空字符串表示清空该格位"),
            viewId: string("视图 id；省略表示当前在台上的视图"),
          },
          ["slotIndex"],
        ),
        run: (args) => {
          const index = Number(args["slotIndex"]);
          if (!Number.isInteger(index) || index < 0) throw new Error("slotIndex 必须是非负整数");
          const viewId =
            typeof args["viewId"] === "string" && args["viewId"]
              ? args["viewId"]
              : surface().defaultViewId();
          if (!viewId) throw new Error("当前没有打开的视图");
          const id = typeof args["tabId"] === "string" && args["tabId"] ? args["tabId"] : null;
          return surface().pinTab(index, id, viewId);
        },
      },
      {
        name: "close_browser_tab",
        description: "关闭内置浏览器的一个标签页。只关页面，不影响该身份的登录态。",
        kind: "run",
        inputSchema: object({ tabId: string("标签页 id") }, ["tabId"]),
        run: (args) => surface().closeTab(String(args["tabId"] ?? "")),
      },
    ];
  }
}
