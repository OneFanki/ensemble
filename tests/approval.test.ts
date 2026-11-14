import { describe, expect, it } from "vitest";
import { ApprovalCoordinator } from "../src/main/approval";

/**
 * The authorization queue.
 *
 * What matters here is not "does it ask" — the window does that — but what
 * happens in the corners: two requests at once, an answer arriving after the
 * timer, and shutdown with a question still open. Every one of those ends with a
 * decision, because the MCP caller is waiting on a promise and a promise that
 * never settles would hang a tool call until the client gives up.
 */

const input = (tool: string, origin = "https://a.test") => ({
  tool,
  summary: "点击「提交」",
  actionKey: "app.aiApprovalActionClickPage",
  origin,
  siteName: "A 站",
  context: "默认档案",
  tabTitle: "A 站首页",
});

describe("approval coordinator", () => {
  it("resolves with the answer the user gives", async () => {
    const coordinator = new ApprovalCoordinator(60_000);
    const answer = coordinator.ask(input("click_browser_element"));
    const shown = coordinator.current();
    expect(shown?.tool).toBe("click_browser_element");
    expect(shown?.siteName).toBe("A 站");
    coordinator.answer(shown!.id, "allow-once");
    await expect(answer).resolves.toBe("allow-once");
  });

  it("treats silence as refusal", async () => {
    // The one rule that makes the window safe: an unanswered question is a no.
    // A timer that resolved "allow" would turn a closed laptop into consent.
    const coordinator = new ApprovalCoordinator(10);
    await expect(coordinator.ask(input("type_browser_text"))).resolves.toBe("deny");
    expect(coordinator.pending).toBe(0);
  });

  it("shows one question at a time, oldest first", async () => {
    const coordinator = new ApprovalCoordinator(60_000);
    const first = coordinator.ask(input("click_browser_element", "https://a.test"));
    const second = coordinator.ask(input("type_browser_text", "https://b.test"));
    expect(coordinator.pending).toBe(2);
    expect(coordinator.current()?.origin).toBe("https://a.test");
    coordinator.answer(coordinator.current()!.id, "allow-once");
    await expect(first).resolves.toBe("allow-once");
    // The second only becomes current once the first is answered.
    expect(coordinator.current()?.origin).toBe("https://b.test");
    coordinator.answer(coordinator.current()!.id, "deny");
    await expect(second).resolves.toBe("deny");
    expect(coordinator.current()).toBeUndefined();
  });

  it("ignores an answer that arrives after the request is gone", async () => {
    // The window and the timer race by design; a late click must not throw and
    // must not resurrect the request.
    const coordinator = new ApprovalCoordinator(5);
    const answer = coordinator.ask(input("click_browser_element"));
    const id = coordinator.current()!.id;
    await expect(answer).resolves.toBe("deny");
    expect(() => coordinator.answer(id, "allow-always")).not.toThrow();
    expect(coordinator.pending).toBe(0);
  });

  it("answers everything with a refusal when the app quits", async () => {
    const coordinator = new ApprovalCoordinator(60_000);
    const first = coordinator.ask(input("click_browser_element"));
    const second = coordinator.ask(input("type_browser_text"));
    coordinator.abandonAll();
    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
    expect(coordinator.current()).toBeUndefined();
  });

  it("tells its owner when the queue changes", () => {
    // The window is shown and hidden off this signal; without it the queue would
    // only be discovered by polling, and the second of two questions would never
    // appear.
    let changes = 0;
    const coordinator = new ApprovalCoordinator(60_000, Date.now, () => {
      changes += 1;
    });
    void coordinator.ask(input("click_browser_element"));
    expect(changes).toBe(1);
    coordinator.answer(coordinator.current()!.id, "deny");
    expect(changes).toBe(2);
  });

  it("stamps the deadline from the injected clock", () => {
    // The countdown the window draws and the timer that ends the request must
    // come from one number, or the window would promise a minute and lose the
    // request after five seconds.
    const coordinator = new ApprovalCoordinator(5_000, () => 1_000_000);
    void coordinator.ask(input("click_browser_element"));
    expect(coordinator.current()?.expiresAt).toBe(1_005_000);
    coordinator.abandonAll();
  });
});
