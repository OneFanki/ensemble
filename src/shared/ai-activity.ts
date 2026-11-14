/**
 * Grouping for the AI activity log.
 *
 * In `shared/` rather than beside the store because both sides draw the same
 * split: the toolbar panel and the console page. Two implementations of "which
 * rows belong together" would disagree the first time one of them changed, and
 * the panel is the one nobody re-tests.
 *
 * The key is the site id when the call touched a known site, and the origin
 * otherwise — a page the workspace has no site for is still a place, just one
 * with only an address to name it by.
 *
 * Groups come back in the order their newest record appeared, so the site the AI
 * is working on right now is the first one.
 */
import type { AiActivityRecord, AiActivitySiteGroup } from "./types";

export function groupAiActivity(records: readonly AiActivityRecord[]): AiActivitySiteGroup[] {
  const groups = new Map<string, AiActivitySiteGroup>();
  for (const record of records) {
    const key = record.siteId ? `site:${record.siteId}` : `origin:${record.origin}`;
    const existing = groups.get(key);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    groups.set(key, {
      key,
      ...(record.siteId ? { siteId: record.siteId } : {}),
      origin: record.origin,
      records: [record],
    });
  }
  return [...groups.values()];
}
