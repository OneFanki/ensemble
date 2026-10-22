import type { LayoutId, LayoutPreset, SlotRect } from "./types";

/**
 * "free" is the explicit no-layout mode: every window gets the whole work area,
 * so four accounts open as four full-size windows that overlap instead of four
 * windows too small to use. Press the taskbar / Alt-Tab to switch between them.
 */
export const FREE_LAYOUT_ID = "free";

const full = (): SlotRect => ({ x: 0, y: 0, width: 1, height: 1 });

function grid(columns: number, rows: number): SlotRect[] {
  const slots: SlotRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      slots.push({
        x: column / columns,
        y: row / rows,
        width: 1 / columns,
        height: 1 / rows,
      });
    }
  }
  return slots;
}

/**
 * Edge-to-edge on purpose: padding and gaps used to leave a border of unused
 * screen around a four-way split, which is exactly the space a small laptop
 * cannot spare.
 */
export const BUILTIN_LAYOUTS: LayoutPreset[] = [
  { id: FREE_LAYOUT_ID, name: "Free", slots: [], builtin: true },
  { id: "1x1", name: "1 × 1", slots: [full()], builtin: true },
  { id: "2x1", name: "2 × 1", slots: grid(2, 1), builtin: true },
  { id: "1x2", name: "1 × 2", slots: grid(1, 2), builtin: true },
  { id: "2x2", name: "2 × 2", slots: grid(2, 2), builtin: true },
  { id: "3x1", name: "3 × 1", slots: grid(3, 1), builtin: true },
];

export function findLayout(id: LayoutId | undefined, custom: LayoutPreset[] = []): LayoutPreset {
  return (
    BUILTIN_LAYOUTS.find((preset) => preset.id === id) ??
    custom.find((preset) => preset.id === id) ??
    BUILTIN_LAYOUTS.find((preset) => preset.id === "2x2")!
  );
}

export function isFreeLayout(preset: LayoutPreset): boolean {
  return preset.slots.length === 0;
}

/** Keeps a stored slot inside the work area and above a usable minimum size. */
export function clampSlot(slot: SlotRect): SlotRect {
  const width = Math.min(1, Math.max(0.08, slot.width));
  const height = Math.min(1, Math.max(0.08, slot.height));
  return {
    x: Math.min(Math.max(0, slot.x), 1 - width),
    y: Math.min(Math.max(0, slot.y), 1 - height),
    width,
    height,
  };
}

/**
 * Fills in the slots a view does not assign explicitly. Explicit entries win,
 * duplicates are ignored, and the remaining members take the remaining slots in
 * member order — so a view saved before slot assignment existed still opens
 * every window in a sensible place.
 */
export function resolveSlotAssignments(
  preset: LayoutPreset,
  identityIds: string[],
  assignments: Record<string, number>,
): Record<string, number> {
  if (preset.slots.length === 0) return {};
  const result: Record<string, number> = {};
  const taken = new Set<number>();

  for (const [identityId, slot] of Object.entries(assignments ?? {})) {
    if (!identityIds.includes(identityId)) continue;
    if (!Number.isInteger(slot) || slot < 0 || slot >= preset.slots.length) continue;
    if (taken.has(slot)) continue;
    result[identityId] = slot;
    taken.add(slot);
  }

  for (const identityId of identityIds) {
    if (identityId in result) continue;
    for (let slot = 0; slot < preset.slots.length; slot += 1) {
      if (taken.has(slot)) continue;
      result[identityId] = slot;
      taken.add(slot);
      break;
    }
  }

  return result;
}

/** Normalized lines the editor can snap to, in fractions of the stage. */
export interface SnapGuides {
  vertical: number[];
  horizontal: number[];
}

export interface SnapResult {
  rect: SlotRect;
  guides: SnapGuides;
}

function snapCandidates(others: SlotRect[]): { xs: number[]; ys: number[] } {
  // Stage edges are always candidates, so a slot can be flushed to the screen
  // border as well as aligned with a neighbour.
  const xs = [0, 1];
  const ys = [0, 1];
  for (const slot of others) {
    xs.push(slot.x, slot.x + slot.width);
    ys.push(slot.y, slot.y + slot.height);
  }
  return { xs, ys };
}

/**
 * Picks the smallest movement that aligns any of `edges` with a candidate line.
 * A tie is resolved by the first candidate, which keeps snapping predictable.
 */
function bestSnap(
  edges: number[],
  candidates: number[],
  threshold: number,
): { delta: number; target: number } | undefined {
  let best: { delta: number; target: number } | undefined;
  for (const edge of edges) {
    for (const candidate of candidates) {
      const delta = candidate - edge;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, target: candidate };
    }
  }
  return best;
}

/**
 * Moves a slot while snapping either of its horizontal edges to stage or
 * neighbour edges. Both left and right edges are considered so dropping a slot
 * flush against a neighbour's right side works without pixel hunting.
 */
export function snapSlotMove(
  rect: SlotRect,
  others: SlotRect[],
  threshold: { x: number; y: number },
): SnapResult {
  const { xs, ys } = snapCandidates(others);
  const xSnap = bestSnap([rect.x, rect.x + rect.width], xs, threshold.x);
  const ySnap = bestSnap([rect.y, rect.y + rect.height], ys, threshold.y);
  const moved = clampSlot({
    ...rect,
    x: rect.x + (xSnap?.delta ?? 0),
    y: rect.y + (ySnap?.delta ?? 0),
  });

  // Clamping can move the rect away from the line it snapped to; only advertise
  // guides that still coincide with an actual edge of the final rect.
  const vertical =
    xSnap && (aboutEqual(moved.x, xSnap.target) || aboutEqual(moved.x + moved.width, xSnap.target))
      ? [xSnap.target]
      : [];
  const horizontal =
    ySnap && (aboutEqual(moved.y, ySnap.target) || aboutEqual(moved.y + moved.height, ySnap.target))
      ? [ySnap.target]
      : [];
  return { rect: moved, guides: { vertical, horizontal } };
}

/**
 * Resizes from the bottom-right handle with the same snapping rules. The top-left
 * corner stays put, which is what the handle implies.
 */
export function snapSlotResize(
  rect: SlotRect,
  others: SlotRect[],
  threshold: { x: number; y: number },
  minimum = 0.08,
): SnapResult {
  const { xs, ys } = snapCandidates(others);
  const xSnap = bestSnap([rect.x + rect.width], xs, threshold.x);
  const ySnap = bestSnap([rect.y + rect.height], ys, threshold.y);
  const maxWidth = Math.max(minimum, 1 - rect.x);
  const maxHeight = Math.max(minimum, 1 - rect.y);
  const width = Math.min(maxWidth, Math.max(minimum, rect.width + (xSnap?.delta ?? 0)));
  const height = Math.min(maxHeight, Math.max(minimum, rect.height + (ySnap?.delta ?? 0)));
  const resized: SlotRect = { ...rect, width, height };
  const vertical =
    xSnap && aboutEqual(rect.x + width, xSnap.target) && width < maxWidth ? [xSnap.target] : [];
  const horizontal =
    ySnap && aboutEqual(rect.y + height, ySnap.target) && height < maxHeight ? [ySnap.target] : [];
  return { rect: resized, guides: { vertical, horizontal } };
}

function aboutEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}
