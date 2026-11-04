import type { DomSnapshot, ElementPoint, VisibilityProbe } from "@core/cdp/inspect";
import { KEY_TABLE, type CdpExecutor } from "./cdp";

/**
 * A page's CDP surface when the page lives in a `<webview>`.
 *
 * Purely a router: every command goes through the guest manager, which owns the
 * session state machine, so idle release and the teardown handshake see all
 * traffic. A guest that bypassed this class would be invisible to that
 * accounting, and detaching with a command in flight crashes the process.
 *
 * The guest id is resolved per command rather than captured: the manager
 * registers guests by the time the renderer reports them, and a page whose node
 * was replaced has to talk to the new guest.
 *
 * The command set is the same one the direct executor offers, because the
 * browser manager should not know which carrier it is talking to.
 */
export interface GuestCdpTarget {
  /** Current guest id for this page, or `undefined` while it is not attached. */
  guestId(): string | undefined;
  send<T = unknown>(guestId: string, method: string, params?: Record<string, unknown>): Promise<T>;
  evaluate<T>(
    guestId: string,
    expression: string,
    options?: { awaitPromise?: boolean },
  ): Promise<T>;
  has(guestId: string): boolean;
  /** Resolves once the page's node has a real box (or the wait times out). */
  waitLaidOut(timeoutMs?: number): Promise<void>;
}

export class GuestCdp implements CdpExecutor {
  /** A guest routes input by pointer position; see `ensureInputFocus`. */
  readonly requiresPointerBeforeTyping = true;

  constructor(
    private readonly target: GuestCdpTarget,
    /** Correlation token for presentation requests — the page id. */
    private readonly tabId: string,
    /** Asks the renderer to show this page briefly, then put it back. */
    private readonly present?: (tabId: string, visible: boolean) => Promise<void>,
  ) {}

  /**
   * Set once the guest has received a real pointer event.
   *
   * Not a cached "is focused" flag: the input route opens for good after the
   * first mouse event, so this only has to remember that it happened.
   */
  private pointerSeen = false;

  /** The live guest, or a rejection once the page is gone. */
  private guest(): string {
    const guestId = this.target.guestId();
    if (!guestId) throw new Error("页面已关闭");
    return guestId;
  }

  isAttached(): boolean {
    const guestId = this.target.guestId();
    // The manager releases the session on idle and reopens it on demand, so
    // "attached" is not a stable property callers can act on. Reporting the
    // guest's existence is the useful answer.
    return guestId !== undefined && this.target.has(guestId);
  }

  async prepare(): Promise<void> {
    // Opening happens lazily inside the first command; there is nothing to warm
    // up here without sending one.
  }

  detach(): void {
    // Releasing is the manager's decision (idle timer or teardown). A caller
    // that detaches mid-burst would make every following command re-attach,
    // which is exactly the pattern that gets the session noticed by page
    // scripts. `teardown` is the explicit way to close it.
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.target.send<T>(this.guest(), method, params);
  }

  lifecycle(state: "frozen" | "active"): Promise<void> {
    return this.target.send<void>(this.guest(), "Page.setWebLifecycleState", { state });
  }

