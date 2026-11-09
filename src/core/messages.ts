import { randomUUID } from "node:crypto";
import { JsonStore } from "./storage/json-store";
import type {
  AddMessageInput,
  AppMessage,
  AppMessageView,
  MessageAction,
} from "@shared/types";

/**
 * How many messages are kept.
 *
 * The log answers "what happened while I was not looking", not archival
 * questions: a cap keeps the file from growing without anyone deciding it should,
 * and 500 is several days of ordinary use. Oldest entries go first.
 */
export const MESSAGE_LIMIT = 500;

interface MessagesFile {
  messages: AppMessage[];
}

/**
 * The message centre's storage: an append-only, capped list on disk.
 *
 * Deliberately dumb. It does not know what a login capture is, does not resolve
 * i18n and does not decide staleness — those belong to whoever produced the
 * message and whoever reads it. Keeping it that way is what lets one list hold
 * four unrelated kinds without growing a switch statement per feature.
 */
export class MessageStore {
  private readonly store: JsonStore<MessagesFile>;

  constructor(filePath: string) {
    this.store = new JsonStore<MessagesFile>(filePath, () => ({ messages: [] }));
  }

  get path(): string {
    return this.store.path;
  }

  /**
   * Records one message and returns it.
   *
   * Repeating an identical headline for the same action within `dedupeMs`
   * updates the existing row instead of adding a second: background checks fire
   * on a timer, and "登录已过期" once per identity per hour belongs in history
   * once, not twelve times.
   */
  add(input: AddMessageInput, dedupeMs = 5 * 60_000): AppMessage {
    const file = this.read();
    const now = Date.now();
    if (dedupeMs > 0) {
      const twin = file.messages.find(
        (item) =>
          item.kind === input.kind &&
          item.titleKey === input.titleKey &&
          sameAction(item.action, input.action) &&
          now - Date.parse(item.at) < dedupeMs,
      );
      if (twin) {
        // Newest state wins, and the row comes back as unread so the count is
        // not silently reset by a repeat of something the user never opened.
        twin.at = new Date(now).toISOString();
        twin.detail = input.detail;
        twin.read = false;
        this.write(file);
        return twin;
      }
    }
    const message: AppMessage = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      kind: input.kind,
      tone: input.tone,
      titleKey: input.titleKey,
      ...(input.titleParams ? { titleParams: input.titleParams } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.action ? { action: input.action } : {}),
      read: false,
    };
    file.messages.unshift(message);
    if (file.messages.length > MESSAGE_LIMIT) {
      file.messages.length = MESSAGE_LIMIT;
    }
    this.write(file);
    return message;
  }

  /** Newest first. */
  list(): AppMessage[] {
    return this.read().messages;
  }

  unreadCount(): number {
    return this.read().messages.filter((item) => !item.read).length;
  }

  /** Marks everything up to now as read; returns how many changed. */
  markAllRead(): number {
    const file = this.read();
    let changed = 0;
    for (const item of file.messages) {
      if (!item.read) {
        item.read = true;
        changed += 1;
      }
    }
    if (changed) this.write(file);
    return changed;
  }

  markRead(id: string): void {
    const file = this.read();
    const item = file.messages.find((entry) => entry.id === id);
    if (!item || item.read) return;
    item.read = true;
    this.write(file);
  }

  /** Drops one row, and the secret it points at with it. */
  remove(id: string): AppMessage | undefined {
    const file = this.read();
    const index = file.messages.findIndex((entry) => entry.id === id);
    if (index < 0) return undefined;
    const [removed] = file.messages.splice(index, 1);
    this.write(file);
    return removed;
  }

  clear(): void {
    this.write({ messages: [] });
  }

  private read(): MessagesFile {
    const file = this.store.read();
    // A hand-edited or truncated file must not take the app down; an empty list
    // is recoverable, a crash on startup is not.
    if (!Array.isArray(file?.messages)) return { messages: [] };
    return file;
  }

  private write(file: MessagesFile): void {
    this.store.write(file);
  }
}

function sameAction(left: MessageAction | undefined, right: MessageAction | undefined): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "login-capture":
      return left.token === (right as { token?: string }).token;
    case "identity":
      return left.identityId === (right as { identityId?: string }).identityId;
    case "tab":
      return left.tabId === (right as { tabId?: string }).tabId;
  }
}
