/**
 * When a parked page may be put to sleep.
 *
 * The decision is one function because every clause below has been a separate
 * bug at some point: a page that was on stage froze while the user was looking
 * at it, a loading page froze mid-navigation, a page with an AI command in
 * flight froze under the command, and setting "never sleep" did nothing because
 * the sweep had its own copy of the rules. The manager supplies facts; this
 * module owns the policy and is trivial to test without Electron.
 *
 * "Asleep" means `Page.setWebLifecycleState: "frozen"` — JavaScript is
 * suspended while the DOM, scroll position and session stay intact. It is not
 * tab discarding: memory is not reclaimed, but timers, scenes and rAF loops
 * stop, which is what background tabs were consuming.
 */

import type { TabSleepPolicy } from "@shared/embedded";

/** The facts the manager knows about one page at sweep time. */
export interface SleepCandidate {
  /**
   * The user is looking at this page right now: it is the current page of an
   * instance that holds a stage cell, and the window carrying that cell is
   * visible and not minimised. Occupying a cell alone is not enough — a
   * minimised or hidden window shows nothing, and a background member of a
   * batch launch shares a container without being on stage at all.
   */
  userVisible: boolean;
  /** Its JavaScript is already suspended. */
  frozen: boolean;
  /** Its carrier exists and is not destroyed. */
  available: boolean;
  loading: boolean;
  crashed: boolean;
  /** A blank page has no document of its own to suspend. */
  blank: boolean;
  /** A panel is attached and somebody is inspecting it. */
  devtoolsOpen: boolean;
  /** Playing audio must keep running. */
  audible: boolean;
  /** Per-page override; absent means the default policy. */
  policy?: TabSleepPolicy;
  /** Wall clock until which AI traffic keeps the page awake. */
  aiActiveUntil?: number;
  /** A CDP command is still in flight; the page is not idle. */
  busy: boolean;
}

/**
 * Why a page is not being frozen right now, as one short string.
 *
 * Published per page so an AI can tell which pages are holding resources and
 * why — the same facts the sweep reads, shaped for a tool result instead of a
 * decision. `undefined` means "nothing exempts it": the next sweep freezes it.
 */
export type SleepExemptReason =
  | "on-stage-visible"
  | "audible"
  | "ai-active"
  | "policy"
  | "loading"
  | "crashed"
  | "blank"
  | "devtools"
  | "frozen"
  | "no-carrier";

/**
 * The first clause that keeps this page awake, or undefined when it should
 * sleep. Clauses run in the same order `shouldSleepPage` used to read them, so
 * the reason always names the rule that actually decided.
 */
export function sleepExemptReason(
  candidate: SleepCandidate,
  now: number,
): SleepExemptReason | undefined {
  if (!candidate.available) return "no-carrier";
  if (candidate.frozen) return "frozen";
  if (candidate.userVisible) return "on-stage-visible";
  if (candidate.loading) return "loading";
  if (candidate.crashed) return "crashed";
  if (candidate.blank) return "blank";
  if (candidate.devtoolsOpen) return "devtools";
  if (candidate.audible) return "audible";
  if (candidate.policy === "never") return "policy";
  if (candidate.busy) return "ai-active";
  if ((candidate.aiActiveUntil ?? 0) > now) return "ai-active";
  return undefined;
}

/**
 * True when the page should be frozen now.
 *
 * `busy` is checked here as well as in the manager so the rule is complete on
 * its own: a long `evaluate` may outlive the AI grace window, and freezing the
 * page mid-script would turn a running command into a 30-second timeout.
 */
export function shouldSleepPage(candidate: SleepCandidate, now: number): boolean {
  return sleepExemptReason(candidate, now) === undefined;
}
