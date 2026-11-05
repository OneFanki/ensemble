/**
 * Dismissing a floating layer by clicking outside it.
 *
 * Two things have to be true for that to work at all, and the second one is the
 * one that was missing:
 *
 * 1. **A click outside the layer closes it.** Usually `onClickOutside` from
 *    VueUse, which the select and the composer wrappers already use.
 * 2. **The click has to reach the renderer.** The window's title band is a
 *    `-webkit-app-region: drag` region, and Electron uses those for moving the
 *    window: the mouse events never arrive in the page. Aiming at the empty part
 *    of the header — which is what people do to dismiss a menu, precisely because
 *    there is nothing there to activate by accident — therefore did nothing at
 *    all: no `pointerdown`, no close, not even a focus change.
 *
 * So while any layer is open the drag regions give up their role, and the click
 * lands in the document where the dismissal handler is listening. That is a fair
 * trade: a user with a menu open is not trying to move the window, and moving it
 * still works the moment the menu closes.
 *
 * The counter is module-level because layers nest in practice — a view menu over
 * a page, a confirm over that — and each one flipping the flag on its own would
 * have the first close re-enable dragging underneath the second.
 */
import { watch, type Ref } from "vue";

/** How many layers are open. Positive means drag regions are suspended. */
let openLayers = 0;

/**
 * Publishes "a layer is open" while `open` is true.
 *
 * Returns nothing on purpose: the caller keeps owning its own open state, and
 * the cleanup is registered against it. There is exactly one thing to get right
 * here — that the flag is removed when the component unmounts with a layer open,
 * which would otherwise leave dragging disabled for the rest of the session.
 */
export function useFloatingLayer(open: Ref<boolean>): void {
  watch(
    open,
    (isOpen) => {
      openLayers = Math.max(0, openLayers + (isOpen ? 1 : -1));
      if (openLayers > 0) document.documentElement.dataset["floating"] = "1";
      else delete document.documentElement.dataset["floating"];
    },
    { immediate: true },
  );
}
