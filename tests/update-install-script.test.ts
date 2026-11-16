import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWindowsInstallScript } from "@core/update/install";

/**
 * Runs the generated wait loop on a real cmd.exe.
 *
 * The unit tests assert the script's text. This runs it, because the bugs this
 * guards were not typos — one picked up the wrong `find` from PATH, another
 * tested an exit code `tasklist` never sets. Both look fine as text and fail only
 * when a shell executes them.
 */
const isWindows = process.platform === "win32";
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runScript(path: string, timeoutMs: number): Promise<{ out: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("cmd.exe", ["/c", path], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve({ out, ms: Date.now() - started });
    });
  });
}

/**
 * The generated script with its installer step swapped for a marker write, so the
 * test exercises the wait loop without ever running an installer. `del "%~f0"`
 * is dropped too: it removes the script mid-run, which would take the marker line
 * with it.
 */
function waitOnly(pid: number, installer: string, appExe: string, marker: string): string {
  return buildWindowsInstallScript({ pid, installerPath: installer, appExePath: appExe })
    .split("\r\n")
    .filter((line) => line !== 'del "%~f0"')
    .filter((line) => !line.includes(installer) && !line.includes(appExe))
    .join("\r\n")
    .concat(`\r\necho PROCEEDED > "${marker}"\r\n`);
}

describe.runIf(isWindows)("install script on a real shell", () => {
  it("waits while the pid is alive, and proceeds only once it has exited", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ensemble-wait-"));
    dirs.push(dir);

    // A real process with a real pid that outlives the first poll by ~2s.
    const victim = spawn("cmd.exe", ["/c", "ping -n 3 127.0.0.1 >nul"], { windowsHide: true });
    const victimPid = victim.pid ?? 0;
    await new Promise((r) => setTimeout(r, 250));

    const scriptPath = join(dir, "apply.cmd");
    await writeFile(
      scriptPath,
      waitOnly(victimPid, join(dir, "in.exe"), join(dir, "ap.exe"), join(dir, "ok.txt")),
      "utf8",
    );

    const exited = new Promise((r) => victim.on("exit", r));
    const run = await runScript(scriptPath, 25_000);
    await exited;

    // The victim lived on for roughly two more seconds, so a loop that really
    // waited cannot have finished in under one.
    expect(run.ms, `finished in ${run.ms}ms — it did not wait for the pid`).toBeGreaterThan(900);
    expect(run.out, "the wait loop shelled out to a tool that does not exist here").not.toMatch(
      /不是内部或外部命令|invalid time interval|No such file|not recognized/,
    );
    expect(await readFile(join(dir, "ok.txt"), "utf8")).toContain("PROCEEDED");
  }, 40_000);

  it("proceeds at once when the pid is already gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ensemble-gone-"));
    dirs.push(dir);

    const scriptPath = join(dir, "apply.cmd");
    await writeFile(
      scriptPath,
      waitOnly(999_999, join(dir, "in.exe"), join(dir, "ap.exe"), join(dir, "ok.txt")),
      "utf8",
    );

    const run = await runScript(scriptPath, 20_000);

    expect(run.ms, `took ${run.ms}ms for a pid that does not exist`).toBeLessThan(9_000);
    expect(await readFile(join(dir, "ok.txt"), "utf8")).toContain("PROCEEDED");
  }, 25_000);
});
