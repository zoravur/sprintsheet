/**
 * Registry of the demo "test databases".
 *
 * A test database is a set of DuckDB relations backed by files the Bun server
 * serves. Each database is selected with the `?db=` URL param, and each of its
 * relations becomes a tab at the bottom of the grid.
 *
 * Kept dependency-free so both the Bun server (to know which files to expose)
 * and the browser bundle (to know what to register) can import it.
 */

import { quoteIdentifier } from "./sql";

export interface Relation {
  /** Relation name used inside SQL and shown on the tab strip. */
  name: string;
  /** CSV filename under `src/data`, served at `/data/<file>`. */
  file: string;
  /** Column used to target a row when writing edits back (the row id). */
  primaryKey: string;
}

export interface TestDatabase {
  /** URL param value, e.g. `?db=shop`. */
  id: string;
  /** Human label for the header. */
  label: string;
  relations: Relation[];
}

export const TEST_DATABASES: readonly TestDatabase[] = [
  {
    id: "test",
    label: "Test",
    relations: [{ name: "test", file: "test.csv", primaryKey: "id" }],
  },
  {
    id: "shop",
    label: "Shop",
    relations: [
      { name: "products", file: "products.csv", primaryKey: "id" },
      { name: "sales", file: "sales.csv", primaryKey: "id" },
    ],
  },
];

export const DEFAULT_DATABASE_ID = "test";

/** Resolve a `?db=` value to a database, falling back to the default. */
export function resolveDatabase(id: string | null | undefined): TestDatabase {
  return (
    TEST_DATABASES.find((db) => db.id === id) ??
    TEST_DATABASES.find((db) => db.id === DEFAULT_DATABASE_ID) ??
    TEST_DATABASES[0]!
  );
}

/** Every CSV the server needs to expose, across all databases. */
export function allDataFiles(): string[] {
  return TEST_DATABASES.flatMap((db) => db.relations.map((relation) => relation.file));
}

/** The default statement for a relation, e.g. `FROM "products"`. */
export function selectQuery(relation: string): string {
  return `FROM ${quoteIdentifier(relation)}`;
}
