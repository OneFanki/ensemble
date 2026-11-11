/**
 * Placement for a panel that is teleported out of the component that owns it.
 *
 * Both the select and the suggestion list need this, and their versions had
 * drifted line for line while being separate copies — the next fix would have
 * landed in one and not the other. The rules are the same for any anchored
 * popover, so they live here:
 *
 * 1. **Teleport, never absolute.** A dialog body scrolls (`overflow-y: auto`),
 *    so an absolutely positioned list is clipped at the dialog's edge. The panel
 *    is appended to `<body>` and positioned in viewport coordinates instead.
 * 2. **Never leave the window.** A trigger near the right edge would push the
 *    panel past it, so the horizontal position is clamped after the width is
 *    decided — not before, because the clamp needs the width.
 * 3. **Flip up when there is no room below.** Measured after the panel has been
 *    mounted once, because its height is only known then. Flipping only happens
 *    when the space above is genuinely larger, so a short panel on a short
 *    screen does not jump above its trigger for no reason.
 */
import { nextTick, onBeforeUnmount, watch, type Ref } from "vue";

export interface AnchoredPanelOptions {
  /** Whether the panel is currently mounted. */
  open: Readonly<Ref<boolean>>;
  /** Element the panel hangs off; its box decides position and width. */
  anchor: () => HTMLElement | null | undefined;
  /** The teleported panel, read for its height when deciding to flip. */
  panel: Readonly<Ref<HTMLElement | null>>;
  /** Style object written by this composable. */
  style: Ref<Record<string, string>>;
  /** Smallest width the panel may take, in CSS pixels. Defaults to the anchor's. */
  minWidth?: number;
  /**
   * Preferred width, overriding the anchor's own.
   *
   * A list row spans the whole pane, and a detail panel as wide as the row it
   * hangs off would be a second page rather than a popover. The width is still
   * clamped to the window, so a narrow pane shrinks the panel instead of
   * pushing it off the edge.
   */
  width?: number;
  /**
   * Which side of the anchor the panel opens on.
   *
   * `left` exists for a popover stacked on another popover: opening it below
   * the row would cover the list it was opened from, so a detail that belongs
   * to a row in a narrow panel opens beside that panel instead.
   */
  placement?: "below" | "left";
  /** Gap between the trigger and the panel. */
  gap?: number;
  /** Margin kept from the window edges. */
  margin?: number;
}

export function useAnchoredPanel(options: AnchoredPanelOptions): {
  /** Recompute the position now. Safe to call when closed. */
  place: () => void;
} {
  const gap = options.gap ?? 4;
  const margin = options.margin ?? 8;

  function place(): void {
    const anchor = options.anchor();
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const available = Math.max(0, window.innerWidth - margin * 2);
    const width = Math.min(options.width ?? Math.max(rect.width, options.minWidth ?? 0), available);

    if (options.placement === "left") {
      /*
       * Open to the left of the anchor, vertically aligned with it.
       *
       * Used when this panel belongs to a row inside another popover: below the
       * row it would cover the sibling rows the user is choosing between. If
       * the left edge would leave the window, the panel goes right instead —
       * an overlapping panel is still readable, one clipped at the screen edge
       * is not.
       */
      const preferred = rect.left - gap - width;
      const left = preferred >= margin ? preferred : Math.min(rect.right + gap, window.innerWidth - width - margin);
      options.style.value = {
        left: `${Math.max(margin, left)}px`,
        top: `${Math.max(margin, rect.top)}px`,
        width: `${width}px`,
      };
      void nextTick(() => {
        // Keep the panel's bottom inside the window: a row near the bottom would
        // otherwise hang its detail off the edge.
        const height = options.panel.value?.offsetHeight ?? 0;
        if (!height) return;
        const top = Math.min(
          Math.max(margin, rect.top),
          Math.max(margin, window.innerHeight - height - margin),
        );
        options.style.value = { ...options.style.value, top: `${top}px` };
      });
      return;
    }

    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    options.style.value = {
      left: `${left}px`,
      top: `${rect.bottom + gap}px`,
      width: `${width}px`,
    };
    /*
     * The flip is decided after a paint, because `offsetHeight` is zero until
     * the panel exists. A second write is therefore expected, and it is cheap:
     * one style update on an element the user has not seen yet.
     */
    void nextTick(() => {
      const height = options.panel.value?.offsetHeight ?? 0;
      if (!height) return;
      const below = window.innerHeight - rect.bottom - margin;
      if (height > below && rect.top - margin > below) {
        options.style.value = {
          left: `${left}px`,
          top: `${rect.top - gap - height}px`,
          width: `${width}px`,
        };
      }
    });
  }

  function onViewportChange(): void {
    place();
  }

  /**
   * The panel follows its trigger while open, and stops the moment it closes.
   *
   * A listener left behind would keep repositioning a node that is gone, which
   * shows up as a stale position the next time the panel opens.
   */
  const stopWatch = watch(options.open, (open) => {
    if (open) {
      place();
      window.addEventListener("resize", onViewportChange);
      window.addEventListener("scroll", onViewportChange, true);
    } else {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    }
  });

  onBeforeUnmount(() => {
    stopWatch();
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);
  });

  return { place };
}
