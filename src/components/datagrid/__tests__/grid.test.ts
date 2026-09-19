import { describe, expect, test } from "bun:test";

import { compareValues, formatCell, parseEditedValue, resolveValue } from "../format";
import { Axis } from "../layout";
import { fullGrid, scanCell } from "../navigation";
import { computeThumb, dragScroll, thumbToScroll } from "../scrollbar";
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

describe("computeThumb", () => {
  test("proportional thumb plus travel range", () => {
    const m = computeThumb(500, 5000, 0, 28);
    expect(m.thumb).toBe(50);
    expect(m.maxScroll).toBe(4500);
    expect(m.travel).toBe(450);
    expect(m.position).toBe(0);
  });

  test("position tracks scroll across the whole travel", () => {
    expect(computeThumb(500, 5000, 2250, 28).position).toBe(225);
    expect(computeThumb(500, 5000, 4500, 28).position).toBe(450);
  });

  test("no overflow -> full-length thumb, zero travel", () => {
    const m = computeThumb(500, 400, 0, 28);
    expect(m.thumb).toBe(500);
    expect(m.travel).toBe(0);
    expect(m.maxScroll).toBe(0);
    expect(m.position).toBe(0);
  });

  test("min thumb keeps huge datasets grabbable", () => {
    // 500/100000 * 500 = 2.5px -> clamped up to 28px.
    expect(computeThumb(500, 100_000, 0, 28).thumb).toBe(28);
  });

  test("thumb never exceeds the viewport", () => {
    expect(computeThumb(20, 1000, 0, 28).thumb).toBe(20);
  });

  test("clamps out-of-range scroll", () => {
    expect(computeThumb(500, 5000, 99999, 28).position).toBe(450);
    expect(computeThumb(500, 5000, -50, 28).position).toBe(0);
  });
});

describe("thumbToScroll", () => {
  test("maps thumb position back to scroll", () => {
    expect(thumbToScroll(225, 450, 4500)).toBe(2250);
    expect(thumbToScroll(450, 450, 4500)).toBe(4500);
  });

  test("clamps out-of-range positions", () => {
    expect(thumbToScroll(-100, 450, 4500)).toBe(0);
    expect(thumbToScroll(9999, 450, 4500)).toBe(4500);
  });

  test("degenerate travel does nothing", () => {
    expect(thumbToScroll(100, 0, 4500)).toBe(0);
  });
});

describe("dragScroll", () => {
  test("scales the pixel delta by content ratio", () => {
    // travel 450px represents 4500px of content -> 1px drag = 10px scroll.
    expect(dragScroll(0, 45, 450, 4500)).toBe(450);
    expect(dragScroll(1000, 45, 450, 4500)).toBe(1450);
  });

  test("clamps to the scrollable range", () => {
    expect(dragScroll(0, -1000, 450, 4500)).toBe(0);
    expect(dragScroll(0, 99999, 450, 4500)).toBe(4500);
  });

  test("degenerate travel keeps the start offset", () => {
    expect(dragScroll(120, 50, 0, 4500)).toBe(120);
  });
});
