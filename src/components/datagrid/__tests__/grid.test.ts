import { describe, expect, test } from "bun:test";

import { compareValues, formatCell, parseEditedValue, resolveValue } from "../format";
import { anchorAt, Axis, scrollForAnchor } from "../layout";
import { fullGrid, scanCell } from "../navigation";
import { clampToRect, normalizeSelection, singleCellSelection } from "../types";
import type { ColumnDef } from "../types";

describe("Axis.uniform", () => {
  const axis = Axis.uniform(100, 28);

  test("computes total size", () => {
    expect(axis.total).toBe(2800);
    expect(axis.count).toBe(100);
  });

  test("maps index -> offset", () => {
    expect(axis.offsetOf(0)).toBe(0);
    expect(axis.offsetOf(10)).toBe(280);
    expect(axis.offsetOf(100)).toBe(2800);
    // clamped
    expect(axis.offsetOf(-5)).toBe(0);
    expect(axis.offsetOf(1_000)).toBe(2800);
  });

  test("maps pixel -> index", () => {
    expect(axis.indexAt(0)).toBe(0);
    expect(axis.indexAt(27)).toBe(0);
    expect(axis.indexAt(28)).toBe(1);
    expect(axis.indexAt(2799)).toBe(99);
    expect(axis.indexAt(99999)).toBe(99);
  });

  test("visibleRange matches viewport and overscan", () => {
    // 300px tall viewport starting at 0 -> rows 0..10 inclusive (11 rows).
    expect(axis.visibleRange(0, 300)).toEqual({ start: 0, end: 11 });
    // 1 row of overscan on each side.
    expect(axis.visibleRange(280, 280, 1)).toEqual({ start: 9, end: 22 });
    // Clamped at the end of the axis.
    expect(axis.visibleRange(2800, 300)).toEqual({ start: 99, end: 100 });
  });
});

describe("Axis.variable", () => {
  const axis = Axis.variable([100, 50, 200]);

  test("prefix sums", () => {
    expect(axis.total).toBe(350);
    expect(axis.offsetOf(1)).toBe(100);
    expect(axis.offsetOf(2)).toBe(150);
    expect(axis.offsetOf(3)).toBe(350);
    expect(axis.sizeOf(2)).toBe(200);
  });

  test("binary-searches the containing index", () => {
    expect(axis.indexAt(-1)).toBe(0);
    expect(axis.indexAt(0)).toBe(0);
    expect(axis.indexAt(99)).toBe(0);
    expect(axis.indexAt(100)).toBe(1);
    expect(axis.indexAt(149)).toBe(1);
    expect(axis.indexAt(150)).toBe(2);
    expect(axis.indexAt(349)).toBe(2);
    expect(axis.indexAt(400)).toBe(2);
  });
});

describe("normalizeSelection", () => {
  test("bounds anchor/extent into a rect", () => {
    expect(
      normalizeSelection({ anchorRow: 5, anchorCol: 3, extentRow: 2, extentCol: 7, focusRow: 4, focusCol: 4 }),
    ).toEqual({
      rowMin: 2,
      rowMax: 5,
      colMin: 3,
      colMax: 7,
    });
  });

  test("focus does not influence the rectangle", () => {
    const rect = normalizeSelection({
      anchorRow: 0,
      anchorCol: 0,
      extentRow: 3,
      extentCol: 3,
      focusRow: 1,
      focusCol: 2,
    });
    expect(rect).toEqual({ rowMin: 0, rowMax: 3, colMin: 0, colMax: 3 });
  });
});

describe("clampToRect", () => {
  const rect = { rowMin: 2, rowMax: 5, colMin: 3, colMax: 7 };

  test("keeps a cell inside the rect", () => {
    expect(clampToRect(rect, 4, 4)).toEqual({ row: 4, col: 4 });
  });

  test("pulls an outside cell to the nearest edge", () => {
    expect(clampToRect(rect, 0, 0)).toEqual({ row: 2, col: 3 });
    expect(clampToRect(rect, 9, 9)).toEqual({ row: 5, col: 7 });
  });
});

