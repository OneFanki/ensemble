import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinStartupMode } from "@core/launch/browser";
import { afterEach, describe, expect, it } from "vitest";

const created: string[] = [];

async function makeProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-startup-mode-"));
  created.push(dir);
  await mkdir(join(dir, "Default"), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("chromium startup mode", () => {
  it("pins restore_on_startup to the new tab page", async () => {
    const profileDir = await makeProfile();
    await pinStartupMode(profileDir);

    const prefs = JSON.parse(await readFile(join(profileDir, "Default", "Preferences"), "utf8"));
    // 5 = "Open the New Tab page". Any restore value makes Chromium reopen the
    // previous session *in addition to* the URL given on the command line, which
    // is what showed up as two identical tabs.
    expect(prefs.session.restore_on_startup).toBe(5);
  });

  it("keeps unrelated preferences intact", async () => {
    const profileDir = await makeProfile();
    const file = join(profileDir, "Default", "Preferences");
    await writeFile(file, JSON.stringify({ session: { startup_urls: ["x"] }, other: 7 }));

    await pinStartupMode(profileDir);

    const prefs = JSON.parse(await readFile(file, "utf8"));
    expect(prefs.other).toBe(7);
    expect(prefs.session.startup_urls).toEqual(["x"]);
    expect(prefs.session.restore_on_startup).toBe(5);
  });

  it("creates the file on a fresh profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ensemble-startup-mode-"));
    created.push(dir);

    await pinStartupMode(dir);

    const prefs = JSON.parse(await readFile(join(dir, "Default", "Preferences"), "utf8"));
    expect(prefs.session.restore_on_startup).toBe(5);
  });

  it("recovers from a corrupted preferences file", async () => {
    const profileDir = await makeProfile();
    await writeFile(join(profileDir, "Default", "Preferences"), "{not json");

    await pinStartupMode(profileDir);

    const prefs = JSON.parse(await readFile(join(profileDir, "Default", "Preferences"), "utf8"));
    expect(prefs.session.restore_on_startup).toBe(5);
  });
});
