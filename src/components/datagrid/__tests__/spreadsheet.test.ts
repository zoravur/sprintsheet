import { describe, expect, test } from "bun:test";

import { normalizeSelection } from "../types";
import { computeView, initialState, reduce, SpreadsheetModel, type Command } from "../spreadsheet";
import type { ColumnDef, SelectionRange } from "../types";

interface Row {
  id: string;
  name: string;
  amount: number;
}

const columns: ColumnDef<Row>[] = [
  { id: "id", header: "ID", width: 100, type: "text", field: "id" },
  { id: "name", header: "Name", width: 160, type: "text", field: "name" },
  { id: "amount", header: "Amount", width: 120, type: "currency", field: "amount" },
  {
    id: "double",
    header: "Double",
    width: 100,
    type: "number",
    // computed column — no `field`, so it must not be editable
    getValue: (row) => row.amount * 2,
  },
];

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `name-${i}`, amount: i }));
}

function makeModel(n = 5, cols = columns, rows = makeRows(n)) {
  return new SpreadsheetModel<Row>(rows, cols);
}

const sel = (m: SpreadsheetModel<Row>): SelectionRange => m.getState().selection;
const rect = (m: SpreadsheetModel<Row>) => normalizeSelection(m.getState().selection);

describe("initialState", () => {
  test("starts collapsed at A1, unsorted, with column default widths", () => {
    const state = initialState(makeRows(5), columns);
    expect(state.selection).toEqual({
      anchorRow: 0,
      anchorCol: 0,
      extentRow: 0,
      extentCol: 0,
      focusRow: 0,
      focusCol: 0,
    });
    expect(state.sort).toBe(null);
    expect(state.widths).toEqual([100, 160, 120, 100]);
    expect(state.view).toBe(state.rows);
    expect(state.editing).toBe(null);
  });
});

describe("reduce is pure", () => {
  test("does not mutate the input state", () => {
    const state = initialState(makeRows(5), columns);
    const before = JSON.stringify(state.selection);
    const { state: next } = reduce(state, { type: "selectCell", row: 3, col: 2 });
    expect(JSON.stringify(state.selection)).toBe(before);
    expect(next).not.toBe(state);
    expect(next.selection.focusRow).toBe(3);
  });
});

describe("selection commands", () => {
  test("selectCell collapses to a single cell and clamps", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 99, col: 99 });
    expect(sel(m)).toEqual({ anchorRow: 4, anchorCol: 3, extentRow: 4, extentCol: 3, focusRow: 4, focusCol: 3 });
  });

  test("selectRange clamps focus into the rectangle", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 0, col: 0 },
      extent: { row: 2, col: 2 },
      focus: { row: 9, col: 9 },
    });
    expect(rect(m)).toEqual({ rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 });
    expect(sel(m).focusRow).toBe(2);
    expect(sel(m).focusCol).toBe(2);
  });

  test("selectRange keeps focus inside when the anchor is the far corner", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 2, col: 2 },
      extent: { row: 0, col: 0 },
      focus: { row: 2, col: 2 },
    });
    // anchor/extent are not normalised at the model level...
    expect(sel(m).anchorRow).toBe(2);
    expect(sel(m).extentRow).toBe(0);
    // ...but the rectangle is, and focus is inside it.
    expect(rect(m)).toEqual({ rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 });
  });

  test("selectRow spans every column with focus on the first", () => {
    const m = makeModel();
    m.dispatch({ type: "selectRow", row: 2 });
    expect(sel(m)).toEqual({ anchorRow: 2, anchorCol: 0, extentRow: 2, extentCol: 3, focusRow: 2, focusCol: 0 });
  });

  test("selectAll covers the grid", () => {
    const m = makeModel();
    m.dispatch({ type: "selectAll" });
    expect(sel(m)).toEqual({ anchorRow: 0, anchorCol: 0, extentRow: 4, extentCol: 3, focusRow: 0, focusCol: 0 });
  });
});

