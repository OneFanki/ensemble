import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretBox } from "@core/credentials/vault";
import {
  CLEAN_SESSION_SEGMENT,
  isCleanProfileDir,
  removeCleanProfiles,
} from "@core/processes/clean-profiles";
import { WorkspaceService } from "@core/service";
import type { RunningInstance } from "@shared/types";
import { afterEach, describe, expect, it } from "vitest";

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

/** Holds a file without sharing deletes, then releases it after `holdMs`. */
async function lockExclusively(file: string, holdMs: number): Promise<() => Promise<void>> {
  const quoted = file.replace(/'/g, "''");
  const script =
    `$f=[System.IO.File]::Open('${quoted}','Open','Read','None');` +
    `[Console]::Out.WriteLine('locked');[Console]::Out.Flush();` +
    `Start-Sleep -Milliseconds ${holdMs};$f.Close()`;
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("lock holder exited early")));
  });
  return () =>
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

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

  // Opening a file without FILE_SHARE_DELETE is how a slower Chromium shutdown
  // shows up to us. Node's own open() always shares delete, so PowerShell holds
  // the handle exclusively instead. Other platforms delete open files silently.
  it.skipIf(process.platform !== "win32")(
    "finishes the delete in the background when a held file blocks the first attempt",
    async () => {
      const { service, profileRoot } = await makeService();
      const dir = join(profileRoot, "env", "clean-locked");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "Preferences");
      await writeFile(file, "{}");
      const release = await lockExclusively(file, 2_500);
      seedInstance(service, { id: "clean-locked", profileDir: dir, clean: true });

      await service.stopInstance("clean-locked");
      // The window close must not wait for the browser to flush its handles.
      expect(existsSync(dir)).toBe(true);

      await release();
      const deadline = Date.now() + 10_000;
      while (existsSync(dir) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(existsSync(dir)).toBe(false);
    },
    20_000,
  );
});

describe("environment-free clean sessions", () => {
  it("uses a dedicated root segment outside every environment", () => {
    // Deleting an environment stops instances by environmentId, so a blank clean
    // session must not borrow a real one.
    expect(CLEAN_SESSION_SEGMENT).toBe("clean");
    expect(isCleanProfileDir(join("profiles", CLEAN_SESSION_SEGMENT, "clean-123"))).toBe(true);
  });

  it("is swept on startup alongside environment-scoped clean profiles", async () => {
    const { profileRoot } = await makeService();
    const scoped = join(profileRoot, "env-1", "clean-a");
    const unscoped = join(profileRoot, CLEAN_SESSION_SEGMENT, "clean-b");
    const identityDir = join(profileRoot, "env-1", "identity-1");
    for (const dir of [scoped, unscoped, identityDir]) {
      await mkdir(dir, { recursive: true });
    }

    await removeCleanProfiles([profileRoot]);

    expect(existsSync(scoped)).toBe(false);
    expect(existsSync(unscoped)).toBe(false);
    expect(existsSync(identityDir)).toBe(true);
  });
});
