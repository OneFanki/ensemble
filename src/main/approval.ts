import { randomUUID } from "node:crypto";
import type { AiApprovalDecision } from "@shared/types";

/**
 * Asks the person before an AI call reaches a signed-in page.
 *
 * The origin gate used to refuse outright: the AI got "只读" back and the user,
 * if they ever found out, had to go and edit a list by hand. But the moment a
 * refusal happens is the moment the user is best placed to decide — they are
 * looking at the page, they know whether this is the assistant doing something
 * useful or a page talking it into something. So the refusal becomes a question.
 *
 * ## Shape
 *
 * A queue, not a stack: two clients can ask at once and the user answers one at
 * a time, in the order the questions arrived. One request is on screen; the rest
 * wait. That is `HttpAuthCoordinator`'s contract, borrowed because it is the same
 * problem (a browser event needs a human answer and cannot be dropped mid-flight).
 *
 * Waiting is a promise, and **timeout is an answer, not an error**: an
 * unanswered request resolves to `deny`, because silence is not consent. Resolving
 * rather than rejecting is deliberate — the caller has to send the AI a refusal
 * message either way, and a rejection here would turn a normal outcome into an
 * exception path that the audit log reports as a crash.
 *
 * Deliberately free of Electron so the queueing and timeout rules are unit
 * testable; the window is somebody else's job.
 */
export interface ApprovalInput {
  /** Tool name, shown to the user. */
  tool: string;
  /** One line of arguments, already redacted by the caller. */
  summary: string;
  /** i18n key naming the action, plus its parameters. */
  actionKey: string;
  actionParams?: Record<string, string>;
  origin: string;
  siteName: string;
  context: string;
  tabTitle: string;
}

export interface PendingApproval {
  id: string;
  tool: string;
  summary: string;
  actionKey: string;
  actionParams?: Record<string, string>;
  origin: string;
  siteName: string;
  context: string;
  tabTitle: string;
  /** Epoch ms when the timer fires; the window counts down to it. */
  expiresAt: number;
}

/** How long a question stays open before the answer becomes "no". */
export const APPROVAL_TIMEOUT_MS = 60_000;

interface Waiter {
  request: PendingApproval;
  resolve: (decision: AiApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalCoordinator {
  private readonly waiting = new Map<string, Waiter>();
  /** Requests not yet shown, in arrival order. */
  private readonly queued: string[] = [];
  /** Id of the request the window is showing right now, if any. */
  private showing: string | undefined;

  /**
   * @param timeoutMs How long the user has to answer. Tests pass a small value.
   * @param now Injectable clock, so a countdown assertion does not depend on
   *   wall time — the queue only compares timestamps.
   * @param onChange Called whenever the queue changes, so the window can be
   *   shown, updated or closed without the coordinator knowing what a window is.
   */
  constructor(
    private readonly timeoutMs: number = APPROVAL_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
    private readonly onChange: () => void = () => {},
  ) {}

  /** True while at least one question is unanswered. */
  get pending(): number {
    return this.waiting.size;
  }

  /**
   * Queues a request and resolves with the answer.
   *
   * Resolves `"deny"` on timeout or when {@link abandonAll} runs, so every path
   * that waits ends with a decision rather than a dangling promise.
   */
  ask(input: ApprovalInput): Promise<AiApprovalDecision> {
    const id = randomUUID();
    const request: PendingApproval = {
      id,
      tool: input.tool,
      summary: input.summary,
      actionKey: input.actionKey,
      ...(input.actionParams ? { actionParams: input.actionParams } : {}),
      origin: input.origin,
      siteName: input.siteName,
      context: input.context,
      tabTitle: input.tabTitle,
      expiresAt: this.now() + this.timeoutMs,
    };
    return new Promise<AiApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout is the same outcome as a dismissal: the question stopped being
        // current, and an AI that keeps acting on an old question is worse than
        // one that is told to stop.
        this.settle(id, "deny");
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting.set(id, { request, resolve, timer });
      this.queued.push(id);
      this.onChange();
    });
  }

  /**
   * The request the window should be showing.
   *
   * The oldest unanswered one. Returns `undefined` when nothing is waiting —
   * which is what tells the caller to close the window.
   */
  current(): PendingApproval | undefined {
    if (this.showing) {
      const shown = this.waiting.get(this.showing);
      if (shown) return shown.request;
      this.showing = undefined;
    }
    const next = this.queued.find((id) => this.waiting.has(id));
    if (!next) return undefined;
    this.showing = next;
    return this.waiting.get(next)?.request;
  }

  /**
   * Applies an answer to the request on screen.
   *
   * An id that is no longer waiting is ignored rather than thrown on: the
   * window can answer a request that timed out a moment earlier, and that race
   * is normal, not exceptional.
   */
  answer(id: string, decision: AiApprovalDecision): void {
    this.settle(id, decision);
  }

  /** Dismissing the window is a refusal, not a pause. */
  cancel(id: string): void {
    this.settle(id, "deny");
  }

  /**
   * Answers everything with `deny`. Used on quit and when the MCP endpoint
   * stops, so no caller is left holding a promise across shutdown.
   */
  abandonAll(): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, "deny");
  }

  private settle(id: string, decision: AiApprovalDecision): void {
    const waiter = this.waiting.get(id);
    if (!waiter) return;
    this.waiting.delete(id);
    clearTimeout(waiter.timer);
    const queueIndex = this.queued.indexOf(id);
    if (queueIndex >= 0) this.queued.splice(queueIndex, 1);
    if (this.showing === id) this.showing = undefined;
    waiter.resolve(decision);
    this.onChange();
  }
}