describe("move (arrows)", () => {
  test("plain move collapses the selection and clamps at the edges", () => {
    const m = makeModel();
    m.dispatch({ type: "move", dr: -1, dc: -1, extend: false });
    expect(sel(m).focusRow).toBe(0);
    expect(sel(m).focusCol).toBe(0);
    m.dispatch({ type: "move", dr: 2, dc: 1, extend: false });
    expect(sel(m)).toEqual({ anchorRow: 2, anchorCol: 1, extentRow: 2, extentCol: 1, focusRow: 2, focusCol: 1 });
  });

  test("extend moves the extent and keeps the anchor + focus", () => {
    const m = makeModel();
    m.dispatch({ type: "move", dr: 2, dc: 2, extend: true });
    expect(sel(m)).toEqual({ anchorRow: 0, anchorCol: 0, extentRow: 2, extentCol: 2, focusRow: 0, focusCol: 0 });
  });

  test("shrinking the range pulls focus back inside", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 0, col: 0 },
      extent: { row: 3, col: 3 },
      focus: { row: 3, col: 3 },
    });
    m.dispatch({ type: "move", dr: -2, dc: -2, extend: true });
    expect(sel(m).extentRow).toBe(1);
    expect(sel(m).extentCol).toBe(1);
    expect(sel(m).focusRow).toBe(1);
    expect(sel(m).focusCol).toBe(1);
  });

  test("reveals the moved cell", () => {
    const m = makeModel();
    const effects = m.dispatch({ type: "move", dr: 1, dc: 0, extend: false });
    expect(effects).toEqual([{ type: "reveal", row: 1, col: 0 }]);
  });
});

describe("moveTo (Home / End)", () => {
  test("plain End collapses to the last column of the active row", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 2, col: 1 });
    m.dispatch({ type: "moveTo", row: 2, col: 3, extend: false });
    expect(sel(m)).toEqual({ anchorRow: 2, anchorCol: 3, extentRow: 2, extentCol: 3, focusRow: 2, focusCol: 3 });
  });

  test("Shift+End extends to the last column of the ACTIVE row", () => {
    const m = makeModel();
    // A rectangle whose extent is not on the active cell's row.
    m.dispatch({
      type: "selectRange",
      anchor: { row: 0, col: 0 },
      extent: { row: 3, col: 3 },
      focus: { row: 0, col: 0 },
    });
    m.dispatch({ type: "moveTo", row: 0, col: 3, extend: true });
    // The extent must land on row 0 (the active row), not row 3 + delta.
    expect(sel(m).extentRow).toBe(0);
    expect(sel(m).extentCol).toBe(3);
    expect(rect(m)).toEqual({ rowMin: 0, rowMax: 0, colMin: 0, colMax: 3 });
  });

  test("Shift+Home extends to the first column even when the extent is elsewhere", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 0, col: 0 },
      extent: { row: 2, col: 3 },
      focus: { row: 0, col: 0 },
    });
    m.dispatch({ type: "moveTo", row: 0, col: 0, extend: true });
    expect(sel(m).extentRow).toBe(0);
    expect(sel(m).extentCol).toBe(0);
  });

  test("Ctrl+End selects to the last cell", () => {
    const m = makeModel();
    m.dispatch({ type: "moveTo", row: 4, col: 3, extend: true });
    expect(rect(m)).toEqual({ rowMin: 0, rowMax: 4, colMin: 0, colMax: 3 });
  });
});

describe("scan (Enter / Tab)", () => {
  test("single cell: Enter is column-major and wraps to the next column", () => {
    const m = makeModel(); // 5 rows x 4 cols
    m.dispatch({ type: "selectCell", row: 4, col: 0 });
    m.dispatch({ type: "scan", axis: "v", forward: true });
    expect(sel(m).focusRow).toBe(0);
    expect(sel(m).focusCol).toBe(1);
  });

  test("single cell: Tab is row-major and wraps to the next row", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 3 });
    m.dispatch({ type: "scan", axis: "h", forward: true });
    expect(sel(m).focusRow).toBe(1);
    expect(sel(m).focusCol).toBe(0);
  });

  test("range: Tab cycles within the rectangle and wraps", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 1, col: 1 },
      extent: { row: 3, col: 3 },
      focus: { row: 1, col: 1 },
    });
    m.dispatch({ type: "scan", axis: "h", forward: true }); // -> (1,2)
    m.dispatch({ type: "scan", axis: "h", forward: true }); // -> (1,3)
    m.dispatch({ type: "scan", axis: "h", forward: true }); // -> (2,1) wrap
    expect(sel(m).focusRow).toBe(2);
    expect(sel(m).focusCol).toBe(1);
    // the rectangle did not move
    expect(rect(m)).toEqual({ rowMin: 1, rowMax: 3, colMin: 1, colMax: 3 });
  });

  test("range: Enter cycles within the rectangle and wraps", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 1, col: 1 },
      extent: { row: 3, col: 3 },
      focus: { row: 1, col: 1 },
    });
    m.dispatch({ type: "scan", axis: "v", forward: true }); // -> (2,1)
    m.dispatch({ type: "scan", axis: "v", forward: true }); // -> (3,1)
    m.dispatch({ type: "scan", axis: "v", forward: true }); // -> (1,2) wrap
    expect(sel(m).focusRow).toBe(1);
    expect(sel(m).focusCol).toBe(2);
  });

  test("Shift+Tab at the start of a range wraps to the end", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 1, col: 1 },
      extent: { row: 2, col: 2 },
      focus: { row: 1, col: 1 },
    });
    m.dispatch({ type: "scan", axis: "h", forward: false });
    expect(sel(m).focusRow).toBe(2);
    expect(sel(m).focusCol).toBe(2);
  });
});