  /**
   * Runs a command with the page painted, then puts it back.
   *
   * Visibility is not cosmetic for a guest. A node hidden with
   * `visibility:hidden` — which is how a background tab is kept alive — makes
   * every element inside it fail `checkVisibility()`, so `isVisible` reported
   * false for the whole document, selectors resolved to nothing, and reads came
   * back `not-found`. Presenting during the command is what makes the DOM
   * answers honest.
   */
  private async presented<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.present || !this.target.guestId()) return fn();
    // A node with no box reports a 0×0 viewport, and every visibility check in
    // the page then answers false — so this waits for the layout before asking
    // the page anything, not just before painting it.
    await this.target.waitLaidOut(2_000).catch(() => undefined);
    // Nesting is normal: a click runs `evaluate` for hit testing, and typing
    // runs `evaluate` to find the field. Only the outermost call may flip
    // visibility, or the inner one would put the page back mid-command.
    this.presentDepth += 1;
    if (this.presentDepth === 1) {
      await this.present(this.tabId, true).catch(() => undefined);
    }
    try {
      return await fn();
    } finally {
      this.presentDepth -= 1;
      if (this.presentDepth === 0) {
        await this.present(this.tabId, false).catch(() => undefined);
      }
    }
  }

  /** Nesting depth of {@link presented}; see the note there. */
  private presentDepth = 0;

  evaluate<T>(expression: string, options: { awaitPromise?: boolean } = {}): Promise<T> {
    return this.presented(() => this.target.evaluate<T>(this.guest(), expression, options));
  }

  async snapshotDom(expression: string): Promise<DomSnapshot> {
    return this.evaluate<DomSnapshot>(expression);
  }

  async elementPoint(expression: string): Promise<ElementPoint> {
    return this.evaluate<ElementPoint>(expression);
  }

  async visibility(expression: string): Promise<VisibilityProbe> {
    return this.evaluate<VisibilityProbe>(expression);
  }

  /**
   * Screenshot through the guest's CDP session.
   *
   * A guest only produces frames while it is painting. Hidden, fully occluded
   * and off-window guests are culled from the compositor, and a culled guest
   * answers `Page.captureScreenshot` by never replying at all — not by failing,
   * which is what makes it expensive. So the page is presented first, captured,
   * then put back.
   *
   * The deadline is not defensive padding: it is the difference between a
   * screenshot that reports "this page cannot be captured" and a tool call that
   * never returns. The native executor has the same bound for the same reason.
   *
   * No renderer fallback: a guest cannot be captured with `capturePage` (the
   * embedder's page owns the pixels), so an unavailable capture reports the
   * failure instead of silently returning the app's own chrome.
   */
  async screenshot(
    options: { format?: "png" | "jpeg"; quality?: number; preferRenderer?: boolean } = {},
  ): Promise<Buffer> {
    const format = options.format ?? "png";
    const params = {
      format,
      ...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
    };
    // Presenting covers both halves of the problem: a culled guest never answers
    // this command, and a hidden one makes the page's own visibility checks lie.
    return this.presented(async () => {
      const result = await Promise.race([
        this.send<{ data: string }>("Page.captureScreenshot", params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("截图超时")), 4_000),
        ),
      ]);
      return Buffer.from(result.data, "base64");
    });
  }

  async clickAt(x: number, y: number): Promise<void> {
    // Presented while the pointer works: a hidden page's hit testing follows
    // the same visibility rules as everything else, so a click on a background
    // tab would otherwise land on nothing.
    await this.presented(async () => {
      // A move first: Chromium resolves the hit target from the last pointer
      // position, so press/release at a spot the mouse never visited can land
      // on nothing.
      await this.pointerMove(x, y);
      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    });
    this.pointerSeen = true;
  }

  /**
   * Moves the pointer without pressing anything.
   *
   * The event is also what tells the guest's input pipeline that a real pointer
   * is over it, which is a precondition for keyboard and text routing — see
   * {@link ensureInputFocus}.
   */
  private async pointerMove(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  }

  /**
   * Makes the guest accept keyboard and text input.
   *
   * Measured on 45.2.1: a guest whose `document.hasFocus()` already reports
   * `true` still drops every `Input.dispatchKeyEvent` and `Input.insertText`
   * until it has received at least one pointer event. DOM focus (`el.focus()`)
   * and `webContents.focus()` are both insufficient — only a dispatched mouse
   * event opens the input route, after which typing works for the rest of the
   * page's life.
   *
   * The nudge is a move over the page's own centre, not a click: pressing would
   * activate whatever happens to be under the cursor, and typing targets are
   * chosen by the caller, not by this class.
   */
  private async ensureInputFocus(): Promise<void> {
    if (this.pointerSeen) return;
    const size = await this.evaluate<{ w: number; h: number }>(
      "({ w: window.innerWidth, h: window.innerHeight })",
    ).catch(() => undefined);
    const x = Math.max(1, Math.round((size?.w ?? 800) / 2));
    const y = Math.max(1, Math.round((size?.h ?? 600) / 2));
    try {
      await this.pointerMove(x, y);
      // Only now is the route actually open. Setting the flag before the
      // dispatch meant one failed attempt disabled the nudge for the whole
      // page, and every later keystroke went nowhere.
      this.pointerSeen = true;
    } catch {
      // Leave the flag clear so the next command retries.
    }
  }

  async insertText(text: string): Promise<void> {
    await this.ensureInputFocus();
    await this.send("Input.insertText", { text });
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  /**
   * Presses Ctrl+A to select the field's contents.
   *
   * Separate from {@link key} on purpose: a bare `keyDown`/`keyUp` pair without
   * modifiers never reaches the page's editing commands — measured on a guest,
   * where a plain "a" press produced no `keydown` at all — so "clear before
   * typing" silently did nothing and the new text was appended to whatever the
   * credential fill had put there. A `rawKeyDown` with `commands: ["selectAll"]`
   * is Chromium's own editing command and needs no synthetic text payload.
   */
  async selectAll(): Promise<void> {
    await this.ensureInputFocus();
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      commands: ["selectAll"],
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: 2,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
  }

  async key(key: string, code: string, keyCode: number): Promise<void> {
    await this.ensureInputFocus();
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }

  async pressNamedKey(name: string): Promise<void> {
    const key = KEY_TABLE[name];
    if (!key) throw new Error(`不支持的按键：${name}`);
    await this.ensureInputFocus();
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
    });
  }
}

/** Re-exported so the manager and this file agree on the key table. */
export { KEY_TABLE };
