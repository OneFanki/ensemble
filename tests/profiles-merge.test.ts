import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";
import { EMBEDDED_CLEAN_PROFILE_ID, EMBEDDED_DEFAULT_PROFILE_ID } from "@shared/embedded";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Merging profiles into the default one.
 *
 * The promise the invitation makes is narrow and has to stay narrow: the rows
 * leave the settings list, the built-in default becomes the landing place for
 * every account-less page, and **nothing on disk is touched** — a click that
 * says "merge" must never be the click that deletes someone's cookies. Each
 * test below pins one side of that contract.
 */
const dirs: string[] = [];
const services: WorkspaceService[] = [];

async function makeService(): Promise<WorkspaceService> {
  const userDataDir = await mkdtemp(join(tmpdir(), "ensemble-profiles-merge-"));
  dirs.push(userDataDir);
  const service = new WorkspaceService({
    userDataDir,
    profileRoot: join(userDataDir, "profiles"),
    platform: process.platform as "win32" | "darwin" | "linux",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
    workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  });
  services.push(service);
  await service.initialize();
  return service;
}

afterAll(async () => {
  await Promise.all(services.map((service) => service.stopAll().catch(() => {})));
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })),
  );
});

/** Creates a user profile and returns the fresh settings row. */
function createProfile(service: WorkspaceService, name: string) {
  const settings = service.createProfile(name);
  return settings.profiles.find((profile) => profile.name === name);
}

describe("profile merge invitation", () => {
  it("never appears for a workspace with only the built-in profiles", async () => {
    const service = await makeService();
    expect(service.profileMergePending()).toBe(false);
    expect(service.mergeableProfiles()).toEqual([]);
  });

  it("appears once a user profile exists, and stays away after it was answered", async () => {
    const service = await makeService();
    createProfile(service, "工作档案");
    expect(service.profileMergePending()).toBe(true);

    // Keeping the profiles is one of the two answers; it must silence the
    // invitation without touching the rows.
    service.keepProfiles();
    expect(service.profileMergePending()).toBe(false);
    expect(service.mergeableProfiles().map((profile) => profile.name)).toEqual(["工作档案"]);

    // The answer lives in the settings file like every other choice, so a
    // workspace that was answered once stays answered after the app reopens it.
    const service2 = await makeService();
    createProfile(service2, "工作档案");
    service2.keepProfiles();
    const reopenedDir = dirs.at(-1) ?? "";
    const reopened = new WorkspaceService({
      userDataDir: reopenedDir,
      profileRoot: join(reopenedDir, "profiles"),
      platform: process.platform as "win32" | "darwin" | "linux",
      secretBox: new MemorySecretBox(),
      appVersion: "test",
      workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    });
    await reopened.initialize();
    services.push(reopened);
    expect(reopened.profileMergePending()).toBe(false);
  });
});

describe("mergeProfilesToDefault", () => {
  it("removes user rows, hands the default back to the built-in, and keeps the built-ins", async () => {
    const service = await makeService();
    const work = createProfile(service, "工作档案");
    const alt = createProfile(service, "对照档案");
    service.setDefaultProfile(work?.id ?? "");

    const settings = service.mergeProfilesToDefault();
    expect(settings.profiles.map((profile) => profile.id)).toEqual([
      EMBEDDED_DEFAULT_PROFILE_ID,
      EMBEDDED_CLEAN_PROFILE_ID,
    ]);
    expect(settings.defaultProfileId).toBe(EMBEDDED_DEFAULT_PROFILE_ID);
    expect(settings.profilesMerged).toBe(true);
    expect(work?.id).toBeTruthy();
    expect(alt?.id).toBeTruthy();
    expect(service.profileMergePending()).toBe(false);
  });

  it("leaves every profile directory on disk", async () => {
    const service = await makeService();
    const work = createProfile(service, "工作档案");
    // The external surface's jar lives under profiles/<id>; create it the way a
    // launch would, so the assertion reads real bytes rather than a wish.
    const externalDir = join(service.profileRoot, work?.id ?? "");
    await import("node:fs/promises").then((fs) => fs.mkdir(externalDir, { recursive: true }));
    // The built-in surface keeps each profile's session in a partition directory
    // under userData. Stand one in, since a plain Node test never opens Electron.
    const partitionDir = join(service.userDataDir, "Partitions", `profile-${work?.id ?? ""}`);
    await import("node:fs/promises").then((fs) => fs.mkdir(partitionDir, { recursive: true }));

    service.mergeProfilesToDefault();
    await expect(stat(externalDir)).resolves.toBeTruthy();
    await expect(stat(partitionDir)).resolves.toBeTruthy();
  });

  it("refuses to run twice", async () => {
    const service = await makeService();
    createProfile(service, "工作档案");
    service.mergeProfilesToDefault();
    expect(() => service.mergeProfilesToDefault()).toThrow("没有可合并的档案");
  });

  it("keeps a user-chosen default that the merge did not remove", async () => {
    // Only reachable when the default points at the built-in while a user row
    // exists — the fallback branch must not clobber that choice.
    const service = await makeService();
    createProfile(service, "工作档案");
    const settings = service.mergeProfilesToDefault();
    expect(settings.defaultProfileId).toBe(EMBEDDED_DEFAULT_PROFILE_ID);
  });
});