describe("editing", () => {
  test("beginEdit collapses the selection, seeds text and flags select-all", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 0, col: 0 },
      extent: { row: 3, col: 3 },
      focus: { row: 2, col: 1 },
    });
    m.dispatch({ type: "beginEdit", seed: "x", selectAll: false });
    expect(m.getState().editing).toEqual({ row: 2, col: 1, text: "x", selectAll: false });
    // The rectangle is preserved; only the focus cell is being edited.
    expect(sel(m)).toEqual({ anchorRow: 0, anchorCol: 0, extentRow: 3, extentCol: 3, focusRow: 2, focusCol: 1 });
  });

  test("beginEdit seeds from the current value when no seed is given", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 1, col: 1 });
    m.dispatch({ type: "beginEdit", seed: null, selectAll: true });
    expect(m.getState().editing?.text).toBe("name-1");
  });

  test("beginEdit is a no-op on a computed (field-less) column", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 1, col: 3 });
    m.dispatch({ type: "beginEdit", seed: "9", selectAll: false });
    expect(m.getState().editing).toBe(null);
  });

  test("commitEdit coerces the value, writes it and reports the change", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 2 });
    m.dispatch({ type: "beginEdit", seed: "42.5", selectAll: false });
    const effects = m.dispatch({ type: "commitEdit" });
    expect(m.getState().view[0]?.amount).toBe(42.5);
    expect(m.getState().editing).toBe(null);
    expect(effects).toContainEqual({
      type: "edited",
      row: m.getState().view[0]!,
      rowIndex: 0,
      column: columns[2]!,
      value: 42.5,
      previous: 0,
    });
    expect(effects).toContainEqual({ type: "focusGrid" });
  });

  test("commitEdit with no change emits no `edited` effect", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 0 });
    m.dispatch({ type: "beginEdit", seed: null, selectAll: true });
    const effects = m.dispatch({ type: "commitEdit" });
    expect(effects.some((e) => e.type === "edited")).toBe(false);
  });

  test("commitEdit writes to the displayed row when sorted", () => {
    const m = makeModel();
    m.dispatch({ type: "sortColumn", columnId: "amount" });
    m.dispatch({ type: "sortColumn", columnId: "amount" }); // desc
    const topRow = m.getState().view[0]!;
    m.dispatch({ type: "selectCell", row: 0, col: 1 });
    m.dispatch({ type: "beginEdit", seed: "edited", selectAll: false });
    m.dispatch({ type: "commitEdit" });
    expect(topRow.name).toBe("edited");
  });

  test("cancelEdit discards the text", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 0 });
    m.dispatch({ type: "beginEdit", seed: "nope", selectAll: false });
    const effects = m.dispatch({ type: "cancelEdit" });
    expect(m.getState().editing).toBe(null);
    expect(m.getState().view[0]?.id).toBe("r0");
    expect(effects).toContainEqual({ type: "focusGrid" });
  });

  test("setEditText only updates an open editor", () => {
    const m = makeModel();
    expect(m.dispatch({ type: "setEditText", text: "x" })).toEqual([]);
    m.dispatch({ type: "beginEdit", seed: "", selectAll: false });
    m.dispatch({ type: "setEditText", text: "hello" });
    expect(m.getState().editing?.text).toBe("hello");
  });
});

