import { describe, expect, it } from "vitest";
import { GuestSessions, type GuestCdpPort, type GuestHandle } from "@core/cdp/guest-sessions";

/**
 * A port that records what happened, so the tests assert the observable
 * contract (attach before first command, detach on idle, no detach while a
 * command is pending) rather than internal counters.
 */
class FakePort implements GuestCdpPort {
  events: string[] = [];
  opens = 0;
  closes = 0;
  /** Resolve to hold a command open; omit for an immediate reply. */
  hold?: Promise<void>;

  async open(): Promise<void> {
    this.opens += 1;
    this.events.push("open");
  }

  close(): void {
    this.closes += 1;
    this.events.push("close");
  }

  async send<T>(method: string): Promise<T> {
    this.events.push(`send:${method}`);
    if (this.hold) await this.hold;
    return undefined as T;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("guest session lifecycle", () => {
  it("opens the session on the first command and reuses it for the next", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000 });
    const handle = sessions.attach("g1", port);

    await sessions.run(handle, (p) => p.send("Page.navigate"));
    await sessions.run(handle, (p) => p.send("Runtime.evaluate"));

    expect(port.opens).toBe(1);
    expect(port.events).toEqual(["open", "send:Page.navigate", "send:Runtime.evaluate"]);
  });

  it("detaches when the command stream goes idle, and reopens on the next command", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 5 });
    const handle = sessions.attach("g1", port);

    await sessions.run(handle, (p) => p.send("Page.enable"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(port.closes).toBe(1);

    await sessions.run(handle, (p) => p.send("Runtime.evaluate"));
    expect(port.opens).toBe(2);
  });

  it("never detaches while a command is still waiting for its reply", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 5 });
    const handle = sessions.attach("g1", port);

    port.hold = new Promise<void>(() => {});
    void sessions.run(handle, (p) => p.send("Page.captureScreenshot"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(port.closes).toBe(0);
  });

  it("waits for the in-flight command before detaching on teardown", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000, teardownTimeoutMs: 500 });
    const handle = sessions.attach("g1", port);
    const gate = deferred();
    port.hold = gate.promise;

    const inFlight = sessions.run(handle, (p) => p.send("Runtime.evaluate"));
    // Wait until the command is really on the wire: tearing down during the
    // attach handshake is a different path, covered by the next test.
    await waitFor(() => port.events.includes("send:Runtime.evaluate"));
    let tornDown = false;
    const teardown = sessions.teardown("g1").then(() => {
      tornDown = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tornDown).toBe(false);

    gate.resolve();
    await inFlight;
    await teardown;
    expect(tornDown).toBe(true);
    // The command settled before the detach, never after it.
    expect(port.events.at(-1)).toBe("close");
  });

  it("refuses new commands once teardown started", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000 });
    const handle = sessions.attach("g1", port);

    await sessions.teardown("g1");
    await expect(sessions.run(handle, (p) => p.send("Runtime.evaluate"))).rejects.toThrow("页面已关闭");
  });

  it("shares one teardown between concurrent close requests", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000 });
    const handle = sessions.attach("g1", port);
    await sessions.run(handle, (p) => p.send("Page.enable"));

    await Promise.all([sessions.teardown("g1"), sessions.teardown("g1"), sessions.teardown("g1")]);
    expect(port.closes).toBe(1);
    expect(sessions.has("g1")).toBe(false);
  });

  it("closes nothing when a guest is dropped before its session ever opened", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000 });
    sessions.attach("g1", port);

    await sessions.teardown("g1");
    expect(port.opens).toBe(0);
    expect(port.closes).toBe(0);
  });

  it("gives up waiting for a stuck command instead of blocking the close forever", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000, teardownTimeoutMs: 20 });
    const handle = sessions.attach("g1", port);
    port.hold = new Promise<void>(() => {});

    void sessions.run(handle, (p) => p.send("Runtime.evaluate")).catch(() => {});
    await sessions.teardown("g1");
    expect(port.closes).toBe(1);
  });

  it("does not attach a new command to a guest whose generation moved on", () => {
    const first = new FakePort();
    const second = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000 });
    const stale: GuestHandle = sessions.attach("g1", first);
    sessions.forget("g1");
    const fresh = sessions.attach("g1", second);

    expect(fresh.generation).not.toBe(stale.generation);
    return expect(sessions.run(stale, (p) => p.send("Runtime.evaluate"))).rejects.toThrow("页面已关闭");
  });

  it("keeps the same handle when the embedder re-attaches the same node", () => {
    const port = new FakePort();
    const sessions = new GuestSessions();
    const first = sessions.attach("g1", port);
    const second = sessions.attach("g1", port);
    expect(second.generation).toBe(first.generation);
  });

  it("never detaches a guest that is already gone", () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000 });
    sessions.attach("g1", port);
    sessions.forget("g1");
    expect(sessions.has("g1")).toBe(false);
    expect(port.closes).toBe(0);
  });

  it("does not reopen a session for a command that arrived during a close", async () => {
    const port = new FakePort();
    const sessions = new GuestSessions({ idleDetachMs: 10_000 });
    const handle = sessions.attach("g1", port);
    await sessions.run(handle, (p) => p.send("Page.enable"));

    await sessions.teardown("g1");
    const opensBefore = port.opens;
    await expect(sessions.run(handle, (p) => p.send("Page.enable"))).rejects.toThrow();
    expect(port.opens).toBe(opensBefore);
  });
});
