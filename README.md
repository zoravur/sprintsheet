# bun-react-tailwind-shadcn-template

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run for production:

```bash
bun start
```

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Data: DuckDB-wasm over Bun-served CSVs

The grid is fed by real SQL, not an in-memory fixture. Relation data lives as
CSVs in `src/data`, which the Bun server exposes under `/data/*` (HTTP range
requests supported). On first paint the browser:

1. loads the DuckDB-wasm worker + wasm module, which the server streams out of
   `node_modules` under `/duckdb/*` (see `src/index.ts`),
2. registers each relation with `registerFileURL(..., DuckDBDataProtocol.HTTP)`
   so DuckDB reads the CSVs directly from the Bun server, and
3. loads each CSV into a table and runs a `SELECT * FROM "<relation>"` query,
   turning the Arrow result into grid rows.

### Test databases

Databases are declared in `src/lib/databases.ts` and selected with the `?db=`
URL param (the header shows a link per database):

| URL              | relations                                                      |
| ---------------- | -------------------------------------------------------------- |
| `/` or `?db=test` | `test` — 5,000 order rows                                      |
| `?db=shop`       | `products` + `sales` — joinable on `sales.productId = products.id` |

Each relation of the selected database is a tab at the bottom of the grid;
clicking a tab runs `SELECT * FROM "<relation>"`. Columns are derived from the
query's Arrow schema (`src/lib/arrow.ts`). The query is fixed to the active
relation (shown, not edited); use the tabs to switch relations and **Run** to
re-fetch.

### Editing

Relations are materialized as real DuckDB tables, so edits write back to the
database. Committing an inline cell edit (double-click, `F2`, or start typing)
runs

```sql
UPDATE "<relation>" SET "<column>" = ? WHERE "<primaryKey>" = ?
```

with the new value and the row's key bound as parameters. Each relation declares
its `primaryKey` in `src/lib/databases.ts`; the statement is a canned template in
`src/lib/sql.ts`, and `updateCell` in `src/lib/duckdb.ts` quotes the identifiers
with DuckDB and binds the values.

### Ad-hoc views

The **+ New View** button opens a new view tab holding its own editable query
(e.g. a join across relations); each tab's query persists as you switch around.
A view has no primary key, so its results are **read-only**:
`query(..., { readOnly: true })` builds fields with no `field` accessor
(`getValue` only), which is the grid's marker for a non-editable cell.

Double-click a view tab to name it. On commit the view is persisted in the
DuckDB catalog via a canned `CREATE OR REPLACE VIEW "<name>" AS <query>`
prepared statement (`createView` in `src/lib/duckdb.ts`), so it can be queried
by name like any other relation.

### Persistence

The database is saved to the Bun server as **DuckDB files rather than JSON**:
each base table is dumped to Parquet (`COPY … TO`, so dates/timestamps keep
their exact type) and the view definitions to `views.sql`. They live under
`src/data/saved/<db>/` and are served by `src/index.ts`:

| Method   | Route                     | Effect                   |
| -------- | ------------------------- | ------------------------ |
| `GET`    | `/api/database/:db/:file` | a saved file, or `404`   |
| `PUT`    | `/api/database/:db/:file` | store a file (raw bytes) |
| `DELETE` | `/api/database/:db`       | reset back to the CSVs   |

`<file>` is `<relation>.parquet` or `views.sql`. On load the Parquet files are
re-registered and re-read with `read_parquet`, then the views are replayed
(`src/lib/persistence.ts`). The client autosaves ~800 ms after the last change
and on **⌘/Ctrl+S** (the header Save control). Only registered ids and filenames
are accepted, so a path can never escape `data/saved`.

Regenerate the (deterministic) CSVs with:

```bash
bun run scripts/generate-data.ts
```

## Query construction

Statements are built in `src/lib/sql.ts` and run in `src/lib/duckdb.ts`.
SELECTs are assembled as DuckDB JSON ASTs (`selectAllFrom`, `selectIdentifier`)
and rendered back to SQL by DuckDB itself via `json_deserialize_sql`, so
identifiers and literals never go through hand-rolled quoting. DuckDB's JSON
(de)serializer only understands SELECT, so the write statements (`UPDATE`,
`CREATE VIEW`, `COPY … TO`, `CREATE TABLE … AS`) are canned templates executed
as prepared statements: identifiers are quoted by DuckDB and every value is
bound as a `?` parameter.