describe("edit mode ends on navigation", () => {
  test("an open edit is committed before a scan (Enter/Tab)", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 1 });
    m.dispatch({ type: "beginEdit", seed: "typed", selectAll: false });

    const effects = m.dispatch({ type: "scan", axis: "v", forward: true });

    expect(m.getState().editing).toBe(null);
    expect(m.getState().view[0]?.name).toBe("typed");
    expect(sel(m).focusRow).toBe(1);
    // commit effects come first, then the navigation's reveal
    expect(effects.map((e) => e.type)).toEqual(["edited", "focusGrid", "reveal"]);
  });

  test("selectCell (a click) commits the open edit", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 2 });
    m.dispatch({ type: "beginEdit", seed: "9", selectAll: false });
    m.dispatch({ type: "selectCell", row: 2, col: 0 });
    expect(m.getState().view[0]?.amount).toBe(9);
    expect(m.getState().editing).toBe(null);
    expect(sel(m).focusRow).toBe(2);
  });

  test("a `move` command also ends edit mode", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 1 });
    m.dispatch({ type: "beginEdit", seed: "q", selectAll: false });
    m.dispatch({ type: "move", dr: 1, dc: 0, extend: false });
    expect(m.getState().editing).toBe(null);
    expect(m.getState().view[0]?.name).toBe("q");
  });

  test("sortColumn commits the open edit", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 1 });
    m.dispatch({ type: "beginEdit", seed: "zzz", selectAll: false });
    m.dispatch({ type: "sortColumn", columnId: "amount" });
    expect(m.getState().editing).toBe(null);
    expect(m.getState().view[0]?.name).toBe("zzz");
  });

  test("navigation with no open edit emits no commit effects", () => {
    const m = makeModel();
    const effects = m.dispatch({ type: "scan", axis: "v", forward: true });
    expect(effects.map((e) => e.type)).toEqual(["reveal"]);
  });

  test("editing commands themselves do not commit", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 0, col: 1 });
    m.dispatch({ type: "beginEdit", seed: "a", selectAll: false });
    m.dispatch({ type: "setEditText", text: "ab" });
    expect(m.getState().editing?.text).toBe("ab");
    expect(m.getState().view[0]?.name).toBe("name-0"); // not committed
  });

  test("replacing the data cancels without writing the pending text", () => {
    const m = makeModel(5);
    const original = m.getState().view[0]!;
    m.dispatch({ type: "selectCell", row: 0, col: 1 });
    m.dispatch({ type: "beginEdit", seed: "ignored", selectAll: false });
    m.dispatch({ type: "setRows", rows: makeRows(5) });
    expect(original.name).toBe("name-0");
    expect(m.getState().editing).toBe(null);
  });
});

describe("sorting", () => {
  test("cycles asc -> desc -> off and reorders the view", () => {
    const m = makeModel();
    const original = m.getState().view;
    m.dispatch({ type: "sortColumn", columnId: "amount" });
    expect(m.getState().sort).toEqual({ columnId: "amount", direction: "asc" });
    expect(m.getState().view.map((r) => r.amount)).toEqual([0, 1, 2, 3, 4]);
    expect(m.getState().view).not.toBe(original);
    m.dispatch({ type: "sortColumn", columnId: "amount" });
    expect(m.getState().view.map((r) => r.amount)).toEqual([4, 3, 2, 1, 0]);
    m.dispatch({ type: "sortColumn", columnId: "amount" });
    expect(m.getState().sort).toBe(null);
    expect(m.getState().view).toBe(original);
  });

  test("ignores unsortable columns", () => {
    const cols: ColumnDef<Row>[] = [{ id: "id", header: "ID", width: 100, field: "id", sortable: false }];
    const m = makeModel(3, cols);
    m.dispatch({ type: "sortColumn", columnId: "id" });
    expect(m.getState().sort).toBe(null);
  });

  test("computeView leaves the source array untouched", () => {
    const rows = makeRows(3);
    const view = computeView(rows, columns, { columnId: "amount", direction: "desc" });
    expect(rows.map((r) => r.amount)).toEqual([0, 1, 2]);
    expect(view.map((r) => r.amount)).toEqual([2, 1, 0]);
  });
});

