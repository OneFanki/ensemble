import type { WebContents } from "electron";

/**
 * What the browser manager needs from whatever is displaying a page.
 *
 * The carrier is a `<webview>` guest owned by the renderer, so main never moves
 * pixels. The rectangle still lives here because it is the one value both sides
 * reason about: main computes it from the layout, the renderer positions the
 * node from it, and every geometry-based decision (is this page on screen, which
 * screenshot path to take) reads it back.
 *
 * Kept as an interface rather than folded into the guest class because it is the
 * seam the manager is written against: collapsing it would put renderer
 * bookkeeping in the middle of layout code.
 */
export interface PageSurface {
  readonly webContents: WebContents;
  setBounds(rect: { x: number; y: number; width: number; height: number }): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  setVisible(visible: boolean): void;
  setBackgroundColor(color: string): void;
}

/**
 * A page hosted by the renderer as a `<webview>`.
 *
 * The renderer owns where the node sits, but main still computes the rect it
 * asks for: that value is what `bounds` reports and what the screenshot paths
 * read to decide whether the page is on screen. So `setBounds` records rather
 * than moves.
 */
export class GuestPageSurface implements PageSurface {
  private reported = { x: 0, y: 0, width: 0, height: 0 };

  constructor(
    readonly webContents: WebContents,
    /**
     * Stage origin in window coordinates, read at call time.
     *
     * The manager lays pages out in window space, while the renderer positions a
     * node from the stage's own origin. Subtracting here is what keeps `bounds`
     * in the renderer's space without a second layout branch in the manager. Read
     * lazily because the stage moves (the console covers it, the window resizes)
     * and the value must be the current one, not the one at construction.
     */
    private readonly stageOrigin: () => { x: number; y: number },
  ) {}

  /**
   * Records where the page sits, converted to stage-relative pixels.
   *
   * Nothing is moved here — the renderer positions the node — but the value is
   * what `bounds` reports and what the screenshot paths read to decide whether
   * the page is on screen.
   */
  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    const origin = this.stageOrigin();
    this.reported = { ...rect, x: rect.x - origin.x, y: rect.y - origin.y };
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.reported;
  }

  setVisible(): void {
    // Visibility follows from what the renderer mounts.
  }

  setBackgroundColor(): void {
    // Painted by the app's CSS behind the node.
  }
}
