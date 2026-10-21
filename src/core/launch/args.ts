import type { Rect } from "../layout/grid";

export interface ChromiumArgsInput {
  profileDir: string;
  startUrl: string;
  windowBounds?: Rect;
  /** Run without a window. Used for background session checks only. */
  headless?: boolean;
}

export function buildChromiumArgs(input: ChromiumArgsInput): string[] {
  const args = [
    `--user-data-dir=${input.profileDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    // Keep the browser behaving like a real one: no automation banner, no throttling.
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-background-timer-throttling",
    // A test profile must never inherit the operator's account data. Without this,
    // Chromium vendors auto-sign-in with the OS account, open the sync consent
    // dialog, and install synced extensions (password managers, etc.) that hijack
    // the first page load. Sync is never desirable here.
    "--disable-sync",
    "--disable-features=Translate,msEdgeSyncConsent,EdgeSyncConsent",
    // Every launch names exactly one URL. A "Restore pages?" bubble from a
    // previous unclean exit would offer to bring back old tabs, which looks like
    // the app opened duplicates.
    "--hide-crash-restore-bubble",
  ];

  if (input.headless) {
    // "new" is the only mode that still runs the real renderer; old headless
    // renders a different engine path and would check the wrong thing.
    args.push("--headless=new", "--disable-gpu", "--mute-audio");
  }

  if (input.windowBounds) {
    args.push(
      `--window-position=${Math.round(input.windowBounds.x)},${Math.round(input.windowBounds.y)}`,
      `--window-size=${Math.round(input.windowBounds.width)},${Math.round(input.windowBounds.height)}`,
    );
  }

  args.push(input.startUrl);
  return args;
}

export interface FirefoxArgsInput {
  profileDir: string;
  startUrl: string;
}

export function buildFirefoxArgs(input: FirefoxArgsInput): string[] {
  return [
    "-profile",
    input.profileDir,
    "-no-remote",
    "-new-instance",
    input.startUrl,
  ];
}

export function safeProfileSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  return cleaned || "profile";
}
