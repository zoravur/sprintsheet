import { describe, expect, test } from "bun:test";

import { compareValues, formatCell, parseEditedValue, resolveValue } from "../format";
import { Axis } from "../layout";
import { normalizeSelection } from "../types";
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
  test("orders anchor/focus into a rect", () => {
    expect(normalizeSelection({ anchorRow: 5, anchorCol: 3, focusRow: 2, focusCol: 7 })).toEqual({
      rowMin: 2,
      rowMax: 5,
      colMin: 3,
      colMax: 7,
    });
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
