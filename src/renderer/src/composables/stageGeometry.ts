/**
 * The stage's rectangle, measured in the renderer and reported to the main
 * process.
 *
 * This is the whole contract between the app's HTML and whatever displays the
 * page inside the stage. Today that is a native `WebContentsView` positioned by
 * the main process; a different surface would keep the same contract — "here is
 * the box, put the page in it" — so the measuring code is kept deliberately free
 * of any knowledge about how pages are drawn.
 *
 * Owning it in one place is also what makes a future carrier swap tractable:
 * everything that needs to know where the stage is reads from here, instead of
 * re-deriving it from whatever ancestor happens to be positioned.
 */
import type { StageRect } from "@shared/embedded";
import { onBeforeUnmount, ref, type Ref } from "vue";

export interface StageGeometry {
  /** The stage element to attach to. Bind it with `ref="stage"`. */
  stage: Ref<HTMLElement | null>;
  /** Size of the stage in CSS pixels, for laying out the app's own overlays. */
  box: Ref<{ width: number; height: number }>;
  /** Window-content coordinates of the stage's top-left corner. */
  origin: Ref<{ x: number; y: number }>;
  /** Re-measure now. Safe to call when the element is missing. */
  report: () => void;
  /** Attach the resize observer. Call after mount, once the element exists. */
  observe: () => void;
  /** Detach it; called automatically on unmount. */
  stop: () => void;
}

/**
 * @param onChange Called after every measurement, including the zero-size case.
 *   The caller forwards it to the main process; the size only changes on real
 *   resizes, so `onChange` fires on every report but `box` only updates on a
 *   change (which is what the overlay layout watches).
 */
export function useStageGeometry(onChange: (rect: StageRect | null) => void): StageGeometry {
  const stage = ref<HTMLElement | null>(null);
  const box = ref({ width: 0, height: 0 });
  const origin = ref({ x: 0, y: 0 });

  function report(): void {
    const element = stage.value;
    if (!element) {
      onChange(null);
      return;
    }
    // Viewport coordinates are window content-area DIPs, which is exactly what
    // `WebContentsView.setBounds` expects.
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      onChange(null);
      return;
    }
    origin.value = { x: Math.round(rect.left), y: Math.round(rect.top) };
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (width !== box.value.width || height !== box.value.height) {
      box.value = { width, height };
    }
    onChange({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.floor(rect.width),
      height: Math.floor(rect.height),
    });
  }

  let observer: ResizeObserver | null = null;

  /** Start watching; call once the element exists (after mount). */
  function observe(): void {
    if (!stage.value) return;
    observer?.disconnect();
    observer = new ResizeObserver(() => report());
    observer.observe(stage.value);
    report();
  }

  function stop(): void {
    observer?.disconnect();
    observer = null;
  }

  onBeforeUnmount(() => {
    stop();
    window.removeEventListener("resize", report);
  });

  return { stage, box, origin, report, observe, stop };
}
