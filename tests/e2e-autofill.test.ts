import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "@core/cdp/browser";
import { MemorySecretBox } from "@core/credentials/vault";
import { cdpRegistry } from "@core/launch/browser";
import { WorkspaceService } from "@core/service";
import type { AutoFillReport } from "@shared/types";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Drives the real launch path against an installed Chromium engine. Opt in with
 * ENSEMBLE_E2E=1 so CI machines without a browser stay green.
 */
const enabled = process.env.ENSEMBLE_E2E === "1";

const LOGIN_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>用户登录</title></head>
<body>
<form id="login">
  <input type="text" name="tenant" placeholder="请输入租户名" />
  <input type="text" name="account" placeholder="请输入用户名" />
  <input type="password" name="pwd" placeholder="请输入密码" />
  <button type="submit">登录</button>
</form>
<pre id="out"></pre>
<script>
document.getElementById('login').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  document.getElementById('out').textContent = JSON.stringify(values);
  window.__submitted = values;
});
</script>
</body></html>`;

const servers: Server[] = [];
const cleanup: string[] = [];
let service: WorkspaceService | undefined;

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function listen(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function makeService(onAutoFill: (report: AutoFillReport) => void) {
  const userDataDir = await mkdtemp(join(tmpdir(), "ensemble-e2e-"));
  cleanup.push(userDataDir);
  const profileRoot = join(userDataDir, "profiles");
  await mkdir(profileRoot, { recursive: true });
  const created = new WorkspaceService({
    userDataDir,
    profileRoot,
    platform: process.platform as "win32" | "darwin" | "linux",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
    workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    onAutoFill,
  });
  await created.initialize();
  const engines = await created.scanAvailableEngines();
  const engine = engines.find((item) => item.family === "chromium" && item.cdp);
  if (!engine) throw new Error("需要至少一个可用的 Chromium 引擎");
  return { service: created, engine };
}

async function waitForReport(reports: AutoFillReport[]): Promise<AutoFillReport> {
  const deadline = Date.now() + 20_000;
  while (reports.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(reports).toHaveLength(1);
  return reports[0] as AutoFillReport;
}

afterAll(async () => {
  await service?.stopAll();
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    cleanup.map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {}),
    ),
  );
});

describe.skipIf(!enabled)("auto fill on launch (real browser)", () => {
  it("fills a three-input login form and reports the outcome", async () => {
    const baseUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(LOGIN_PAGE);
    });

    const reports: AutoFillReport[] = [];
    const { service: workspace, engine } = await makeService((report) => reports.push(report));
    service = workspace;

    const site = workspace.saveSite({
      name: "e2e",
      baseUrl,
      loginPath: "/login",
      defaultEngineId: engine.id,
      autoSubmit: true,
      extraFields: [{ label: "租户名", value: "acme" }],
    });
    workspace.setPassword({ kind: "site", id: site.id }, "s3cret!");

    const identity = workspace.saveIdentity({
      siteId: site.id,
      name: "admin",
      username: "admin",
      role: "admin",
      color: "amber",
      passwordMode: "inherit",
      startPath: "/login",
      extraFields: [],
    });

    const { instance } = await workspace.launchIdentity(identity.id);
    const report = await waitForReport(reports);

    expect(report).toMatchObject({
      identityId: identity.id,
      filled: true,
      submitted: true,
      missingFields: [],
    });

    const entry = cdpRegistry.get(instance.id);
    if (!entry) throw new Error("CDP 连接未登记");
    const submitted = await evaluate<Record<string, string> | undefined>(
      entry.page,
      "window.__submitted",
    );
    expect(submitted).toEqual({ tenant: "acme", account: "admin", pwd: "s3cret!" });

    // The profile must survive a normal stop; only clean sessions are disposable.
    expect(existsSync(instance.profileDir)).toBe(true);
    await workspace.stopInstance(instance.id);
    expect(existsSync(instance.profileDir)).toBe(true);
  }, 90_000);

  it("refuses to fill after a redirect to a foreign origin", async () => {
    // The second server plays the SSO host. The site lives on the first,
    // so typing credentials there would leak them across origins.
    const ssoUrl = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(LOGIN_PAGE);
    });
    const entryUrl = await listen((_request, response) => {
      response.writeHead(302, { location: `${ssoUrl}/sso` });
      response.end();
    });

    const reports: AutoFillReport[] = [];
    const { service: workspace, engine } = await makeService((report) => reports.push(report));
    service = workspace;

    const site = workspace.saveSite({
      name: "sso",
      baseUrl: entryUrl,
      loginPath: "/login",
      defaultEngineId: engine.id,
      autoSubmit: false,
      extraFields: [],
    });
    workspace.setPassword({ kind: "site", id: site.id }, "s3cret!");
    const identity = workspace.saveIdentity({
      siteId: site.id,
      name: "leak",
      username: "admin",
      role: "admin",
      color: "rose",
      passwordMode: "inherit",
      startPath: "/login",
      extraFields: [],
    });

    const { instance } = await workspace.launchIdentity(identity.id);
    const report = await waitForReport(reports);

    expect(report.filled).toBe(false);
    expect(report.skipped).toBe("cross-origin");

    // The redirect lands the window on the other origin; whatever it renders, no
    // password may have been typed into it.
    const entry = cdpRegistry.get(instance.id);
    if (!entry) throw new Error("CDP 连接未登记");
    const state = await evaluate<{ href: string; password: string }>(
      entry.page,
      `(() => {
        const field = document.querySelector('input[type="password"]');
        return { href: location.href, password: field ? field.value : "" };
      })()`,
    );
    expect(state.password).toBe("");
    expect(new URL(state.href).port).toBe(new URL(ssoUrl).port);
  }, 90_000);
});
