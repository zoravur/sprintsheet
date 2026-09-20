/**
 * Tiny SQL builders for the write path.
 *
 * Pure string helpers (no DuckDB import) so they can be unit tested directly —
 * the DuckDB-wasm instance is only involved when the statement is executed.
 */

import type { CellValue } from "@/components/datagrid/types";

/** Quote a SQL identifier, escaping embedded double quotes. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Render a cell value as a SQL literal (`NULL`, numbers, booleans, strings). */
export function sqlLiteral(value: CellValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

export interface CellUpdate {
  /** Table/view name. */
  relation: string;
  /** Primary-key column used to target the row. */
  primaryKey: string;
  /** The row's primary-key value (before the edit). */
  primaryKeyValue: CellValue;
  /** Column being changed. */
  column: string;
  /** New value. */
  value: CellValue;
}

/** `UPDATE <relation> SET <column> = <value> WHERE <pk> = <pkValue>` */
export function buildCellUpdate(update: CellUpdate): string {
  const { relation, primaryKey, primaryKeyValue, column, value } = update;
  return (
    `UPDATE ${quoteIdentifier(relation)} ` +
    `SET ${quoteIdentifier(column)} = ${sqlLiteral(value)} ` +
    `WHERE ${quoteIdentifier(primaryKey)} = ${sqlLiteral(primaryKeyValue)}`
  );
}

/**
 * `CREATE OR REPLACE VIEW <name> AS <query>`.
 *
 * Persists a named view into the DuckDB catalog. A trailing `;` on the query is
 * stripped so it can be embedded after `AS`.
 */
export function buildCreateView(name: string, query: string): string {
  const body = query.trim().replace(/;+\s*$/, "");
  return `CREATE OR REPLACE VIEW ${quoteIdentifier(name.trim())} AS ${body}`;
}
