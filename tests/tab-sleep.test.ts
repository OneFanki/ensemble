import { type SleepCandidate, shouldSleepPage } from "@core/cdp/sleep";
import { describe, expect, it } from "vitest";

/**
 * The tab-sleep policy.
 *
 * The scenario the user asked for is short — "a background page saves resources
 * after a while, unless told otherwise, and AI work keeps it responsive" — so
 * each rule is asserted on its own against a candidate that would otherwise
 * sleep. The manager only gathers facts; this table is the whole decision.
 */

const NOW = 1_000_000;

/** A parked page with nothing keeping it awake. */
function parked(overrides: Partial<SleepCandidate> = {}): SleepCandidate {
  return {
    staged: false,
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

  it("never touches a page on stage, even after the grace window", () => {
    expect(shouldSleepPage(parked({ staged: true, aiActiveUntil: 0 }), NOW)).toBe(false);
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
