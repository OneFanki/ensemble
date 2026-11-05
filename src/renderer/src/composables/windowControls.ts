/**
 * How much of the window's top-right corner the native window controls own.
 *
 * Every surface that reaches that corner has to leave the band empty, and the
 * app used to guess: `148px` in the console's title bar, `140px` above the tab
 * strip, `146px` in a component that had not been rendered since the v2 shell
 * rewrite. Three numbers for one measurement, all of them wrong on a machine
 * whose caption buttons happen to be a different size — and with the run dock
 * open, the guess was not merely off, it was reserved in the wrong place: the
 * dock sits on the right edge, the tab strip kept a 140px hole it did not need,
 * and the dock's own first row (创建视图, collapse) rendered underneath buttons
 * that cannot be clicked through.
 *
 * The measurement is available: with `titleBarOverlay`, Chromium exposes the
 * area the app may paint into, and the controls are whatever is left over. Actual
 * value measured at 137px on Windows 11 at 1.5 device scale, where the three
 * guesses had picked 140-ish by eye.
 *
 * The result is published as `--window-controls-width` so any layout can use it
 * without importing this module. Two listeners keep it honest: a window resize
 * changes the number when the caption buttons scale, and `geometrychange` fires
 * when the overlay itself changes size.
 */

/**
 * Fallback when the overlay API is unavailable (older Electron, or a platform
 * that does not paint controls into the client area). Windows is the only
 * platform this app ships on where the caption buttons are drawn by the app's
 * own frame, and 138px is the documented default for it.
 */
const FALLBACK = 138;

/**
 * The overlay API is not in TypeScript's DOM lib, and it is genuinely optional:
 * a host without it falls back to the measured default rather than failing.
 */
interface WindowControlsOverlay extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

function overlay(): WindowControlsOverlay | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
    .windowControlsOverlay;
}

function measure(): number {
  const api = overlay();
  const rect = api?.getTitlebarAreaRect?.();
  if (!rect || !rect.width) return FALLBACK;
  // The titlebar area starts at x=0 in this app, so the controls are simply the
  // rest of the window. Subtracting the right edge rather than assuming the
  // origin keeps the maths right if a future layout moves the area.
  return Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width)));
}

function publish(value: number): void {
  document.documentElement.style.setProperty("--window-controls-width", `${value}px`);
}

/**
 * Starts publishing the measurement. Safe to call once, before mount.
 *
 * On macOS the traffic lights live on the left and nothing is painted into the
 * client area, so the variable is pinned to zero rather than relying on a
 * measurement that does not apply.
 */
export function installWindowControlsWidth(platform: string): void {
  if (platform === "darwin") {
    publish(0);
    return;
  }

  publish(measure());
  const sync = () => publish(measure());
  window.addEventListener("resize", sync);
  overlay()?.addEventListener("geometrychange", sync);
}
