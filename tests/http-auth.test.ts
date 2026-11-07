import { describe, expect, it } from "vitest";
import { fixRealmEncoding, HttpAuthCoordinator } from "../src/main/http-auth";

/** A challenge's display info, minus the id the coordinator assigns. */
const INFO = { host: "example.com", scheme: "Basic", isProxy: false };

/** Collects what one responder received, in call order. */
function recorder() {
  const calls: Array<Array<string | undefined>> = [];
  const respond = (username?: string, password?: string) => calls.push([username, password]);
  return { calls, respond };
}

describe("realm encoding repair", () => {
  it("recovers a UTF-8 realm that was decoded as latin-1", () => {
    // What Chromium hands over for a server sending UTF-8 bytes in the
    // WWW-Authenticate header (nginx configs with a Chinese realm do this).
    const mojibake = Buffer.from("路径登录密码管理", "utf8").toString("latin1");
    expect(fixRealmEncoding(mojibake)).toBe("路径登录密码管理");
  });

  it("leaves pure-ASCII realms untouched", () => {
    expect(fixRealmEncoding("Restricted area")).toBe("Restricted area");
  });

  it("keeps genuinely latin-1 text instead of corrupting it further", () => {
    // "Zone protégée" as latin-1 (é = one byte) has no valid UTF-8 reading:
    // the repair would produce replacement characters, so the original stays.
    expect(fixRealmEncoding("Zone protégée")).toBe("Zone protégée");
    expect(fixRealmEncoding("已登录")).toBe("已登录");
  });
});

describe("http auth coordinator", () => {
  it("answers a repeat challenge once from the cache, then asks again", () => {
    const coordinator = new HttpAuthCoordinator();
    const first = recorder();
    const shown = coordinator.begin("k", INFO, first.respond);
    expect(shown).not.toBeNull();
    coordinator.submit(shown!.id, "user", "secret");

    // Same protection space challenges again (the page's next request will,
    // until Chromium's own auth cache takes over): the cached answer is used…
    const second = recorder();
    const again = coordinator.begin("k", INFO, second.respond);
    expect(again).toBeNull();
    expect(second.calls).toEqual([["user", "secret"]]);
    expect(first.calls).toHaveLength(1);

    // …consumed once. If the server challenges a third time, the credentials
    // were rejected and the user has to be asked again — this is what keeps a
    // rejected answer from looping forever.
    const third = recorder();
    expect(coordinator.begin("k", INFO, third.respond)).not.toBeNull();
    expect(third.calls).toEqual([]);
  });

  it("queues concurrent challenges for one space behind the open dialog", () => {
    const coordinator = new HttpAuthCoordinator();
    const lead = recorder();
    const shown = coordinator.begin("k", INFO, lead.respond);
    expect(shown).not.toBeNull();

    // A second request to the same origin while the dialog is up: no second
    // dialog, and no answer yet.
    const follower = recorder();
    expect(coordinator.begin("k", INFO, follower.respond)).toBeNull();
    expect(follower.calls).toEqual([]);

    coordinator.submit(shown!.id, "user", "secret");
    expect(follower.calls).toEqual([["user", "secret"]]);
  });

  it("gives a different protection space its own dialog", () => {
    const coordinator = new HttpAuthCoordinator();
    const a = coordinator.begin("a", INFO, () => {});
    const b = coordinator.begin("b", { ...INFO, host: "other.com" }, () => {});
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it("cancelling answers nothing, does not cache, and abandons the queue", () => {
    // silenceMs 0: the dismissal window is not under test here.
    const coordinator = new HttpAuthCoordinator(0);
    const lead = recorder();
    const shown = coordinator.begin("k", INFO, lead.respond);
    const follower = recorder();
    coordinator.begin("k", INFO, follower.respond);

    coordinator.cancel(shown!.id);
    expect(lead.calls).toEqual([[undefined, undefined]]);
    expect(follower.calls).toEqual([[undefined, undefined]]);

    // Not cached: the next challenge has to ask again…
    const next = recorder();
    expect(coordinator.begin("k", INFO, next.respond)).not.toBeNull();
    expect(next.calls).toEqual([]);
  });

  it("stays silent for the dismissed space while its resources keep challenging", () => {
    const coordinator = new HttpAuthCoordinator();
    const lead = recorder();
    const shown = coordinator.begin("k", INFO, lead.respond);
    coordinator.cancel(shown!.id);

    // The dismissed navigation's remaining resources each get a challenge; the
    // dismissal window answers them with nothing instead of stacking dialogs.
    const favicon = recorder();
    expect(coordinator.begin("k", INFO, favicon.respond)).toBeNull();
    expect(favicon.calls).toEqual([[undefined, undefined]]);
  });

  it("ignores a second answer for the same challenge", () => {
    const coordinator = new HttpAuthCoordinator();
    const lead = recorder();
    const shown = coordinator.begin("k", INFO, lead.respond);
    coordinator.submit(shown!.id, "user", "secret");
    coordinator.cancel(shown!.id);
    expect(lead.calls).toEqual([["user", "secret"]]);
  });

  it("abandons everything on shutdown so no callback hangs", () => {
    const coordinator = new HttpAuthCoordinator();
    const lead = recorder();
    const shown = coordinator.begin("k", INFO, lead.respond);
    const follower = recorder();
    coordinator.begin("k", INFO, follower.respond);

    coordinator.abandonAll();
    expect(lead.calls).toEqual([[undefined, undefined]]);
    expect(follower.calls).toEqual([[undefined, undefined]]);
    // After the wipe, a stale dialog answer is a no-op.
    coordinator.submit(shown!.id, "user", "secret");
    expect(lead.calls).toEqual([[undefined, undefined]]);
  });

  it("carries the display info through untouched", () => {
    const coordinator = new HttpAuthCoordinator();
    const shown = coordinator.begin(
      "k",
      { host: "proxy.local", port: 8080, realm: "Restricted", scheme: "Digest", isProxy: true },
      () => {},
    );
    expect(shown).toEqual({
      id: expect.any(String),
      host: "proxy.local",
      port: 8080,
      realm: "Restricted",
      scheme: "Digest",
      isProxy: true,
    });
  });
});
