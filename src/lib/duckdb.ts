/**
 * DuckDB-wasm data provider.
 *
 * The app used to build its rows in the browser (`createOrders`). Now the data
 * lives in CSVs that the Bun server serves, and the grid is fed by real SQL
 * queries against those files:
 *
 *   1. `selectBundle` picks the `eh` or `mvp` wasm build for this browser.
 *   2. A classic `Worker` runs DuckDB off the main thread.
 *   3. Each relation is loaded into a real (writable) table, and named query
 *      views are created in the catalog.
 *   4. `query()` returns an Arrow table which `resultSetFromArrow` flattens
 *      into grid columns + rows.
 *
 * Statements come from `./sql`: SELECTs are built as DuckDB JSON ASTs and
 * rendered back to SQL with `json_deserialize_sql` (`deserializeSql` below),
 * while the writes DuckDB can't express as JSON — `UPDATE`, `CREATE VIEW`,
 * `COPY … TO`, `CREATE TABLE … AS` — are fixed prepared statements with their
 * values bound (`?`) and their identifiers quoted by DuckDB itself.
 *
 * Persistence uses DuckDB's own files rather than a JSON snapshot: each table is
 * dumped to Parquet (`COPY … TO`, so dates/timestamps keep their exact type) and
 * the view definitions to `views.sql`. Those files are uploaded to the Bun
 * server and re-loaded (`read_parquet` + replay) on the next visit; see
 * `src/lib/persistence.ts` for the file helpers.
 *
 * Each database id gets its own wasm instance, created once and reused.
 */

import * as duckdb from "@duckdb/duckdb-wasm";

import type { CellValue } from "@/components/datagrid/types";
import { resultSetFromArrow, type ResultSet } from "./arrow";
import { type Relation, type TestDatabase } from "./databases";
import type { SelectStatement } from "./duckdb-serialization.gen";
import { DUCKDB_ASSET_PREFIX, dataUrlFor } from "./paths";
import {
  parquetFile,
  parseStatements,
  parseViewStatement,
  serializeViewStatements,
  VIEWS_SQL_FILE,
  type SavedView,
} from "./persistence";
import {
  copyToParquetStatement,
  createTableFromCsvStatement,
  createTableFromParquetStatement,
  createViewStatement,
  selectIdentifier,
  updateCellStatement,
} from "./sql";

/** Where this browser should load each DuckDB wasm bundle from. */
const LOCAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: `${DUCKDB_ASSET_PREFIX}duckdb-mvp.wasm`,
    mainWorker: `${DUCKDB_ASSET_PREFIX}duckdb-browser-mvp.worker.js`,
  },
  eh: {
    mainModule: `${DUCKDB_ASSET_PREFIX}duckdb-eh.wasm`,
    mainWorker: `${DUCKDB_ASSET_PREFIX}duckdb-browser-eh.worker.js`,
  },
};

export interface QueryResult extends ResultSet {
  /** Wall-clock time for `conn.query`, excluding wasm boot + CSV registration. */
  elapsedMs: number;
}

export interface QueryOptions {
  /** Read-only results expose no `field`, so the grid cannot edit them. */
  readOnly?: boolean;
}

/** A booted instance plus the view tabs restored from its saved files. */
interface Booted {
  instance: duckdb.AsyncDuckDB;
  views: SavedView[];
}

const boots = new Map<string, Promise<Booted>>();

// ---- saved-file transport --------------------------------------------------

function savedFileUrl(databaseId: string, file: string): string {
  return `/api/database/${encodeURIComponent(databaseId)}/${encodeURIComponent(file)}`;
}

