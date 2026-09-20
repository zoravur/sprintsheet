import { describe, expect, test } from "bun:test";

import {
  copyToParquetStatement,
  createTableFromCsvStatement,
  createTableFromParquetStatement,
  createViewStatement,
  selectAllFrom,
  selectIdentifier,
  updateCellStatement,
} from "../sql";

describe("selectAllFrom", () => {
  test("builds a SELECT * FROM <relation> node", () => {
    expect(selectAllFrom("my table").node).toMatchObject({
      type: "SELECT_NODE",
      select_list: [{ class: "STAR", type: "STAR" }],
      from_table: { type: "BASE_TABLE", table_name: "my table" },
    });
  });

  test("emits empty maps in DuckDB's wire form (an empty array)", () => {
    const statement = selectAllFrom("t") as unknown as {
      node: { cte_map: { map: unknown } };
      named_param_map: unknown;
    };
    expect(statement.node.cte_map.map).toEqual([]);
    expect(statement.named_param_map).toEqual([]);
  });
});

describe("selectIdentifier", () => {
  test("builds a single-column SELECT over an empty FROM", () => {
    expect(selectIdentifier("my col").node).toMatchObject({
      type: "SELECT_NODE",
      select_list: [{ class: "COLUMN_REF", column_names: ["my col"] }],
      from_table: { type: "EMPTY" },
    });
  });
});

describe("canned statements", () => {
  test("updateCellStatement binds values and takes quoted identifiers", () => {
    expect(updateCellStatement('"sales"', '"units"', '"id"')).toBe(
      `UPDATE "sales" SET "units" = ? WHERE "id" = ?`,
    );
  });

  test("createViewStatement wraps the user's query", () => {
    expect(createViewStatement('"top"', "SELECT * FROM t")).toBe(
      `CREATE OR REPLACE VIEW "top" AS SELECT * FROM t`,
    );
  });

  test("copyToParquetStatement binds the destination file", () => {
    expect(copyToParquetStatement('"sales"')).toBe(`COPY "sales" TO ? (FORMAT PARQUET)`);
  });

  test("createTableFromCsvStatement binds the CSV path", () => {
    expect(createTableFromCsvStatement('"sales"')).toBe(
      `CREATE OR REPLACE TABLE "sales" AS SELECT * FROM read_csv_auto(?)`,
    );
  });

  test("createTableFromParquetStatement binds the Parquet path", () => {
    expect(createTableFromParquetStatement('"sales"')).toBe(
      `CREATE OR REPLACE TABLE "sales" AS SELECT * FROM read_parquet(?)`,
    );
  });
});
