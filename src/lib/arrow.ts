/**
 * Arrow -> canvas-grid adapters.
 *
 * DuckDB-wasm answers every query with an Arrow `Table`. The grid, however,
 * speaks in `ColumnDef` + plain row objects. This module is the (pure) bridge
 * between the two: it turns an Arrow schema into column definitions and an
 * Arrow table into rows of `CellValue`s.
 *
 * A query can produce several columns with the *same* name (e.g.
 * `SELECT *, productid AS id FROM sales`). Arrow keeps them distinct by
 * position, so rows are keyed by a per-column storage key — unique even when
 * the display name repeats — and are read by column index rather than by name.
 *
 * Keeping this separate from the database lifecycle means it can be unit tested
 * without spinning up a worker or a wasm module.
 */

import * as arrow from "apache-arrow";

import type { CellValue, ColumnDef, ColumnType } from "@/components/datagrid/types";

/** A single row produced by the providers: plain object keyed by column id. */
export type DataRow = Record<string, CellValue>;

/** Columns + rows, the two things `CanvasDataGrid` needs. */
export interface ResultSet {
  columns: ColumnDef<DataRow>[];
  rows: DataRow[];
}

export interface ColumnOptions {
  /**
   * Read-only columns resolve their value through `getValue` and carry no
   * `field`. The grid treats field-less columns as non-editable, so ad-hoc
   * query views (arbitrary projections/joins) render but cannot be edited.
   */
  readOnly?: boolean;
}

/**
 * A unique storage key per output column. Unique names are used verbatim (so a
 * base relation's columns keep their real names); repeated names get a stable
 * `#<nth>@<index>` suffix. The suffix never reaches the UI — headers use the
 * original name — it only keeps the row object (and `ColumnDef.id`) collision
 * free.
 */
export function columnKeys(schema: arrow.Schema): string[] {
  const total = new Map<string, number>();
  for (const field of schema.fields) total.set(field.name, (total.get(field.name) ?? 0) + 1);

  const seen = new Map<string, number>();
  return schema.fields.map((field, index) => {
    if ((total.get(field.name) ?? 0) === 1) return field.name;
    const nth = (seen.get(field.name) ?? 0) + 1;
    seen.set(field.name, nth);
    return `${field.name}#${nth}@${index}`;
  });
}

/** Map an Arrow logical type onto the closest grid column type. */
export function columnType(type: arrow.DataType): ColumnType {
  // Type predicates cover every bit width (Int8..Int64, Uint*, Float16..64).
  if (arrow.DataType.isInt(type)) return "integer";
  if (arrow.DataType.isFloat(type) || arrow.DataType.isDecimal(type)) return "number";
  if (arrow.DataType.isBool(type)) return "boolean";
  if (arrow.DataType.isDate(type) || arrow.DataType.isTimestamp(type)) return "date";
  return "text";
}

/** Minimum readable width for each column type (px). */
const BASE_WIDTH: Record<ColumnType, number> = {
  text: 160,
  integer: 96,
  number: 120,
  currency: 122,
  percent: 104,
  date: 168,
  boolean: 88,
  badge: 120,
};

/** `unitPrice` / `unit_price` -> `Unit Price`. */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

/** Build grid columns from an Arrow schema, one per field. */
export function columnsFromArrow(schema: arrow.Schema, options: ColumnOptions = {}): ColumnDef<DataRow>[] {
  const readOnly = options.readOnly ?? false;
  const keys = columnKeys(schema);
  return schema.fields.map((field, index) => {
    const key = keys[index]!;
    const type = columnType(field.type);
    const header = humanize(field.name);
    // Grow the column so the header (upper-cased by the renderer) fits.
    const width = Math.max(BASE_WIDTH[type], header.length * 9 + 48);
    return readOnly
      ? { id: key, header, type, width, getValue: (row: DataRow) => row[key] }
      : { id: key, header, field: key, type, width };
  });
}

/**
 * Values Arrow hands back can be `bigint` (64-bit ints), `Date` (timestamps) or
 * the primitives the grid already understands. Normalise to `CellValue`.
 */
function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "bigint":
      // 64-bit ints render/sort fine as doubles at CSV scale.
      return Number(value);
    case "string":
    case "number":
    case "boolean":
      return value;
    default:
      if (value instanceof Date) return value;
      return String(value);
  }
}

/** Materialise an Arrow table into plain rows the grid can render. */
export function rowsFromArrow(table: arrow.Table): DataRow[] {
  const keys = columnKeys(table.schema);
  // Read children by index, not name: duplicate-named columns must not collapse
  // (which is exactly what `row.toJSON()` would do).
  const vectors = keys.map((_, index) => table.getChildAt(index));
  const rows: DataRow[] = new Array(table.numRows);
  for (let r = 0; r < table.numRows; r++) {
    const row: DataRow = {};
    for (let c = 0; c < keys.length; c++) row[keys[c]!] = toCellValue(vectors[c]?.get(r));
    rows[r] = row;
  }
  return rows;
}

/** Turn a whole Arrow table into `{ columns, rows }`. */
export function resultSetFromArrow(table: arrow.Table, options: ColumnOptions = {}): ResultSet {
  return { columns: columnsFromArrow(table.schema, options), rows: rowsFromArrow(table) };
}
