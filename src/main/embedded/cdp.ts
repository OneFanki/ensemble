import type { WebContents } from "electron";
import type { DomSnapshot, ElementPoint, VisibilityProbe } from "@core/cdp/inspect";
import { buildPressHitExpression } from "@core/cdp/inspect";
import { withDeadline } from "@shared/async";

/**
 * Ceiling for one CDP command, when the caller does not name one.
 *
 * Generous against any real command (the slowest ordinary one is a page load,
 * which arrives as several events) and short enough that a client sees an error
 * instead of waiting out its own multi-minute timeout.
 *
 * Callers that run *their own* work in the page override it: an `evaluate` of a
 * five-minute scrape is not a command that hung, and it should get the deadline
 * the AI asked for rather than this one.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * One CDP event, as a caller sees it.
 *
 * Deliberately untyped beyond the method name: domains differ wildly, and the
 * only caller today (dialog tracking) reads two string fields. A generic
 * `Record<string, unknown>` would force every listener to narrow anyway.
 */
export type CdpEventListener = (method: string, params: Record<string, unknown>) => void;

/**
 * Where the press was about to land, read at press time.
 *
 * Produced by `clickAt` in the window between the pointer move and
 * `mousePressed` — the same instant Chromium resolves its own hit test — so it
 * is the trusted baseline for whether the click went to the target. `null` means
 * the page could not answer at that moment (a dialog up, a navigation mid-flight)
 * and the click was still dispatched; the caller then falls back to the
 * post-release read alone.
 */
export interface ClickPressHit {
  onTarget: boolean;
  tag?: string;
  text?: string;
}

/**
 * The command surface every displayed page is driven through.
 *
 * Two implementations exist while the carrier migration is in progress: the
 * direct one below (a page main owns outright) and a managed one that routes
 * through the guest session state machine (idle release and teardown
 * handshakes). Callers cannot tell them apart — which is the point: the browser
 * manager keeps driving pages the same way regardless of where they render.
 */
