import * as arrow from "apache-arrow";
import { describe, expect, test } from "bun:test";

import { columnKeys, columnType, columnsFromArrow, humanize, resultSetFromArrow, rowsFromArrow } from "../arrow";

/**
 * A tiny table exercising the scalar types DuckDB emits for a CSV: `bigint`
 * arrives for 64-bit ints, `Timestamp` for the date column.
 */
function sampleTable(): arrow.Table {
  return arrow.tableFromArrays({
    id: ["SO-1", "SO-2"],
    units: [1n, 2n],
    unitPrice: [1.5, 2.25],
    rush: [true, false],
    orderedAt: [new Date("2024-01-01T00:00:00Z"), new Date("2024-02-02T00:00:00Z")],
  });
}

describe("columnType", () => {
  test("maps numeric/boolean/temporal Arrow types", () => {
    expect(columnType(new arrow.Int64())).toBe("integer");
    expect(columnType(new arrow.Uint32())).toBe("integer");
    expect(columnType(new arrow.Float64())).toBe("number");
    expect(columnType(new arrow.Decimal(10, 2))).toBe("number");
    expect(columnType(new arrow.Bool())).toBe("boolean");
    expect(columnType(new arrow.Timestamp(arrow.TimeUnit.MILLISECOND))).toBe("date");
    expect(columnType(new arrow.DateDay())).toBe("date");
  });

  test("falls back to text for strings", () => {
    expect(columnType(new arrow.Utf8())).toBe("text");
  });
});

describe("humanize", () => {
  test("splits camelCase, snake_case and kebab-case", () => {
    expect(humanize("unitPrice")).toBe("Unit Price");
    expect(humanize("unit_price")).toBe("Unit Price");
    expect(humanize("ordered-at")).toBe("Ordered At");
    expect(humanize("id")).toBe("Id");
  });
});

describe("columnsFromArrow", () => {
  test("widens columns to fit the header and wires the field accessor", () => {
    const columns = columnsFromArrow(sampleTable().schema);
    expect(columns.map((c) => c.id)).toEqual(["id", "units", "unitPrice", "rush", "orderedAt"]);
    expect(columns.map((c) => c.header)).toEqual(["Id", "Units", "Unit Price", "Rush", "Ordered At"]);
    expect(columns.map((c) => c.field)).toEqual(["id", "units", "unitPrice", "rush", "orderedAt"]);
    expect(columns.every((c) => c.width > 0)).toBe(true);
    // A wider header must widen its column.
    const units = columns.find((c) => c.id === "units")!;
    const orderedAt = columns.find((c) => c.id === "orderedAt")!;
    expect(orderedAt.width).toBeGreaterThan(units.width);
  });
});

describe("rowsFromArrow", () => {
  test("normalises bigint to number and keeps primitives", () => {
    const rows = rowsFromArrow(sampleTable());
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe("SO-1");
    expect(typeof rows[0]!.units).toBe("number");
    expect(rows[0]!.units).toBe(1);
    expect(rows[0]!.unitPrice).toBe(1.5);
    expect(rows[0]!.rush).toBe(true);
    expect(typeof rows[0]!.orderedAt).toBe("number");
  });
});

describe("resultSetFromArrow", () => {
  test("returns columns and rows together", () => {
    const { columns, rows } = resultSetFromArrow(sampleTable());
    expect(columns).toHaveLength(5);
    expect(rows).toHaveLength(2);
  });
});

describe("read-only columns (query views)", () => {
  test("carry no `field` but still resolve values through getValue", () => {
    const table = sampleTable();
    const columns = columnsFromArrow(table.schema, { readOnly: true });
    const rows = rowsFromArrow(table);
    for (const column of columns) {
      // No `field` is the grid's read-only marker: beginEdit/paste skip it.
      expect(column.field).toBeUndefined();
      expect(typeof column.getValue).toBe("function");
    }
    const id = columns.find((c) => c.id === "id")!;
    expect(id.getValue?.(rows[0]!, 0)).toBe("SO-1");
    const units = columns.find((c) => c.id === "units")!;
    expect(units.getValue?.(rows[0]!, 0)).toBe(1);
  });

  test("resultSetFromArrow forwards the readOnly option", () => {
    const { columns } = resultSetFromArrow(sampleTable(), { readOnly: true });
    expect(columns.every((c) => c.field === undefined && c.getValue !== undefined)).toBe(true);
  });
});

describe("duplicate column names", () => {
  /** Arrow table with two columns both named "id" (like `SELECT *, productid AS id`). */
  function duplicateTable(): arrow.Table {
    const salesIds = arrow.vectorFromArray(["S-1", "S-2"], new arrow.Utf8());
    const productIds = arrow.vectorFromArray(["P-1", "P-2"], new arrow.Utf8());
    const fields = [new arrow.Field("id", new arrow.Utf8()), new arrow.Field("id", new arrow.Utf8())];
    const schema = new arrow.Schema(fields);
    const data = arrow.makeData<arrow.Struct<any>>({
      type: new arrow.Struct(fields),
      length: 2,
      children: [salesIds.data[0]!, productIds.data[0]!],
    });
    return new arrow.Table(schema, new arrow.RecordBatch(schema, data));
  }

  test("columnKeys gives each duplicate a unique key", () => {
    const keys = columnKeys(duplicateTable().schema);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  test("each column keeps its own values instead of overwriting", () => {
    const table = duplicateTable();
    const columns = columnsFromArrow(table.schema, { readOnly: true });
    const rows = rowsFromArrow(table);

    // Both headers stay "Id" but the ids (and values) are distinct.
    expect(columns.map((c) => c.header)).toEqual(["Id", "Id"]);
    expect(new Set(columns.map((c) => c.id)).size).toBe(2);
    expect(columns[0]!.getValue?.(rows[0]!, 0)).toBe("S-1");
    expect(columns[1]!.getValue?.(rows[0]!, 0)).toBe("P-1");
    expect(columns[0]!.getValue?.(rows[1]!, 1)).toBe("S-2");
    expect(columns[1]!.getValue?.(rows[1]!, 1)).toBe("P-2");
  });
});
