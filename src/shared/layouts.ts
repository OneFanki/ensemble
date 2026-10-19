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
 * Fills in the slots a scene does not assign explicitly. Explicit entries win,
 * duplicates are ignored, and the remaining members take the remaining slots in
 * member order — so a scene saved before slot assignment existed still opens
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
