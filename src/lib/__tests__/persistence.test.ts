import { describe, expect, test } from "bun:test";

import {
  buildTableStatements,
  copyToParquetStatement,
  parquetFile,
  parseStatements,
  parseViewStatement,
  serializeViewStatements,
} from "../persistence";

describe("parquetFile", () => {
  test("appends a .parquet extension", () => {
    expect(parquetFile("sales")).toBe("sales.parquet");
  });
});

describe("copyToParquetStatement", () => {
  test("builds a COPY ... TO parquet statement", () => {
    expect(copyToParquetStatement("sales")).toBe(`COPY "sales" TO 'sales.parquet' (FORMAT PARQUET)`);
  });
});

describe("buildTableStatements", () => {
  test("recreates each table from its parquet file", () => {
    expect(buildTableStatements(["sales", "products"])).toEqual([
      `CREATE OR REPLACE TABLE "sales" AS SELECT * FROM read_parquet('sales.parquet')`,
      `CREATE OR REPLACE TABLE "products" AS SELECT * FROM read_parquet('products.parquet')`,
    ]);
  });
});

describe("serializeViewStatements + parseStatements", () => {
  test("one statement per line, inner newlines collapsed to spaces", () => {
    const text = serializeViewStatements([
      "CREATE VIEW a AS SELECT 1\nFROM t\nWHERE x > 0;",
      "CREATE VIEW b AS SELECT * FROM t;",
    ]);
    expect(text).toBe("CREATE VIEW a AS SELECT 1 FROM t WHERE x > 0;\nCREATE VIEW b AS SELECT * FROM t;");
    expect(parseStatements(text)).toHaveLength(2);
  });

  test("parseStatements ignores blank lines", () => {
    expect(parseStatements("a;\n\n  \nb;")).toEqual(["a;", "b;"]);
  });
});

describe("parseViewStatement", () => {
  test("extracts name and query from a simple-named view", () => {
    expect(parseViewStatement("CREATE VIEW big AS SELECT region FROM sales GROUP BY 1;")).toEqual({
      name: "big",
      query: "SELECT region FROM sales GROUP BY 1",
    });
  });

  test("handles a quoted name and CREATE OR REPLACE", () => {
    expect(parseViewStatement(`CREATE OR REPLACE VIEW "top sales" AS FROM "sales" LIMIT 5`)).toEqual({
      name: "top sales",
      query: `FROM "sales" LIMIT 5`,
    });
  });

  test("returns null for a non-view statement", () => {
    expect(parseViewStatement("CREATE TABLE t(a INTEGER);")).toBe(null);
  });
});
