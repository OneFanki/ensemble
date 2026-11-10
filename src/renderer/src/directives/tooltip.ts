/**
 * The app's own hover label, for controls whose text is an icon.
 *
 * A native `title` was the cheap answer, and it looked like one: it waits about
 * a second before appearing, it cannot be styled, it ignores the app's own
 * scale, and on Windows it renders in the system font at a position the window
 * does not control. The reason it survived is historical — pages used to be
 * native views painted above the renderer, so a flyout drawn in our own layer
 * would have been hidden behind them. Pages now live in the renderer's DOM, so
 * that constraint is gone and the only thing left was the habit.
 *
 * It is a directive rather than a wrapper component on purpose: wrapping every
 * icon button in a span would insert a flex item where a button used to be, and
 * properties like `margin-left: auto` on the button would silently stop working.
 * `v-tooltip` attaches to the element that is already there.
 *
 * One host element is shared by every tooltip. Two cannot be visible at once —
 * the pointer is on one control — so a singleton is not a shortcut, it is the
 * accurate model, and it keeps the document from collecting empty nodes.
 */
import type { Directive, DirectiveBinding } from "vue";

type Placement = "bottom" | "top";

export interface TooltipOptions {
  text: string;
  placement?: Placement;
}

/** Long enough that sweeping the toolbar does not flash a trail of labels. */
const SHOW_DELAY = 380;
const GAP = 6;
const EDGE = 8;

interface Bound {
  options: TooltipOptions;
  onEnter: () => void;
  onLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onPress: () => void;
}

const bound = new WeakMap<HTMLElement, Bound>();

let host: HTMLDivElement | null = null;
let active: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function ensureHost(): HTMLDivElement {
  if (host?.isConnected) return host;
  const node = document.createElement("div");
  node.className = "app-tooltip";
  node.setAttribute("role", "tooltip");
  // The host is always in the tree so its size can be measured before the first
  // paint; `visibility` keeps it out of sight while still contributing layout,
  // which `display: none` would not.
  document.body.appendChild(node);
  host = node;
  return node;
}

function clearTimers(): void {
  if (showTimer !== undefined) clearTimeout(showTimer);
  if (hideTimer !== undefined) clearTimeout(hideTimer);
  showTimer = undefined;
  hideTimer = undefined;
}

/**
 * Places the label under its control, then resolves the two cases where that
 * would put it somewhere unreadable: past a window edge, or over the control's
 * own row of neighbours.
 */
function place(element: HTMLElement, placement: Placement = "bottom"): void {
  const node = ensureHost();
  const anchor = element.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;

  const left = Math.min(
    Math.max(EDGE, anchor.left + anchor.width / 2 - width / 2),
    window.innerWidth - width - EDGE,
  );

  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - height;
  // Flip only when the preferred side genuinely has no room: a label that
  // jumps sides on a well-placed control reads as the control moving.
  let top = placement === "top" ? above : below;
  if (top < EDGE) top = below;
  if (top + height > window.innerHeight - EDGE) top = above;

  node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function show(element: HTMLElement, options: TooltipOptions): void {
  // Text can be empty now: a control whose visible label is hidden in a narrow
  // layout has a tooltip, and the same control in a wide layout does not. An
  // empty label would paint an empty box, so it is treated as "no tooltip".
  if (!options.text) {
    if (active === element) hide();
    return;
  }
  const node = ensureHost();
  node.textContent = options.text;
  active = element;
  place(element, options.placement);
  // A frame between writing the text and revealing it lets the browser lay the
  // label out first; without it the first tooltip of a session appears at the
  // previous label's width for one frame.
  requestAnimationFrame(() => {
    if (active !== element) return;
    place(element, options.placement);
    node.classList.add("visible");
  });
}

function hide(): void {
  clearTimers();
  active = null;
  host?.classList.remove("visible");
}

export const vTooltip: Directive<HTMLElement, string | TooltipOptions> = {
  mounted(element, binding) {
    // Listeners are attached even when the text is empty: the text can be
    // filled in later (a label that only appears when its button is icon-only),
    // and a directive that skipped binding would never pick that up.
    const options = normalize(binding.value);

    const entry: Bound = {
      options,
      onEnter: () => {
        clearTimers();
        showTimer = setTimeout(() => show(element, entry.options), SHOW_DELAY);
      },
      onLeave: () => {
        clearTimers();
        // Deliberately not delayed: a label that lingers after the pointer has
        // left sits on top of whatever the user moved on to.
        if (active === element) hide();
      },
      onFocus: () => show(element, entry.options),
      onBlur: () => {
        if (active === element) hide();
      },
      // The control's own action usually opens a menu or a panel; leaving a
      // label underneath it covers the thing the click produced.
      onPress: () => {
        if (active === element) hide();
      },
    };

    bound.set(element, entry);
    element.addEventListener("pointerenter", entry.onEnter);
    element.addEventListener("pointerleave", entry.onLeave);
    element.addEventListener("focus", entry.onFocus);
    element.addEventListener("blur", entry.onBlur);
    element.addEventListener("pointerdown", entry.onPress);
  },

  updated(element, binding) {
    const entry = bound.get(element);
    if (!entry) return;
    const next = normalize(binding.value);
    entry.options = next;
    // A label can be showing while its text changes (a locale switch, a count
    // that updates). Writing the new text into the shared host keeps it honest
    // instead of leaving the old words up until the pointer moves.
    if (active === element) {
      show(element, next);
    }
  },

  unmounted(element) {
    const entry = bound.get(element);
    if (!entry) return;
    element.removeEventListener("pointerenter", entry.onEnter);
    element.removeEventListener("pointerleave", entry.onLeave);
    element.removeEventListener("focus", entry.onFocus);
    element.removeEventListener("blur", entry.onBlur);
    element.removeEventListener("pointerdown", entry.onPress);
    bound.delete(element);
    if (active === element) hide();
  },
};

function normalize(value: string | TooltipOptions | undefined): TooltipOptions {
  if (typeof value === "string") return { text: value };
  return value ?? { text: "" };
}

/**
 * Hides the label immediately.
 *
 * Called from the views that unmount a control while the pointer is still over
 * it — closing a view, switching a page. Without it the label stays up over the
 * surface that replaced the control, because no `pointerleave` ever fires for an
 * element that is gone.
 */
export function hideTooltip(): void {
  hide();
}
