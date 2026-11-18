import {
  type SleepCandidate,
  shouldSleepPage,
  sleepExemptReason,
} from "@core/cdp/sleep";
import { describe, expect, it } from "vitest";

/**
 * The tab-sleep policy.
 *
 * The scenario the user asked for is short — "a background page saves resources
 * after a while, unless told otherwise, and AI work keeps it responsive" — so
 * each rule is asserted on its own against a candidate that would otherwise
 * sleep. The manager only gathers facts; this table is the whole decision.
 *
 * The exemption reason is asserted alongside the decision: it is the published
 * shape of the same rule (`list_browser_tabs` 的 `sleepExempt`), so reason and
 * decision must never drift — `undefined` means the sweep will freeze.
 */

const NOW = 1_000_000;

/** A parked page with nothing keeping it awake. */
function parked(overrides: Partial<SleepCandidate> = {}): SleepCandidate {
  return {
    userVisible: false,
    frozen: false,
    available: true,
    loading: false,
    crashed: false,
    blank: false,
    devtoolsOpen: false,
    audible: false,
    busy: false,
    ...overrides,
  };
}

describe("shouldSleepPage", () => {
  it("sleeps a parked page once the AI window has lapsed", () => {
    expect(shouldSleepPage(parked(), NOW)).toBe(true);
    expect(shouldSleepPage(parked({ aiActiveUntil: NOW - 1 }), NOW)).toBe(true);
    expect(shouldSleepPage(parked({ aiActiveUntil: NOW }), NOW)).toBe(true);
  });

  it("keeps the page awake while AI traffic is recent", () => {
    expect(shouldSleepPage(parked({ aiActiveUntil: NOW + 60_000 }), NOW)).toBe(false);
  });

  it("never touches a page the user is looking at, even after the grace window", () => {
    expect(shouldSleepPage(parked({ userVisible: true, aiActiveUntil: 0 }), NOW)).toBe(false);
  });

  it("does not re-sleep a page that is already frozen", () => {
    expect(shouldSleepPage(parked({ frozen: true }), NOW)).toBe(false);
  });

  it("skips a page whose carrier is gone", () => {
    expect(shouldSleepPage(parked({ available: false }), NOW)).toBe(false);
  });

  it("waits for loading, crashed and blank pages", () => {
    expect(shouldSleepPage(parked({ loading: true }), NOW)).toBe(false);
    expect(shouldSleepPage(parked({ crashed: true }), NOW)).toBe(false);
    expect(shouldSleepPage(parked({ blank: true }), NOW)).toBe(false);
  });

  it("leaves inspected and audible pages alone", () => {
    expect(shouldSleepPage(parked({ devtoolsOpen: true }), NOW)).toBe(false);
    expect(shouldSleepPage(parked({ audible: true }), NOW)).toBe(false);
  });

  it("honours a per-tab never-sleep policy", () => {
    expect(shouldSleepPage(parked({ policy: "never" }), NOW)).toBe(false);
  });

  it("treats an in-flight command as activity, even past the grace window", () => {
    // A long `evaluate` can outlive the AI grace period. Freezing here would
    // suspend the script mid-run and end it as a timeout.
    expect(shouldSleepPage(parked({ busy: true, aiActiveUntil: NOW - 60_000 }), NOW)).toBe(false);
  });
});

describe("sleepExemptReason", () => {
  it("agrees with the sleep decision: undefined means the sweep will freeze", () => {
    expect(sleepExemptReason(parked(), NOW)).toBeUndefined();
    expect(sleepExemptReason(parked({ aiActiveUntil: NOW - 1 }), NOW)).toBeUndefined();
    expect(sleepExemptReason(parked({ aiActiveUntil: NOW + 60_000 }), NOW)).toBe("ai-active");
  });

  it("names the stage visibility exemption, not just occupancy", () => {
    expect(sleepExemptReason(parked({ userVisible: true }), NOW)).toBe("on-stage-visible");
  });

  it("reports the clause that actually decided, in policy order", () => {
    expect(sleepExemptReason(parked({ frozen: true }), NOW)).toBe("frozen");
    expect(sleepExemptReason(parked({ loading: true }), NOW)).toBe("loading");
    expect(sleepExemptReason(parked({ crashed: true }), NOW)).toBe("crashed");
    expect(sleepExemptReason(parked({ blank: true }), NOW)).toBe("blank");
    expect(sleepExemptReason(parked({ devtoolsOpen: true }), NOW)).toBe("devtools");
    expect(sleepExemptReason(parked({ audible: true }), NOW)).toBe("audible");
    expect(sleepExemptReason(parked({ policy: "never" }), NOW)).toBe("policy");
    expect(sleepExemptReason(parked({ busy: true }), NOW)).toBe("ai-active");
  });

  it("ranks the visible-page clause above every later one", () => {
    // A page the user is watching stays awake whatever else is true of it; the
    // reason names the visibility clause so the AI can tell it apart from a
    // page held open by sound or by an AI window.
    expect(
      sleepExemptReason(parked({ userVisible: true, audible: true, policy: "never" }), NOW),
    ).toBe("on-stage-visible");
  });

  it("keeps the carrier-less page awake and says why", () => {
    // The sweep never reaches a carrier-less page, and the decision stays
    // "do not freeze" — the reason just names it instead of pretending the page
    // would sleep.
    expect(sleepExemptReason(parked({ available: false }), NOW)).toBe("no-carrier");
    expect(shouldSleepPage(parked({ available: false }), NOW)).toBe(false);
  });
});
