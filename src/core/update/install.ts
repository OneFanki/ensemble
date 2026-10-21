/**
 * Builds the small launcher script that applies a verified installer.
 *
 * The app cannot install itself while it is running: the NSIS installer replaces
 * the executable in place, and Windows refuses to overwrite a file that is open.
 * So the app writes this script, starts it detached and quits; the script waits
 * for the app's process to disappear, runs the installer silently, and starts the
 * new build at the same path the old one lived at.
 *
 * This lives in core (no Electron imports) so the generated text can be unit
 * tested: a typo here means an update that installs and never comes back.
 */
export interface WindowsInstallScript {
  /** Process id of the running app; the script waits for it to exit. */
  pid: number;
  /** Absolute path of the verified installer. */
  installerPath: string;
  /** Absolute path of the running executable, reused after the upgrade. */
  appExePath: string;
}

/** Quotes one argument for cmd.exe, doubling embedded quotes. */
function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildWindowsInstallScript(input: WindowsInstallScript): string {
  const { pid, installerPath, appExePath } = input;
  return [
    "@echo off",
    "setlocal",
    // Wait for the app to exit. `tasklist /FI "PID eq N"` prints a line with the
    // pid while it is alive; the loop exits as soon as that line is gone.
    `:waitForExit`,
    `tasklist /FI "PID eq ${pid}" /NH 2>nul | find "${pid}" >nul`,
    "if not errorlevel 1 (",
    "  timeout /t 1 /nobreak >nul",
    "  goto waitForExit",
    ")",
    // Silent NSIS upgrade. The installer remembers the previous install
    // directory, so this lands in the same place the app already lives.
    `${quote(installerPath)} /S`,
    // Relaunch the new build. `start` returns immediately, so the script can
    // delete itself below instead of leaving a cmd window on screen.
    `start "" ${quote(appExePath)}`,
    "del \"%~f0\"",
    "endlocal",
    "",
  ].join("\r\n");
}

/**
 * File name for the downloaded installer. Kept as the release asset's own name so
 * a user who looks in the temp folder can recognise it, with the version so two
 * pending downloads cannot collide.
 *
 * Everything outside a conservative character set is replaced, and any run of
 * dots is collapsed: a name like `../../x.exe` must not survive as something a
 * path joiner could interpret as traversal, even though it is joined under a
 * directory we own.
 */
export function updateFileName(assetName: string): string {
  const safe = assetName
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.\-_]+/, "");
  return safe.length > 0 ? safe : "ensemble-update.exe";
}
