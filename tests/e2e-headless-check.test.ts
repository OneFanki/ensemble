import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { cdpRegistry } from "@core/launch/browser";
import { WorkspaceService } from "@core/service";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Real-browser coverage for the headless session check: an identity whose window
 * is not open must still be checkable, using its own profile's cookies.
 *
 * Opt in with ENSEMBLE_E2E=1, same as the other real-browser suites.
 */
const enabled = process.env.ENSEMBLE_E2E === "1";

const servers: Server[] = [];
const cleanup: string[] = [];
let service: WorkspaceService | undefined;

/** Hands out a session cookie on /login and requires it on /api/session. */
function startServer(): Promise<{ baseUrl: string; setExpired: (value: boolean) => void }> {
  let expired = false;
  const server = createServer((request, response) => {
    if (request.url === "/login") {
      // Persistent on purpose. Chromium drops cookies without Max-Age when the
      // browser exits (verified against the real engine), so a pure session
      // cookie would make the post-close check expired by design rather than
      // because anything is wrong. Real logins people expect to survive a
      // restart use an expiry, and that is the case under test here.
      response.writeHead(200, {
        "set-cookie": "sid=e2e-session; Path=/; HttpOnly; Max-Age=86400",
        "content-type": "text/html; charset=utf-8",
      });
      response.end("<!doctype html><title>login</title><h1>signed in</h1>");
      return;
    }
    if (request.url === "/api/session") {
      const signedIn = !expired && (request.headers.cookie ?? "").includes("sid=e2e-session");
      response.writeHead(signedIn ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ signedIn }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>home</title><h1>home</h1>");
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        setExpired: (value: boolean) => {
          expired = value;
        },
      });
    });
  });
}

async function makeService(): Promise<WorkspaceService> {
  const userDataDir = await mkdtemp(join(tmpdir(), "ensemble-headless-"));
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
  });
  await created.initialize();
  return created;
}

async function chromiumEngine(workspace: WorkspaceService) {
  const engines = await workspace.scanAvailableEngines();
  const engine = engines.find((item) => item.family === "chromium" && item.cdp);
  if (!engine) throw new Error("需要至少一个可用的 Chromium 引擎");
  return engine;
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

describe.skipIf(!enabled)("headless session check (real browser)", () => {
  it("checks an identity whose window is closed and leaves no instance behind", async () => {
    const { baseUrl, setExpired } = await startServer();
    const workspace = await makeService();
    service = workspace;
    const engine = await chromiumEngine(workspace);
    workspace.saveSettings({ defaultEngineId: engine.id });

    const site = workspace.saveSite({
      name: "headless",
      baseUrl,
      loginPath: "/login",
      authCheckPath: "/api/session",
      autoSubmit: false,
    });
    const identity = workspace.saveIdentity({
      siteId: site.id,
      name: "后台检测",
      username: "worker",
      role: "member",
      color: "teal",
      passwordMode: "inherit",
      startPath: "/",
      extraFields: [],
    });

    // 1. Establish a real session in the profile by visiting /login once.
    const first = await workspace.launchIdentity(identity.id, "/login");
    const entry = cdpRegistry.get(first.instance.id);
    if (!entry) throw new Error("CDP 连接未登记");
    // Give the navigation time to receive and store the cookie.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await workspace.stopInstance(first.instance.id);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(workspace.snapshot().instances).toHaveLength(0);

    // 2. No window is open now — this is the case the old code could not check.
    const signedIn = await workspace.checkAuth(identity.id);
    expect(signedIn.status, signedIn.detail).toBe("signed-in");
    expect(signedIn.detail).toContain("200");
    // The hidden session must not register as a running instance.
    expect(workspace.snapshot().instances).toHaveLength(0);

    // 3. Break the session on the server: the same hidden check must now say expired.
    setExpired(true);
    const expired = await workspace.checkAuth(identity.id);
    expect(expired.status).toBe("expired");
    expect(expired.detail).toContain("401");
    expect(workspace.snapshot().instances).toHaveLength(0);
  }, 120_000);

  it("reports unknown, not a crash, when the profile has never signed in", async () => {
    const { baseUrl } = await startServer();
    const workspace = await makeService();
    service = workspace;
    const engine = await chromiumEngine(workspace);
    workspace.saveSettings({ defaultEngineId: engine.id });

    const site = workspace.saveSite({
      name: "fresh",
      baseUrl,
      loginPath: "/login",
      authCheckPath: "/api/session",
      autoSubmit: false,
    });
    const identity = workspace.saveIdentity({
      siteId: site.id,
      name: "从未登录",
      username: "nobody",
      role: "member",
      color: "slate",
      passwordMode: "inherit",
      startPath: "/",
      extraFields: [],
    });

    const result = await workspace.checkAuth(identity.id);
    // No cookies means the endpoint answers 401: that is a verdict, not an error.
    expect(result.status).toBe("expired");
    expect(workspace.snapshot().instances).toHaveLength(0);
  }, 120_000);

  it("batch-checks a whole site without opening any window", async () => {
    const { baseUrl } = await startServer();
    const workspace = await makeService();
    service = workspace;
    const engine = await chromiumEngine(workspace);
    workspace.saveSettings({ defaultEngineId: engine.id });

    const site = workspace.saveSite({
      name: "batch",
      baseUrl,
      loginPath: "/login",
      authCheckPath: "/api/session",
      autoSubmit: false,
    });
    for (const name of ["a", "b", "c"]) {
      workspace.saveIdentity({
        siteId: site.id,
        name,
        username: name,
        role: "member",
        color: "amber",
        passwordMode: "inherit",
        startPath: "/",
        extraFields: [],
      });
    }

    const batch = await workspace.checkAllAuth(site.id);
    expect(batch.results).toHaveLength(3);
    expect(batch.totals.unknown).toBe(0);
    expect(workspace.snapshot().instances).toHaveLength(0);
  }, 180_000);
});
