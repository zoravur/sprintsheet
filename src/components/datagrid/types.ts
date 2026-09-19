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

/** A raw selection: `anchor` is where the drag started, `focus` is the active cell. */
export interface SelectionRange {
  anchorRow: number;
  anchorCol: number;
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
    rowMin: Math.min(sel.anchorRow, sel.focusRow),
    rowMax: Math.max(sel.anchorRow, sel.focusRow),
    colMin: Math.min(sel.anchorCol, sel.focusCol),
    colMax: Math.max(sel.anchorCol, sel.focusCol),
  };
}

export const EMPTY_SELECTION: SelectionRange = {
  anchorRow: 0,
  anchorCol: 0,
  focusRow: 0,
  focusCol: 0,
};
