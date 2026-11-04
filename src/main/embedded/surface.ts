import { WebContentsView, type BrowserWindow, type WebContents } from "electron";

/**
 * What the browser manager needs from whatever is displaying a page.
 *
 * Two carriers exist in this codebase: a native `WebContentsView` owned by
 * main, and a `<webview>` guest owned by the renderer. They differ in *where*
 * the pixels live, not in *what a page is* — both are a `webContents` that can
 * be navigated and driven over CDP, and both occupy a rectangle.
 *
 * Keeping that rectangle in the interface is what makes the migration a swap
 * rather than a rewrite: every caller keeps saying "put this page at these
 * bounds", and a guest implementation answers by doing nothing, because DOM
 * layout already put it there. `getBounds` answers with what the renderer last
 * reported so geometry-based checks (`viewIsOnScreen`, screenshots) keep
 * working without a native view to ask.
 */
export interface PageSurface {
  readonly webContents: WebContents;
  setBounds(rect: { x: number; y: number; width: number; height: number }): void;
  getBounds(): { x: number; y: number; width: number; height: number };
  setVisible(visible: boolean): void;
  setBackgroundColor(color: string): void;
  /**
   * Renders DevTools into a view this app owns.
   *
   * Only a native surface can do this: the panel is a second `WebContents`
   * drawn in a child view of the window, and a `<webview>` guest has no
   * privilege to draw one. A guest implementation reports that it cannot, so
   * the caller can fall back to Electron's own DevTools window instead of
   * silently losing the panel.
   */
  bindDevTools(contents: WebContents): boolean;
}

/** A page hosted by main as a child view of the window. */
export class NativePageSurface implements PageSurface {
  readonly view: WebContentsView;

  constructor(options: Electron.WebContentsViewConstructorOptions) {
    this.view = new WebContentsView(options);
  }

  get webContents(): WebContents {
    return this.view.webContents;
  }

  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.view.setBounds(rect);
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.view.getBounds();
  }

  setVisible(visible: boolean): void {
    this.view.setVisible(visible);
  }

  setBackgroundColor(color: string): void {
    this.view.setBackgroundColor(color);
  }

  /** Puts the native view into a window's content area. */
  attachTo(win: BrowserWindow): void {
    win.contentView.addChildView(this.view);
  }

  /**
   * Hands the inspected page's DevTools to a view this app owns.
   *
   * `setDevToolsWebContents` is the only way to dock the panel inside a cell:
   * `openDevTools({ mode: "right" })` would open Electron's own window instead.
   */
  bindDevTools(contents: WebContents): boolean {
    this.view.webContents.setDevToolsWebContents(contents);
    return true;
  }
}

/**
 * A page hosted by the renderer as a `<webview>`.
 *
 * Positioning is a no-op on purpose: the node sits in the app's own DOM, so its
 * box is CSS, not `setBounds`. The manager still tracks a rectangle because
 * some callers need to answer "is this page on screen" — the renderer reports
 * the real one through {@link reportBounds}.
 */
export class GuestPageSurface implements PageSurface {
  private reported = { x: 0, y: 0, width: 0, height: 0 };

  constructor(readonly webContents: WebContents) {}

  setBounds(): void {
    // DOM layout decides; main has nothing to move.
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

  /**
   * A guest cannot host a DevTools panel.
   *
   * The panel is a second renderer drawn in a child view of the window; a guest
   * has no privilege to create one. Reporting failure lets the caller use
   * Electron's own DevTools window instead of silently losing the panel.
   */
  bindDevTools(): boolean {
    return false;
  }

  /** Records the box the renderer laid the node out in. */
  reportBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.reported = rect;
  }
}

export function isNativeSurface(surface: PageSurface): surface is NativePageSurface {
  return surface instanceof NativePageSurface;
}
