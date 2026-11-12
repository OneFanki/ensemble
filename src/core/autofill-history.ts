import type { AutoFillReport } from "@shared/types";

/**
 * Which automatic-fill outcomes are worth keeping in the message history.
 *
 * The report itself always reaches the renderer, which decides whether to show a
 * toast for the moment. History is a different question: it is the record you
 * scroll back through when something went wrong, so it should hold outcomes the
 * user has to *act* on and nothing else.
 *
 * Three cases, and the boundary between them is the whole point of this module:
 *
 *  - A successful fill is already visible on the page. Nothing to look up later.
 *  - "not-login-page" on a landing or dashboard page is the ordinary case. The
 *    tab opened on a page that never had a login step; the poll found no field to
 *    type into, which is correct behaviour, not a failure. Recording it per
 *    launched tab filled the history with "no login form found": true, useless,
 *    and phrased as if the app had broken.
 *  - "not-login-page" *after navigating to the site's own login path* is the
 *    opposite: the app went to the page that must contain a form and did not find
 *    one. That is a wrong `loginPath` or a form the field scan cannot see — a
 *    real defect, and exactly what the history is for.
 *
 * Everything else (a missing password, a cross-origin login page, a session that
 * stayed signed out after submitting) is a failure the user can fix, so it stays.
 */
export type AutoFillReportForHistory = Pick<
  AutoFillReport,
  "filled" | "submitted" | "loggedIn" | "skipped" | "navigatedToLogin"
>;

export function shouldRecordAutoFill(report: AutoFillReportForHistory): boolean {
  if (report.skipped === "not-login-page") {
    return report.navigatedToLogin === true;
  }
  if (report.skipped) return true;
  // A fill that submitted and still left the session signed out is the generic
  // "wrong password / needs a second step" case; a fill that simply worked does
  // not need a record.
  return report.filled === true && report.submitted === true && report.loggedIn === false;
}
