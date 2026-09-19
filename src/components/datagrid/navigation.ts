/**
 * Keyboard scan navigation for `Enter` / `Tab`.
 *
 * Given the rectangle that bounds the selection, move the active cell one step
 * in a scan order and wrap around the rectangle:
 *  - horizontal (`Tab`) scans row-major,   wrapping to the next row.
 *  - vertical (`Enter`) scans column-major, wrapping to the next column.
 *
 * `forward: false` (the `Shift` variants) walks the same order backwards.
 */

import type { SelectionRect } from "./types";

export type ScanAxis = "h" | "v";

export interface Cell {
  row: number;
  col: number;
}

export function scanCell(domain: SelectionRect, focus: Cell, axis: ScanAxis, forward: boolean): Cell {
  let { row, col } = focus;

  if (axis === "h") {
    if (forward) {
      if (col < domain.colMax) col += 1;
      else if (row < domain.rowMax) {
        col = domain.colMin;
        row += 1;
      } else {
        col = domain.colMin;
        row = domain.rowMin;
      }
    } else if (col > domain.colMin) {
      col -= 1;
    } else if (row > domain.rowMin) {
      col = domain.colMax;
      row -= 1;
    } else {
      col = domain.colMax;
      row = domain.rowMax;
    }
    return { row, col };
  }

  if (forward) {
    if (row < domain.rowMax) row += 1;
    else if (col < domain.colMax) {
      row = domain.rowMin;
      col += 1;
    } else {
      row = domain.rowMin;
      col = domain.colMin;
    }
  } else if (row > domain.rowMin) {
    row -= 1;
  } else if (col > domain.colMin) {
    row = domain.rowMax;
    col -= 1;
  } else {
    row = domain.rowMax;
    col = domain.colMax;
  }
  return { row, col };
}

/** Whole-grid rectangle, used when the selection is a single cell. */
export function fullGrid(cols: number, rows: number): SelectionRect {
  return { rowMin: 0, rowMax: Math.max(0, rows - 1), colMin: 0, colMax: Math.max(0, cols - 1) };
}
