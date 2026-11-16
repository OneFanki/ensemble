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
    // Wait for the app to exit before touching its files.
    //
    // This check has been wrong twice, both times from trusting something about
    // the output rather than reading it:
    //
    // 1. `tasklist … | find "N"` depended on PATH resolving `find` to Windows'
    //    own `find.exe`. Where a Unix `find` came first it treated the argument
    //    as a file name; where it got no input it blocked on stdin. A user
    //    upgrading from 2.1.0 was left with a cmd window and a `find` process
    //    that never exited.
    // 2. `tasklist … & if not errorlevel 1` is always true: `tasklist` returns 0
    //    whether or not the filter matched anything, so the loop never waited.
    //
    // So the pid is compared explicitly against column 2 of the output — the
    // only column that is a number, and the only part of the line that does not
    // change with the system language. `%SystemRoot%` is used so nothing depends
    // on PATH, and the output goes to a file so `for /f` gets a real stream to
    // read instead of a literal string.
    `set "PIDFILE=%TEMP%\\ensemble-wait-${pid}.txt"`,
    ":waitForExit",
    `"%SystemRoot%\\System32\\tasklist.exe" /FI "PID eq ${pid}" /NH >"%PIDFILE%" 2>nul`,
    `set "STILL_RUNNING="`,
    `for /f "usebackq tokens=1,2" %%A in ("%PIDFILE%") do if "%%B"=="${pid}" set "STILL_RUNNING=1"`,
    `del "%PIDFILE%" 2>nul`,
    `if defined STILL_RUNNING (`,
    // By absolute path for the same reason as `tasklist`: a Unix `timeout` on
    // PATH reads `/t 1 /nobreak` as a bad interval and exits at once, so the loop
    // spun without ever pausing — which is what produced the burst of "interrupt"
    // errors and then a wedged window rather than a slow, silent wait.
    "  \"%SystemRoot%\\System32\\timeout.exe\" /t 1 /nobreak >nul 2>nul",
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
