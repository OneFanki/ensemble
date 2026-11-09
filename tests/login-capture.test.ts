import { describe, expect, it, vi } from "vitest";
import { LoginCaptureStore } from "../src/main/embedded/login-capture";

/**
 * The capture store is what stands between a submitted login form and the
 * vault: the renderer only ever learns the token and username, and the secret
 * leaves exactly once. These cases pin that contract, and the de-duplication
 * that keeps one login from becoming several prompts.
 */
const base = {
  password: "s3cret",
  origin: "http://localhost:3000",
  path: "/login",
  tabId: "tab-1",
};

describe("login capture store", () => {
  it("gives the renderer a token and username but never the password", () => {
    const store = new LoginCaptureStore();
    const notice = store.add({ ...base, username: "admin" });
    expect(notice?.username).toBe("admin");
    expect(notice?.token).toBeTruthy();
    expect(JSON.stringify(notice)).not.toContain("s3cret");
  });

  it("releases the secret once and then forgets it", () => {
    const store = new LoginCaptureStore();
    const notice = store.add({ ...base, username: "admin" });
    expect(store.take(notice!.token)?.password).toBe("s3cret");
    // A form submits several events for one login; the second write must fail
    // loudly instead of saving an account with no password.
    expect(store.take(notice!.token)).toBeUndefined();
  });

  it("collapses repeated submissions of the same login into one prompt", () => {
    const store = new LoginCaptureStore();
    expect(store.add({ ...base, username: "Admin" })).toBeTruthy();
    expect(store.add({ ...base, username: "admin" })).toBeUndefined();
  });

  it("keeps different accounts on one origin apart", () => {
    const store = new LoginCaptureStore();
    expect(store.add({ ...base, username: "admin" })).toBeTruthy();
    expect(store.add({ ...base, username: "viewer" })).toBeTruthy();
  });

  it("attaches a site to a pending capture without touching the secret", () => {
    const store = new LoginCaptureStore();
    const notice = store.add({ ...base, username: "admin" });
    const withSite = store.attachSite(notice!.token, "site-1");
    expect(withSite?.siteId).toBe("site-1");
    expect(JSON.stringify(withSite)).not.toContain("s3cret");
    expect(store.take(notice!.token)?.password).toBe("s3cret");
  });

  it("drops a dismissed capture so it cannot be saved later", () => {
    const store = new LoginCaptureStore();
    const notice = store.add({ ...base, username: "admin" });
    store.discard(notice!.token);
    expect(store.take(notice!.token)).toBeUndefined();
  });

  it("lists every pending capture newest first, without secrets", () => {
    const store = new LoginCaptureStore();
    store.add({ ...base, username: "admin" });
    store.add({ ...base, username: "viewer" });
    const list = store.list();
    expect(list.map((item) => item.username)).toEqual(["viewer", "admin"]);
    expect(JSON.stringify(list)).not.toContain("s3cret");
  });

  /**
   * A capture the user let pass is still recoverable. It used to be lost, and
   * the only way back was to sign out and in again.
   */
  it("keeps a capture in the list after a newer one arrives", () => {
    const store = new LoginCaptureStore();
    const first = store.add({ ...base, username: "admin" });
    store.add({ ...base, username: "viewer" });
    expect(store.list().map((item) => item.token)).toContain(first!.token);
    expect(store.take(first!.token)?.password).toBe("s3cret");
  });

  /**
   * Signing in again with the same account replaces the earlier capture: the
   * older password is the one that stopped working, and offering both would ask
   * the user to save the same login twice.
   */
  it("replaces an earlier capture of the same account", () => {
    vi.useFakeTimers();
    try {
      const store = new LoginCaptureStore();
      const first = store.add({ ...base, username: "admin" });
      // Past the submit-event dedupe window: this is a second real attempt.
      vi.advanceTimersByTime(60_000);
      const second = store.add({ ...base, username: "admin", password: "n3w" });
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.token).toBe(second!.token);
      expect(store.take(first!.token)).toBeUndefined();
      expect(store.take(second!.token)?.password).toBe("n3w");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a saved capture leave the list after take()", () => {
    const store = new LoginCaptureStore();
    const notice = store.add({ ...base, username: "admin" });
    store.take(notice!.token);
    expect(store.list()).toHaveLength(0);
  });
});
