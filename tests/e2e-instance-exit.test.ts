import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { cdpRegistry } from "@core/launch/browser";
import { WorkspaceService } from "@core/service";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Real-browser check that a browser closed outside Ensemble disappears from the
 * instance list. Opt in with `pnpm test:e2e`.
 */
const enabled = process.env.ENSEMBLE_E2E === "1";

const cleanup: string[] = [];
const services: WorkspaceService[] = [];

async function makeService() {
  const userDataDir = await mkdtemp(join(tmpdir(), "ensemble-e2e-exit-"));
  cleanup.push(userDataDir);
  const profileRoot = join(userDataDir, "profiles");
  await mkdir(profileRoot, { recursive: true });
  const service = new WorkspaceService({
    userDataDir,
    profileRoot,
    platform: process.platform as "win32" | "darwin" | "linux",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
    workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  });
  services.push(service);
  await service.initialize();
  const engines = await service.scanAvailableEngines();
  const engine = engines.find((item) => item.family === "chromium" && item.cdp);
  if (!engine) throw new Error("需要至少一个可用的 Chromium 引擎");

  const environment = service.saveEnvironment({
    name: "exit",
    baseUrl: "http://127.0.0.1:1",
    loginPath: "/",
    defaultEngineId: engine.id,
    autoSubmit: false,
  });
  const identity = service.saveIdentity({
    environmentId: environment.id,
    name: "closer",
    username: "closer@example.test",
    role: "member",
    color: "blue",
    passwordMode: "inherit",
    startPath: "/",
  });
  return { service, identity };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return predicate();
}

afterAll(async () => {
  await Promise.all(services.map((service) => service.stopAll().catch(() => {})));
  await Promise.all(
    cleanup.map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {}),
    ),
  );
});

describe.skipIf(!enabled)("browser closed outside the app", () => {
  it("drops the instance once the browser closes its last window", async () => {
    const { service, identity } = await makeService();
    const { instance } = await service.launchIdentity(identity.id);
    expect(service.snapshot().instances).toHaveLength(1);

    // Quitting through the browser's own socket is what closing the last window
    // does; Ensemble did not initiate it, so the instance must clear itself.
    const entry = cdpRegistry.get(instance.id);
    if (!entry) throw new Error("CDP 连接未登记");
    await entry.browser.send("Browser.close", {}).catch(() => {});

    const cleared = await waitFor(() => service.snapshot().instances.length === 0);
    expect(cleared).toBe(true);
    expect(cdpRegistry.get(instance.id)).toBeUndefined();
  }, 90_000);

  it("also clears the instance when the browser process is killed", async () => {
    const { service, identity } = await makeService();
    const { instance } = await service.launchIdentity(identity.id);

    if (process.platform === "win32") {
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        execFile("taskkill", ["/PID", String(instance.pid), "/T", "/F"], () => resolve());
      });
    } else {
      process.kill(instance.pid, "SIGKILL");
    }

    const cleared = await waitFor(() => service.snapshot().instances.length === 0);
    expect(cleared).toBe(true);
  }, 90_000);

  it("removes the profile of a clean session that was closed by the user", async () => {
    const { service } = await makeService();
    const environments = service.snapshot().environments;
    const environmentId = environments[0]?.id;
    if (!environmentId) throw new Error("缺少环境");

    const { instance } = await service.launchCleanSession(environmentId);
    await writeFile(join(instance.profileDir, "marker.txt"), "x", "utf8");
    expect(existsSync(instance.profileDir)).toBe(true);

    const entry = cdpRegistry.get(instance.id);
    if (!entry) throw new Error("CDP 连接未登记");
    await entry.browser.send("Browser.close", {}).catch(() => {});

    // The directory is removed inline when possible and by a background retry
    // otherwise; give the retry its full budget before failing the case.
    const cleaned = await waitFor(() => !existsSync(instance.profileDir), 30_000);
    expect(cleaned).toBe(true);
    expect(service.snapshot().instances).toHaveLength(0);
  }, 90_000);

  it("raises a minimized browser window without relaunching it", async () => {
    const { service, identity } = await makeService();
    const { instance } = await service.launchIdentity(identity.id);
    const entry = cdpRegistry.get(instance.id);
    if (!entry) throw new Error("CDP 连接未登记");

    const info = await entry.browser.send<{ windowId: number }>("Browser.getWindowForTarget", {
      targetId: instance.targetId,
    });
    await entry.browser.send("Browser.setWindowBounds", {
      windowId: info.windowId,
      bounds: { windowState: "minimized" },
    });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(await service.focusInstance(instance.id)).toBe(true);

    // Window managers may ignore a programmatic minimize (Wayland in particular),
    // so only assert the restored state when it actually took effect.
    const state = await entry.browser.send<{ bounds: { windowState?: string } }>(
      "Browser.getWindowForTarget",
      { targetId: instance.targetId },
    );
    if (state.bounds.windowState) expect(state.bounds.windowState).toBe("normal");
    // Switching must raise the existing window, never replace it.
    expect(service.snapshot().instances).toHaveLength(1);
    expect(service.snapshot().instances[0]?.id).toBe(instance.id);
  }, 90_000);

  it("reports false when the instance has no CDP target", async () => {
    const { service } = await makeService();
    expect(await service.focusInstance("missing")).toBe(false);
  });

  it("closes only one scene's windows", async () => {
    const { service, identity } = await makeService();
    const environmentId = service.snapshot().environments[0]?.id;
    if (!environmentId) throw new Error("缺少环境");
    const other = service.saveIdentity({
      environmentId,
      name: "other",
      username: "other@example.test",
      role: "member",
      color: "teal",
      passwordMode: "inherit",
      startPath: "/",
    });
    const sceneDraft = (name: string, identityIds: string[]) => ({
      environmentId,
      name,
      identityIds,
      layoutId: "2x2" as const,
      slotAssignments: {},
      paths: {},
    });
    const first = service.saveScene(sceneDraft("first", [identity.id]));
    service.saveScene(sceneDraft("second", [other.id]));

    const launched = await Promise.all([
      service.launchIdentity(identity.id),
      service.launchIdentity(other.id),
    ]);
    expect(service.snapshot().instances).toHaveLength(2);

    await service.stopScene(first.id);

    // Only the scene's own window is gone; the window that belongs to the other
    // scene (or to no scene at all) is still running.
    const remaining = service.snapshot().instances;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.identityId).toBe(other.id);
    expect(remaining[0]?.id).toBe(launched[1].instance.id);
  }, 90_000);

  it("batch-launches a selection with the default layout and reuses running windows", async () => {
    const { service, identity } = await makeService();
    const environmentId = service.snapshot().environments[0]?.id;
    if (!environmentId) throw new Error("缺少环境");
    const second = service.saveIdentity({
      environmentId,
      name: "second",
      username: "second@example.test",
      role: "member",
      color: "violet",
      passwordMode: "inherit",
      startPath: "/",
    });
    service.saveSettings({ layout: "2x2" });

    const first = await service.launchIdentities([identity.id, second.id]);
    const instances = service.snapshot().instances;
    expect(instances).toHaveLength(2);
    expect(first.identities).toHaveLength(2);
    // Tiled, not stacked: each window gets its own slot of the default layout.
    expect(instances.map((item) => item.slotIndex).sort()).toEqual([0, 1]);

    // Asking again must raise the existing windows instead of opening duplicates.
    await service.launchIdentities([identity.id, second.id]);
    expect(service.snapshot().instances).toHaveLength(2);
  }, 90_000);
});
