import { describe, expect, test } from "bun:test";

import { buildCellUpdate, buildCreateView, quoteIdentifier, sqlLiteral } from "../sql";

describe("quoteIdentifier", () => {
  test("wraps the name and escapes embedded quotes", () => {
    expect(quoteIdentifier("sales")).toBe('"sales"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });
});

describe("sqlLiteral", () => {
  test("renders null and undefined as NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
  });

  test("renders numbers and booleans", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(1.5)).toBe("1.5");
    expect(sqlLiteral(Number.NaN)).toBe("NULL");
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(sqlLiteral(false)).toBe("FALSE");
  });

  test("quotes strings and escapes single quotes", () => {
    expect(sqlLiteral("Refunded")).toBe("'Refunded'");
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  test("renders dates as ISO strings", () => {
    expect(sqlLiteral(new Date("2024-01-02T03:04:05.000Z"))).toBe("'2024-01-02T03:04:05.000Z'");
  });
});

describe("buildCellUpdate", () => {
  test("builds UPDATE ... SET ... WHERE <pk> = <pkValue>", () => {
    expect(
      buildCellUpdate({
        relation: "test",
        primaryKey: "id",
        primaryKeyValue: "SO-100000",
        column: "status",
        value: "Refunded",
      }),
    ).toBe(`UPDATE "test" SET "status" = 'Refunded' WHERE "id" = 'SO-100000'`);
  });

  test("handles numeric values and keys", () => {
    expect(
      buildCellUpdate({
        relation: "sales",
        primaryKey: "id",
        primaryKeyValue: "S-100000",
        column: "units",
        value: 12,
      }),
    ).toBe(`UPDATE "sales" SET "units" = 12 WHERE "id" = 'S-100000'`);
  });

  test("handles a NULL value", () => {
    expect(
      buildCellUpdate({
        relation: "products",
        primaryKey: "id",
        primaryKeyValue: "P-1000",
        column: "category",
        value: null,
      }),
    ).toBe(`UPDATE "products" SET "category" = NULL WHERE "id" = 'P-1000'`);
  });
});

describe("buildCreateView", () => {
  test("wraps a query as a named view", () => {
    expect(buildCreateView("cheap", `SELECT * FROM "products"`)).toBe(
      `CREATE OR REPLACE VIEW "cheap" AS SELECT * FROM "products"`,
    );
  });

  test("trims whitespace and a trailing semicolon", () => {
    expect(buildCreateView("  top  ", `  FROM "sales" LIMIT 5;  `)).toBe(
      `CREATE OR REPLACE VIEW "top" AS FROM "sales" LIMIT 5`,
    );
  });

  test("quotes a name containing a double quote", () => {
    expect(buildCreateView('we"ird', "FROM t")).toBe(`CREATE OR REPLACE VIEW "we""ird" AS FROM t`);
  });
});
