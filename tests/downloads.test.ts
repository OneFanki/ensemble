import { describe, expect, it, vi } from "vitest";
import {
  DownloadManager,
  type DownloadItemLike,
  type DownloadSessionLike,
} from "../src/main/downloads";

/** Stands in for Electron's DownloadItem, driven by hand from the tests. */
class FakeItem {
  private state = "progressing";
  private received = 0;
  private total = 1_000;
  private savePath = "";
  private updated: (() => void)[] = [];
  private done: ((event: unknown, state: string) => void)[] = [];

  constructor(
    readonly filename = "orders.csv",
    readonly url = "http://example.test/orders.csv",
  ) {}

  getFilename(): string {
    return this.filename;
  }
  getURL(): string {
    return this.url;
  }
  getSavePath(): string {
    return this.savePath;
  }
  getState(): string {
    return this.state;
  }
  getReceivedBytes(): number {
    return this.received;
  }
  getTotalBytes(): number {
    return this.total;
  }
  getStartTime(): number {
    return 1_700_000_000;
  }
  cancel(): void {
    this.state = "cancelled";
    for (const listener of this.done) listener({}, "cancelled");
  }
  // Cast once instead of repeating Electron's two overloads: the fake only has
  // to behave like the interface, not re-declare it.
  on = ((event: string, listener: (event?: unknown, state?: string) => void) => {
    if (event === "updated") this.updated.push(listener as () => void);
    else this.done.push(listener as (event: unknown, state: string) => void);
  }) as unknown as DownloadItemLike["on"];

  /** One chunk of progress, as Chromium reports it. */
  progress(received: number): void {
    this.received = received;
    for (const listener of this.updated) listener();
  }

  /** The save dialog was accepted and the bytes landed. */
  finish(savePath = "/Users/someone/Downloads/orders.csv"): void {
    this.state = "completed";
    this.savePath = savePath;
    this.received = this.total;
    for (const listener of this.done) listener({}, "completed");
  }
}

function fakeSession() {
  let deliver: (item: DownloadItemLike) => void = () => {};
  const session = {
    hooks: 0,
    on(_event: "will-download", listener: (event: unknown, item: DownloadItemLike) => void) {
      session.hooks += 1;
      deliver = (item) => listener({}, item);
    },
    /** Starts a download the way the session would. */
    download(item: DownloadItemLike) {
      deliver(item);
    },
  };
  return session;
}

type FakeSession = ReturnType<typeof fakeSession>;

function attach(manager: DownloadManager): FakeSession {
  const ses = fakeSession();
  manager.attach(ses as unknown as DownloadSessionLike);
  return ses;
}

describe("DownloadManager", () => {
  it("hooks a session once, however often it is configured", () => {
    const manager = new DownloadManager(() => {});
    const ses = attach(manager);
    manager.attach(ses as unknown as DownloadSessionLike);
    expect(ses.hooks).toBe(1);
  });

  it("shows a download as soon as it starts", () => {
    const changes: number[] = [];
    const manager = new DownloadManager((entries) => changes.push(entries.length));
    const ses = attach(manager);
    ses.download(new FakeItem());

    const [entry] = manager.list();
    expect(entry?.filename).toBe("orders.csv");
    expect(entry?.state).toBe("progressing");
    expect(entry?.receivedBytes).toBe(0);
    expect(changes.at(-1)).toBe(1);
  });

  it("throttles notifications while the state stays current", () => {
    vi.useFakeTimers();
    try {
      let notifications = 0;
      const manager = new DownloadManager(() => {
        notifications += 1;
      });
      const ses = attach(manager);
      const item = new FakeItem();
      ses.download(item);
      const afterStart = notifications;

      item.progress(200);
      item.progress(400);
      item.progress(600);
      // Three chunks, one scheduled redraw: the list is already current, but
      // the toolbar is not asked to repaint per chunk.
      expect(notifications).toBe(afterStart);
      expect(manager.list()[0]?.receivedBytes).toBe(600);
      vi.advanceTimersByTime(200);
      expect(notifications).toBe(afterStart + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a finished download immediately and keeps the path", () => {
    const manager = new DownloadManager(() => {});
    const ses = attach(manager);
    const item = new FakeItem();
    ses.download(item);

    item.finish();
    const [entry] = manager.list();
    expect(entry?.state).toBe("completed");
    expect(entry?.savePath).toContain("orders.csv");
    expect(entry?.finishedAt).toBeGreaterThan(0);
  });

  it("cancels through the item", () => {
    const manager = new DownloadManager(() => {});
    const ses = attach(manager);
    const item = new FakeItem();
    ses.download(item);
    const id = manager.list()[0]?.id ?? "";

    manager.cancel(id);
    expect(manager.list()[0]?.state).toBe("cancelled");
  });

  it("removes one finished entry but never a running one", () => {
    const manager = new DownloadManager(() => {});
    const ses = attach(manager);
    const running = new FakeItem("running.bin", "http://example.test/running.bin");
    const finished = new FakeItem("done.bin", "http://example.test/done.bin");
    ses.download(running);
    ses.download(finished);
    finished.finish("/tmp/done.bin");

    const idOf = (name: string) => manager.list().find((entry) => entry.filename === name)?.id ?? "";

    manager.remove(idOf("running.bin"));
    expect(manager.list()).toHaveLength(2);
    manager.remove(idOf("done.bin"));
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.filename).toBe("running.bin");
  });

  it("clears only what has finished", () => {
    const manager = new DownloadManager(() => {});
    const ses = attach(manager);
    const running = new FakeItem("running.bin", "http://example.test/running.bin");
    const finished = new FakeItem("done.bin", "http://example.test/done.bin");
    ses.download(running);
    ses.download(finished);
    finished.finish("/tmp/done.bin");

    manager.clear();
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.filename).toBe("running.bin");
  });
});
