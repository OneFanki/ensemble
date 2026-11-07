import { describe, expect, it } from "vitest";
import { messages, setCoreLocale, t } from "@core/i18n/translate";

/** Keys of the flat message table (`"vault.locked"` is one literal key). */
function keysOf(tree: Record<string, string>): string[] {
  return Object.keys(tree);
}

describe("core translate", () => {
  it("has the same keys in both languages", () => {
    // The runtime `t()` falls back to zh silently, so a key that only exists in
    // one tree ships as the wrong language with no error anywhere. This is how
    // the default tab label stayed 中文 in the English UI (2.0.0).
    const zh = new Set(keysOf(messages.zh));
    const en = new Set(keysOf(messages.en));
    expect([...zh].filter((key) => !en.has(key)).sort()).toEqual([]);
    expect([...en].filter((key) => !zh.has(key)).sort()).toEqual([]);
  });

  it("leaves no empty message", () => {
    // An empty string renders as a blank label, which reads as a missing
    // control rather than a missing translation.
    for (const tree of [messages.zh, messages.en]) {
      for (const [key, value] of Object.entries(tree)) {
        expect(`${key}: ${value.trim()}`).not.toMatch(/: $/);
      }
    }
  });

  it("follows the locale the main process sets", () => {
    // Default names are persisted into the workspace at creation time, so the
    // locale has to be resolved at the call site — `setCoreLocale` runs on
    // startup and on every settings change for exactly this reason.
    setCoreLocale("en");
    expect(t("page.untitled")).toBe("New tab");
    setCoreLocale("zh");
    expect(t("page.untitled")).toBe("新标签页");
  });
});