async function fetchSavedFile(databaseId: string, file: string): Promise<Uint8Array | null> {
  const response = await fetch(savedFileUrl(databaseId, file));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load ${file} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function putSavedFile(databaseId: string, file: string, bytes: Uint8Array): Promise<void> {
  const response = await fetch(savedFileUrl(databaseId, file), {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    // `Uint8Array` is a valid BodyInit at runtime; the DOM lib generics fight it.
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) throw new Error(`Failed to save ${file} (${response.status})`);
}

// ---- canned statements + identifier quoting --------------------------------

/** Run a canned statement, binding `params` to its `?` markers. */
async function runPrepared(
  connection: duckdb.AsyncDuckDBConnection,
  statement: string,
  ...params: unknown[]
): Promise<void> {
  const prepared = await connection.prepare(statement);
  try {
    await prepared.query(...params);
  } finally {
    await prepared.close();
  }
}

/** DuckDB's identifier quoting is deterministic, so cache the rendered names. */
const quotedIdentifiers = new Map<string, string>();

/**
 * Quote `name` as a SQL identifier by asking DuckDB to render a one-column
 * `SELECT <name>` AST back to SQL. Delegating to DuckDB keeps identifier
 * escaping out of our own code.
 */
async function quotedIdentifier(connection: duckdb.AsyncDuckDBConnection, name: string): Promise<string> {
  const cached = quotedIdentifiers.get(name);
  if (cached !== undefined) return cached;
  const rendered = await renderSelect(connection, selectIdentifier(name));
  const match = /^SELECT\s+(.*)$/s.exec(rendered);
  if (!match) throw new Error(`Could not render identifier ${JSON.stringify(name)}`);
  const quoted = match[1]!.trim();
  quotedIdentifiers.set(name, quoted);
  return quoted;
}

// ---- JSON AST <-> SQL ------------------------------------------------------

/**
 * Render a SELECT AST to SQL with DuckDB's own `json_deserialize_sql`.
 *
 * The statement is wrapped in the `{ error: false, statements: [...] }` envelope
 * `json_serialize_sql` produces and bound as a `?` parameter, so it never gets
 * concatenated into the query text.
 */
async function renderSelect(connection: duckdb.AsyncDuckDBConnection, statement: SelectStatement): Promise<string> {
  const json = JSON.stringify({ error: false, statements: [statement] });
  const prepared = await connection.prepare(`SELECT json_deserialize_sql(?) AS sql`);
  try {
    const value = (await prepared.query(json)).getChildAt(0)?.get(0);
    if (value === null || value === undefined) {
      throw new Error("json_deserialize_sql returned no value");
    }
    return String(value);
  } finally {
    await prepared.close();
  }
}

/** Build a SELECT from a JSON AST (`./sql`) and render it back to SQL. */
export async function deserializeSql(db: TestDatabase, statement: SelectStatement): Promise<string> {
  const instance = await getDatabase(db);
  const connection = await instance.connect();
  try {
    return await renderSelect(connection, statement);
  } finally {
    await connection.close();
  }
}

// ---- boot ------------------------------------------------------------------

async function bootstrap(db: TestDatabase): Promise<Booted> {
  const bundle = await duckdb.selectBundle(LOCAL_BUNDLES);
  if (!bundle.mainWorker) throw new Error("No DuckDB worker bundle available for this browser.");

  const worker = new Worker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const instance = new duckdb.AsyncDuckDB(logger, worker);
  await instance.instantiate(bundle.mainModule, bundle.pthreadWorker);

  const connection = await instance.connect();
  try {
    const first = db.relations[0]!;
    const marker = await fetchSavedFile(db.id, parquetFile(first.name)).catch(() => null);

    if (marker) {
      // Restore: register the Parquet files, rebuild the tables, replay views.
      for (const relation of db.relations) {
        const file = parquetFile(relation.name);
        const bytes = await fetchSavedFile(db.id, file);
        if (!bytes) throw new Error(`Saved database is missing ${file}`);
        await instance.registerFileBuffer(file, bytes);
      }
      for (const relation of db.relations) {
        await runPrepared(
          connection,
          createTableFromParquetStatement(await quotedIdentifier(connection, relation.name)),
          parquetFile(relation.name),
        );
      }

      const views: SavedView[] = [];
      const viewsBytes = await fetchSavedFile(db.id, VIEWS_SQL_FILE);
      if (viewsBytes) {
        for (const statement of parseStatements(new TextDecoder().decode(viewsBytes))) {
          await connection.query(statement);
          const parsed = parseViewStatement(statement);
          if (parsed) views.push(parsed);
        }
      }
      return { instance, views };
    }

    // Fresh database: register each CSV and load it into a table.
    for (const relation of db.relations) {
      const url = new URL(dataUrlFor(relation.file), globalThis.location.href).href;
      await instance.registerFileURL(relation.file, url, duckdb.DuckDBDataProtocol.HTTP, false);
    }
    for (const relation of db.relations) {
      await runPrepared(
        connection,
        createTableFromCsvStatement(await quotedIdentifier(connection, relation.name)),
        relation.file,
      );
    }
    return { instance, views: [] };
  } finally {
    await connection.close();
  }
}

function boot(db: TestDatabase): Promise<Booted> {
  let pending = boots.get(db.id);
  if (!pending) {
    pending = bootstrap(db).catch((error: unknown) => {
      boots.delete(db.id);
      throw error;
    });
    boots.set(db.id, pending);
  }
  return pending;
}

/** Lazily boot (and cache) the wasm instance for a database. */
export async function getDatabase(db: TestDatabase): Promise<duckdb.AsyncDuckDB> {
  return (await boot(db)).instance;
}

/** The view tabs restored from the saved files (empty when none). */
export async function getRestoredViews(db: TestDatabase): Promise<SavedView[]> {
  return (await boot(db)).views;
}

// ---- queries + writes ------------------------------------------------------

/** `json_serialize_sql` output when the SQL parsed. */
export interface DuckDBParseSuccess {
  error: false;
  statements: SelectStatement[];
}

/** `json_serialize_sql` output when the SQL did not parse. */
export interface DuckDBParseError {
  error: true;
  error_type: string;
  error_message: string;
  error_subtype?: string;
  position?: string;
}

/** The two shapes `json_serialize_sql` can return, discriminated on `error`. */
export type DuckDBParseResult = DuckDBParseSuccess | DuckDBParseError;

/**
 * Parse `sql` into DuckDB's JSON AST.
 *
 * `json_serialize_sql(varchar)` runs the statement through DuckDB's own parser
 * and returns the serialized parse tree as a JSON string (or, when the SQL does
 * not parse, an object with `error: true`). The statement is bound as a `?`
 * parameter; the JSON is parsed and returned as a `DuckDBParseResult`, narrowed
 * on its `error` flag.
 */
export async function duckdbParse(db: TestDatabase, sql: string): Promise<DuckDBParseResult> {
  const instance = await getDatabase(db);
  const connection = await instance.connect();
  try {
    const prepared = await connection.prepare(`SELECT json_serialize_sql(?) AS ast`);
    try {
      const serialized = (await prepared.query(sql)).getChildAt(0)?.get(0);
      if (serialized === null || serialized === undefined) {
        throw new Error("json_serialize_sql returned no value");
      }
      return JSON.parse(String(serialized)) as DuckDBParseResult;
    } finally {
      await prepared.close();
    }
  } finally {
    await connection.close();
  }
}

/** Run `sql` against a database and return grid-ready columns + rows. */
export async function query(db: TestDatabase, sql: string, options: QueryOptions = {}): Promise<QueryResult> {
  const instance = await getDatabase(db);
  const connection = await instance.connect();
  try {
    // Parse the user's statement first and log the AST for inspection.
    const ast = await duckdbParse(db, sql);
    console.log(JSON.stringify(ast, null, 2));
    const started = performance.now();
    const table = await connection.query(sql);
    const elapsedMs = performance.now() - started;
    return { ...resultSetFromArrow(table, { readOnly: options.readOnly }), elapsedMs };
  } finally {
    await connection.close();
  }
}

/**
 * Persist a single cell edit to the backing table:
 * `UPDATE <relation> SET <column> = ? WHERE <primaryKey> = ?`.
 *
 * The identifiers are quoted by DuckDB and the two values are bound, so nothing
 * here is escaped by hand.
 */
export async function updateCell(
  db: TestDatabase,
  relation: Relation,
  primaryKeyValue: CellValue,
  columnId: string,
  value: CellValue,
): Promise<void> {
  const instance = await getDatabase(db);
  const connection = await instance.connect();
  try {
    const relationName = await quotedIdentifier(connection, relation.name);
    const columnName = await quotedIdentifier(connection, columnId);
    const primaryKey = await quotedIdentifier(connection, relation.primaryKey);
    await runPrepared(connection, updateCellStatement(relationName, columnName, primaryKey), value, primaryKeyValue);
  } finally {
    await connection.close();
  }
}

/**
 * Persist a named view into the DuckDB catalog:
 * `CREATE OR REPLACE VIEW <name> AS <query>`.
 *
 * A trailing `;` on the query is stripped so it can be embedded after `AS`.
 */
export async function createView(db: TestDatabase, name: string, query: string): Promise<void> {
  const instance = await getDatabase(db);
  const connection = await instance.connect();
  try {
    const quotedName = await quotedIdentifier(connection, name);
    const body = query.trim().replace(/;+\s*$/, "");
    await runPrepared(connection, createViewStatement(quotedName, body));
  } finally {
    await connection.close();
  }
}

/**
 * Dump the database to DuckDB files on the server: one Parquet file per base
 * table (types preserved) plus `views.sql` with the view definitions.
 */
export async function saveDatabase(db: TestDatabase): Promise<void> {
  const instance = await getDatabase(db);
  const connection = await instance.connect();
  try {
    for (const relation of db.relations) {
      const file = parquetFile(relation.name);
      try {
        await instance.dropFile(file);
      } catch {
        /* file wasn't there */
      }
      await instance.registerEmptyFileBuffer(file);
      await runPrepared(connection, copyToParquetStatement(await quotedIdentifier(connection, relation.name)), file);
      await putSavedFile(db.id, file, await instance.copyFileToBuffer(file));
    }

    const views = await connection.query(
      `SELECT sql FROM duckdb_views() WHERE NOT internal AND schema_name = 'main' ORDER BY view_name`,
    );
    const statements = views
      .toArray()
      .map((row) => String((row.toJSON() as { sql?: unknown }).sql ?? ""))
      .filter((sql) => sql.length > 0);
    await putSavedFile(db.id, VIEWS_SQL_FILE, new TextEncoder().encode(serializeViewStatements(statements)));
  } finally {
    await connection.close();
  }
}
