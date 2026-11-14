import type { DomSnapshot, ElementPoint, VisibilityProbe } from "@core/cdp/inspect";
import { withDeadline } from "@shared/async";
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
  /**
   * Runs one command.
   *
   * `timeoutMs` reaches the shared executor, which owns the only deadline in the
   * chain. Re-wrapping here would report a timeout while the guest manager still
   * counts the command as in flight — and a session released with a command
   * pending takes the native target out from under the reply.
   */
  send<T = unknown>(
    guestId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  evaluate<T>(
    guestId: string,
    expression: string,
    options?: { awaitPromise?: boolean; timeoutMs?: number },
  ): Promise<T>;
  has(guestId: string): boolean;
  /** Resolves once the page's node has a real box (or the wait times out). */
  waitLaidOut(timeoutMs?: number): Promise<void>;
  /**
   * The guest's own `webContents`, when the caller needs more than CDP.
   *
   * Only the renderer screenshot path uses it: `capturePage()` paints into an
   * offscreen surface, which is the one thing that still works when the window
   * is minimised and the compositor has stopped producing frames.
   */
  contents(guestId: string): Electron.WebContents | undefined;
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

  /** The guest's `webContents`, for the renderer capture path. */
  private guestContents(): Electron.WebContents | undefined {
    const guestId = this.target.guestId();
    if (!guestId) return undefined;
    return this.target.contents(guestId);
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

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.target.send<T>(this.guest(), method, params, options);
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

  evaluate<T>(
    expression: string,
    options: { awaitPromise?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
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
   * Screenshot of a guest page.
   *
   * Two paths, and which one works is decided by the *embedding window's* state,
   * not by the guest's:
   *
   * - **Compositor** (`Page.captureScreenshot`). Correct pixels, but a guest only
   *   produces frames while its embedder does. A minimised window produces none,
   *   and a culled guest answers this command by never replying at all — not by
   *   failing, which is what makes it expensive.
   * - **Renderer** (`webContents.capturePage`). Measured on a minimised window:
   *   41ms and a full image, while the CDP path timed out at 5s. A guest is a
   *   real `webContents`, so the renderer can paint into an offscreen surface
   *   without the window being on screen.
   *
   * `preferRenderer` is how the caller says "the window is not painting". The
   * CDP path needs the guest to be composited, so it presents first; the renderer
   * path does not need compositor frames, but it *does* need the node to have a
   * real box — `capturePage` on a node that was never laid out (or was laid out
   * and then cleared) fails with `UnknownVizError` rather than returning an empty
   * image. So both paths present, for different reasons.
   *
   * That distinction cost a regression once: clearing a parked page's rect fixed
   * tab switching and broke background screenshots, because the renderer branch
   * had assumed the rect was still there.
   *
   * The deadline is not defensive padding: it is the difference between a
   * screenshot that reports "this page cannot be captured" and a tool call that
   * never returns.
   */
  async screenshot(
    options: {
      format?: "png" | "jpeg";
      quality?: number;
      preferRenderer?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<Buffer> {
    const format = options.format ?? "png";
    const budget = Math.max(500, options.timeoutMs ?? 8_000);
    const params = {
      format,
      ...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
    };
    const fromRenderer = async (): Promise<Buffer> => {
      const contents = this.guestContents();
      if (!contents) throw new Error("页面已关闭");
      // Bounded like every other path: a capture that never returns is
      // indistinguishable from a page that is busy, so it reports as a deadline
      // instead of waiting out the caller's transport timeout.
      const image = await withDeadline(contents.capturePage(), budget, "页面画面采集没有返回");
      if (image.isEmpty()) throw new Error("窗口不可见，无法截图");
      return format === "jpeg" ? image.toJPEG(options.quality ?? 80) : image.toPNG();
    };
    if (options.preferRenderer) {
      // Present for the box, not for the frames: `capturePage` needs the node
      // laid out, and the caller's reason for taking this path is that the node
      // has no usable box right now. The capture happens *inside* `presented` —
      // once it returns, the node is parked again and a second `capturePage`
      // would fail exactly as the first one did.
      return this.presented(fromRenderer);
    }
    // Presenting covers both halves of the compositor's requirements: a culled
    // guest never answers this command, and a hidden one makes the page's own
    // visibility checks lie.
    try {
      return await this.presented(async () => {
        const result = await Promise.race([
          this.send<{ data: string }>(
            "Page.captureScreenshot",
            params,
            { timeoutMs: Math.min(4_000, budget) },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("截图超时")), Math.min(4_000, budget)),
          ),
        ]);
        return Buffer.from(result.data, "base64");
      });
    } catch (error) {
      // The window can stop painting between the caller's check and this command
      // — minimised mid-flight, moved to another display. Falling back here turns
      // a failed screenshot into a slightly slower one.
      try {
        return await fromRenderer();
      } catch {
        throw error;
      }
    }
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