export interface CdpExecutor {
  isAttached(): boolean;
  /**
   * True while a command is waiting for its reply.
   *
   * The sleep sweep reads this: a long `evaluate` outlives the AI grace window,
   * and freezing the page in the middle of it turns a running script into a
   * thirty-second timeout. "Not idle" is a fact about the command stream, not
   * about when the last command started.
   */
  busy(): boolean;
  prepare(): Promise<void>;
  detach(): void;
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  /**
   * Runs a command without counting as AI activity.
   *
   * `send` marks the page active first: AI-facing commands must wake a page the
   * sleep sweep froze. Observers must not — a pure read of the page's state
   * (performance sampling) that kept the page awake would be the sampler
   * changing the thing it measures, and a page would never return to sleep
   * while anyone was watching it.
   */
  sendQuiet<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  lifecycle(state: "frozen" | "active"): Promise<void>;
  evaluate<T>(
    expression: string,
    options?: { awaitPromise?: boolean; timeoutMs?: number },
  ): Promise<T>;
  snapshotDom(expression: string): Promise<DomSnapshot>;
  elementPoint(expression: string): Promise<ElementPoint>;
  visibility(expression: string): Promise<VisibilityProbe>;
  screenshot(options?: {
    format?: "png" | "jpeg";
    quality?: number;
    preferRenderer?: boolean;
    /** How long to wait for pixels before reporting the page as busy. */
    timeoutMs?: number;
    /**
     * Rectangle to capture, in CSS pixels of the page.
     *
     * A clipped capture always goes through the compositor, because the renderer
     * path has no rectangle to take. Said here rather than silently dropping the
     * clip: a caller that asked for one element and got the whole viewport would
     * have no way to notice.
     */
    clip?: { x: number; y: number; width: number; height: number; scale?: number };
  }): Promise<Buffer>;
  /**
   * Clicks a point and reports where the press was about to land.
   *
   * The press-time read happens between the pointer move and `mousePressed` —
   * the instant Chromium's own hit test resolves — and is the baseline for
   * "did this click go to the target". The usual read-back after
   * `mouseReleased` cannot be that baseline: a page that swaps its DOM in the
   * click's handler makes the read-back see the replacement, while the click
   * itself landed and worked. `null` means the press-time read failed and the
   * click was dispatched anyway.
   */
  clickAt(x: number, y: number): Promise<ClickPressHit | null>;
  /**
   * Moves the pointer without pressing.
   *
   * A move is not a formality: it is the only way to open anything that appears
   * on hover — a menu, a tooltip, a row's actions — and Chromium resolves the
   * hit target for the *next* press from wherever the pointer was last. Dispatching
   * a press at a coordinate the pointer never visited can land on nothing.
   */
  hoverAt(x: number, y: number): Promise<void>;
  /**
   * A wheel event at a point.
   *
   * `deltaY` follows the DOM convention: positive scrolls down. Negative delta
   * scrolls up. Chromium delivers this to whatever is under (x, y), so scrolling a
   * nested container means passing that container's centre rather than the
   * viewport's.
   */
  scrollAt(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  insertText(text: string): Promise<void>;
  navigate(url: string): Promise<void>;
  key(key: string, code: string, keyCode: number): Promise<void>;
  /**
   * Presses a key while modifiers are held.
   *
   * `modifiers` is Chromium's bit field — Alt 1, Ctrl 2, Meta 4, Shift 8, summed
   * for combinations — and it belongs on *all three* events: the modifier keys
   * go down first, the target key is pressed with the mask already set, then
   * everything comes up in reverse. Setting it only on the target key produces a
   * keydown whose `ctrlKey` is true while the browser's own state says no key is
   * held, and sites that check either one see a contradiction.
   */
  pressWithModifiers(key: string, code: string, keyCode: number, modifiers: number): Promise<void>;
  /** Selects the focused field's contents, so the next input replaces them. */
  selectAll(): Promise<void>;
  pressNamedKey(name: string): Promise<void>;
  /**
   * Answers the page's open JavaScript dialog.
   *
   * Separate from `pressNamedKey("Enter")` on purpose: the dialog is drawn by
   * the browser, not by the page, so no input event reaches it and no DOM query
   * can see it. This command is the only way to answer one.
   *
   * It works even when the opening event was never observed — which matters,
   * because a session that detached while the dialog appeared has no record of
   * it. The error it throws when nothing is showing ("No dialog is showing") is
   * then the honest answer rather than a failure.
   */
  handleDialog(accept: boolean, promptText?: string): Promise<void>;
  /**
   * Puts files into a file input, the way a file picker would.
   *
   * `DOM.setFileInputFiles` needs a backend node id, and the caller only has a
   * selector: the node is found in the page and handed back as a remote object,
   * then resolved server-side. The paths are absolute and are read by the browser
   * process, not by the page — the page never sees a filesystem path it could act
   * on, which is why this is a command rather than a page-script feature.
   */
  setFiles(selector: string, paths: string[]): Promise<void>;
  /**
   * Drags from one point to another, with the pointer moves a real drag has.
   *
   * A single jump from press to release is not a drag: pages listen for the
   * intermediate `mousemove` stream (sortable lists compare positions between
   * moves) and a press immediately followed by a release at a new spot is a click
   * that missed. Several steps in between is what makes the target's own
   * drag-over and drop handlers fire.
   */
  dragFromTo(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>;
  /**
   * Subscribes to this page's CDP events; the return value unsubscribes.
   *
   * Events are never replayed, so a listener that arrives after the event it
   * cares about has already missed it. The dialog tracker therefore subscribes
   * when the tab is created, not when a tool happens to ask.
   */
  onEvent(listener: CdpEventListener): () => void;
  /**
   * Whether keyboard input only reaches the element the pointer last clicked.
   *
   * True for a `<webview>` guest: its input route follows the last real pointer
   * event, so typing into a merely-focused field drops every keystroke. False
   * for a page main owns, where DOM focus is enough.
   */
  readonly requiresPointerBeforeTyping: boolean;
}

/**
 * CDP over Electron's in-process debugger instead of a TCP endpoint.
 *
 * A `--remote-debugging-port` is unauthenticated: any local process could drive
 * the browser. Attaching through `webContents.debugger` gives the same protocol
 * without opening a socket, so the only way in is the already-authenticated IPC
 * and MCP surface.
 *
 * One client per webContents: the attach is lazy and idempotent, and every
 * caller shares it. Electron allows DevTools to be open at the same time, so the
 * user can inspect a page while an AI call is running.
 */
export class EmbeddedCdp implements CdpExecutor {
  /** DOM focus is enough for a page main owns; see the interface note. */
  readonly requiresPointerBeforeTyping = false;

  private attached = false;
  /** Resolves once attach and focus emulation are both in place. */
  private ready: Promise<void> | null = null;
  /** Commands waiting for their reply; see `busy()`. */
  private pending = 0;
  /** CDP events this target emitted, so callers can observe them. */
  private readonly listeners = new Set<CdpEventListener>();
  private readonly onDebuggerMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
  ): void => {
    for (const listener of this.listeners) {
      try {
        listener(method, (params ?? {}) as Record<string, unknown>);
      } catch {
        // A listener is an observer: one that throws must not take down the
        // debugger's own dispatch loop and leave later events undelivered.
      }
    }
  };

  constructor(private readonly contents: WebContents) {}

  /**
   * Subscribes to this target's CDP events.
   *
   * Events are not replayed: a listener added after `Page.javascriptDialogOpening`
   * fired has missed it. That is why the dialog path pins the session and
   * registers its listener when the tab is created rather than when a tool is
   * called.
   *
   * One `debugger.on` for the whole client, so adding a second feature that needs
   * events does not need a second listener on the native object — and the events
   * it wants are enabled by whatever code enables that domain.
   */
  onEvent(listener: CdpEventListener): () => void {
    if (this.listeners.size === 0 && !this.contents.isDestroyed()) {
      this.contents.debugger.on("message", this.onDebuggerMessage);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && !this.contents.isDestroyed()) {
        this.contents.debugger.removeListener("message", this.onDebuggerMessage);
      }
    };
  }