describe("singleCellSelection", () => {
  test("collapses anchor, extent and focus", () => {
    expect(singleCellSelection(4, 2)).toEqual({
      anchorRow: 4,
      anchorCol: 2,
      extentRow: 4,
      extentCol: 2,
      focusRow: 4,
      focusCol: 2,
    });
  });
});

describe("scanCell within a range", () => {
  const rect = { rowMin: 0, rowMax: 2, colMin: 0, colMax: 2 };

  test("Tab scans row-major and wraps to the next row", () => {
    expect(scanCell(rect, { row: 0, col: 2 }, "h", true)).toEqual({ row: 1, col: 0 });
    expect(scanCell(rect, { row: 2, col: 2 }, "h", true)).toEqual({ row: 0, col: 0 });
  });

  test("Shift+Tab scans backwards and wraps to the previous row", () => {
    expect(scanCell(rect, { row: 1, col: 0 }, "h", false)).toEqual({ row: 0, col: 2 });
    expect(scanCell(rect, { row: 0, col: 0 }, "h", false)).toEqual({ row: 2, col: 2 });
  });

  test("Enter scans column-major and wraps to the next column", () => {
    expect(scanCell(rect, { row: 2, col: 0 }, "v", true)).toEqual({ row: 0, col: 1 });
    expect(scanCell(rect, { row: 2, col: 2 }, "v", true)).toEqual({ row: 0, col: 0 });
  });

  test("Shift+Enter scans backwards and wraps to the previous column", () => {
    expect(scanCell(rect, { row: 0, col: 1 }, "v", false)).toEqual({ row: 2, col: 0 });
    expect(scanCell(rect, { row: 0, col: 0 }, "v", false)).toEqual({ row: 2, col: 2 });
  });
});

describe("scanCell across the whole grid (single cell)", () => {
  const grid = fullGrid(4, 3); // 4 columns, 3 rows

  test("Tab is row-major and wraps rows", () => {
    expect(scanCell(grid, { row: 0, col: 0 }, "h", true)).toEqual({ row: 0, col: 1 });
    expect(scanCell(grid, { row: 0, col: 3 }, "h", true)).toEqual({ row: 1, col: 0 });
    expect(scanCell(grid, { row: 2, col: 3 }, "h", true)).toEqual({ row: 0, col: 0 });
  });

  test("Enter is column-major and wraps columns", () => {
    expect(scanCell(grid, { row: 2, col: 0 }, "v", true)).toEqual({ row: 0, col: 1 });
    expect(scanCell(grid, { row: 0, col: 1 }, "v", false)).toEqual({ row: 2, col: 0 });
  });
});

interface Order {
  amount: number;
  ratio: number;
  label: string;
  when: Date;
}

describe("formatCell", () => {
  const row: Order = {
    amount: 1234.5,
    ratio: 0.1234,
    label: "Paid",
    when: new Date(Date.UTC(2023, 0, 15)),
  };

  test("currency", () => {
    const col: ColumnDef<Order> = { id: "a", header: "A", width: 100, type: "currency", field: "amount" };
    expect(formatCell(col, resolveValue(col, row, 0), row, 0)).toBe("$1,234.50");
  });

  test("percent", () => {
    const col: ColumnDef<Order> = { id: "r", header: "R", width: 100, type: "percent", field: "ratio" };
    expect(formatCell(col, resolveValue(col, row, 0), row, 0)).toBe("12.3%");
  });

  test("integer rounds", () => {
    const col: ColumnDef<{ n: number }> = { id: "n", header: "N", width: 100, type: "integer", field: "n" };
    const r = { n: 1234.7 };
    expect(formatCell(col, resolveValue(col, r, 0), r, 0)).toBe("1,235");
  });

  test("date contains the year", () => {
    const col: ColumnDef<Order> = { id: "w", header: "W", width: 100, type: "date", field: "when" };
    expect(formatCell(col, resolveValue(col, row, 0), row, 0)).toContain("2023");
  });

  test("empty values render blank", () => {
    const col: ColumnDef<{ a: string | null }> = { id: "a", header: "A", width: 100, type: "text", field: "a" };
    const r = { a: null };
    expect(formatCell(col, resolveValue(col, r, 0), r, 0)).toBe("");
  });
});

