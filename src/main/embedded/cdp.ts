import type { WebContents } from "electron";
import type { DomSnapshot, ElementPoint, VisibilityProbe } from "@core/cdp/inspect";
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
  prepare(): Promise<void>;
  detach(): void;
  send<T = unknown>(
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
  }): Promise<Buffer>;
  clickAt(x: number, y: number): Promise<void>;
  insertText(text: string): Promise<void>;
  navigate(url: string): Promise<void>;
  key(key: string, code: string, keyCode: number): Promise<void>;
  /** Selects the focused field's contents, so the next input replaces them. */
  selectAll(): Promise<void>;
  pressNamedKey(name: string): Promise<void>;
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

  constructor(
    private readonly contents: WebContents,
    /**
     * Called before every protocol command. The browser manager uses it to
     * keep the page usable: a parked page idles hidden after a while, and the
     * first CDP call of an AI burst must show it again before the actual
     * command runs — screenshots and input dispatch included.
     */
    private readonly onActivity?: () => Promise<void> | void,
  ) {}

  isAttached(): boolean {
    return this.attached && !this.contents.isDestroyed();
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

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    await this.onActivity?.();
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
    return (await withDeadline(
      this.contents.debugger.sendCommand(method, params) as Promise<T>,
      timeoutMs,
      `CDP ${method} 没有响应`,
    )) as T;
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
    if (options.preferRenderer) return fromRenderer();
    try {
      const result = await Promise.race([
        this.send<{ data: string }>(
          "Page.captureScreenshot",
          {
            format,
            ...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
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
    } catch {
      return fromRenderer();
    }
  }

  async clickAt(x: number, y: number): Promise<void> {
    // A move first: Chromium resolves the hit target from the last pointer
    // position, so dispatching press/release at a spot the mouse never visited
    // can land on nothing and the page's own handler never runs.
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
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
  }

  /** Types through the input pipeline so frameworks see real input events. */
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