## DuckDB serialization types

DuckDB describes how its parse tree serializes in the JSON schemas under
`src/include/duckdb/storage/serialization`. Two scripts mirror those schemas and
turn them into TypeScript types; both take the revision as an argument and are
deterministic (same input → byte-identical output).

```bash
# 1. Mirror one revision of the schema directory into `schemas/duckdb/<ref>/`.
bun run scripts/fetch-serialization-schemas.ts v1.5-variegata

# 2. Generate TypeScript types from the mirrored schemas.
bun run scripts/generate-serialization-types.ts v1.5-variegata
```

The fetch script is a GitHub mirror (pass `--owner` / `--repo` / `--path` /
`--out` to point elsewhere; `GITHUB_TOKEN` raises the rate limit). The generate
script emits `src/lib/duckdb-serialization.gen.ts`: one `interface` per schema
class (members typed from their C++ types, subclassing via `extends`, the
polymorphic discriminator narrowed to its literal), an `Any<Base>` union per
hierarchy, and `DuckDBValue` / `DuckDBLogicalType` placeholders for types
defined outside these schemas. A pointer or smart pointer to a class that has
subclasses is typed as its `Any<Base>` union (it holds a concrete subclass), so
the AST narrows on `type`; and an indirect reference (`T*`, smart pointer) is
nullable (`| null`) because a nil pointer serializes as `null` (container
elements are never null). See the doc comments in each script for the mapping.

## Canvas data grid

`src/components/datagrid` contains a virtualized spreadsheet datatable painted
on a single `<canvas>`. It renders only the rows/columns intersecting the
viewport, so a 50,000-row sheet repaints in well under a frame budget.

```tsx
import { CanvasDataGrid, createOrders, orderColumns } from "@/components/datagrid";

const rows = createOrders(50_000);

<CanvasDataGrid rows={rows} columns={orderColumns} className="h-full" />;
```

Features:

- virtualized canvas rendering with device-pixel-ratio crispness
- custom scrollbars (drag / click-to-jump) synced to the canvas with zero
  React renders per scroll frame
- frozen column header + row-number gutter
- cell / range selection, marquee drag, row select, select-all
- three-point selection model (`anchor` / `extent` / `focus`): the rectangle is
  the bounding box of anchor + extent, and the active cell may sit anywhere
  inside it; after a pointer gesture anchor/extent are normalised to the
  top-left/bottom-right corners
- keyboard navigation — arrows (+`Shift` to extend), `PageUp/Down`,
  `Home`/`End`; `Enter`/`Tab` cycle the active cell inside the selection and
  wrap (`Enter` column-major, `Tab` row-major)
- inline editing (double-click, `F2`, or just start typing) with type coercion.
  Edit mode is a *model* mode, not a view special case: while editing the arrow
  keys become caret movement, and every other navigation command commits the
  pending edit before it runs (see `ENDS_EDIT` in `spreadsheet.ts`)
- click-to-sort headers, drag-to-resize columns
- `⌘/Ctrl+C` / `⌘/Ctrl+V` of TSV ranges
- reads shadcn/Tailwind theme tokens and follows dark mode

### Architecture

The document is a **headless model**, independent of React and the canvas:

- `spreadsheet.ts` — `SpreadsheetState` (rows/view/columns/widths/sort/selection/
  editing) plus a pure `reduce(state, command)` and an observable
  `SpreadsheetModel` wrapper. Every interaction is a `Command`
  (`move`, `scan`, `beginEdit`, `commitEdit`, `sortColumn`, `paste`, …); results
  are `Effect`s (`reveal`, `focusGrid`, `edited`) that the view plays back.
- `CanvasDataGrid.tsx` — thin view: builds the model once, subscribes with
  `useSyncExternalStore`, dispatches commands from DOM events and turns effects
  into scrolling / focus / callbacks. It owns only presentational state
  (scroll offsets, hover, in-progress resize).

Supporting pure modules: `layout.ts` (axis maths + virtualization), `renderer.ts`
(canvas paint), `format.ts` (value resolution + `Intl` formatting), `theme.ts`
(CSS-var bridge), `navigation.ts` (Enter/Tab scan), `scrollbar.ts` (thumb
geometry). Because the model is pure it is exhaustively unit-testable — see
`__tests__/spreadsheet.test.ts`. Run everything with `bun test` and
`bunx tsc --noEmit`.
