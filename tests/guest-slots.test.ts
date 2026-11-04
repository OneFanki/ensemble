import { describe, expect, it } from "vitest";
import { GuestSlots } from "@core/cdp/guest-slots";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("waiting for a guest that has not attached yet", () => {
  it("delivers the guest to a command that asked first", async () => {
    const slots = new GuestSlots<string>();
    const waiting = slots.wait("tab-1");
    slots.resolve("tab-1", "guest-7");
    await expect(waiting).resolves.toBe("guest-7");
  });

  it("answers immediately once the guest already arrived", async () => {
    const slots = new GuestSlots<string>();
    slots.resolve("tab-1", "guest-7");
    await expect(slots.wait("tab-1")).resolves.toBe("guest-7");
    expect(slots.pending).toBe(0);
  });

  it("gives every command in the same gap the same guest", async () => {
    const slots = new GuestSlots<string>();
    const first = slots.wait("tab-1");
    const second = slots.wait("tab-1");
    expect(slots.pending).toBe(1);

    slots.resolve("tab-1", "guest-7");
    await expect(Promise.all([first, second])).resolves.toEqual(["guest-7", "guest-7"]);
  });

  it("fails a wait that never resolves instead of blocking forever", async () => {
    const slots = new GuestSlots<string>({ timeoutMs: 10 });
    await expect(slots.wait("tab-1")).rejects.toThrow("页面没有在预期时间内就绪");
    expect(slots.pending).toBe(0);
  });

  it("fails the waiter when its page is closed", async () => {
    const slots = new GuestSlots<string>();
    const waiting = slots.wait("tab-1").catch((error: Error) => error.message);
    slots.cancel("tab-1");
    expect(await waiting).toBe("页面已关闭");
  });

  it("does not hand a stale guest to a command that arrives after the close", async () => {
    const slots = new GuestSlots<string>();
    slots.resolve("tab-1", "guest-7");
    slots.cancel("tab-1");
    const waiting = slots.wait("tab-1");
    slots.resolve("tab-1", "guest-9");
    await expect(waiting).resolves.toBe("guest-9");
  });

  it("keeps tokens independent", async () => {
    const slots = new GuestSlots<string>();
    const one = slots.wait("tab-1");
    const two = slots.wait("tab-2");
    slots.resolve("tab-2", "guest-b");
    await expect(two).resolves.toBe("guest-b");
    slots.resolve("tab-1", "guest-a");
    await expect(one).resolves.toBe("guest-a");
  });
});
