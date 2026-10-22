import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { DEFAULT_SETTINGS } from "@shared/defaults";
import type { SiteDraft, IdentityDraft, ViewDraft } from "@shared/types";
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

const siteDraft = (): SiteDraft => ({
  name: "测试环境",
  baseUrl: "http://localhost:3000",
  loginPath: "/login",
  authCheckPath: "/api/session",
  autoSubmit: false,
});

const identityDraft = (siteId: string, name: string): IdentityDraft => ({
  siteId,
  name,
  username: name.toLowerCase(),
  role: "member",
  color: "slate",
  passwordMode: "inherit",
});

function seedIdentities(service: WorkspaceService, count: number): string {
  const site = service.saveSite(siteDraft());
  for (let index = 0; index < count; index += 1) {
    service.saveIdentity(identityDraft(site.id, `账号${index + 1}`));
  }
  return site.id;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("session health", () => {
  it("reports identities without a window as unknown and writes nothing", async () => {
    const { service, changes } = await makeService();
    const siteId = seedIdentities(service, 8);
    const before = changes();

    const batch = await service.checkAllAuth(siteId);

    expect(batch.results).toHaveLength(8);
    expect(batch.totals).toEqual({ signedIn: 0, expired: 0, unknown: 8 });
    // A batch of eight undecidable checks must not rewrite workspace.json eight
    // times; the whole point of the aggregation is one write per run.
    expect(changes()).toBe(before);
    expect(batch.results.every((result) => result.detail?.includes("未在运行"))).toBe(true);
  });

  it("aggregates only the requested site", async () => {
    const { service } = await makeService();
    const first = seedIdentities(service, 2);
    seedIdentities(service, 3);

    const batch = await service.checkAllAuth(first);

    expect(batch.siteId).toBe(first);
    expect(batch.results).toHaveLength(2);
  });

  it("reports a failed relogin instead of aborting the batch", async () => {
    const { service } = await makeService();
    const siteId = seedIdentities(service, 2);
    const [, second] = service.snapshot().identities;
    if (!second) throw new Error("missing identity");
    // No saved password: the fill must fail, and the batch must say so.
    second.status = "expired";

    const result = await service.reloginExpired(siteId);

    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.results[0]?.identityId).toBe(second.id);
    expect(result.results[0]?.ok).toBe(false);
  });
});

describe("restore last view", () => {
  it("does nothing when the setting is off", async () => {
    const { service } = await makeService();
    seedIdentities(service, 1);

    expect(await service.restoreLastView()).toEqual({ restored: false, reason: "disabled" });
  });

  it("drops a view id that no longer exists", async () => {
    const { service } = await makeService();
    const siteId = seedIdentities(service, 1);
    service.saveView({
      siteId,
      name: "场景",
      identityIds: [service.snapshot().identities[0]?.id as string],
      layoutId: "2x2",
      slotAssignments: {},
      paths: {},
    } satisfies ViewDraft);
    service.saveSettings({ lastViewId: "deleted-view", restoreLastView: true });

    const outcome = await service.restoreLastView();

    expect(outcome).toEqual({ restored: false, reason: "missing" });
    expect(service.settingsSnapshot().lastViewId).toBeUndefined();
  });

  it("only attempts once per process", async () => {
    const { service } = await makeService();

    await service.restoreLastView();
    expect(await service.restoreLastView()).toEqual({
      restored: false,
      reason: "already-attempted",
    });
  });

  it("forgets which view was last when that view is deleted", async () => {
    const { service } = await makeService();
    const siteId = seedIdentities(service, 1);
    const view = service.saveView({
      siteId,
      name: "场景",
      identityIds: [service.snapshot().identities[0]?.id as string],
      layoutId: "2x2",
      slotAssignments: {},
      paths: {},
    } satisfies ViewDraft);
    service.saveSettings({ lastViewId: view.id });

    service.deleteView(view.id);

    expect(service.settingsSnapshot().lastViewId).toBeUndefined();
  });
});

describe("new settings defaults", () => {
  it("keeps automatic restore off and the overlay on", () => {
    expect(DEFAULT_SETTINGS.restoreLastView).toBe(false);
    expect(DEFAULT_SETTINGS.overlayEnabled).toBe(true);
  });
});
