import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCleanProfileDir, removeCleanProfiles } from "@core/processes/clean-profiles";
import { afterEach, describe, expect, it } from "vitest";

const created: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ensemble-clean-"));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("clean profile handling", () => {
  it("recognizes only clean-session directory names", () => {
    expect(isCleanProfileDir(join("root", "env", "clean-abc"))).toBe(true);
    expect(isCleanProfileDir(join("root", "env", "6ff8e322-8304"))).toBe(false);
    expect(isCleanProfileDir(join("root", "env", "cleanup"))).toBe(false);
  });

  it("removes leftover clean sessions but keeps identity profiles", async () => {
    const root = await makeRoot();
    const env = join(root, "env");
    const clean = join(env, "clean-abc");
    const identity = join(env, "6ff8e322-8304-462f-a6a5-746d167b6563");
    await mkdir(join(clean, "Default"), { recursive: true });
    await writeFile(join(clean, "Default", "Preferences"), "{}");
    await mkdir(identity, { recursive: true });
    await writeFile(join(identity, "Preferences"), "{}");

    await removeCleanProfiles([root]);

    expect(existsSync(clean)).toBe(false);
    expect(existsSync(join(identity, "Preferences"))).toBe(true);
  });

  it("ignores missing roots and files at the environment level", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "notes.txt"), "not a profile dir");

    await expect(removeCleanProfiles([root, join(root, "missing")])).resolves.toBeUndefined();
    expect(existsSync(join(root, "notes.txt"))).toBe(true);
  });
});
