import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "@core/service";
import type { SecretBox } from "@core/credentials/vault";
import type { RunningInstance } from "@shared/types";

const plainBox: SecretBox = {
  available: false,
  backend: "plain",
  encrypt: (plain) => `plain:${Buffer.from(plain).toString("base64")}`,
  decrypt: (payload) => Buffer.from(payload.slice(6), "base64").toString("utf8"),
};

const created: string[] = [];

async function makeService(): Promise<{ service: WorkspaceService; profileRoot: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), "ensemble-lifecycle-"));
  created.push(userDataDir);
  const profileRoot = join(userDataDir, "profiles");
  await mkdir(profileRoot, { recursive: true });
  const service = new WorkspaceService({
    userDataDir,
    profileRoot,
    platform: "win32",
    secretBox: plainBox,
    appVersion: "test",
  });
  await service.initialize();
  return { service, profileRoot };
}

function seedInstance(
  service: WorkspaceService,
  instance: Pick<RunningInstance, "id" | "profileDir" | "clean">,
): void {
  // Stop is exercised directly here; liveInstances is only populated by the launcher.
  (service as unknown as { liveInstances: Map<string, RunningInstance> }).liveInstances.set(
    instance.id,
    {
      id: instance.id,
      label: instance.id,
      environmentId: "env",
      engineId: "chromium:test",
      pid: 0,
      profileDir: instance.profileDir,
      mode: "cdp",
      startedAt: new Date().toISOString(),
      clean: instance.clean,
    },
  );
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("clean session lifecycle", () => {
  it("drops the profile directory when a clean instance stops", async () => {
    const { service, profileRoot } = await makeService();
    const dir = join(profileRoot, "env", "clean-abc");
    await mkdir(join(dir, "Default"), { recursive: true });
    await writeFile(join(dir, "Default", "Preferences"), "{}");
    seedInstance(service, { id: "clean-abc", profileDir: dir, clean: true });

    await service.stopInstance("clean-abc");

    expect(existsSync(dir)).toBe(false);
    expect(service.snapshot().instances).toHaveLength(0);
  });

  it("keeps an identity profile when its instance stops", async () => {
    const { service, profileRoot } = await makeService();
    const dir = join(profileRoot, "env", "identity-1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "Preferences"), "{}");
    seedInstance(service, { id: "identity-1", profileDir: dir, clean: false });

    await service.stopInstance("identity-1");

    expect(existsSync(join(dir, "Preferences"))).toBe(true);
  });

  it("never deletes a directory that is not marked as a clean session", async () => {
    const { service, profileRoot } = await makeService();
    const dir = join(profileRoot, "env", "identity-2");
    await mkdir(dir, { recursive: true });
    // A stale clean flag must not widen the deletion target.
    seedInstance(service, { id: "identity-2", profileDir: dir, clean: true });

    await service.stopInstance("identity-2");

    expect(existsSync(dir)).toBe(true);
  });
});
