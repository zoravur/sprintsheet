/**
 * Headless spreadsheet model.
 *
 * Everything the grid *does* lives here as pure state transitions, so it can be
 * tested without a DOM, a canvas or React. The React component only turns input
 * events into {@link Command}s and turns the resulting {@link Effect}s back into
 * view side effects (scrolling, focus, callbacks).
 *
 * The whole document state is one immutable-ish object produced by
 * {@link reduce}; mutations of row objects happen in place (a commit writes to
 * the row the user edited) but the state wrapper is always fresh, which gives
 * `useSyncExternalStore` a new snapshot to compare against.
 */

import { compareValues, parseEditedValue, resolveValue } from "./format";
import { fullGrid, scanCell } from "./navigation";
import {
  clampToRect,
  normalizeSelection,
  singleCellSelection,
  type CellAddress,
  type CellValue,
  type ColumnDef,
  type SelectionRange,
  type SortState,
} from "./types";

export interface EditingState {
  row: number;
  col: number;
  text: string;
  /** Whether the editor should select-all on open (F2/double-click) or not (typing). */
  selectAll: boolean;
}

export interface SpreadsheetState<Row> {
  /** Source rows, in data order. */
  rows: Row[];
  /** Visual order (sorted or identity). Indexed by *display* row. */
  view: Row[];
  columns: ColumnDef<Row>[];
  widths: number[];
  sort: SortState | null;
  selection: SelectionRange;
  editing: EditingState | null;
}

/** Things the model asks the view to do. Deliberately not state. */
export type Effect<Row> =
  | { type: "reveal"; row: number; col: number }
  | { type: "focusGrid" }
  | { type: "edited"; row: Row; rowIndex: number; column: ColumnDef<Row>; value: CellValue; previous: CellValue };

export type Command<Row> =
  | { type: "selectCell"; row: number; col: number }
  | { type: "selectRange"; anchor: CellAddress; extent: CellAddress; focus: CellAddress }
  | { type: "selectRow"; row: number }
  | { type: "selectAll" }
  | { type: "move"; dr: number; dc: number; extend: boolean }
  | { type: "moveTo"; row: number; col: number; extend: boolean }
  | { type: "scan"; axis: "h" | "v"; forward: boolean }
  | { type: "beginEdit"; seed: string | null; selectAll: boolean }
  | { type: "setEditText"; text: string }
  | { type: "commitEdit" }
  | { type: "cancelEdit" }
  | { type: "sortColumn"; columnId: string }
  | { type: "setColumnWidth"; col: number; width: number }
  | { type: "clearCells" }
  | { type: "paste"; text: string }
  | { type: "setRows"; rows: Row[] }
  | { type: "setColumns"; columns: ColumnDef<Row>[] };

export interface CommandResult<Row> {
  state: SpreadsheetState<Row>;
  effects: Effect<Row>[];
}

const NO_EFFECTS: Effect<never>[] = [];

