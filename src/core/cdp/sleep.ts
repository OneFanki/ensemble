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
  /** The page occupies a cell on the visible stage. */
  staged: boolean;
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
 * True when the page should be frozen now.
 *
 * `busy` is checked here as well as in the manager so the rule is complete on
 * its own: a long `evaluate` may outlive the AI grace window, and freezing the
 * page mid-script would turn a running command into a 30-second timeout.
 */
export function shouldSleepPage(candidate: SleepCandidate, now: number): boolean {
  if (!candidate.available || candidate.staged || candidate.frozen) return false;
  if (candidate.loading || candidate.crashed || candidate.blank) return false;
  if (candidate.devtoolsOpen || candidate.audible) return false;
  if (candidate.policy === "never") return false;
  if (candidate.busy) return false;
  return (candidate.aiActiveUntil ?? 0) <= now;
}