describe("column widths", () => {
  test("clamps to min/max and ignores no-op changes", () => {
    const cols: ColumnDef<Row>[] = [{ id: "id", header: "ID", width: 100, minWidth: 80, maxWidth: 200, field: "id" }];
    const m = makeModel(3, cols);
    m.dispatch({ type: "setColumnWidth", col: 0, width: 10 });
    expect(m.getState().widths[0]).toBe(80);
    m.dispatch({ type: "setColumnWidth", col: 0, width: 9999 });
    expect(m.getState().widths[0]).toBe(200);
    const before = m.getState().widths;
    m.dispatch({ type: "setColumnWidth", col: 0, width: 200 });
    expect(m.getState().widths).toBe(before);
  });
});

describe("clearCells", () => {
  test("nulls the editable cells of the rectangle only", () => {
    const m = makeModel();
    m.dispatch({
      type: "selectRange",
      anchor: { row: 0, col: 0 },
      extent: { row: 1, col: 1 },
      focus: { row: 0, col: 0 },
    });
    m.dispatch({ type: "clearCells" });
    const view = m.getState().view;
    const raw = (r: number) => view[r] as unknown as Record<string, unknown>;
    expect(raw(0)["id"]).toBe(null);
    expect(raw(0)["name"]).toBe(null);
    expect(raw(1)["id"]).toBe(null);
    expect(raw(1)["name"]).toBe(null);
    // untouched
    expect(view[2]?.id).toBe("r2");
    expect(view[0]?.amount).toBe(0);
  });
});

describe("paste", () => {
  test("writes a TSV block from the focus cell, coercing types", () => {
    const m = makeModel();
    m.dispatch({ type: "selectCell", row: 1, col: 0 });
    m.dispatch({ type: "paste", text: "a\tb\t7\nc\td\t8" });
    const view = m.getState().view;
    expect(view[1]?.id).toBe("a");
    expect(view[1]?.name).toBe("b");
    expect(view[1]?.amount).toBe(7);
    expect(view[2]?.id).toBe("c");
    expect(view[2]?.amount).toBe(8);
  });

  test("clips writes that run past the grid and skips read-only columns", () => {
    const m = makeModel(2, columns);
    m.dispatch({ type: "selectCell", row: 1, col: 2 });
    // second line targets row 2, which does not exist -> clipped
    m.dispatch({ type: "paste", text: "7\n9" });
    expect(m.getState().view[1]?.amount).toBe(7);

    // column 3 is computed (no `field`) -> must not gain a stored property
    m.dispatch({ type: "selectCell", row: 0, col: 3 });
    m.dispatch({ type: "paste", text: "42" });
    expect((m.getState().view[0] as unknown as Record<string, unknown>)["double"]).toBeUndefined();
  });
});

describe("data changes", () => {
  test("setRows clamps the selection into the new bounds", () => {
    const m = makeModel(10);
    m.dispatch({ type: "selectCell", row: 9, col: 3 });
    m.dispatch({ type: "setRows", rows: makeRows(3) });
    expect(sel(m).focusRow).toBe(2);
    expect(m.getState().view.length).toBe(3);
  });

  test("setColumns resets widths only when the shape changes", () => {
    const m = makeModel();
    const before = m.getState().widths;
    m.dispatch({ type: "setColumns", columns: [...columns] });
    expect(m.getState().widths).toBe(before);
    m.dispatch({ type: "setColumns", columns: [columns[0]!] });
    expect(m.getState().widths).toEqual([100]);
  });

  test("setRows cancels an open editor (its row may no longer exist)", () => {
    const m = makeModel(5);
    m.dispatch({ type: "selectCell", row: 4, col: 0 });
    m.dispatch({ type: "beginEdit", seed: "x", selectAll: false });
    m.dispatch({ type: "setRows", rows: makeRows(2) });
    expect(m.getState().editing).toBe(null);
  });

  test("setColumns cancels an open editor (its column may no longer exist)", () => {
    const m = makeModel(5);
    m.dispatch({ type: "selectCell", row: 0, col: 2 });
    m.dispatch({ type: "beginEdit", seed: "x", selectAll: false });
    m.dispatch({ type: "setColumns", columns: [columns[0]!] });
    expect(m.getState().editing).toBe(null);
  });
});