  isAttached(): boolean {
    return this.attached && !this.contents.isDestroyed();
  }

  busy(): boolean {
    return this.pending > 0;
  }

  /** Attaches and turns on focus emulation. Safe to call concurrently. */
  async prepare(): Promise<void> {
    if (this.isAttached()) {
      await this.ready;
      return;
    }
    if (this.contents.isDestroyed()) throw new Error("页面已关闭");
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach("1.3");
    }
    this.attached = true;
    // Without focus emulation the renderer reports `document.hasFocus() === false`
    // whenever the window is behind another app, and Chromium then drops
    // `Input.dispatchMouseEvent` / `Input.insertText` instead of delivering them.
    // Runtime.evaluate still works, which makes the failure look like a broken
    // selector. Playwright enables this for the same reason.
    this.ready ??= this.contents.debugger
      .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
      .then(
        () => undefined,
        () => undefined,
      );
    await this.ready;
  }

  detach(): void {
    this.attached = false;
    this.ready = null;
    try {
      if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) {
        this.contents.debugger.detach();
      }
    } catch {
      // A destroyed webContents detaches itself.
    }
  }

  /**
   * Puts files into a file input.
   *
   * The node id is resolved here rather than taken from the caller: `Runtime`
   * object ids belong to one execution context, and a navigation invalidates
   * them, so an id passed in from an earlier call is a coin flip. Resolving and
   * using it in the same command is the only ordering that cannot race.
   */
  async setFiles(selector: string, paths: string[]): Promise<void> {
    const response = await this.send<{ result?: { objectId?: string } }>("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
    });
    const objectId = response?.result?.objectId;
    if (!objectId) throw new Error(`找不到文件输入框：${selector}`);
    /*
     * `backendNodeId`, not `nodeId`: `DOM.requestNode` only answers for nodes the
     * DOM agent has already pushed to the client, which requires `DOM.enable`
     * and a document snapshot. `DOM.describeNode` resolves a remote object's node
     * directly, so it works on the first call and on every page.
     */
    const node = await this.send<{ node?: { backendNodeId?: number } }>("DOM.describeNode", {
      objectId,
    });
    const backendNodeId = node?.node?.backendNodeId;
    if (!backendNodeId) throw new Error(`找不到文件输入框：${selector}`);
    await this.send("DOM.setFileInputFiles", { files: paths, backendNodeId });
  }

  /**
   * Drags between two points with intermediate moves.
   *
   * The count is not arbitrary: sortable lists decide "dropped above or below"
   * from the last few moves, and a two-step drag reads as "teleported". Six moves
   * is enough for those handlers to see a direction while staying one round trip
   * per step — the whole drag is a few hundred milliseconds, which is also what a
   * person's drag looks like.
   */
  async dragFromTo(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
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
      // `buttons: 1` on every move is what makes it a drag rather than a hover:
      // HTML5 drag handlers and `dragover` only fire while a button is held.
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
  }

  /**
   * Answers the page's open JavaScript dialog.
   *
   * `Page.handleJavaScriptDialog` is the only way: the dialog lives in the
   * browser's own UI, so no key event reaches it and no `Runtime.evaluate` runs
   * while it is up (the page is blocked waiting for the answer). Passing
   * `promptText` on an `alert`/`confirm` is harmless; Chromium ignores it.
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.send(
      "Page.handleJavaScriptDialog",
      {
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      },
      // Bounded, and shorter than the default ceiling: the command that *opened*
      // the dialog is still waiting for its reply, and Chromium answers one
      // session's commands in order — so this can queue behind that straggler.
      // An unbounded wait would report success after 30 seconds of nothing.
      { timeoutMs: 5_000 },
    );
  }

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    await this.prepare();
    /*
     * Every command is bounded.
     *
     * Chromium answers some commands by never replying when the target is not
     * painting — `Page.captureScreenshot` is the documented one, but the same
     * surface state can swallow `Runtime.evaluate` on a culled guest. Unbounded,
     * one such command hangs the tool call that issued it with no way to tell
     * that from a slow page: a client hits its own 90-second timeout and reports
     * "no response", which is exactly what was observed. A per-command ceiling
     * turns that into an error naming the command.
     *
     * Long-running work (`wait_browser`, a flow step) runs as repeated short
     * commands rather than one long one, so this ceiling does not cap it.
     */
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.pending += 1;
    try {
      return (await withDeadline(
        this.contents.debugger.sendCommand(method, params) as Promise<T>,
        timeoutMs,
        `CDP ${method} 没有响应`,
      )) as T;
    } finally {
      this.pending -= 1;
    }
  }

  /**
   * Same transport as {@link send}.
   *
   * This carrier has no activity hook to skip — the wake-on-traffic behaviour
   * lives in the guest executor — so quiet only means "identical, by contract".
   * Declaring it here rather than letting the caller fall back to `send` keeps
   * the observer's intent true on both carriers.
   */
  async sendQuiet<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.send<T>(method, params, options);
  }

  /**
   * Page lifecycle control for the parked-page sleep.
   *
   * Deliberately not routed through `send`: the freeze sweep must not count as
   * AI activity, or it would keep the page awake forever. `"frozen"` suspends
   * the page's JavaScript entirely (measured: `Runtime.evaluate` on a frozen
   * page never returns), which is what actually stops a 3D scene — CPU
   * throttling and `setVisible(false)` measurably do not.
   */
  async lifecycle(state: "frozen" | "active"): Promise<void> {
    await this.prepare();
    // Bounded like every other command: this one runs in the background sweep,
    // where a command that never returns would silently stop the sweep from
    // ever finishing a pass.
    await withDeadline(
      this.contents.debugger.sendCommand("Page.setWebLifecycleState", { state }),
      DEFAULT_COMMAND_TIMEOUT_MS,
      "CDP Page.setWebLifecycleState 没有响应",
    );
  }

  async evaluate<T>(
    expression: string,
    options: { awaitPromise?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const response = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise ?? false,
      },
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "页面脚本执行失败",
      );
    }
    return response.result.value as T;
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
   * Screenshot, choosing the path that can actually work right now.
   *
   * Two ways to read pixels, with different blind spots (measured on Electron 44
   * / Chromium 152):
   *
   * | state                | Page.captureScreenshot | capturePage |
   * | -------------------- | ---------------------- | ----------- |
   * | on stage             | works, ~40ms           | works       |
   * | parked off-window    | **stalls**             | works       |
   * | window minimised     | **stalls**             | works       |
   * | window fully hidden  | fails                  | fails       |
   *
   * `Page.captureScreenshot` goes through the compositor, which stops producing
   * frames for a view that is not on screen — so the call does not fail, it
   * never returns. Trying it first is what made a screenshot of a page the user
   * had switched away from cost a full 4-second timeout before falling back,
   * every single time.
   *
   * `preferRenderer` lets the caller say "this view is not on screen", so the
   * compositor path is skipped entirely instead of being timed out on. The
   * fallback stays for the states this cannot predict.
   *
   * **Both paths are bounded.** `capturePage` used to be the one unguarded call
   * in this class: it goes through the renderer's paint pipeline, which stalls
   * in the same situations the compositor does, and a caller then waited out its
   * own transport timeout with no idea what had happened. A stalled capture is
   * reported as a deadline like any other — the page is busy, not broken — and
   * the MCP layer turns that into a `page-busy` result rather than a hard error.
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
    const format = options.format ?? "png";
    const budget = Math.max(500, options.timeoutMs ?? 8_000);
    const fromRenderer = async (): Promise<Buffer> => {
      if (this.contents.isDestroyed()) throw new Error("页面已关闭");
      const image = await withDeadline(
        this.contents.capturePage(),
        budget,
        "页面画面采集没有返回",
      );
      if (image.isEmpty()) throw new Error("窗口不可见，无法截图");
      return format === "jpeg" ? image.toJPEG(options.quality ?? 80) : image.toPNG();
    };
    // A clip forces the compositor: `capturePage` takes no rectangle, and cropping
    // the result would need an image library the main process does not have.
    if (options.preferRenderer && !options.clip) return fromRenderer();
    try {
      const result = await Promise.race([
        this.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format,
            ...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
            ...(options.clip
              ? { clip: { ...options.clip, scale: options.clip.scale ?? 1 } }
              : {}),
          },
          // The compositor path answers in tens of milliseconds or never. Four
          // seconds is the window in which a real answer could still arrive.
          { timeoutMs: Math.min(4_000, budget) },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("截图超时")), Math.min(4_000, budget)),
        ),
      ]);
      return Buffer.from(result.data, "base64");
    } catch (error) {
      /*
       * The fallback is only for the unclipped case. `capturePage` ignores the
       * rectangle, so falling back with a clip would answer "here is your element"
       * with a picture of the whole viewport — a wrong answer that looks right.
       */
      if (options.clip) throw error;
      return fromRenderer();
    }
  }

  async clickAt(x: number, y: number): Promise<ClickPressHit | null> {
    // A move first: Chromium resolves the hit target from the last pointer
    // position, so dispatching press/release at a spot the mouse never visited
    // can land on nothing and the page's own handler never runs.
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    /*
     * Read the hit at the instant the press is about to happen. After
     * `mouseReleased` a page that swaps its DOM in the click's handler makes the
     * read-back see the replacement element, which reported misses for clicks
     * that landed and worked. A read failure here must not cancel the click:
     * a dialog opening between the move and this evaluate leaves the press
     * perfectly valid, only unverifiable at press time.
     */
    let pressHit: ClickPressHit | null = null;
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
    return pressHit;
  }

  /**
   * Moves the pointer, without clicking.
   *
   * Two dispatches, not one: a bare `mouseMoved` from a position the page never
   * saw is treated by some sites' hover handlers as a jump rather than a hover,
   * and CSS `:hover` needs the transition to actually run. Moving *to* the point
   * again in a second dispatch is what makes `mouseenter` fire on an element the
   * pointer was not already over.
   *
   * No `button` field: including one turns this into a drag move, and a hover
   * that reports a pressed button opens menus the user never asked for.
   */
  async hoverAt(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    // Browsers coalesce same-position moves; a zero-distance move is a no-op, so
    // nudge by a pixel and back to guarantee the second one is delivered.
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 1, y });
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  /**
   * Scrolls whatever is under the point.
   *
   * `mouseWheel` rather than `window.scrollBy`: a page that scrolls a nested
   * container (a virtual list, a modal body) ignores viewport scrolling, and a
   * wheel event routed through the input pipeline also runs the page's own
   * scroll handlers and lazy-loading, which is what "scroll like a person" means.
   */
  async scrollAt(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    // The pointer has to be over the target for the wheel to land there.
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  /**
   * Presses a key with modifiers held, in the order a person does it.
   *
   * Chromium derives the modifier state from which keys are down, so the mask on
   * the target event alone is not enough: the browser's own state would still say
   * nothing is held. Pressing the modifier keys first, then the target with the
   * mask, then releasing in reverse, is what makes `ctrlKey` / `shiftKey` true on
   * the keydown handlers that read them.
   *
   * The modifier keys themselves are derived from the same bit field the caller
   * passes, so "Ctrl+Shift+S" needs one number rather than a list of key presses
   * that has to agree with it.
   *
   * Known editing combinations additionally carry `commands` on the keyDown.
   * The keydown's own default action edits only the DOM selection; the input
   * pipeline that the next `Input.insertText` (an IME commit) reads from never
   * learns about it, so a Ctrl+A followed by typing appended instead of
   * replaced — measured on Electron 45. `commands` runs the same editing command
   * through the input pipeline, where both the IME state and later editing
   * commands see the result. The keydown still reaches the page first, so
   * handlers that observe or prevent it behave as before.
   */
  async pressWithModifiers(
    key: string,
    code: string,
    keyCode: number,
    modifiers: number,
  ): Promise<void> {
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
      // The editing command runs in the pipeline — the same layer a later
      // `Input.insertText` (an IME commit) reads its selection from, which is
      // what makes "select all, then type" replace. Without `commands` the
      // keydown's own default action edits only the DOM selection, which the
      // pipeline never sees (measured on Electron 45).
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
   * Types through the input pipeline so frameworks see real input events.
   *
   * `Input.insertText` is an IME commit. It replaces whatever selection the
   * *input pipeline* recorded — which is why clear-before-type goes through
   * `selectAll()` (an editing command the pipeline tracks) and why page-script
   * selections never make typing replace anything. Callers that want "select,
   * then replace" must select through this executor, not through the page.
   */
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  async key(key: string, code: string, keyCode: number): Promise<void> {
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

  /**
   * Selects the focused field's contents.
   *
   * `commands` is Chromium's own editing command; a plain "a" key press without
   * a text payload produces no editing action on its own, which is how "clear
   * before typing" ended up doing nothing and appending the new value instead.
   */
  async selectAll(): Promise<void> {
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

  /**
   * Presses a key by its human name (Enter, Escape, Tab, …).
   *
   * `Input.dispatchKeyEvent` needs four fields that have to agree with each
   * other — key, code, virtual key code, and a text payload for keys that
   * produce one. Sending Enter without `text` leaves inputs that listen for the
   * character (search boxes, chat composers) unfired, which reads as "the key did
   * nothing". This table is the single place that mapping lives.
   */
  async pressNamedKey(name: string): Promise<void> {
    const key = KEY_TABLE[name];
    if (!key) throw new Error(`不支持的按键：${name}`);
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

/**
 * Editing commands carried on the keyDown for known modifier combinations.
 *
 * Keyed by `${modifiers}:${key}` — the same bit field the caller passes. These
 * run through the input pipeline (see the note in `pressWithModifiers`), which
 * is what makes the combination's effect visible to the IME commit that a later
 * `Input.insertText` performs. Kept to the combinations Chromium maps to plain
 * editing commands on every platform; anything else (browser-level shortcuts,
 * tab management) stays with the keydown's own default handling.
 */
export const EDIT_COMMANDS_BY_COMBO: Record<string, string[]> = {
  "2:a": ["selectAll"],
  "2:c": ["copy"],
  "2:x": ["cut"],
  "2:v": ["paste"],
  "2:z": ["undo"],
  "10:z": ["redo"],
};

/**
 * Chromium's modifier bit field, as the key each bit stands for.
 *
 * The numbers are the protocol's, not ours: `Input.dispatchKeyEvent` and
 * `Input.dispatchMouseEvent` both take this mask, so a click that holds Ctrl and
 * a keypress that holds Ctrl agree because they read from the same table. A
 * second copy of these values anywhere else would drift the moment one of them
 * was fixed.
 */
export const MODIFIER_KEYS: Array<{ mask: number; key: string; code: string; keyCode: number }> = [
  { mask: 1, key: "Alt", code: "AltLeft", keyCode: 18 },
  { mask: 2, key: "Control", code: "ControlLeft", keyCode: 17 },
  { mask: 4, key: "Meta", code: "MetaLeft", keyCode: 91 },
  { mask: 8, key: "Shift", code: "ShiftLeft", keyCode: 16 },
];

/**
 * Key names a flow may press.
 *
 * Kept next to the dispatcher rather than in `shared/` because the codes are
 * Chromium's, not the product's: a second copy elsewhere would drift.
 */
export const KEY_TABLE: Record<
  string,
  { key: string; code: string; keyCode: number; text?: string }
> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
};
