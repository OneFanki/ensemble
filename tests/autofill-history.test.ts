import { describe, expect, it } from "vitest";
import { shouldRecordAutoFill, type AutoFillReportForHistory } from "../src/core/autofill-history";

/**
 * Which auto-fill outcomes reach the message history.
 *
 * The bug this pins: every launched tab ended up with a "no login form found"
 * row. The text is true — the tab really had no form — but on a landing page
 * that is the normal outcome, and a page of them reads as if the app keeps
 * failing at something it is doing correctly.
 *
 * The distinction that matters is *how the run arrived at the page*: landing on
 * a dashboard with no login step is ordinary; walking onto `/login` and finding
 * no form there is a broken site definition.
 */
const base = { filled: false, submitted: false } satisfies AutoFillReportForHistory;

describe("auto-fill history", () => {
  it("drops the ordinary landing-page outcome", () => {
    expect(shouldRecordAutoFill({ ...base, skipped: "not-login-page" })).toBe(false);
  });

  it("keeps a login page that had no form", () => {
    expect(
      shouldRecordAutoFill({ ...base, skipped: "not-login-page", navigatedToLogin: true }),
    ).toBe(true);
  });

  it("drops a successful fill", () => {
    expect(shouldRecordAutoFill({ filled: true, submitted: true, loggedIn: true })).toBe(false);
    // Filled but not submitted (autoSubmit off) is also success: the form is
    // waiting for the user, which is what they configured.
    expect(shouldRecordAutoFill({ filled: true, submitted: false })).toBe(false);
  });

  it("keeps a fill that submitted and stayed signed out", () => {
    expect(shouldRecordAutoFill({ filled: true, submitted: true, loggedIn: false })).toBe(true);
  });

  it("keeps every outcome the user can act on", () => {
    for (const skipped of ["no-password", "cross-origin", "login-failed"] as const) {
      expect(shouldRecordAutoFill({ ...base, skipped })).toBe(true);
    }
  });
});
