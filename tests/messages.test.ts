import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_LIMIT, MessageStore } from "../src/core/messages";

/**
 * The message centre's storage.
 *
 * Its contract is small on purpose — append, cap, mark read, remove — because
 * what a message *means* belongs to its producer. These cases pin the parts that
 * are easy to get wrong silently: the cap, the de-duplication, and the file
 * surviving a restart.
 */
let dir: string;
let store: MessageStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-messages-"));
  store = new MessageStore(join(dir, "messages.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("message store", () => {
  it("records a message as unread, newest first", () => {
    store.add({ kind: "app", tone: "info", titleKey: "messages.first" });
    store.add({ kind: "ai", tone: "warning", titleKey: "messages.second" });
    const list = store.list();
    expect(list.map((item) => item.titleKey)).toEqual(["messages.second", "messages.first"]);
    expect(list.every((item) => !item.read)).toBe(true);
    expect(store.unreadCount()).toBe(2);
  });

  it("survives a restart", () => {
    store.add({ kind: "account", tone: "error", titleKey: "app.messagesLoginFailed" });
    const reopened = new MessageStore(join(dir, "messages.json"));
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]?.titleKey).toBe("app.messagesLoginFailed");
  });

  it("keeps the newest entries when the cap is reached", () => {
    for (let index = 0; index < MESSAGE_LIMIT + 5; index += 1) {
      store.add({ kind: "app", tone: "info", titleKey: `messages.m${index}` });
    }
    const list = store.list();
    expect(list).toHaveLength(MESSAGE_LIMIT);
    // The last one written is first, and the five oldest are the ones gone.
    expect(list[0]?.titleKey).toBe(`messages.m${MESSAGE_LIMIT + 4}`);
    expect(list.some((item) => item.titleKey === "messages.m0")).toBe(false);
  });

  /**
   * Background checks run on a timer. Without de-duplication one broken site
   * would push a row per identity per hour and bury everything else.
   */
  it("collapses a repeat of the same headline within the window", () => {
    const first = store.add({
      kind: "account",
      tone: "error",
      titleKey: "app.messagesLoginFailed",
      action: { type: "identity", identityId: "id-1" },
    });
    const second = store.add({
      kind: "account",
      tone: "error",
      titleKey: "app.messagesLoginFailed",
      action: { type: "identity", identityId: "id-1" },
    });
    expect(store.list()).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it("keeps the same headline for a different target apart", () => {
    store.add({
      kind: "account",
      tone: "error",
      titleKey: "app.messagesLoginFailed",
      action: { type: "identity", identityId: "id-1" },
    });
    store.add({
      kind: "account",
      tone: "error",
      titleKey: "app.messagesLoginFailed",
      action: { type: "identity", identityId: "id-2" },
    });
    expect(store.list()).toHaveLength(2);
  });

  it("records the same headline again once the window has passed", () => {
    vi.useFakeTimers();
    store.add({ kind: "ai", tone: "info", titleKey: "app.messagesAiAction" });
    vi.advanceTimersByTime(10 * 60_000);
    store.add({ kind: "ai", tone: "info", titleKey: "app.messagesAiAction" });
    expect(store.list()).toHaveLength(2);
  });

  it("marks one message read without touching the others", () => {
    const first = store.add({ kind: "app", tone: "info", titleKey: "messages.a" });
    store.add({ kind: "app", tone: "info", titleKey: "messages.b" });
    store.markRead(first.id);
    expect(store.unreadCount()).toBe(1);
  });

  it("marks everything read at once", () => {
    store.add({ kind: "app", tone: "info", titleKey: "messages.a" });
    store.add({ kind: "app", tone: "info", titleKey: "messages.b" });
    expect(store.markAllRead()).toBe(2);
    expect(store.unreadCount()).toBe(0);
    // A second pass changes nothing, so it does not rewrite the file.
    expect(store.markAllRead()).toBe(0);
  });

  it("removes one row and reports it, so its secret can be dropped too", () => {
    const kept = store.add({ kind: "app", tone: "info", titleKey: "messages.keep" });
    const dropped = store.add({
      kind: "login-capture",
      tone: "info",
      titleKey: "app.messagesLoginCaptured",
      action: { type: "login-capture", token: "tok-1" },
    });
    const removed = store.remove(dropped.id);
    expect(removed?.action).toEqual({ type: "login-capture", token: "tok-1" });
    expect(store.list().map((item) => item.id)).toEqual([kept.id]);
  });

  /**
   * A truncated or hand-edited file must not take the app down: an empty history
   * is a recoverable state, a crash on startup is not.
   */
  it("treats an unreadable file as an empty history rather than crashing", () => {
    writeFileSync(join(dir, "messages.json"), "{ not json", "utf8");
    expect(() => store.list()).toThrow();
    writeFileSync(join(dir, "messages.json"), JSON.stringify({ messages: "nope" }), "utf8");
    expect(store.list()).toEqual([]);
  });
});
