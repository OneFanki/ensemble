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
 *
 * ## Docked DevTools step aside here too
 *
 * A docked DevTools panel is a native view: it paints over everything the
 * renderer draws, so a dropdown opening across it is buried mid-list. The first
 * fix for that was a manual call per menu, and it was incomplete in the way that
 * shape always is — six of the seven menus in the toolbar never made the call,
 * and the one that did passed a boolean, so closing either of two nested menus
 * reported "nothing is open". Both follow from the same root cause: the
 * knowledge of *which* surfaces overlap a native panel lived in each menu.
 *
 * Parking now hangs off this counter, which every floating layer already passes
 * through. One place, correct nesting, and a new menu cannot forget.
 */
import { watch, type Ref } from "vue";

/** How many layers are open. Positive means drag regions are suspended. */
let openLayers = 0;

function publish(open: boolean): void {
  if (open) document.documentElement.dataset["floating"] = "1";
  else delete document.documentElement.dataset["floating"];
  // Fire and forget: a menu must not wait on a round trip to appear.
  void window.ensemble?.setDevtoolsParked?.(open);
}

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
      publish(openLayers > 0);
    },
    { immediate: true },
  );
}
