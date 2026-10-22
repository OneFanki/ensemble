import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

/** Clean sessions are disposable, so their profile directories share this prefix. */
export const CLEAN_PROFILE_PREFIX = "clean-";

/**
 * Profile-root segment for clean sessions that belong to no site. Keeping
 * them out of `<root>/<envId>/` means deleting an site can never stop or
 * adopt a throwaway window, and the startup sweep still finds them.
 */
export const CLEAN_SESSION_SEGMENT = "clean";

/** Chromium releases its files slightly after the process exits. */
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 8, retryDelay: 150 } as const;

export function isCleanProfileDir(profileDir: string): boolean {
  return basename(profileDir).startsWith(CLEAN_PROFILE_PREFIX);
}

export async function removeCleanProfiles(roots: string[]): Promise<void> {
  for (const root of new Set(roots)) {
    let siteDirs: string[];
    try {
      siteDirs = await readdir(root);
    } catch {
      continue;
    }
    for (const siteDir of siteDirs) {
      const dir = join(root, siteDir);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(CLEAN_PROFILE_PREFIX))
          .map((entry) => rm(join(dir, entry), REMOVE_OPTIONS).catch(() => {})),
      );
    }
  }
}
