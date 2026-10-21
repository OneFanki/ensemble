import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import type { EnvironmentDraft, IdentityDraft, SceneDraft } from "@shared/types";
import { afterEach, describe, expect, it } from "vitest";

const plainBox: SecretBox = {
  available: false,
  backend: "plain",
  encrypt: (plain) => `plain:${Buffer.from(plain).toString("base64")}`,
  decrypt: (payload) => Buffer.from(payload.slice(6), "base64").toString("utf8"),
};

const created: string[] = [];

async function makeService(): Promise<{
  service: WorkspaceService;
  changes: () => number;
}> {
  const userDataDir = await mkdtemp(join(tmpdir(), "ensemble-health-"));
  created.push(userDataDir);
  const profileRoot = join(userDataDir, "profiles");
  await mkdir(profileRoot, { recursive: true });
  let changes = 0;
  const service = new WorkspaceService({
    userDataDir,
    profileRoot,
    platform: "win32",
    secretBox: plainBox,
    appVersion: "test",
    // A unit test must never start eight real browsers: the headless path is
    // exercised by the e2e suite, which has a browser available.
    headlessAuthCheck: false,
    onChange: () => {
      changes += 1;
    },
  });
  await service.initialize();
  return { service, changes: () => changes };
}

const environmentDraft = (): EnvironmentDraft => ({
  name: "测试环境",
  baseUrl: "http://localhost:3000",
  loginPath: "/login",
  authCheckPath: "/api/session",
  autoSubmit: false,
});

const identityDraft = (environmentId: string, name: string): IdentityDraft => ({
  environmentId,
  name,
  username: name.toLowerCase(),
  role: "member",
  color: "slate",
  passwordMode: "inherit",
});

function seedIdentities(service: WorkspaceService, count: number): string {
  const environment = service.saveEnvironment(environmentDraft());
  for (let index = 0; index < count; index += 1) {
    service.saveIdentity(identityDraft(environment.id, `账号${index + 1}`));
  }
  return environment.id;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session health", () => {
  it("reports identities without a window as unknown and writes nothing", async () => {
    const { service, changes } = await makeService();
    const environmentId = seedIdentities(service, 8);
    const before = changes();

    const batch = await service.checkAllAuth(environmentId);

    expect(batch.results).toHaveLength(8);
    expect(batch.totals).toEqual({ signedIn: 0, expired: 0, unknown: 8 });
    // A batch of eight undecidable checks must not rewrite workspace.json eight
    // times; the whole point of the aggregation is one write per run.
    expect(changes()).toBe(before);
    expect(batch.results.every((result) => result.detail?.includes("未在运行"))).toBe(true);
  });

  it("aggregates only the requested environment", async () => {
    const { service } = await makeService();
    const first = seedIdentities(service, 2);
    seedIdentities(service, 3);

    const batch = await service.checkAllAuth(first);

    expect(batch.environmentId).toBe(first);
    expect(batch.results).toHaveLength(2);
  });

  it("reports a failed relogin instead of aborting the batch", async () => {
    const { service } = await makeService();
    const environmentId = seedIdentities(service, 2);
    const [, second] = service.snapshot().identities;
    if (!second) throw new Error("missing identity");
    // No saved password: the fill must fail, and the batch must say so.
    second.status = "expired";

    const result = await service.reloginExpired(environmentId);

    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.results[0]?.identityId).toBe(second.id);
    expect(result.results[0]?.ok).toBe(false);
  });
});

describe("restore last scene", () => {
  it("does nothing when the setting is off", async () => {
    const { service } = await makeService();
    seedIdentities(service, 1);

    expect(await service.restoreLastScene()).toEqual({ restored: false, reason: "disabled" });
  });

  it("drops a scene id that no longer exists", async () => {
    const { service } = await makeService();
    const environmentId = seedIdentities(service, 1);
    service.saveScene({
      environmentId,
      name: "场景",
      identityIds: [service.snapshot().identities[0]?.id as string],
      layoutId: "2x2",
      slotAssignments: {},
      paths: {},
    } satisfies SceneDraft);
    service.saveSettings({ lastSceneId: "deleted-scene", restoreLastScene: true });

    const outcome = await service.restoreLastScene();

    expect(outcome).toEqual({ restored: false, reason: "missing" });
    expect(service.settingsSnapshot().lastSceneId).toBeUndefined();
  });

  it("only attempts once per process", async () => {
    const { service } = await makeService();

    await service.restoreLastScene();
    expect(await service.restoreLastScene()).toEqual({
      restored: false,
      reason: "already-attempted",
    });
  });

  it("forgets which scene was last when that scene is deleted", async () => {
    const { service } = await makeService();
    const environmentId = seedIdentities(service, 1);
    const scene = service.saveScene({
      environmentId,
      name: "场景",
      identityIds: [service.snapshot().identities[0]?.id as string],
      layoutId: "2x2",
      slotAssignments: {},
      paths: {},
    } satisfies SceneDraft);
    service.saveSettings({ lastSceneId: scene.id });

    service.deleteScene(scene.id);

    expect(service.settingsSnapshot().lastSceneId).toBeUndefined();
  });
});

describe("new settings defaults", () => {
  it("keeps automatic restore off and the overlay on", () => {
    expect(DEFAULT_SETTINGS.restoreLastScene).toBe(false);
    expect(DEFAULT_SETTINGS.overlayEnabled).toBe(true);
  });
});
