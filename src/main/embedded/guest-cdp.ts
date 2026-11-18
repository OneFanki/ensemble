import type { DomSnapshot, ElementPoint, VisibilityProbe } from "@core/cdp/inspect";
import { buildPressHitExpression } from "@core/cdp/inspect";
import { withDeadline } from "@shared/async";
import {
  EDIT_COMMANDS_BY_COMBO,
  KEY_TABLE,
  MODIFIER_KEYS,
  type ClickPressHit,
  type CdpEventListener,
  type CdpExecutor,
} from "./cdp";

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
  /** True while a command against this guest is waiting for its reply. */
  busy(guestId: string): boolean;
  /**
   * Subscribes to a guest's CDP events.
   *
   * Optional: a target that cannot expose events simply never delivers one, and
   * the feature that wanted them (dialog tracking) sees nothing instead of
   * crashing. The listener survives session reopens because it lives on the
   * guest's executor, not on the session.
   */
  onEvent?(listener: CdpEventListener): () => void;
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
    /**
     * Called before every AI-facing command.
     *
     * The browser manager uses it to wake a page the sleep sweep froze and to
     * start the grace clock. `lifecycle()` deliberately does not call it: the
     * sweep's own freeze must not count as activity, or nothing would ever
     * sleep.
     */
    private readonly onActivity?: () => Promise<void> | void,
  ) {}

  /**
   * AI-facing commands waiting for their reply; see {@link busy}.
   *
   * Deliberately not the session's own pending count: that one also covers the
   * observer channel (`sendQuiet`), and a 5 Hz performance sample happening to
   * be in flight at sweep time then reads as "a command is running" — the sweep
   * refreshes the AI grace, and a page under continuous observation can chain
   * one lucky hit into the next, never sleeping at all. Freezing an observation
   * costs nothing (the sampler just stops producing readings); freezing a real
   * command turns it into a timeout. Busy counts the second kind only.
   */
  private aiInFlight = 0;

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

  /**
   * True while an AI-facing command is in flight.
   *
   * This is the fact the sleep sweep reads before freezing: only these commands
   * would be broken by a freeze, so only these count — observer traffic
   * (`sendQuiet`) runs under a freeze without harm and is excluded.
   */
  busy(): boolean {
    return this.aiInFlight > 0;
  }

  /** Marks this page as the AI's current target; see `onActivity`. */
  private async touch(): Promise<void> {
    await this.onActivity?.();
  }

  /** Runs one AI-facing command with the in-flight count held above zero. */
  private async counted<T>(work: () => Promise<T>): Promise<T> {
    this.aiInFlight += 1;
    try {
      return await work();
    } finally {
      this.aiInFlight -= 1;
    }
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

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.counted(async () => {
      await this.touch();
      return this.target.send<T>(this.guest(), method, params, options);
    });
  }

  /**
   * Sends without marking the page active — the observer's channel.
   *
   * `send` wakes a sleeping page first, which is right for AI commands and
   * wrong for pure observation: the performance sampler's own heartbeat went
   * through `send`, so its 5 Hz `Performance.getMetrics` kept re-arming the
   * sleep grace and the page stayed awake for as long as anyone sampled it.
   * An observation must not change what it observes — a page an agent read
   * once has to be able to fall back asleep while the sampler keeps running.
   *
   * `lifecycle()` skips `touch()` for the mirrored reason: the sleep sweep's
   * own freeze must not count as activity.
   */
  async sendQuiet<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.target.send<T>(this.guest(), method, params, options);
  }

  lifecycle(state: "frozen" | "active"): Promise<void> {
    // No `touch()` here on purpose: the sleep sweep calls this to freeze a page,
    // and marking its own command as AI activity would keep the page awake
    // forever. Waking is handled by `browser.wakeTab`, which runs before this.
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

  async evaluate<T>(
    expression: string,
    options: { awaitPromise?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    return this.counted(async () => {
      await this.touch();
      return this.presented(() => this.target.evaluate<T>(this.guest(), expression, options));
    });
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
      clip?: { x: number; y: number; width: number; height: number; scale?: number };
    } = {},
  ): Promise<Buffer> {
    // The renderer capture path never sends a CDP command, so the activity mark
    // cannot come from `send`: a screenshot of a sleeping page must wake it too.
    // The whole capture counts as in-flight (see `busy`) — the inner compositor
    // `send` nests its own count, which the `> 0` check absorbs.
    return this.counted(async () => {
      await this.touch();
      const format = options.format ?? "png";
      const budget = Math.max(500, options.timeoutMs ?? 8_000);
      const params = {
        format,
        ...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
        ...(options.clip ? { clip: { ...options.clip, scale: options.clip.scale ?? 1 } } : {}),
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
      // A clip forces the compositor: `capturePage` has no rectangle to take.
      if (options.preferRenderer && !options.clip) {
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
            this.send<{ data: string }>("Page.captureScreenshot", params, {
              timeoutMs: Math.min(4_000, budget),
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("截图超时")), Math.min(4_000, budget)),
            ),
          ]);
          return Buffer.from(result.data, "base64");
        });
      } catch (error) {
        /*
         * The renderer fallback is only for the unclipped case: a clipped capture
         * that fell back would hand back the whole viewport and look like success.
         */
        if (options.clip) throw error;
        // The window can stop painting between the caller's check and this command
        // — minimised mid-flight, moved to another display. Falling back here turns
        // a failed screenshot into a slightly slower one.
        try {
          return await fromRenderer();
        } catch {
          throw error;
        }
      }
    });
  }

  async clickAt(x: number, y: number): Promise<ClickPressHit | null> {
    // Presented while the pointer works: a hidden page's hit testing follows
    // the same visibility rules as everything else, so a click on a background
    // tab would otherwise land on nothing.
    let pressHit: ClickPressHit | null = null;
    await this.presented(async () => {
      // A move first: Chromium resolves the hit target from the last pointer
      // position, so press/release at a spot the mouse never visited can land
      // on nothing.
      await this.pointerMove(x, y);
      // Press-time hit read, before `mousePressed` — the same instant the
      // browser resolves its own hit test. A page that swaps its DOM in the
      // click's handler makes the post-release read-back see the replacement,
      // which reported misses for clicks that landed and worked. A failure here
      // must not cancel the click; the caller falls back to the read-back.
      try {
        pressHit = await this.evaluate<ClickPressHit>(buildPressHitExpression(x, y));
      } catch {
        pressHit = null;
      }
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
    return pressHit;
  }

  /**
   * Moves the pointer over an element, without pressing.
   *
   * It goes through `presented()` for the same reason a click does: a page that
   * is parked off-window is not being hit-tested, so a hover sent to it would
   * land nowhere and every hover-driven menu would silently refuse to open.
   *
   * `pointerSeen` is set here too. On a guest the input route opens on the first
   * pointer event of any kind, so a hover is enough to make a later `type` land —
   * and a flow that hovers a field before filling it depends on that.
   */
  async hoverAt(x: number, y: number): Promise<void> {
    await this.presented(async () => {
      await this.pointerMove(x, y);
    });
    this.pointerSeen = true;
  }

  /**
   * Scrolls whatever sits under the point.
   *
   * Presented like the other pointer work: `mouseWheel` is hit-tested against the
   * page under the coordinates, and a parked page has no hit-test target.
   */
  async scrollAt(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.presented(async () => {
      await this.pointerMove(x, y);
      await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
    });
    this.pointerSeen = true;
  }

  /**
   * A key with modifiers, in the order a person presses it.
   *
   * `ensureInputFocus` first: a guest drops every key event until it has received
   * a real pointer event, and Ctrl+A on a field that never saw the pointer is a
   * shortcut the page never receives.
   *
   * Known editing combinations carry `commands` on the keyDown — same reason as
   * the direct executor: the keydown's own default action never reaches the
   * input pipeline the next IME commit reads from.
   */
  async pressWithModifiers(
    key: string,
    code: string,
    keyCode: number,
    modifiers: number,
  ): Promise<void> {
    await this.ensureInputFocus();
    const commands = EDIT_COMMANDS_BY_COMBO[`${modifiers}:${key}`];
    const held = MODIFIER_KEYS.filter((entry) => (modifiers & entry.mask) !== 0);
    for (const modifier of held) {
      await this.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        nativeVirtualKeyCode: modifier.keyCode,
        modifiers,
      });
    }
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
      // Editing commands ride the pipeline, same as the direct executor.
      ...(commands ? { commands } : {}),
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    for (const modifier of [...held].reverse()) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        nativeVirtualKeyCode: modifier.keyCode,
        modifiers: modifiers & ~modifier.mask,
      });
    }
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

  /**
   * Puts files into a file input.
   *
   * Not wrapped in `presented()`: `DOM.setFileInputFiles` works on the node, not
   * on a point, so the page does not have to be on screen for it — and unlike a
   * click there is no hit testing involved.
   *
   * The node is resolved per command because `Runtime` object ids die with their
   * execution context: an id from an earlier call is invalid after a navigation,
   * and a flow that fills a form and uploads a file is exactly that sequence.
   */
  async setFiles(selector: string, paths: string[]): Promise<void> {
    const response = await this.send<{ result?: { objectId?: string } }>("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    const objectId = response?.result?.objectId;
    if (!objectId) throw new Error(`找不到文件输入框：${selector}`);
    // `backendNodeId` rather than `nodeId`: the latter needs `DOM.enable` plus a
    // document push, and this path deliberately enables nothing extra.
    const node = await this.send<{ node?: { backendNodeId?: number } }>("DOM.describeNode", {
      objectId,
    });
    const backendNodeId = node?.node?.backendNodeId;
    if (!backendNodeId) throw new Error(`找不到文件输入框：${selector}`);
    await this.send("DOM.setFileInputFiles", { files: paths, backendNodeId });
  }

  /**
   * Drags between two points.
   *
   * Presented like the other pointer work: every move is hit-tested against the
   * page under the coordinates, and a parked page has no target to drag over.
   */
  async dragFromTo(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.presented(async () => {
      await this.pointerMove(from.x, from.y);
      await this.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: from.x,
        y: from.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      const steps = 6;
      for (let step = 1; step <= steps; step += 1) {
        const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
        const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
        await this.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "left",
          buttons: 1,
        });
      }
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: to.x,
        y: to.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    });
    this.pointerSeen = true;
  }

  /**
   * Answers the page's open JavaScript dialog.
   *
   * Not routed through `presented()`: the dialog is browser chrome, so the page
   * does not have to be painted for this to work — and presenting a page that is
   * blocked on a dialog is exactly the command that would hang.
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.send(
      "Page.handleJavaScriptDialog",
      {
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      },
      // Shorter than the default ceiling: the command that opened the dialog is
      // still queued ahead of this one, and an unbounded wait would report
      // success long after nothing happened.
      { timeoutMs: 5_000 },
    );
  }

  /**
   * Subscribes to this page's CDP events.
   *
   * Kept in this class rather than forwarded on demand: routing it through
   * `target.send` would create a command per event and count it against the
   * session, and the bus is per guest — which is what a listener actually wants,
   * since the guest is the thing that emits.
   */
  onEvent(listener: CdpEventListener): () => void {
    return this.target.onEvent?.(listener) ?? (() => undefined);
  }
}

/** Re-exported so the manager and this file agree on the key table. */
export { KEY_TABLE };
