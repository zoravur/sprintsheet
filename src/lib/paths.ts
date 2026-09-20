/**
 * Route prefixes shared by the Bun server and the browser bundle.
 *
 * Kept dependency-free so the server can import it without dragging the
 * DuckDB-wasm browser bundle into the server process.
 */

/** Prefix under which the Bun server exposes the CSV relations. */
export const DATA_ROUTE_PREFIX = "/data/";

/** Prefix under which the Bun server exposes the DuckDB wasm + worker assets. */
export const DUCKDB_ASSET_PREFIX = "/duckdb/";

/** URL for a relation's CSV, e.g. `dataUrlFor("test.csv") => "/data/test.csv"`. */
export function dataUrlFor(file: string): string {
  return `${DATA_ROUTE_PREFIX}${file}`;
}
