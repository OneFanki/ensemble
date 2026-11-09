import { describe, expect, it } from "vitest";
import { navigationArrived } from "../src/main/embedded/browser";

/**
 * Deciding that a navigation has landed.
 *
 * The failure this pins was never an error message: a login page that redirects
 * (`/` → `/login`, `/login` → `/home`) never matched the requested address, so
 * every such navigation sat out the whole ten-second deadline. It did not fail,
 * it just felt like the app was slow — which is why the rule is a pure function
 * with its own cases.
 */
const base = { state: "complete" };

describe("navigationArrived", () => {
  it("accepts the requested address", () => {
    expect(
      navigationArrived({ ...base, href: "https://app.test/login", wanted: "https://app.test/login" }),
    ).toBe(true);
  });

  it("accepts a query-string difference", () => {
    // Logins bounce around with `?redirect=`: same page, different address.
    expect(
      navigationArrived({
        ...base,
        href: "https://app.test/login?redirect=%2Fhome",
        wanted: "https://app.test/login",
      }),
    ).toBe(true);
  });

  it("accepts a trailing-slash difference", () => {
    expect(
      navigationArrived({ ...base, href: "https://app.test/home/", wanted: "https://app.test/home" }),
    ).toBe(true);
  });

  it("accepts a redirect to another path", () => {
    expect(
      navigationArrived({
        ...base,
        href: "https://app.test/login",
        wanted: "https://app.test/",
        startedFrom: "https://app.test/",
      }),
    ).toBe(true);
  });

  it("does not call an unparsed document arrived", () => {
    expect(
      navigationArrived({
        state: "loading",
        href: "https://app.test/login",
        wanted: "https://app.test/",
        startedFrom: "https://app.test/",
      }),
    ).toBe(false);
  });

  /**
   * Before the navigation commits, the old document is still there and is
   * already `complete`. Treating that as arrival made the following read look
   * in the page being left behind.
   */
  it("does not call the page we started on arrived", () => {
    expect(
      navigationArrived({
        ...base,
        href: "https://app.test/old",
        wanted: "https://app.test/new",
        startedFrom: "https://app.test/old",
      }),
    ).toBe(false);
  });

  it("trusts only the exact address when it does not know where it started", () => {
    expect(
      navigationArrived({ ...base, href: "https://app.test/elsewhere", wanted: "https://app.test/login" }),
    ).toBe(false);
  });
});