export function editTextFor(col: ColumnDef<any>, value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Sort the rows for display. Stable, and returns the input array when unsorted. */
export function computeView<Row>(rows: Row[], columns: ColumnDef<Row>[], sort: SortState | null): Row[] {
  if (!sort) return rows;
  const column = columns.find((c) => c.id === sort.columnId);
  if (!column) return rows;
  const decorated = rows.map((row, i) => ({ row, i }));
  decorated.sort((a, b) => {
    const cmp = compareValues(resolveValue(column, a.row, a.i), resolveValue(column, b.row, b.i));
    return sort.direction === "asc" ? cmp : -cmp;
  });
  return decorated.map((d) => d.row);
}

function clampCell(rowCount: number, colCount: number, sel: SelectionRange): SelectionRange {
  const maxRow = Math.max(0, rowCount - 1);
  const maxCol = Math.max(0, colCount - 1);
  const anchorRow = Math.max(0, Math.min(maxRow, sel.anchorRow));
  const anchorCol = Math.max(0, Math.min(maxCol, sel.anchorCol));
  const extentRow = Math.max(0, Math.min(maxRow, sel.extentRow));
  const extentCol = Math.max(0, Math.min(maxCol, sel.extentCol));
  const rect = normalizeSelection({ ...sel, anchorRow, anchorCol, extentRow, extentCol });
  const focus = clampToRect(rect, sel.focusRow, sel.focusCol);
  return { anchorRow, anchorCol, extentRow, extentCol, focusRow: focus.row, focusCol: focus.col };
}

function clampRow(state: SpreadsheetState<any>, i: number): number {
  return Math.max(0, Math.min(state.rows.length - 1, i));
}

function clampCol(state: SpreadsheetState<any>, i: number): number {
  return Math.max(0, Math.min(state.columns.length - 1, i));
}

export function initialState<Row>(rows: Row[], columns: ColumnDef<Row>[]): SpreadsheetState<Row> {
  return {
    rows,
    view: computeView(rows, columns, null),
    columns,
    widths: columns.map((c) => c.width),
    sort: null,
    selection: singleCellSelection(0, 0),
    editing: null,
  };
}

/**
 * Commands that implicitly finish an open edit before they apply — i.e. "most
 * navigation actions just end edit mode". The view deliberately keeps the arrow
 * keys out of this path while editing (they become caret movement inside the
 * field), so they are listed only as a defensive default.
 */
const ENDS_EDIT = new Set<Command<any>["type"]>([
  "selectCell",
  "selectRange",
  "selectRow",
  "selectAll",
  "move",
  "moveTo",
  "scan",
  "sortColumn",
  "setColumnWidth",
  "clearCells",
  "paste",
]);

/** Write the edited value back (if changed) and leave edit mode. */
function commitEditing<Row>(state: SpreadsheetState<Row>): CommandResult<Row> {
  const editing = state.editing;
  if (!editing) return { state, effects: NO_EFFECTS as Effect<Row>[] };

  const effects: Effect<Row>[] = [];
  const column = state.columns[editing.col];
  const target = state.view[editing.row];
  if (column && target !== undefined && column.field !== undefined) {
    const previous = resolveValue(column, target, editing.row);
    const value = parseEditedValue(column, editing.text);
    if (value !== previous) {
      (target as Record<string, unknown>)[column.field] = value;
      effects.push({ type: "edited", row: target, rowIndex: editing.row, column, value, previous });
    }
  }
  effects.push({ type: "focusGrid" });
  return { state: { ...state, editing: null }, effects };
}

export function reduce<Row>(state: SpreadsheetState<Row>, command: Command<Row>): CommandResult<Row> {
  // Edit mode is a mode of the sheet, not a special case for the view: any
  // navigation command commits the pending edit first, then proceeds.
  if (state.editing && ENDS_EDIT.has(command.type)) {
    const committed = commitEditing(state);
    const result = reduce(committed.state, command);
    return { state: result.state, effects: [...committed.effects, ...result.effects] };
  }

  const rowCount = state.rows.length;
  const colCount = state.columns.length;
  const empty: CommandResult<Row> = { state, effects: NO_EFFECTS as Effect<Row>[] };

  switch (command.type) {
    case "selectCell": {
      const row = clampRow(state, command.row);
      const col = clampCol(state, command.col);
      return { state: { ...state, selection: singleCellSelection(row, col) }, effects: NO_EFFECTS as Effect<Row>[] };
    }

    case "selectRange": {
      const selection = clampCell(rowCount, colCount, {
        anchorRow: command.anchor.row,
        anchorCol: command.anchor.col,
        extentRow: command.extent.row,
        extentCol: command.extent.col,
        focusRow: command.focus.row,
        focusCol: command.focus.col,
      });
      return { state: { ...state, selection }, effects: NO_EFFECTS as Effect<Row>[] };
    }

    case "selectRow": {
      const row = clampRow(state, command.row);
      const lastCol = Math.max(0, colCount - 1);
      return {
        state: {
          ...state,
          selection: { anchorRow: row, anchorCol: 0, extentRow: row, extentCol: lastCol, focusRow: row, focusCol: 0 },
        },
        effects: NO_EFFECTS as Effect<Row>[],
      };
    }

    case "selectAll": {
      return {
        state: {
          ...state,
          selection: {
            anchorRow: 0,
            anchorCol: 0,
            extentRow: Math.max(0, rowCount - 1),
            extentCol: Math.max(0, colCount - 1),
            focusRow: 0,
            focusCol: 0,
          },
        },
        effects: NO_EFFECTS as Effect<Row>[],
      };
    }

    case "move": {
      const sel = state.selection;
      if (!command.extend) {
        const row = clampRow(state, sel.focusRow + command.dr);
        const col = clampCol(state, sel.focusCol + command.dc);
        return {
          state: { ...state, selection: singleCellSelection(row, col) },
          effects: [{ type: "reveal", row, col }],
        };
      }
      const extentRow = clampRow(state, sel.extentRow + command.dr);
      const extentCol = clampCol(state, sel.extentCol + command.dc);
      const rect = normalizeSelection({ ...sel, extentRow, extentCol });
      const focus = clampToRect(rect, sel.focusRow, sel.focusCol);
      return {
        state: {
          ...state,
          selection: { ...sel, extentRow, extentCol, focusRow: focus.row, focusCol: focus.col },
        },
        effects: [{ type: "reveal", row: extentRow, col: extentCol }],
      };
    }

    case "moveTo": {
      const row = clampRow(state, command.row);
      const col = clampCol(state, command.col);
      const sel = state.selection;
      if (!command.extend) {
        return {
          state: { ...state, selection: singleCellSelection(row, col) },
          effects: [{ type: "reveal", row, col }],
        };
      }
      const rect = normalizeSelection({ ...sel, extentRow: row, extentCol: col });
      const focus = clampToRect(rect, sel.focusRow, sel.focusCol);
      return {
        state: {
          ...state,
          selection: { ...sel, extentRow: row, extentCol: col, focusRow: focus.row, focusCol: focus.col },
        },
        effects: [{ type: "reveal", row, col }],
      };
    }

    case "scan": {
      const sel = state.selection;
      const rect = normalizeSelection(sel);
      const single = rect.rowMin === rect.rowMax && rect.colMin === rect.colMax;
      const domain = single ? fullGrid(colCount, rowCount) : rect;
      const { row, col } = scanCell(domain, { row: sel.focusRow, col: sel.focusCol }, command.axis, command.forward);
      return {
        state: {
          ...state,
          selection: single ? singleCellSelection(row, col) : { ...sel, focusRow: row, focusCol: col },
        },
        effects: [{ type: "reveal", row, col }],
      };
    }

    case "beginEdit": {
      const sel = state.selection;
      const col = sel.focusCol;
      const row = sel.focusRow;
      const column = state.columns[col];
      const target = state.view[row];
      if (!column || target === undefined || column.field === undefined) return empty;
      const text = command.seed ?? editTextFor(column, resolveValue(column, target, row));
      return {
        // Keep the rectangle intact — only the focus cell is being edited, so
        // `Enter`/`Tab` still cycle within the selection when the edit commits.
        state: { ...state, editing: { row, col, text, selectAll: command.selectAll } },
        effects: NO_EFFECTS as Effect<Row>[],
      };
    }

    case "setEditText": {
      if (!state.editing) return empty;
      return { state: { ...state, editing: { ...state.editing, text: command.text } }, effects: NO_EFFECTS as Effect<Row>[] };
    }

    case "cancelEdit": {
      if (!state.editing) return empty;
      return { state: { ...state, editing: null }, effects: [{ type: "focusGrid" }] };
    }

    case "commitEdit":
      return commitEditing(state);

    case "sortColumn": {
      const column = state.columns.find((c) => c.id === command.columnId);
      if (!column || column.sortable === false) return empty;
      let sort: SortState | null;
      if (!state.sort || state.sort.columnId !== command.columnId) {
        sort = { columnId: command.columnId, direction: "asc" };
      } else if (state.sort.direction === "asc") {
        sort = { columnId: command.columnId, direction: "desc" };
      } else {
        sort = null;
      }
      return { state: { ...state, sort, view: computeView(state.rows, state.columns, sort) }, effects: NO_EFFECTS as Effect<Row>[] };
    }

    case "setColumnWidth": {
      const column = state.columns[command.col];
      if (!column) return empty;
      const min = column.minWidth ?? 56;
      const max = column.maxWidth ?? 800;
      const width = Math.max(min, Math.min(max, command.width));
      if (state.widths[command.col] === width) return empty;
      const widths = state.widths.slice();
      widths[command.col] = width;
      return { state: { ...state, widths }, effects: NO_EFFECTS as Effect<Row>[] };
    }

    case "clearCells": {
      const rect = normalizeSelection(state.selection);
      const rowMax = Math.min(rect.rowMax, rowCount - 1);
      const colMax = Math.min(rect.colMax, colCount - 1);
      const effects: Effect<Row>[] = [];
      for (let r = rect.rowMin; r <= rowMax; r++) {
        const target = state.view[r];
        if (target === undefined) continue;
        for (let c = rect.colMin; c <= colMax; c++) {
          const column = state.columns[c];
          if (!column || column.field === undefined) continue;
          const previous = resolveValue(column, target, r);
          if (previous === null || previous === undefined) continue; // already empty
          (target as Record<string, unknown>)[column.field] = null;
          effects.push({ type: "edited", row: target, rowIndex: r, column, value: null, previous });
        }
      }
      return { state: { ...state }, effects };
    }

    case "paste": {
      const origin = { row: state.selection.focusRow, col: state.selection.focusCol };
      const matrix = command.text.replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
      const effects: Effect<Row>[] = [];
      matrix.forEach((cells, dr) => {
        cells.forEach((cellText, dc) => {
          const r = origin.row + dr;
          const c = origin.col + dc;
          if (r >= rowCount || c >= colCount) return;
          const column = state.columns[c];
          const target = state.view[r];
          if (!column || target === undefined || column.field === undefined) return;
          const previous = resolveValue(column, target, r);
          const value = parseEditedValue(column, cellText);
          if (value === previous) return;
          (target as Record<string, unknown>)[column.field] = value;
          effects.push({ type: "edited", row: target, rowIndex: r, column, value, previous });
        });
      });
      return { state: { ...state }, effects };
    }

    case "setRows": {
      const view = computeView(command.rows, state.columns, state.sort);
      return {
        // A row/column swap can invalidate the edited address, so drop the editor.
        state: {
          ...state,
          rows: command.rows,
          view,
          editing: null,
          selection: clampCell(command.rows.length, colCount, state.selection),
        },
        effects: NO_EFFECTS as Effect<Row>[],
      };
    }

    case "setColumns": {
      const columns = command.columns;
      const widths = state.widths.length === columns.length ? state.widths : columns.map((c) => c.width);
      const view = computeView(state.rows, columns, state.sort);
      return {
        state: {
          ...state,
          columns,
          widths,
          view,
          editing: null,
          selection: clampCell(rowCount, columns.length, state.selection),
        },
        effects: NO_EFFECTS as Effect<Row>[],
      };
    }

    default:
      return empty;
  }
}

/** Observable wrapper around {@link reduce}. `subscribe`/`getState` are stable. */
export class SpreadsheetModel<Row> {
  private state: SpreadsheetState<Row>;
  private listeners = new Set<() => void>();

  constructor(rows: Row[], columns: ColumnDef<Row>[]) {
    this.state = initialState(rows, columns);
  }

  getState = (): SpreadsheetState<Row> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch = (command: Command<Row>): Effect<Row>[] => {
    const { state, effects } = reduce(this.state, command);
    if (state === this.state) return effects;
    this.state = state;
    for (const listener of this.listeners) listener();
    return effects;
  };
}
