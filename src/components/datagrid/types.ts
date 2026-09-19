/**
 * Core types for the canvas data grid.
 *
 * The grid is column-oriented: the caller describes columns once and the grid
 * resolves each visible cell's raw value lazily through `getValue`/`field`.
 * Only visible cells are ever touched during a frame, which is what keeps the
 * render loop O(rows-on-screen x columns-on-screen) instead of O(rows x cols).
 */

/** Raw value a cell can hold. `Date` is coerced via `formatCell`. */
export type CellValue = string | number | boolean | Date | null | undefined;

export type ColumnType =
  | "text"
  | "number"
  | "integer"
  | "currency"
  | "percent"
  | "date"
  | "boolean"
  | "badge";

export type Align = "left" | "right" | "center";

export interface ColumnDef<Row> {
  /** Stable identity, also used to persist sort + width. */
  id: string;
  header: string;
  /** Default pixel width. */
  width: number;
  minWidth?: number;
  maxWidth?: number;
  type?: ColumnType;
  /** Default alignment; `number`/`integer`/`currency`/`percent` default to `right`. */
  align?: Align;
  /** Shorthand accessor, used when `getValue` is absent. */
  field?: keyof Row & string;
  /** Full accessor with the display row index available. */
  getValue?: (row: Row, rowIndex: number) => CellValue;
  /** Override the display string. Receives the already-resolved raw value. */
  format?: (value: CellValue, row: Row, rowIndex: number) => string;
  /** Enable click-to-sort on the header. Defaults to `true`. */
  sortable?: boolean;
  currency?: string;
  locale?: string;
}

/**
 * A spreadsheet selection, modelled as three cells:
 *
 *  - `anchor` — one corner of the selection rectangle.
 *  - `extent` — the opposite corner; the rectangle is the bounding box of
 *    `anchor` and `extent`. The two are interchangeable, so after a pointer
 *    gesture we normalise `anchor` to the top-left and `extent` to the
 *    bottom-right.
 *  - `focus` — the active cell. It may sit anywhere *inside* the rectangle
 *    (e.g. where a drag started, or where `Enter`/`Tab` navigated to), and it
 *    is the cell that typing edits.
 *
 * Invariant: `focus` is always inside `normalizeSelection(selection)`.
 */
export interface SelectionRange {
  anchorRow: number;
  anchorCol: number;
  extentRow: number;
  extentCol: number;
  focusRow: number;
  focusCol: number;
}

export interface SortState {
  columnId: string;
  direction: "asc" | "desc";
}

export interface CellAddress {
  row: number;
  col: number;
}

/** Normalized rectangle of a selection (inclusive bounds). */
export interface SelectionRect {
  rowMin: number;
  rowMax: number;
  colMin: number;
  colMax: number;
}

export function normalizeSelection(sel: SelectionRange): SelectionRect {
  return {
    rowMin: Math.min(sel.anchorRow, sel.extentRow),
    rowMax: Math.max(sel.anchorRow, sel.extentRow),
    colMin: Math.min(sel.anchorCol, sel.extentCol),
    colMax: Math.max(sel.anchorCol, sel.extentCol),
  };
}

/** Build a collapsed (single-cell) selection. */
export function singleCellSelection(row: number, col: number): SelectionRange {
  return { anchorRow: row, anchorCol: col, extentRow: row, extentCol: col, focusRow: row, focusCol: col };
}

/** Clamp a cell back inside a rectangle (used to keep `focus` valid). */
export function clampToRect(rect: SelectionRect, row: number, col: number): { row: number; col: number } {
  return {
    row: Math.max(rect.rowMin, Math.min(rect.rowMax, row)),
    col: Math.max(rect.colMin, Math.min(rect.colMax, col)),
  };
}

export const EMPTY_SELECTION: SelectionRange = {
  anchorRow: 0,
  anchorCol: 0,
  extentRow: 0,
  extentCol: 0,
  focusRow: 0,
  focusCol: 0,
};
