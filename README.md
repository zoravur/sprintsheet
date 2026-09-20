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
3. loads each CSV into a table and runs the bare `FROM "<relation>"` short form,
   turning the Arrow result into grid rows.

### Test databases

Databases are declared in `src/lib/databases.ts` and selected with the `?db=`
URL param (the header shows a link per database):

| URL              | relations                                                      |
| ---------------- | -------------------------------------------------------------- |
| `/` or `?db=test` | `test` — 5,000 order rows                                      |
| `?db=shop`       | `products` + `sales` — joinable on `sales.productId = products.id` |

Each relation of the selected database is a tab at the bottom of the grid;
clicking a tab runs `FROM "<relation>"`. Columns are derived from the query's
Arrow schema (`src/lib/arrow.ts`). The query is fixed to the active relation
(shown, not edited); use the tabs to switch relations and **Run** to re-fetch.

### Editing

Relations are materialized as real DuckDB tables, so edits write back to the
database. Committing an inline cell edit (double-click, `F2`, or start typing)
runs

```sql
UPDATE "<relation>" SET "<column>" = <value> WHERE "<primaryKey>" = <pkValue>
```

Each relation declares its `primaryKey` in `src/lib/databases.ts`; the statement
is built by `buildCellUpdate` in `src/lib/sql.ts`.

### Ad-hoc views

The **+ New View** button opens a new view tab holding its own editable query
(e.g. a join across relations); each tab's query persists as you switch around.
A view has no primary key, so its results are **read-only**:
`query(..., { readOnly: true })` builds fields with no `field` accessor
(`getValue` only), which is the grid's marker for a non-editable cell.

Double-click a view tab to name it. On commit the view is persisted in the
DuckDB catalog via `CREATE OR REPLACE VIEW "<name>" AS <query>`
(`buildCreateView` in `src/lib/sql.ts`), so it can be queried by name like any
other relation.

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
