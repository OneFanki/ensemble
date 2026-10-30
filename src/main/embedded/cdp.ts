import type { WebContents } from "electron";
import type { DomSnapshot, ElementPoint, VisibilityProbe } from "@core/cdp/inspect";

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
export class EmbeddedCdp {
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
  ): Promise<T> {
    await this.onActivity?.();
    await this.prepare();
    return (await this.contents.debugger.sendCommand(method, params)) as T;
  }

  /**
   * CPU throttling control for the parked-page slowdown.
   *
   * Deliberately not routed through `send`: the sweep must not count as AI
   * activity, or it would keep the page awake forever. Range is 1 (no
   * throttling) to 20.
   */
  async setCpuThrottlingRate(factor: number): Promise<void> {
    await this.prepare();
    await this.contents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
      rate: factor,
    });
  }

  async evaluate<T>(expression: string, options: { awaitPromise?: boolean } = {}): Promise<T> {
    const response = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? false,
    });
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
   */
  async screenshot(
    options: { format?: "png" | "jpeg"; quality?: number; preferRenderer?: boolean } = {},
  ): Promise<Buffer> {
    const format = options.format ?? "png";
    const fromRenderer = async (): Promise<Buffer> => {
      if (this.contents.isDestroyed()) throw new Error("页面已关闭");
      const image = await this.contents.capturePage();
      if (image.isEmpty()) throw new Error("窗口不可见，无法截图");
      return format === "jpeg" ? image.toJPEG(options.quality ?? 80) : image.toPNG();
    };
    if (options.preferRenderer) return fromRenderer();
    try {
      const result = await Promise.race([
        this.send<{ data: string }>("Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: options.quality ?? 80 } : {}),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("截图超时")), 4_000),
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
