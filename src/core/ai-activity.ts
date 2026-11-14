import { randomUUID } from "node:crypto";
import { JsonStore } from "./storage/json-store";
import type { AiActivityRecord, AiActivityInput } from "@shared/types";

/**
 * What an AI client did, as a log rather than as news.
 *
 * This used to live in the message centre, as `kind: "ai"` rows beside login
 * captures and expired accounts. Two things were wrong with that. The 500-row cap
 * was shared, so one automation run could push every real notification out of
 * the list it was meant to be read in. And the row itself was a headline ("AI
 * ran X on Y") deduplicated by tab, which merged a click and a following type
 * into one line whose tool name stayed the one from the first call.
 *
 * So: its own file, its own cap, and enough structure to group by site — which
 * is the question people actually ask of a log ("what did it do *there*"), and
 * which the old row could not answer because it stored an origin as a display
 * string and nothing else.
 *
 * ## What is deliberately absent
 *
 * There is no `read` field and no unread count. A record is not a notification:
 * the user is not expected to acknowledge that the AI clicked something, and a
 * badge that grows with every tool call would be the same noise in a new place.
 * The toolbar panel shows the newest entries because they are recent, not
 * because they are pending.
 */
export const AI_ACTIVITY_LIMIT = 1000;

/**
 * How long two calls count as one row.
 *
 * Short on purpose. A flow that clicks five links in a row is one intent and
 * reads better as one line with a count; anything slower than this is a
 * separate thing the user would want to see separately.
 */
export const AI_ACTIVITY_MERGE_MS = 10_000;

interface ActivityFile {
  records: AiActivityRecord[];
}

export class AiActivityStore {
  private readonly store: JsonStore<ActivityFile>;

  constructor(filePath: string) {
    this.store = new JsonStore<ActivityFile>(filePath, () => ({ records: [] }));
  }

  get path(): string {
    return this.store.path;
  }

  /**
   * Records one call, or folds it into the row it repeats.
   *
   * The merge key carries `tool` and `ok` — the two fields the message centre's
   * dedupe could not see. Without them, a click and a type in the same tab
   * twelve seconds apart became one row describing only the click.
   */
  add(input: AiActivityInput, mergeMs = AI_ACTIVITY_MERGE_MS): AiActivityRecord {
    const file = this.read();
    const now = Date.now();
    const twin = mergeMs > 0
      ? file.records.find(
          (item) =>
            item.tool === input.tool &&
            item.ok === input.ok &&
            item.originAuthorized === input.originAuthorized &&
            // How the call was authorized is part of what happened: folding a
            // call the user allowed once into one covered by a standing grant
            // would leave one row whose answer describes neither of them.
            item.approval === input.approval &&
            item.tabId === input.tabId &&
            now - Date.parse(item.at) < mergeMs,
        )
      : undefined;
    if (twin) {
      twin.at = new Date(now).toISOString();
      twin.count += 1;
      // Error state travels with the newest attempt; the approval never does,
      // because a row only merges with rows that ended the same way.
      if (input.error) twin.error = input.error;
      else delete twin.error;
      // Moved to the front rather than left in place: every reader assumes the
      // list is newest-first, and a row whose timestamp just moved has to move
      // with it.
      const index = file.records.indexOf(twin);
      if (index > 0) {
        file.records.splice(index, 1);
        file.records.unshift(twin);
      }
      this.write(file);
      return twin;
    }
    const record: AiActivityRecord = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      tool: input.tool,
      origin: input.origin,
      ...(input.siteId ? { siteId: input.siteId } : {}),
      ...(input.identityId ? { identityId: input.identityId } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.clean ? { clean: true } : {}),
      tabId: input.tabId,
      ...(input.tabTitle ? { tabTitle: input.tabTitle } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ok: input.ok,
      originAuthorized: input.originAuthorized,
      ...(input.approval ? { approval: input.approval } : {}),
      ...(input.error ? { error: input.error } : {}),
      count: 1,
    };
    file.records.unshift(record);
    if (file.records.length > AI_ACTIVITY_LIMIT) {
      file.records.length = AI_ACTIVITY_LIMIT;
    }
    this.write(file);
    return record;
  }

  /** Newest first. */
  list(): AiActivityRecord[] {
    return this.read().records;
  }

  clear(): void {
    this.write({ records: [] });
  }

  private read(): ActivityFile {
    const file = this.store.read();
    // A truncated or hand-edited file must not take the app down; an empty log
    // is recoverable, a crash on launch is not.
    if (!Array.isArray(file?.records)) return { records: [] };
    return file;
  }

  private write(file: ActivityFile): void {
    this.store.write(file);
  }
}