describe("model subscription", () => {
  test("notifies listeners and can unsubscribe", () => {
    const m = makeModel();
    let calls = 0;
    const off = m.subscribe(() => {
      calls += 1;
    });
    m.dispatch({ type: "selectCell", row: 1, col: 1 });
    m.dispatch({ type: "selectCell", row: 1, col: 1 }); // same cell -> still notifies (fresh state object)
    expect(calls).toBe(2);
    off();
    m.dispatch({ type: "selectCell", row: 2, col: 2 });
    expect(calls).toBe(2);
  });
});

// A guard against silently dropping commands as the union grows.
test("every command type is handled without throwing", () => {
  const m = makeModel();
  const commands: Command<Row>[] = [
    { type: "selectCell", row: 1, col: 1 },
    { type: "selectRange", anchor: { row: 0, col: 0 }, extent: { row: 1, col: 1 }, focus: { row: 0, col: 0 } },
    { type: "selectRow", row: 1 },
    { type: "selectAll" },
    { type: "move", dr: 1, dc: 0, extend: false },
    { type: "moveTo", row: 0, col: 0, extend: false },
    { type: "scan", axis: "v", forward: true },
    { type: "beginEdit", seed: "1", selectAll: false },
    { type: "setEditText", text: "2" },
    { type: "commitEdit" },
    { type: "cancelEdit" },
    { type: "sortColumn", columnId: "amount" },
    { type: "setColumnWidth", col: 0, width: 120 },
    { type: "clearCells" },
    { type: "paste", text: "x" },
    { type: "setRows", rows: makeRows(4) },
    { type: "setColumns", columns },
  ];
  for (const command of commands) {
    expect(() => m.dispatch(command)).not.toThrow();
  }
});

describe("invariants under random command sequences", () => {
  test("focus stays inside the rectangle, cells stay in bounds, edits stay valid", () => {
    const ROWS = 7;
    const COLS = columns.length;
    const m = makeModel(ROWS, columns);

    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const int = (span: number) => Math.floor(rnd() * span) - 1; // sometimes out of range on purpose

    for (let step = 0; step < 4000; step++) {
      const commands: Command<Row>[] = [
        { type: "move", dr: int(5), dc: int(5), extend: rnd() < 0.5 },
        { type: "moveTo", row: int(9), col: int(6), extend: rnd() < 0.5 },
        { type: "scan", axis: rnd() < 0.5 ? "h" : "v", forward: rnd() < 0.5 },
        { type: "selectCell", row: int(9), col: int(6) },
        { type: "selectRow", row: int(9) },
        { type: "selectAll" },
        {
          type: "selectRange",
          anchor: { row: int(9), col: int(6) },
          extent: { row: int(9), col: int(6) },
          focus: { row: int(9), col: int(6) },
        },
        { type: "beginEdit", seed: "3", selectAll: false },
        { type: "setEditText", text: "5" },
        { type: "commitEdit" },
        { type: "cancelEdit" },
        { type: "clearCells" },
        { type: "sortColumn", columnId: "amount" },
        { type: "setColumnWidth", col: Math.floor(rnd() * COLS), width: Math.floor(rnd() * 400) },
      ];
      m.dispatch(commands[Math.floor(rnd() * commands.length)]!);

      const state = m.getState();
      const r = normalizeSelection(state.selection);
      const vertical = [state.selection.anchorRow, state.selection.extentRow, state.selection.focusRow];
      const horizontal = [state.selection.anchorCol, state.selection.extentCol, state.selection.focusCol];
      for (const value of vertical) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(ROWS);
      }
      for (const value of horizontal) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(COLS);
      }
      expect(state.selection.focusRow).toBeGreaterThanOrEqual(r.rowMin);
      expect(state.selection.focusRow).toBeLessThanOrEqual(r.rowMax);
      expect(state.selection.focusCol).toBeGreaterThanOrEqual(r.colMin);
      expect(state.selection.focusCol).toBeLessThanOrEqual(r.colMax);
      if (state.editing) {
        expect(state.editing.row).toBeGreaterThanOrEqual(0);
        expect(state.editing.row).toBeLessThan(ROWS);
        expect(state.editing.col).toBeGreaterThanOrEqual(0);
        expect(state.editing.col).toBeLessThan(COLS);
      }
    }
  });
});
