import type { LayoutKey } from "@shared/types";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DIMENSIONS: Record<LayoutKey, { columns: number; rows: number }> = {
  "1x1": { columns: 1, rows: 1 },
  "2x1": { columns: 2, rows: 1 },
  "2x2": { columns: 2, rows: 2 },
  "3x1": { columns: 3, rows: 1 },
};

export function layoutDimensions(layout: LayoutKey): { columns: number; rows: number } {
  return DIMENSIONS[layout];
}

/**
 * Splits a work area into `columns x rows` slots in row-major order.
 * Remainder pixels are assigned to the last column/row so slots always cover the area.
 */
export function computeGrid(
  layout: LayoutKey,
  area: Rect,
  gap = 8,
  padding = 8,
): Rect[] {
  const { columns, rows } = DIMENSIONS[layout];
  const innerWidth = Math.max(0, area.width - padding * 2 - gap * (columns - 1));
  const innerHeight = Math.max(0, area.height - padding * 2 - gap * (rows - 1));
  const cellWidth = Math.floor(innerWidth / columns);
  const cellHeight = Math.floor(innerHeight / rows);
  const slots: Rect[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const isLastColumn = column === columns - 1;
      const isLastRow = row === rows - 1;
      const width = isLastColumn ? innerWidth - cellWidth * (columns - 1) : cellWidth;
      const height = isLastRow ? innerHeight - cellHeight * (rows - 1) : cellHeight;
      slots.push({
        x: area.x + padding + column * (cellWidth + gap),
        y: area.y + padding + row * (cellHeight + gap),
        width,
        height,
      });
    }
  }

  return slots;
}

export function slotCount(layout: LayoutKey): number {
  const { columns, rows } = DIMENSIONS[layout];
  return columns * rows;
}
