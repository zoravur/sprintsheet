/**
 * Value resolution + display formatting.
 *
 * `Intl` formatter instances are memoized by their options so the per-frame hot
 * path pays the construction cost once. Everything here is called only for
 * on-screen cells.
 */

import type { CellValue, ColumnDef } from "./types";

const numberFormatters = new Map<string, Intl.NumberFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function numberFormatter(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

/** Numeric columns are right-aligned by default. */
export function defaultAlign(type: ColumnDef<unknown>["type"]): "left" | "right" | "center" {
  switch (type) {
    case "number":
    case "integer":
    case "currency":
    case "percent":
      return "right";
    case "boolean":
    case "badge":
      return "center";
    default:
      return "left";
  }
}

function toDate(value: CellValue): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Resolve a cell's raw value through the column's accessor. */
export function resolveValue<Row>(col: ColumnDef<Row>, row: Row, rowIndex: number): CellValue {
  if (col.getValue) return col.getValue(row, rowIndex);
  if (col.field) return (row as Record<string, unknown>)[col.field] as CellValue;
  return null;
}

/** Turn a raw value into the string painted on the canvas. */
export function formatCell<Row>(
  col: ColumnDef<Row>,
  value: CellValue,
  row: Row,
  rowIndex: number,
): string {
  if (col.format) return col.format(value, row, rowIndex);
  if (value === null || value === undefined) return "";

  const locale = col.locale ?? "en-US";
  const type = col.type ?? "text";

  switch (type) {
    case "integer":
      return typeof value === "number" ? numberFormatter(locale, { maximumFractionDigits: 0 }).format(value) : String(value);
    case "number":
      return typeof value === "number"
        ? numberFormatter(locale, { maximumFractionDigits: 2 }).format(value)
        : String(value);
    case "currency":
      return typeof value === "number"
        ? numberFormatter(locale, {
            style: "currency",
            currency: col.currency ?? "USD",
            maximumFractionDigits: 2,
          }).format(value)
        : String(value);
    case "percent":
      return typeof value === "number"
        ? numberFormatter(locale, { style: "percent", maximumFractionDigits: 1 }).format(value)
        : String(value);
    case "date": {
      const date = toDate(value);
      return date ? dateFormatter(locale, { year: "numeric", month: "short", day: "2-digit" }).format(date) : String(value);
    }
    case "boolean":
      return value ? "Yes" : "No";
    case "badge":
      return String(value);
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/** True for values we render with the muted foreground (null/empty). */
export function isEmptyValue(value: CellValue): boolean {
  return value === null || value === undefined || value === "";
}

/** Coerce an edited string back to the column's native type. */
export function parseEditedValue(col: ColumnDef<any>, text: string): CellValue {
  const trimmed = text.trim();
  const type = col.type ?? "text";

  if (trimmed === "") return null;

  switch (type) {
    case "number":
    case "integer":
    case "currency":
    case "percent": {
      const numeric = Number(trimmed.replace(/[^0-9eE+\-.]/g, ""));
      if (Number.isFinite(numeric)) {
        return type === "integer" ? Math.round(numeric) : numeric;
      }
      return trimmed;
    }
    case "boolean": {
      const lowered = trimmed.toLowerCase();
      if (["yes", "true", "1", "y"].includes(lowered)) return true;
      if (["no", "false", "0", "n"].includes(lowered)) return false;
      return trimmed;
    }
    case "date": {
      const date = new Date(trimmed);
      return Number.isNaN(date.getTime()) ? trimmed : date;
    }
    default:
      return text;
  }
}

/** Ascending/descending comparator over resolved cell values. */
export function compareValues(a: CellValue, b: CellValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "" ? 0 : -1;
  if (b === null || b === undefined || b === "") return 1;

  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
