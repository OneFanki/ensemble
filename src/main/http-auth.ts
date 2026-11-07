import { randomUUID } from "node:crypto";
import type { HttpAuthChallenge } from "@shared/ipc";

/**
 * Recovers a realm the server sent as UTF-8 bytes while the header was decoded
 * as latin-1 — nginx configs with a Chinese realm arrive as "è·¯ç¾å…" mojibake.
 *
 * Only non-ASCII realms are touched, and a repair that produces replacement
 * characters is discarded: genuinely latin-1 text (a French "protégée") reads
 * as U+FFFD when forced through UTF-8, so the heuristic keeps the original in
 * exactly the cases where guessing wrong would make things worse. A realm that
 * is already correct UTF-8 also survives — its code points are above latin-1's
 * reach, so the round trip degrades to replacement characters and is dropped.
 */
export function fixRealmEncoding(realm: string): string {
  if (!/[^\u0000-\u007F]/.test(realm)) return realm;
  const repaired = Buffer.from(realm, "latin1").toString("utf8");
  return repaired.includes("\uFFFD") ? realm : repaired;
}

/**
 * Coordinates HTTP authentication challenges (nginx basic auth and friends).
 *
 * Without a handler for Electron's `login` event, every authentication
 * challenge is dropped silently — the user sees the raw 401 page with nowhere
 * to type. The coordinator answers them: one dialog per protection space, a
 * session-scoped credential cache so a site asking on every request only asks
 * once, and queueing so concurrent challenges for the same space (a page and
 * its favicon, four cells opening one origin) wait for a single answer instead
 * of stacking dialogs.
 *
 * The class is deliberately free of Electron: challenges come in through
 * `begin`, answers go out through the callback the caller received from the
 * `login` event. That keeps the queueing and cache rules unit-testable.
 *
 * Credentials live in process memory only. They die with the app, which is the
 * safe default for credentials that were never asked to be remembered.
 */
export type AuthResponder = (username?: string, password?: string) => void;

/**
 * How long a dismissed protection space stays silent. A dismissed navigation's
 * remaining resources (its favicon, prefetches) each get their own challenge —
 * without this window every one of them would reopen the dialog the user just
 * closed. A fresh dialog after the window is the browser's behaviour too: a
 * manual reload asks again.
 */
const DISMISS_SILENCE_MS = 3000;

interface PendingChallenge {
  challenge: HttpAuthChallenge;
  cacheKey: string;
  respond: AuthResponder;
  answered: boolean;
}

export class HttpAuthCoordinator {
  /** Protection space → the credentials this session already answered with. */
  private cache = new Map<string, { username: string; password: string }>();
  /** Challenge id → the dialog awaiting the user. */
  private pending = new Map<string, PendingChallenge>();
  /**
   * Protection space → responders parked while the first of them shows in the
   * dialog. They all receive the first answer (or its cancellation).
   */
  private queued = new Map<string, AuthResponder[]>();
  /** Protection space → timestamp until which challenges are dropped. */
  private silenced = new Map<string, number>();

  /** Tests inject 0 to skip the dismissal window and observe every challenge. */
  constructor(private readonly silenceMs: number = DISMISS_SILENCE_MS) {}

  /**
   * Presents a challenge. Returns the info to show in the dialog, or `null`
   * when the challenge resolves without asking: this space was answered in
   * this session, or another dialog for the same space is already open and
   * this responder will be driven by its outcome.
   *
   * A cached answer is consumed once. If the server comes back with another
   * challenge, the credentials it was given are wrong and the next challenge
   * for the same space opens the dialog again — this is what keeps a rejected
   * credential from answering every future challenge in a loop (the browser
   * equivalent is Chrome's challenge-driven cache eviction).
   */
  begin(cacheKey: string, info: Omit<HttpAuthChallenge, "id">, respond: AuthResponder): HttpAuthChallenge | null {
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.cache.delete(cacheKey);
      respond(cached.username, cached.password);
      return null;
    }
    const silenceUntil = this.silenced.get(cacheKey) ?? 0;
    if (Date.now() < silenceUntil) {
      respond();
      return null;
    }
    const queue = this.queued.get(cacheKey);
    if (queue) {
      queue.push(respond);
      return null;
    }
    this.queued.set(cacheKey, []);
    const challenge: HttpAuthChallenge = { id: randomUUID(), ...info };
    this.pending.set(challenge.id, { challenge, cacheKey, respond, answered: false });
    return challenge;
  }
  /**
   * Applies the dialog's answer: fulfils the challenge, remembers the
   * credentials until their next challenge decides them, and answers every
   * challenge that queued behind the same protection space.
   */
  submit(id: string, username: string, password: string): void {
    const entry = this.pending.get(id);
    if (!entry || entry.answered) return;
    entry.answered = true;
    this.pending.delete(id);
    entry.respond(username, password);
    this.cache.set(entry.cacheKey, { username, password });
    this.flush(entry.cacheKey, (respond) => respond(username, password));
  }

  /**
   * Dismisses the dialog: the challenge gets no credentials (the user sees the
   * 401), and everything queued behind the same protection space is abandoned
   * too — answering one dialog per space is the contract.
   */
  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry || entry.answered) return;
    entry.answered = true;
    this.pending.delete(id);
    entry.respond();
    this.silenced.set(entry.cacheKey, Date.now() + this.silenceMs);
    this.flush(entry.cacheKey, (respond) => respond());
  }

  /**
   * Answers every open and queued challenge with nothing. Used on quit so a
   * shutdown never leaves a `login` callback hanging.
   */
  abandonAll(): void {
    for (const entry of this.pending.values()) {
      if (!entry.answered) entry.respond();
    }
    this.pending.clear();
    for (const [cacheKey, queue] of this.queued) {
      for (const respond of queue) respond();
      this.queued.delete(cacheKey);
    }
  }

  /** Drives and clears the responders queued behind one protection space. */
  private flush(cacheKey: string, answer: (respond: AuthResponder) => void): void {
    const queue = this.queued.get(cacheKey);
    if (!queue) return;
    this.queued.delete(cacheKey);
    for (const respond of queue) answer(respond);
  }
}
