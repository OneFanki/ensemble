import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Chromium profile trees are deep enough to outlive a normal cleanup when the
 * suite is interrupted (Ctrl+C, timeout), and Windows refuses plain deletes once
 * the paths exceed MAX_PATH. Sweep leftovers from earlier runs before starting a
 * new one; the age gate leaves directories of a concurrently running suite alone.
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const PREFIXES = ["ensemble-e2e-", "ensemble-shot-"];

export default async function setup(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(tmpdir());
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => PREFIXES.some((prefix) => name.startsWith(prefix)))
      .map(async (name) => {
        const dir = join(tmpdir(), name);
        try {
          const info = await stat(dir);
          if (!info.isDirectory() || now - info.mtimeMs < STALE_AFTER_MS) return;
          // Node namespaces long paths internally, so a deep Chromium profile
          // tree can be removed without the MAX_PATH workaround.
          await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
        } catch {
          // Another run may still hold a file; the next sweep picks it up.
        }
      }),
  );
}
