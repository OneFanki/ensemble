import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Environment, Identity, Scene } from "@shared/types";

export interface StoredInstance {
  id: string;
  identityId?: string;
  environmentId: string;
  engineId: string;
  pid: number;
  profileDir: string;
  startedAt: string;
}

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

export function parseWindowsProcessList(stdout: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { ProcessId?: number; CommandLine?: string };
      if (typeof parsed.ProcessId === "number" && typeof parsed.CommandLine === "string") {
        result.push({ pid: parsed.ProcessId, commandLine: parsed.CommandLine });
      }
    } catch {
      // Skip malformed rows.
    }
  }
  return result;
}

export function profileDirFromCommandLine(commandLine: string): string | undefined {
  const match = commandLine.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/i);
  return match?.[1] ?? match?.[2];
}

export function normalizeForCompare(path: string): string {
  return path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
}

/**
 * Lists processes launched with a --user-data-dir pointing inside the given roots.
 * Only processes whose profile directory is under our own profile root are adopted,
 * so a normal user browser is never touched.
 */
export async function findOwnedBrowserProcesses(profileRoot: string): Promise<ProcessInfo[]> {
  const normalizedRoot = normalizeForCompare(profileRoot);
  const processes = await listProcesses();
  return processes.filter((entry) => {
    const profileDir = profileDirFromCommandLine(entry.commandLine);
    if (!profileDir) return false;
    return normalizeForCompare(profileDir).startsWith(normalizedRoot);
  });
}

async function listProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve([]);
            return;
          }
          const text = stdout.trim();
          if (!text) {
            resolve([]);
            return;
          }
          try {
            const parsed = JSON.parse(text) as Array<{ ProcessId?: number; CommandLine?: string }>;
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            resolve(
              rows
                .filter(
                  (row): row is { ProcessId: number; CommandLine: string } =>
                    typeof row.ProcessId === "number" && typeof row.CommandLine === "string",
                )
                .map((row) => ({ pid: row.ProcessId, commandLine: row.CommandLine })),
            );
          } catch {
            resolve(parseWindowsProcessList(text));
          }
        },
      );
    });
  }

  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pid=,args="], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      const rows = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const space = line.indexOf(" ");
          if (space < 0) return undefined;
          const pid = Number.parseInt(line.slice(0, space), 10);
          if (!Number.isInteger(pid)) return undefined;
          return { pid, commandLine: line.slice(space + 1) };
        })
        .filter((row): row is ProcessInfo => Boolean(row));
      resolve(rows);
    });
  });
}

export function profileExists(profileDir: string): boolean {
  return existsSync(join(profileDir));
}

export interface WorkspaceData {
  version: 1;
  environments: Environment[];
  identities: Identity[];
  scenes: Scene[];
  instances: StoredInstance[];
  manualEngines: string[];
}

export function emptyWorkspace(): WorkspaceData {
  return {
    version: 1,
    environments: [],
    identities: [],
    scenes: [],
    instances: [],
    manualEngines: [],
  };
}

export function sanitizeWorkspace(input: Partial<WorkspaceData>): WorkspaceData {
  const base = emptyWorkspace();
  return {
    version: 1,
    environments: Array.isArray(input.environments) ? input.environments : base.environments,
    identities: Array.isArray(input.identities) ? input.identities : base.identities,
    scenes: Array.isArray(input.scenes) ? input.scenes : base.scenes,
    instances: Array.isArray(input.instances) ? input.instances : base.instances,
    manualEngines: Array.isArray(input.manualEngines) ? input.manualEngines : base.manualEngines,
  };
}
