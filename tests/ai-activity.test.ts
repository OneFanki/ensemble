import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_ACTIVITY_LIMIT, AiActivityStore } from "../src/core/ai-activity";
import { groupAiActivity } from "../src/shared/ai-activity";

/**
 * The AI activity log.
 *
 * Three things carry the behaviour: the merge key (which is what makes a click
 * and a following type two rows instead of one), the cap (its own, so a busy
 * session cannot empty the message centre), and grouping (which is the whole
 * reason the rows carry a site id).
 */
let dir: string;
let store: AiActivityStore;

const call = (overrides: Partial<Parameters<AiActivityStore["add"]>[0]> = {}) => ({
  tool: "click_browser_element",
  origin: "https://a.test",
  siteId: "s1",
  tabId: "t1",
  tabTitle: "A 站首页",
  ok: true,
  originAuthorized: true,
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-ai-activity-"));
  store = new AiActivityStore(join(dir, "ai-activity.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("ai activity store", () => {
  it("records a call, newest first", () => {
    store.add(call({ tool: "click_browser_element" }));
    store.add(call({ tool: "type_browser_text", tabId: "t2" }));
    expect(store.list().map((item) => item.tool)).toEqual([
      "type_browser_text",
      "click_browser_element",
    ]);
  });

  it("keeps a different tool in the same tab as its own row", () => {
    // The message centre merged these: the dedupe key was (kind, titleKey,
    // action), and the action was the tab. A click followed by a type inside a
    // minute became one row that still named the click.
    store.add(call({ tool: "click_browser_element" }));
    store.add(call({ tool: "type_browser_text" }));
    expect(store.list()).toHaveLength(2);
  });

  it("folds a repeated call into one row with a count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store.add(call());
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    store.add(call());
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.count).toBe(2);
    expect(list[0]?.at).toBe("2026-01-01T00:00:02.000Z");
  });

  it("stops folding once the merge window has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store.add(call());
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    store.add(call());
    expect(store.list()).toHaveLength(2);
  });

  it("keeps a refusal separate from a success on the same tool", () => {
    store.add(call());
    store.add(call({ ok: false, originAuthorized: false, approval: "deny" }));
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.originAuthorized).toBe(false);
    expect(list[0]?.approval).toBe("deny");
  });

  it("keeps each answer to the authorization question as its own row", () => {
    // Two successful clicks a second apart are one intent, but "allowed once" and
    // "allowed for this run" are two different decisions. Folding them would
    // leave one row whose answer describes neither of the calls it covers.
    store.add(call({ approval: "allow-once" }));
    store.add(call({ approval: "allow-session" }));
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((item) => item.approval)).toEqual(["allow-session", "allow-once"]);
  });

  it("caps its own list without touching messages", () => {
    // The two logs have different volumes; sharing a cap was how a run of AI
    // calls pushed login captures out of the message centre. The overfull file is
    // written as a fixture rather than grown one call at a time: 1000 fsyncs
    // would make this suite slower than the whole rest of it.
    const path = join(dir, "ai-activity.json");
    // Newest first, the order the file is kept in: index 0 is the most recent,
    // so the entry that falls off the end when the cap is exceeded is tool_999.
    const records = Array.from({ length: AI_ACTIVITY_LIMIT }, (_, index) => ({
      id: `seed-${index}`,
      at: new Date(Date.parse("2026-01-01T00:00:00Z") + (AI_ACTIVITY_LIMIT - index) * 1000).toISOString(),
      tool: `tool_${index}`,
      origin: "https://a.test",
      tabId: "t1",
      ok: true,
      originAuthorized: true,
      count: 1,
    }));
    writeFileSync(path, JSON.stringify({ records }));
    const capped = new AiActivityStore(path);
    capped.add(call({ tool: "newest" }), 0);
    const list = capped.list();
    expect(list).toHaveLength(AI_ACTIVITY_LIMIT);
    expect(list[0]?.tool).toBe("newest");
    expect(list.at(-1)?.tool).toBe("tool_998");
  });

  it("survives a restart", () => {
    store.add(call({ tool: "evaluate_browser_page", summary: "在页面里执行脚本" }));
    const reopened = new AiActivityStore(join(dir, "ai-activity.json"));
    expect(reopened.list().map((item) => item.tool)).toEqual(["evaluate_browser_page"]);
    // The description is the only surviving account of what happened, so it has
    // to survive the same trip the tool name does.
    expect(reopened.list()[0]?.summary).toBe("在页面里执行脚本");
  });

  it("reads a truncated file as an empty log", () => {
    // A half-written file must not take the app down on launch; the log is the
    // one thing here that can be lost without harm.
    const path = join(dir, "ai-activity.json");
    const broken = new AiActivityStore(path);
    broken.clear();
    expect(() => new AiActivityStore(path).list()).not.toThrow();
  });

  it("groups by site, newest group first", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    store.add(call({ siteId: "s1", origin: "https://a.test" }), 0);
    vi.setSystemTime(new Date("2026-01-01T00:00:05Z"));
    store.add(call({ siteId: "s2", origin: "https://b.test" }), 0);
    vi.setSystemTime(new Date("2026-01-01T00:00:09Z"));
    store.add(call({ siteId: "s1", origin: "https://a.test", tool: "type_browser_text" }), 0);
    const groups = groupAiActivity(store.list());
    expect(groups.map((group) => group.siteId)).toEqual(["s1", "s2"]);
    expect(groups[0]?.records).toHaveLength(2);
  });

  it("groups a page with no known site by its origin", () => {
    // A typed address the workspace has no site for is still a place, and its
    // rows still belong together.
    store.add(call({ siteId: undefined, origin: "https://loose.test" }), 0);
    store.add(call({ siteId: undefined, origin: "https://loose.test", tool: "scroll_page" }), 0);
    const groups = groupAiActivity(store.list());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("origin:https://loose.test");
    expect(groups[0]?.siteId).toBeUndefined();
  });
});
