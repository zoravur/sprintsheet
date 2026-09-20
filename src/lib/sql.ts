/**
 * Query construction for the app's read and write paths.
 *
 * DuckDB can round-trip SELECT statements through its JSON AST (`json_serialize_sql`
 * / `json_deserialize_sql`), so every SELECT the app issues is built here as a
 * typed AST (the shapes in `duckdb-serialization.gen.ts`) and rendered back to
 * SQL by DuckDB itself — see `deserializeSql` in `./duckdb`. Building the tree
 * (rather than concatenating SQL text) keeps table/column identifiers and
 * literal values out of hand-rolled quoting.
 *
 * DuckDB's JSON (de)serializer only understands SELECT statements, so the write
 * path — `UPDATE`, `CREATE VIEW`, `COPY … TO`, `CREATE TABLE … AS` — is a fixed
 * ("canned") statement template instead. Those templates take identifiers that
 * DuckDB has already quoted (see `quotedIdentifier` in `./duckdb`) and bind
 * their values as `?` parameters; the identifier is the only interpolated part.
 */

import type {
  AnyParsedExpression,
  AnyTableRef,
  BaseTableRef,
  ColumnRefExpression,
  CommonTableExpressionMap,
  EmptyTableRef,
  SelectNode,
  SelectStatement,
  StarExpression,
} from "./duckdb-serialization.gen";

// ---- JSON AST builders -----------------------------------------------------

/*
 * DuckDB's JSON wire format differs from the generated types in two places we
 * have to honour:
 *
 *   - maps serialize as `{ key, value }[]`, so an empty map is `[]` and not the
 *     `Record` the generated types declare;
 *   - the empty FROM clause serializes as `"EMPTY"`, not `"EMPTY_FROM"`.
 *
 * `emptyMap` and `emptyTable` paper over both so the rest of the tree stays
 * typed against the generated interfaces.
 */

/** An empty DuckDB map on the wire (`[]`), typed as the generated `Record`. */
function emptyMap<T>(): T {
  return [] as unknown as T;
}

/** `*` — the select list of a bare `SELECT *` query. */
function star(): AnyParsedExpression {
  return {
    class: "STAR",
    type: "STAR",
    alias: "",
    query_location: 0,
    relation_name: "",
    exclude_list: [],
    replace_list: emptyMap<StarExpression["replace_list"]>(),
    columns: false,
    expr: null,
    unpacked: false,
    qualified_exclude_list: [],
    rename_list: emptyMap<StarExpression["rename_list"]>(),
  } satisfies StarExpression;
}

/** A single unqualified column reference. */
function column(name: string): ColumnRefExpression {
  return {
    class: "COLUMN_REF",
    type: "COLUMN_REF",
    alias: "",
    query_location: 0,
    column_names: [name],
  };
}

/** A reference to a base table by name. */
function baseTable(relation: string): BaseTableRef {
  return {
    type: "BASE_TABLE",
    alias: "",
    sample: null,
    query_location: 0,
    schema_name: "",
    table_name: relation,
    column_name_alias: [],
    catalog_name: "",
    at_clause: null,
  };
}

/** An empty FROM clause (see the wire-format note above). */
function emptyTable(): AnyTableRef {
  return { type: "EMPTY", alias: "", sample: null, query_location: 0 } as unknown as EmptyTableRef;
}

/** A complete `SELECT` node with the given projection and FROM clause. */
function selectNode(selectList: AnyParsedExpression[], fromTable: AnyTableRef): SelectNode {
  return {
    type: "SELECT_NODE",
    modifiers: [],
    cte_map: { map: emptyMap<CommonTableExpressionMap["map"]>() },
    select_list: selectList,
    from_table: fromTable,
    where_clause: null,
    group_expressions: [],
    group_sets: [],
    aggregate_handling: "STANDARD_HANDLING",
    having: null,
    sample: null,
    qualify: null,
  };
}

/** Wrap a query node in the statement envelope `json_deserialize_sql` expects. */
function selectStatement(selectList: AnyParsedExpression[], fromTable: AnyTableRef): SelectStatement {
  return {
    node: selectNode(selectList, fromTable),
    named_param_map: emptyMap<SelectStatement["named_param_map"]>(),
  };
}

/** `SELECT * FROM <relation>` as a DuckDB JSON AST. */
export function selectAllFrom(relation: string): SelectStatement {
  return selectStatement([star()], baseTable(relation));
}

/**
 * `SELECT <name>` (no FROM) as a DuckDB JSON AST.
 *
 * The database layer renders this back to SQL to have DuckDB quote a single
 * identifier; the output is exactly `SELECT <quoted-name>`.
 */
export function selectIdentifier(name: string): SelectStatement {
  return selectStatement([column(name)], emptyTable());
}

// ---- canned statements -----------------------------------------------------

/*
 * DuckDB's JSON (de)serializer only handles SELECT, so these statements stay
 * fixed templates. Every template takes identifiers already quoted by DuckDB
 * and leaves its values as bound `?` parameters. `CREATE VIEW` is the lone
 * exception: its body is the user's own query text.
 */

/** `UPDATE <relation> SET <column> = ? WHERE <primaryKey> = ?` */
export function updateCellStatement(quotedRelation: string, quotedColumn: string, quotedPrimaryKey: string): string {
  return `UPDATE ${quotedRelation} SET ${quotedColumn} = ? WHERE ${quotedPrimaryKey} = ?`;
}

/** `CREATE OR REPLACE VIEW <name> AS <query>` */
export function createViewStatement(quotedName: string, query: string): string {
  return `CREATE OR REPLACE VIEW ${quotedName} AS ${query}`;
}

/** `COPY <relation> TO ? (FORMAT PARQUET)` */
export function copyToParquetStatement(quotedRelation: string): string {
  return `COPY ${quotedRelation} TO ? (FORMAT PARQUET)`;
}

/** `CREATE OR REPLACE TABLE <relation> AS SELECT * FROM read_csv_auto(?)` */
export function createTableFromCsvStatement(quotedRelation: string): string {
  return `CREATE OR REPLACE TABLE ${quotedRelation} AS SELECT * FROM read_csv_auto(?)`;
}

/** `CREATE OR REPLACE TABLE <relation> AS SELECT * FROM read_parquet(?)` */
export function createTableFromParquetStatement(quotedRelation: string): string {
  return `CREATE OR REPLACE TABLE ${quotedRelation} AS SELECT * FROM read_parquet(?)`;
}
