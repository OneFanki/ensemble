import { describe, expect, it } from "vitest";
import { withDeadline } from "@shared/async";

/**
 * The point of this helper is a promise that never settles — Chromium answers
 * `Page.captureScreenshot` on a non-painting surface that way. A test that only
 * covers a slow-but-finite promise would pass with a helper that merely waits.
 */
describe("withDeadline", () => {
  it("passes the value through when the work settles in time", async () => {
    await expect(withDeadline(Promise.resolve(42), 1_000, "work")).resolves.toBe(42);
  });

  it("rejects a promise that never settles, naming what hung", async () => {
    const hung = new Promise<never>(() => {
      // Never resolves and never rejects — the shape Chromium takes.
    });
    const started = Date.now();
    await expect(withDeadline(hung, 60, "Page.captureScreenshot")).rejects.toThrow(
      /Page\.captureScreenshot/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps the original rejection when the work fails first", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("the real reason")), 1_000, "work"),
    ).rejects.toThrow("the real reason");
  });

  it("ignores a value that arrives after the deadline fired", async () => {
    // A late answer must not resolve the caller a second time; it is dropped.
    let finish!: (value: string) => void;
    const late = new Promise<string>((resolve) => {
      finish = resolve;
    });
    await expect(withDeadline(late, 40, "late work")).rejects.toThrow(/late work/);
    finish("too late");
    await new Promise((done) => setTimeout(done, 20));
  });
});
