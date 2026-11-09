import { join } from "node:path";

/**
 * Where a development build keeps its workspace.
 *
 * Packaged builds use Electron's default (`appData/<app name>`). A development
 * build used to inherit exactly the same path, because `electron .` reads the same
 * `package.json`: both got `appData/ensemble`. That made `pnpm dev` and the
 * installed app share `workspace.json`, the credential vault, the MCP endpoint,
 * the browser profiles — and the single-instance lock, so starting one while the
 * other was open made the new process quit and reveal the old window.
 *
 * A separate directory fixes all of it at once, including the part that is not
 * obvious from the outside: `profiles/` moves with it, so two Electron versions
 * never open the same Chromium profile. An older build opening a profile a newer
 * one wrote is a downgrade, and that is how a profile gets corrupted.
 */
export const DEV_USER_DATA_DIR_NAME = "ensemble-dev";

/** Display name of a development build, so the two windows are told apart. */
export const DEV_APP_NAME = "Ensemble Dev";

/** Reads `--user-data-dir=<path>` or `--user-data-dir <path>` out of an argv. */
export function userDataDirArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--user-data-dir") {
      // A following flag is not a path: `--user-data-dir --remote-debugging-port=0`
      // means the directory was left out, not that the port flag is the directory.
      const next = argv[index + 1]?.trim() ?? "";
      return next && !next.startsWith("-") ? next : undefined;
    }
    const prefix = "--user-data-dir=";
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value ? value : undefined;
    }
  }
  return undefined;
}

/**
 * The directory a development build should use, or `undefined` to keep whatever
 * Electron already resolved.
 *
 * `undefined` is the answer in three cases, and the third is the one that
 * matters: the e2e suites and the screenshot pass pass their own
 * `--user-data-dir` to get a throwaway workspace, and overriding that here would
 * send every test run into the developer's real data directory.
 */
export function devUserDataDir(input: {
  packaged: boolean;
  appDataDir: string;
  argv: readonly string[];
  envOverride?: string | undefined;
}): string | undefined {
  if (input.packaged) return undefined;
  if (input.envOverride?.trim()) return undefined;
  if (userDataDirArg(input.argv)) return undefined;
  return join(input.appDataDir, DEV_USER_DATA_DIR_NAME);
}
