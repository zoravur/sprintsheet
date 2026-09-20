/**
 * Persistence helpers for saving a database to the server as DuckDB files.
 *
 * Instead of a JSON snapshot, the database is written as real files DuckDB
 * produces:
 *
 *  - `<relation>.parquet` — one Parquet file per base table (`COPY … TO`), which
 *    preserves column types exactly (dates/timestamps included), and
 *  - `views.sql` — the `CREATE VIEW …` statements read back from the catalog.
 *
 * On load the Parquet files are re-registered and each table is recreated with
 * `read_parquet`, then the view statements are replayed. All helpers here are
 * pure (string/statement construction + parsing) so they unit-test cleanly.
 */

import { quoteIdentifier } from "./sql";

export const VIEWS_SQL_FILE = "views.sql";

/** A view restored from `views.sql` (drives a query tab). */
export interface SavedView {
  name: string;
  query: string;
}

/** The Parquet filename for a base relation. */
export function parquetFile(relation: string): string {
  return `${relation}.parquet`;
}

/** `COPY "<relation>" TO '<relation>.parquet' (FORMAT PARQUET)` */
export function copyToParquetStatement(relation: string): string {
  return `COPY ${quoteIdentifier(relation)} TO '${parquetFile(relation)}' (FORMAT PARQUET)`;
}

/** `CREATE OR REPLACE TABLE "<relation>" AS SELECT * FROM read_parquet('<file>')` */
export function buildTableStatements(relations: readonly string[]): string[] {
  return relations.map(
    (relation) =>
      `CREATE OR REPLACE TABLE ${quoteIdentifier(relation)} AS ` +
      `SELECT * FROM read_parquet('${parquetFile(relation)}')`,
  );
}

/**
 * Serialize view statements to `views.sql`. Each statement is one line (inner
 * newlines become spaces) so the file can be split line-by-line on load without
 * a SQL tokenizer; other whitespace is preserved.
 */
export function serializeViewStatements(statements: readonly string[]): string {
  return statements.map((statement) => statement.replace(/\r?\n+/g, " ").trim()).join("\n");
}

/** Split a `views.sql` file into individual statements. */
export function parseStatements(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parse a DuckDB-normalized `CREATE [OR REPLACE] VIEW <name> AS <query>` statement. */
export function parseViewStatement(statement: string): SavedView | null {
  const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("(?:[^"]|"")*"|\S+)\s+AS\s+([\s\S]*?);?\s*$/i.exec(
    statement.trim(),
  );
  if (!match) return null;
  const rawName = match[1]!;
  const name = rawName.startsWith('"') ? rawName.slice(1, -1).replace(/""/g, '"') : rawName;
  return { name, query: match[2]!.trim() };
}