describe("parseEditedValue", () => {
  const currency: ColumnDef<{ x: unknown }> = { id: "c", header: "C", width: 100, type: "currency" };
  const integer: ColumnDef<{ x: unknown }> = { id: "i", header: "I", width: 100, type: "integer" };
  const boolean: ColumnDef<{ x: unknown }> = { id: "b", header: "B", width: 100, type: "boolean" };
  const text: ColumnDef<{ x: unknown }> = { id: "t", header: "T", width: 100, type: "text" };

  test("parses currency text to a number", () => {
    expect(parseEditedValue(currency, "$1,234.50")).toBe(1234.5);
  });

  test("rounds integers", () => {
    expect(parseEditedValue(integer, "42.7")).toBe(43);
  });

  test("parses booleans", () => {
    expect(parseEditedValue(boolean, "yes")).toBe(true);
    expect(parseEditedValue(boolean, "no")).toBe(false);
  });

  test("empty becomes null", () => {
    expect(parseEditedValue(text, "   ")).toBe(null);
  });

  test("text is preserved verbatim", () => {
    expect(parseEditedValue(text, "  hello  ")).toBe("  hello  ");
  });
});

describe("compareValues", () => {
  test("numbers sort numerically", () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
  });

  test("blanks sort first", () => {
    expect(compareValues(null, 5)).toBeLessThan(0);
    expect(compareValues(5, null)).toBeGreaterThan(0);
    expect(compareValues(null, null)).toBe(0);
  });

  test("strings use natural ordering", () => {
    expect(compareValues("item2", "item10")).toBeLessThan(0);
  });

  test("dates compare by time", () => {
    expect(compareValues(new Date(0), new Date(1000))).toBeLessThan(0);
  });
});

describe("viewport anchor", () => {
  const uniform = Axis.uniform(1000, 28);

  test("captures the origin cell and the sub-cell offset", () => {
    const anchor = anchorAt(Axis.uniform(10, 100), uniform, 250, 100);
    expect(anchor.col).toBe(2);
    expect(anchor.dx).toBe(50);
    expect(anchor.row).toBe(3);
    expect(anchor.dy).toBe(16);
  });

  test("round-trips to the same offsets when the axes are unchanged", () => {
    const cols = Axis.variable([100, 160, 120, 100]);
    const anchor = anchorAt(cols, uniform, 130, 100);
    const { x, y } = scrollForAnchor(anchor, cols, uniform, 200, 200);
    expect(x).toBe(130);
    expect(y).toBe(100);
  });

  test("pins the same cell when columns widen", () => {
    const before = Axis.variable([100, 100, 100, 100]);
    const after = Axis.variable([200, 200, 200, 200]);
    const anchor = anchorAt(before, uniform, 150, 0); // col 1, dx 50
    expect(anchor.col).toBe(1);
    expect(anchor.dx).toBe(50);
    // Col 1 now starts at 200, plus the 50px into the cell.
    expect(scrollForAnchor(anchor, after, uniform, 500, 500).x).toBe(250);
  });

  test("clamps to the new content when it shrinks below the anchor", () => {
    const before = Axis.variable([100, 100, 100, 100]);
    const after = Axis.variable([100, 100]);
    const anchor = anchorAt(before, uniform, 350, 0); // col 3
    // Col 3 no longer exists -> nearest (col 1) and clamp to maxScroll 0.
    expect(scrollForAnchor(anchor, after, uniform, 500, 500).x).toBe(0);
  });

  test("never returns a negative offset", () => {
    const anchor = { row: 0, col: 0, dx: -40, dy: -10 };
    expect(scrollForAnchor(anchor, uniform, uniform, 500, 500)).toEqual({ x: 0, y: 0 });
  });
});

