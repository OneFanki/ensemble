import type { LayoutPreset } from "@shared/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Turns a preset's normalized slots into absolute rectangles on the work area.
 * The conversion is edge-to-edge: no outer padding and no gaps, so a 2×2 preset
 * uses every pixel the screen offers. Adjacent windows keep their own 1px border,
 * which is enough separation without stealing usable space.
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
 * Placement for a single window launched outside a scene. A lone identity is the
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
