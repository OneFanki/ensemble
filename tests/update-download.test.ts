import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadUpdateAsset } from "@core/update/download";
import { buildWindowsInstallScript, updateFileName } from "@core/update/install";

/**
 * The downloader is the one place where the app fetches an executable and then
 * runs it, so these tests cover the refusals as closely as the happy path. The
 * network is injected, so no test touches github.com.
 */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-update-"));
  created.push(dir);
  return dir;
}

/** A Response whose `url` looks like GitHub while serving local bytes. */
function githubResponse(payload: Buffer, trustedUrl: string): Response {
  const response = new Response(new Uint8Array(payload), {
    status: 200,
    headers: { "content-length": String(payload.length) },
  });
  Object.defineProperty(response, "url", { value: trustedUrl });
  return response;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("update download", () => {
  it("refuses a URL that is not on GitHub", async () => {
    await expect(
      downloadUpdateAsset("https://example.test/update.exe", join(await tempDir(), "u.exe"), {
        expectedSha256: "a".repeat(64),
      }),
    ).rejects.toThrow(/不受信任/);
  });

  it("refuses http even on a GitHub host", async () => {
    await expect(
      downloadUpdateAsset(
        "http://github.com/OneFanki/ensemble/releases/download/v1/u.exe",
        join(await tempDir(), "u.exe"),
        { expectedSha256: "a".repeat(64) },
      ),
    ).rejects.toThrow(/不受信任/);
  });

  it("refuses to download without a checksum", async () => {
    await expect(
      downloadUpdateAsset(
        "https://github.com/OneFanki/ensemble/releases/download/v1/u.exe",
        join(await tempDir(), "u.exe"),
        { expectedSha256: "" },
      ),
    ).rejects.toThrow(/校验值/);
  });

  it("rejects a download that was redirected off GitHub", async () => {
    const url = "https://github.com/OneFanki/ensemble/releases/download/v1/u.exe";
    const offsite = githubResponse(Buffer.from("x"), "https://cdn.example.test/u.exe");
    await expect(
      downloadUpdateAsset(url, join(await tempDir(), "u.exe"), {
        expectedSha256: "a".repeat(64),
        fetchImpl: (() => Promise.resolve(offsite)) as typeof fetch,
      }),
    ).rejects.toThrow(/重定向/);
  });

  it("deletes the file and reports it when the checksum does not match", async () => {
    const payload = Buffer.from("not really an installer");
    const dir = await tempDir();
    const destination = join(dir, "u.exe");
    const url = "https://github.com/OneFanki/ensemble/releases/download/v1/u.exe";
    const wrong = createHash("sha256").update("something else").digest("hex");
    await expect(
      downloadUpdateAsset(url, destination, {
        expectedSha256: wrong,
        fetchImpl: (() => Promise.resolve(githubResponse(payload, url))) as typeof fetch,
      }),
    ).rejects.toThrow(/校验值/);
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.part`)).toBe(false);
  });

  it("keeps the file once the checksum matches", async () => {
    const payload = Buffer.from("pretend installer bytes");
    const dir = await tempDir();
    const destination = join(dir, "u.exe");
    const url = "https://github.com/OneFanki/ensemble/releases/download/v1/u.exe";
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const seen: number[] = [];
    const result = await downloadUpdateAsset(url, destination, {
      expectedSha256: sha256,
      onProgress: (received) => seen.push(received),
      fetchImpl: (() => Promise.resolve(githubResponse(payload, url))) as typeof fetch,
    });
    expect(result.sha256).toBe(sha256);
    expect(result.bytes).toBe(payload.length);
    expect(await readFile(destination)).toEqual(payload);
    // Progress must report the final byte count, not stop short of it.
    expect(seen.at(-1)).toBe(payload.length);
  });

  it("accepts release assets served from githubusercontent.com", async () => {
    const payload = Buffer.from("asset bytes");
    const dir = await tempDir();
    const destination = join(dir, "u.exe");
    const url =
      "https://objects.githubusercontent.com/github-production-release-asset/u.exe";
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const result = await downloadUpdateAsset(url, destination, {
      expectedSha256: sha256,
      fetchImpl: (() => Promise.resolve(githubResponse(payload, url))) as typeof fetch,
    });
    expect(result.bytes).toBe(payload.length);
  });
});

describe("install script", () => {
  it("waits for the app to exit, installs silently, then relaunches", async () => {
    const dir = await tempDir();
    const scriptPath = join(dir, "apply.cmd");
    await writeFile(
      scriptPath,
      buildWindowsInstallScript({
        pid: 4242,
        installerPath: "C:\\Temp\\ensemble-updates\\Ensemble-1.0.0-setup.exe",
        appExePath: "C:\\Users\\me\\AppData\\Local\\Programs\\Ensemble\\Ensemble.exe",
      }),
      "utf8",
    );
    const text = await readFile(scriptPath, "utf8");
    // Waiting is the whole point: Windows refuses to overwrite a running exe.
    expect(text).toContain('tasklist /FI "PID eq 4242" /NH');
    expect(text).toContain('"C:\\Temp\\ensemble-updates\\Ensemble-1.0.0-setup.exe" /S');
    expect(text).toContain(
      'start "" "C:\\Users\\me\\AppData\\Local\\Programs\\Ensemble\\Ensemble.exe"',
    );
    // The script deletes itself so no console window is left behind.
    expect(text).toContain('del "%~f0"');
  });

  it("sanitises the downloaded file name", () => {
    expect(updateFileName("Ensemble-1.0.0-win-x64-setup.exe")).toBe(
      "Ensemble-1.0.0-win-x64-setup.exe",
    );
    expect(updateFileName("../../evil name.exe")).not.toContain("..");
    expect(updateFileName("")).toBe("ensemble-update.exe");
  });
});
