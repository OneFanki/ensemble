import type { Rect } from "../layout/grid";

export interface ChromiumArgsInput {
  profileDir: string;
  startUrl: string;
  windowBounds?: Rect;
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
  ];

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
