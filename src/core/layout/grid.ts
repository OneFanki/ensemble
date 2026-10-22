import type { LayoutPreset } from "@shared/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Expands a target rect so the *visible* frame lands on it.
 *
 * Windows draws an invisible resize border around every Chromium window; the
 * bounds we set include it, so two windows placed edge to edge still show a gap
 * of two insets between their visible frames. Growing the outer rect by the
 * inset on each side cancels that out. Neighbouring slots each grow by the same
 * amount, so they meet exactly.
 */
export function inflateRect(rect: Rect, inset: Partial<FrameInset> | undefined): Rect {
  if (!inset) return rect;
  const left = inset.left ?? 0;
  const right = inset.right ?? 0;
  const top = inset.top ?? 0;
  const bottom = inset.bottom ?? 0;
  if (left + right + top + bottom === 0) return rect;
  return {
    x: Math.round(rect.x - left),
    y: Math.round(rect.y - top),
    width: Math.max(1, Math.round(rect.width + left + right)),
    height: Math.max(1, Math.round(rect.height + top + bottom)),
  };
}

export interface FrameInset {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Turns a preset's normalized slots into absolute rectangles on the work area.
 * The conversion is edge-to-edge: no outer padding and no gaps, so a 2×2 preset
 * uses every pixel the screen offers.
 */
export function computeSlots(preset: LayoutPreset, area: Rect): Rect[] {
  return preset.slots.map((slot) => {
    const left = Math.round(slot.x * area.width);
    const top = Math.round(slot.y * area.height);
    const right = Math.round((slot.x + slot.width) * area.width);
    const bottom = Math.round((slot.y + slot.height) * area.height);
    return {
      x: area.x + left,
      y: area.y + top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  });
}

/**
 * Placement for a single window launched outside a view. A lone identity is the
 * one you are actively working in, so it gets a comfortable centered window
 * instead of a grid slot pinned to the top-left quarter.
 */
export function singleWindowRect(
  area: Rect,
  options: {
    widthRatio?: number;
    heightRatio?: number;
    minWidth?: number;
    minHeight?: number;
    margin?: number;
  } = {},
): Rect {
  const margin = options.margin ?? 24;
  const maxWidth = Math.max(320, area.width - margin * 2);
  const maxHeight = Math.max(240, area.height - margin * 2);
  const width = Math.min(
    Math.max(Math.round(area.width * (options.widthRatio ?? 0.78)), options.minWidth ?? 900),
    maxWidth,
  );
  const height = Math.min(
    Math.max(Math.round(area.height * (options.heightRatio ?? 0.84)), options.minHeight ?? 640),
    maxHeight,
  );
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

/** Full work area, used by the "no layout" mode for every window. */
export function fullWorkArea(area: Rect): Rect {
  return { ...area };
}
