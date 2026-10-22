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

  constructor(private readonly contents: WebContents) {}

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
    await this.prepare();
    return (await this.contents.debugger.sendCommand(method, params)) as T;
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
   * Screenshot with a fallback for minimised windows.
   *
   * `Page.captureScreenshot` goes through the compositor and stalls while the
   * window is minimised; `capturePage` reads the renderer directly and still
   * works there. Measured behaviour: visible and unfocused both work either way,
   * minimised works only through `capturePage`, and a fully hidden window
   * supports neither.
   */
  async screenshot(options: { format?: "png" | "jpeg"; quality?: number } = {}): Promise<Buffer> {
    const format = options.format ?? "png";
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
      if (this.contents.isDestroyed()) throw new Error("页面已关闭");
      const image = await this.contents.capturePage();
      if (image.isEmpty()) throw new Error("窗口不可见，无法截图");
      return format === "jpeg" ? image.toJPEG(options.quality ?? 80) : image.toPNG();
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
}
