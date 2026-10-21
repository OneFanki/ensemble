import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

let helper: ChildProcess | null = null;
let helperReady = false;

/**
 * Long-lived PowerShell helper that raises windows on demand.
 *
 * Spawning `powershell` and compiling the P/Invoke block costs ~600ms, which is
 * exactly the delay a user notices after clicking the overlay. The helper is
 * started once (compilation included), then stays reading one PID per line from
 * stdin and prints `raised` / `no-window` / `refused` per request.
 *
 * `Page.bringToFront` alone is not enough: it activates the tab, but Windows
 * refuses foreground changes from a background process, so the window stays
 * behind whatever the user is looking at. Attaching to the current foreground
 * thread lifts that restriction for the duration of the call.
 */
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EnsembleFocus {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }

  // Without this every coordinate below is virtualised differently by each API:
  // GetWindowRect returns CSS pixels while DWM returns device pixels, and
  // subtracting the two produced negative "insets" that squeezed windows.
  public static void Aware() { try { SetProcessDpiAwareness(2); } catch {} }

  public static IntPtr Largest(uint pid) {
    IntPtr best = IntPtr.Zero;
    long area = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static string Raise(uint pid) {
    IntPtr h = Largest(pid);
    if (h == IntPtr.Zero) return "no-window";
    IntPtr fg = GetForegroundWindow();
    uint fgPid;
    uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    try {
      ShowWindow(h, 9);
      BringWindowToTop(h);
      return SetForegroundWindow(h) ? "raised" : "refused";
    } finally {
      if (attached) AttachThreadInput(me, fgThread, false);
    }
  }

  public static string Inset(uint pid) {
    IntPtr h = Largest(pid);
    if (h == IntPtr.Zero) return "no-window";
    RECT w;
    RECT v;
    if (!GetWindowRect(h, out w)) return "failed";
    if (DwmGetWindowAttribute(h, 9, out v, 16) != 0) return "failed";
    uint dpi = GetDpiForWindow(h);
    if (dpi == 0) dpi = 96;
    // Physical pixels of the invisible resize border, left/top/right/bottom,
    // followed by the window DPI so the caller can convert to DIPs.
    return "inset:" + (v.L - w.L) + "," + (v.T - w.T) + "," + (w.R - v.R) + "," + (w.B - v.B) + "," + dpi;
  }

  // Which process owns the foreground window, used to highlight the matching
  // row in the switcher. Reading the OS state instead of remembering our own
  // clicks also follows windows the user raised by hand.
  public static string Foreground() {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero) return "none";
    uint pid;
    GetWindowThreadProcessId(fg, out pid);
    return "pid:" + pid;
  }

  // Visible frame of the largest window of a process, in physical pixels plus
  // its DPI. External-mode browsers have no CDP, so this is how the transient
  // identity label finds the window it belongs over.
  public static string Rect(uint pid) {
    IntPtr h = Largest(pid);
    if (h == IntPtr.Zero) return "no-window";
    RECT v;
    if (DwmGetWindowAttribute(h, 9, out v, 16) != 0) {
      if (!GetWindowRect(h, out v)) return "failed";
    }
    uint dpi = GetDpiForWindow(h);
    if (dpi == 0) dpi = 96;
    return "rect:" + v.L + "," + v.T + "," + (v.R - v.L) + "," + (v.B - v.T) + "," + dpi;
  }
}
"@
[EnsembleFocus]::Aware()
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try {
    if ($line -eq 'fg') {
      [EnsembleFocus]::Foreground()
    } elseif ($line.StartsWith('inset ')) {
      $value = 0
      if ([int]::TryParse($line.Substring(6), [ref]$value) -and $value -gt 0) {
        [EnsembleFocus]::Inset([uint32]$value)
      } else { 'failed' }
    } elseif ($line.StartsWith('rect ')) {
      $value = 0
      if ([int]::TryParse($line.Substring(5), [ref]$value) -and $value -gt 0) {
        [EnsembleFocus]::Rect([uint32]$value)
      } else { 'failed' }
    } else {
      $value = 0
      if ([int]::TryParse($line, [ref]$value) -and $value -gt 0) {
        [EnsembleFocus]::Raise([uint32]$value)
      } else { 'failed' }
    }
  } catch {
    'failed'
  }
  [Console]::Out.Flush()
}
`;

interface PendingRequest {
  resolve: (value: string | undefined) => void;
  timer: NodeJS.Timeout;
}

const pending: PendingRequest[] = [];
let waitingForReady: (() => void) | null = null;

function startHelper(): void {
  if (helper || process.platform !== "win32") return;
  const child = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HELPER_SCRIPT],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  helper = child;
  helperReady = false;

  createInterface({ input: child.stdout }).on("line", (line) => {
    const text = line.trim();
    if (text === "ready") {
      helperReady = true;
      waitingForReady?.();
      waitingForReady = null;
      return;
    }
    // Every request gets exactly one line back, in order.
    const request = pending.shift();
    if (!request) return;
    clearTimeout(request.timer);
    request.resolve(text);
  });

  const dispose = () => {
    if (helper !== child) return;
    helper = null;
    helperReady = false;
    waitingForReady?.();
    waitingForReady = null;
    for (const request of pending.splice(0)) {
      clearTimeout(request.timer);
      request.resolve(undefined);
    }
  };
  child.on("exit", dispose);
  child.on("error", dispose);
}

/**
 * Starts the helper ahead of the first click. Safe to call repeatedly; the
 * renderer calls it when the overlay window appears.
 */
export function warmUpWindowFocus(): void {
  startHelper();
}

function stopHelper(): void {
  const child = helper;
  helper = null;
  helperReady = false;
  try {
    child?.stdin?.end();
    child?.kill();
  } catch {
    // A helper that is already gone is fine.
  }
}

/** Stops the long-lived helper; called on quit so no PowerShell outlives the app. */
export function disposeWindowFocus(): void {
  stopHelper();
}

function askHelper(command: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = helper;
    if (!child?.stdin || child.stdin.destroyed) {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      const index = pending.findIndex((item) => item.timer === timer);
      if (index >= 0) pending.splice(index, 1);
      resolve(undefined);
    }, timeoutMs);
    pending.push({ resolve, timer });
    child.stdin.write(`${command}\n`);
  });
}

function runOnce(command: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout) =>
        resolve(!error && String(stdout).trim() === "raised"),
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Raises the OS window that belongs to a browser process.
 *
 * This is what actually brings it to the front; it also works for external-mode
 * browsers that have no CDP connection at all. Best effort by design: a refusal
 * (another app holds the foreground lock, macOS denies Automation) leaves the
 * window where it is instead of failing the click.
 */
export async function activateWindowForPid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform === "win32") {
    const response = await sendToHelper(String(pid));
    return response === "raised";
  }

  if (process.platform === "darwin") {
    // System Events needs Automation permission the first time; a denial is not
    // fatal because CDP already activated the tab.
    const script =
      'tell application "System Events" to set frontmost of ' +
      `(first process whose unix id is ${pid}) to true`;
    return runOnce("osascript", ["-e", script], 4_000);
  }

  return false;
}

/** Insets in DIPs: how far the visible window sits inside the rect we set. */
export interface FrameInset {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Measures the invisible resize border Windows draws around every Chromium
 * window.
 *
 * `--window-size` and `Browser.setWindowBounds` set the *outer* rect, but the
 * visible frame is inset by that border, so windows placed edge to edge still
 * show a gap of two insets between them. The border is shadow, not content, so
 * expanding the outer rect by the inset makes the visible frames touch. The
 * width is DPI-dependent, hence the measurement instead of a constant.
 */
export async function measureFrameInset(pid: number): Promise<FrameInset | undefined> {
  if (process.platform !== "win32") return undefined;
  const response = await sendToHelper(`inset ${pid}`);
  if (!response?.startsWith("inset:")) return undefined;
  const parts = response.slice(6).split(",").map(Number);
  if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return undefined;
  const [left, top, right, bottom, dpi] = parts as [number, number, number, number, number];
  // Convert physical pixels to DIPs, which is what Electron's bounds use.
  const scale = dpi > 0 ? dpi / 96 : 1;
  return {
    left: left / scale,
    top: top / scale,
    right: right / scale,
    bottom: bottom / scale,
  };
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * PID of the process owning the foreground window.
 *
 * Used by the overlay to highlight the row of the window the user is actually
 * looking at, including windows they raised by hand rather than through us.
 * Returns undefined on platforms without an implementation.
 */
export async function foregroundWindowPid(): Promise<number | undefined> {
  if (process.platform === "win32") {
    const response = await sendToHelper("fg");
    if (!response?.startsWith("pid:")) return undefined;
    const pid = Number(response.slice(4));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }
  if (process.platform === "darwin") {
    const output = await runText(
      "osascript",
      [
        "-e",
        'tell application "System Events" to get unix id of first application process whose frontmost is true',
      ],
      2_500,
    );
    const pid = Number(output?.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }
  return undefined;
}

/**
 * Visible frame of a process's window in DIPs. Used to place the transient
 * identity label over external-mode browsers, which have no CDP to ask.
 */
export async function windowRectForPid(pid: number): Promise<ScreenRect | undefined> {
  if (process.platform !== "win32") return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const response = await sendToHelper(`rect ${pid}`);
  if (!response?.startsWith("rect:")) return undefined;
  const parts = response.slice(5).split(",").map(Number);
  if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return undefined;
  const [left, top, width, height, dpi] = parts as [number, number, number, number, number];
  // Minimized windows report a placeholder rect far off screen.
  if (width <= 0 || height <= 0 || left <= -30_000 || top <= -30_000) return undefined;
  const scale = dpi > 0 ? dpi / 96 : 1;
  return { x: left / scale, y: top / scale, width: width / scale, height: height / scale };
}

function runText(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout) =>
        resolve(error ? undefined : String(stdout)),
      );
    } catch {
      resolve(undefined);
    }
  });
}

/** Starts the helper if needed and sends one command, waiting for it to warm up. */
async function sendToHelper(command: string): Promise<string | undefined> {
  startHelper();
  if (!helperReady) {
    // The helper is still compiling (first request of the process). Waiting is
    // cheaper than spawning a second PowerShell, so do it instead of racing.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      waitingForReady = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  if (!helperReady) return undefined;
  return askHelper(command, 3_000);
}
