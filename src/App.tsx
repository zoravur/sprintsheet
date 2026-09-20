import * as React from "react";
import { Database, Loader2, Moon, Play, Save, Search, Sun, Terminal, TriangleAlert } from "lucide-react";

import { CanvasDataGrid, normalizeSelection, type GridStats, type SelectionRange } from "@/components/datagrid";
import type { CellValue, ColumnDef } from "@/components/datagrid/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DataRow } from "@/lib/arrow";
import { resolveDatabase, TEST_DATABASES, type TestDatabase } from "@/lib/databases";
import type { SelectStatement } from "@/lib/duckdb-serialization.gen";
import {
  createView,
  deserializeSql,
  getRestoredViews,
  query,
  saveDatabase,
  updateCell,
  type QueryResult,
} from "@/lib/duckdb";
import { selectAllFrom } from "@/lib/sql";
import { cn } from "@/lib/utils";
import "./index.css";

/** Stable empties so the grid isn't handed a fresh array every render. */
const NO_COLUMNS: readonly ColumnDef<DataRow>[] = [];
const NO_ROWS: readonly DataRow[] = [];

/** Debounce for autosave: a quiet period after the last change. */
const AUTOSAVE_DELAY_MS = 800;

type QueryStatus = "running" | "ready" | "error";
type SaveStatus = "idle" | "saving" | "saved" | "error";

/** An ad-hoc query tab. Its `sql` is persisted per tab; `name` persists a view. */
interface ViewTab {
  id: string;
  /** DuckDB view name — empty until the tab is named. */
  name: string;
  sql: string;
}

/** Which tab is showing: a base relation (editable) or a view (read-only). */
type ActiveTab = { kind: "relation"; name: string } | { kind: "view"; id: string };

interface QueryRunner {
  sql: string;
  result: QueryResult | null;
  status: QueryStatus;
  error: string | null;
  /** Resolves `true` when the statement ran successfully (fresh, not stale). */
  run: (statement: string | SelectStatement, options: { readOnly: boolean }) => Promise<boolean>;
}

/** Executes SQL, tagging the result editable (relation) or read-only (view). */
function useQueryRunner(db: TestDatabase): QueryRunner {
  const [sql, setSql] = React.useState("");
  const [result, setResult] = React.useState<QueryResult | null>(null);
  const [status, setStatus] = React.useState<QueryStatus>("running");
  const [error, setError] = React.useState<string | null>(null);
  const runId = React.useRef(0);

  const run = React.useCallback(
    (statement: string | SelectStatement, options: { readOnly: boolean }): Promise<boolean> => {
      const id = ++runId.current;
      setError(null);
      // A built SELECT is rendered to SQL by DuckDB first; a string is already SQL.
      const pending =
        typeof statement === "string" ? Promise.resolve(statement.trim()) : deserializeSql(db, statement);
      return pending
        .then((text) => {
          if (runId.current !== id) return false;
          setSql(text);
          if (!text) {
            // Blank query (a fresh view): clear the grid, nothing to run.
            setResult(null);
            setStatus("ready");
            return true;
          }
          setStatus("running");
          return query(db, text, { readOnly: options.readOnly }).then((next) => {
            if (runId.current !== id) return false;
            setResult(next);
            setStatus("ready");
            return true;
          });
        })
        .catch((cause: unknown) => {
          if (runId.current !== id) return false;
          setStatus("error");
          setError(cause instanceof Error ? cause.message : String(cause));
          return false;
        });
    },
    [db],
  );

  return { sql, result, status, error, run };
}

function useDarkMode() {
  const [dark, setDark] = React.useState(() =>
    typeof document === "undefined" ? false : document.documentElement.classList.contains("dark"),
  );
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return [dark, setDark] as const;
}

/** The database selected by `?db=` (falling back to the default). */
function useDatabaseFromUrl(): TestDatabase {
  return React.useMemo(() => {
    const search = typeof window === "undefined" ? "" : window.location.search;
    return resolveDatabase(new URLSearchParams(search).get("db"));
  }, []);
}

interface SelectionSummary {
  label: string;
  cells: number;
}

function summarize(selection: SelectionRange, headers: readonly string[]): SelectionSummary {
  const rect = normalizeSelection(selection);
  const rows = rect.rowMax - rect.rowMin + 1;
  const cols = rect.colMax - rect.colMin + 1;
  const active = headers[selection.focusCol] ?? "—";
  const range = `${headers[rect.colMin] ?? "—"}…${headers[rect.colMax] ?? "—"}`;
  const label =
    cols === 1 && rows === 1
      ? `${active} · row ${selection.focusRow + 1}`
      : `${range} · rows ${rect.rowMin + 1}–${rect.rowMax + 1} · active ${active} ${selection.focusRow + 1}`;
  return { label, cells: rows * cols };
}

const TAB_CLASS = "border-b-2 px-3 py-2 font-mono text-xs transition-colors";

export function App() {
  const db = useDatabaseFromUrl();
  const [active, setActive] = React.useState<ActiveTab>({ kind: "relation", name: db.relations[0]!.name });
  const [views, setViews] = React.useState<ViewTab[]>([]);
  const nextViewId = React.useRef(1);
  const { sql, result, status, error, run } = useQueryRunner(db);

  const relation = active.kind === "relation" ? (db.relations.find((r) => r.name === active.name) ?? null) : null;
  const view = active.kind === "view" ? (views.find((v) => v.id === active.id) ?? null) : null;

  // Keep the latest views reachable from the (tab-keyed) run effect.
  const viewsRef = React.useRef(views);
  viewsRef.current = views;

  // ---- persistence -------------------------------------------------------
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("idle");
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Dump edited tables + view tabs and persist them to the Bun server. */
  const saveNow = React.useCallback(async () => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaveStatus("saving");
    try {
      await saveDatabase(db);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, [db]);

  /** Autosave: coalesce a burst of changes into a single save. */
  const scheduleSave = React.useCallback(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void saveNow();
    }, AUTOSAVE_DELAY_MS);
  }, [saveNow]);

  // Cmd/Ctrl+S forces an immediate save.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveNow]);

  // Restore the view tabs saved in a previous session.
  React.useEffect(() => {
    let cancelled = false;
    getRestoredViews(db)
      .then((restored) => {
        if (cancelled || restored.length === 0) return;
        setViews(restored.map((saved, index) => ({ id: `saved-${index}`, name: saved.name, sql: saved.query })));
      })
      .catch(() => {
        /* no snapshot yet — load fresh */
      });
    return () => {
      cancelled = true;
    };
  }, [db]);

  const [filter, setFilter] = React.useState("");
  const [dark, setDark] = useDarkMode();
  const [selection, setSelection] = React.useState<SelectionRange | null>(null);
  const [stats, setStats] = React.useState<GridStats | null>(null);
  const [writeError, setWriteError] = React.useState<string | null>(null);
  const [viewError, setViewError] = React.useState<string | null>(null);

  // Tab rename (double-click a view tab).
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const renamingRef = React.useRef<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");

  const columns = result?.columns ?? NO_COLUMNS;
  const rows = result?.rows ?? NO_ROWS;
  const running = status === "running";

  /** Persist a named view into the DuckDB catalog. */
  const persistView = React.useCallback(
    (name: string, statement: string): Promise<void> => {
      const trimmedName = name.trim();
      if (!trimmedName || !statement.trim()) return Promise.resolve();
      return createView(db, trimmedName, statement)
        .then(() => {
          setViewError(null);
          scheduleSave();
        })
        .catch((cause: unknown) => {
          setViewError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [db, scheduleSave],
  );

  const runView = React.useCallback(
    (target: ViewTab) => {
      void run(target.sql, { readOnly: true }).then((ok) => {
        if (ok && target.name && target.sql.trim()) void persistView(target.name, target.sql);
      });
    },
    [run, persistView],
  );

  // (Re)run whenever the active tab changes; relations are editable, views read-only.
  const activeKey = active.kind === "relation" ? `relation:${active.name}` : `view:${active.id}`;
  React.useEffect(() => {
    if (active.kind === "relation") {
      void run(selectAllFrom(active.name), { readOnly: false });
      return;
    }
    const target = viewsRef.current.find((v) => v.id === active.id);
    if (target) runView(target);
    else void run("", { readOnly: true });
    // `activeKey` stands in for the whole active tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, run, runView]);

  const filtered = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => columns.some((col) => String(row[col.id] ?? "").toLowerCase().includes(needle)));
  }, [rows, columns, filter]);

  const headers = React.useMemo(() => columns.map((c) => c.header), [columns]);
  const summary = React.useMemo(() => (selection ? summarize(selection, headers) : null), [selection, headers]);

  const handleStats = React.useCallback((next: GridStats) => setStats(next), []);
  const handleSelection = React.useCallback((next: SelectionRange) => setSelection(next), []);

  // Committed cell edits write back to the table; views are read-only, so no wiring.
  const handleCellEdit = React.useCallback(
    (info: { row: DataRow; column: ColumnDef<DataRow>; value: unknown; previous: unknown }) => {
      if (!relation) return;
      const { primaryKey } = relation;
      const primaryKeyValue = info.column.id === primaryKey ? info.previous : info.row[primaryKey];
      void updateCell(db, relation, primaryKeyValue as CellValue, info.column.id, info.value as CellValue)
        .then(() => {
          setWriteError(null);
          scheduleSave();
        })
        .catch((cause: unknown) => setWriteError(cause instanceof Error ? cause.message : String(cause)));
    },
    [db, relation, scheduleSave],
  );

  const openNewView = () => {
    const id = `view-${nextViewId.current++}`;
    setViews((prev) => [...prev, { id, name: "", sql: "" }]);
    setActive({ kind: "view", id });
    setViewError(null);
    scheduleSave();
  };

  const updateViewSql = (id: string, statement: string) => {
    setViews((prev) => prev.map((v) => (v.id === id ? { ...v, sql: statement } : v)));
    scheduleSave();
  };

  const handleRun = () => {
    if (active.kind === "relation") {
      void run(selectAllFrom(active.name), { readOnly: false });
      return;
    }
    if (view) runView(view);
  };

  const startRename = (target: ViewTab) => {
    renamingRef.current = target.id;
    setRenamingId(target.id);
    setRenameDraft(target.name);
  };

  const cancelRename = () => {
    renamingRef.current = null;
    setRenamingId(null);
  };

  const commitRename = () => {
    const id = renamingRef.current;
    if (id == null) return;
    renamingRef.current = null;
    setRenamingId(null);
    const name = renameDraft.trim();
    const target = viewsRef.current.find((v) => v.id === id);
    setViews((prev) => prev.map((v) => (v.id === id ? { ...v, name } : v)));
    if (target && name) void persistView(name, target.sql);
  };

  const queryLabel = sql || (view ? view.name || "untitled view" : "");

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold tracking-tight">Sprintsheet</h1>
          <p className="text-xs text-muted-foreground">
            DuckDB-wasm · {db.label} · {rows.length.toLocaleString()} rows × {columns.length} columns
            {queryLabel ? ` · ${queryLabel}` : ""}
          </p>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => void saveNow()}
          title="Save database to the server (⌘/Ctrl+S)"
        >
          {saveStatus === "saving" ? (
            <Loader2 className="animate-spin" />
          ) : saveStatus === "error" ? (
            <TriangleAlert className="text-destructive" />
          ) : (
            <Save />
          )}
          <span className="hidden sm:inline">
            {saveStatus === "saving"
              ? "saving…"
              : saveStatus === "error"
                ? "save failed"
                : saveStatus === "saved"
                  ? "saved"
                  : "save"}
          </span>
        </Button>

        <nav aria-label="Databases" className="flex items-center gap-1 text-[11px]">
          {TEST_DATABASES.map((candidate) => (
            <a
              key={candidate.id}
              href={`?db=${candidate.id}`}
              title={`Load the "${candidate.id}" test database`}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono transition-colors",
                candidate.id === db.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              ?db={candidate.id}
            </a>
          ))}
        </nav>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter rows…"
            className="h-9 w-52 pl-8 sm:w-64"
            spellCheck={false}
          />
        </div>

        <div className="hidden items-center gap-4 text-xs text-muted-foreground lg:flex">
          <span className="tabular-nums">{filtered.length.toLocaleString()} rows</span>
          {stats ? (
            <span className="tabular-nums">
              {stats.firstRow + 1}–{stats.lastRow + 1}
            </span>
          ) : null}
          <span className="tabular-nums">{stats ? `${stats.frameMs.toFixed(1)} ms/frame` : "—"}</span>
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={() => setDark((value) => !value)}
          aria-label="Toggle color theme"
        >
          {dark ? <Sun /> : <Moon />}
        </Button>
      </header>

      {/* Relation queries are fixed; a view holds its own editable query. */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2">
        <Terminal className="size-4 shrink-0 text-muted-foreground" />
        {view ? (
          <Input
            value={view.sql}
            onChange={(event) => updateViewSql(view.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleRun();
              }
            }}
            spellCheck={false}
            autoFocus
            aria-label="SQL query"
            placeholder={'Write a SQL query — e.g. SELECT * FROM "sales"'}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
        ) : (
          <code
            aria-label="SQL query"
            className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1 font-mono text-xs text-foreground"
          >
            {sql}
          </code>
        )}
        <Button size="sm" variant="outline" onClick={handleRun} disabled={running}>
          {running ? <Loader2 className="animate-spin" /> : <Play />}
          Run
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {status === "error" && error ? (
            <span className="text-destructive">{error}</span>
          ) : writeError ? (
            <span className="text-destructive">update failed: {writeError}</span>
          ) : viewError ? (
            <span className="text-destructive">view not saved: {viewError}</span>
          ) : result ? (
            <>
              {result.rows.length.toLocaleString()} rows · {result.elapsedMs.toFixed(1)} ms
            </>
          ) : null}
        </span>
      </div>

      <main className="min-h-0 flex-1 p-3 sm:p-4">
        <div className="relative h-full overflow-hidden rounded-xl border bg-card shadow-sm">
          <CanvasDataGrid
            rows={filtered}
            columns={columns}
            onCellEdit={relation ? handleCellEdit : undefined}
            onStats={handleStats}
            onSelectionChange={handleSelection}
            className="h-full"
          />

          {result === null && running ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card/80 text-sm text-muted-foreground backdrop-blur-sm">
              <Loader2 className="size-5 animate-spin" />
              <span>Booting DuckDB-wasm & running the query…</span>
            </div>
          ) : null}

          {result === null && status === "error" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card/90 px-6 text-center">
              <TriangleAlert className="size-6 text-destructive" />
              <p className="text-sm font-medium text-foreground">Query failed</p>
              <p className="max-w-lg font-mono text-xs text-muted-foreground">{error}</p>
            </div>
          ) : null}

          {result === null && status === "ready" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Terminal className="size-6 opacity-60" />
              <span>Write a query above and press Run</span>
            </div>
          ) : null}
        </div>
      </main>

      <footer className="flex items-end gap-x-4 border-t bg-muted/20 pl-2 pr-4 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-end gap-1 overflow-x-auto">
          <div role="tablist" aria-label={`${db.label} relations`} className="flex items-end gap-1">
            {db.relations.map((candidate) => {
              const isActive = active.kind === "relation" && candidate.name === active.name;
              return (
                <button
                  key={candidate.name}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActive({ kind: "relation", name: candidate.name })}
                  className={cn(
                    TAB_CLASS,
                    isActive
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
                  )}
                >
                  {candidate.name}
                </button>
              );
            })}
          </div>

          <div role="tablist" aria-label="Views" className="flex items-end gap-1">
            {views.map((candidate) => {
              if (renamingId === candidate.id) {
                return (
                  <input
                    key={candidate.id}
                    autoFocus
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                    spellCheck={false}
                    placeholder="view name"
                    aria-label="View name"
                    className={cn(TAB_CLASS, "w-32 border-primary bg-transparent text-foreground outline-none")}
                  />
                );
              }
              const isActive = active.kind === "view" && candidate.id === active.id;
              return (
                <button
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  title="Double-click to rename"
                  onClick={() => setActive({ kind: "view", id: candidate.id })}
                  onDoubleClick={() => startRename(candidate)}
                  className={cn(
                    TAB_CLASS,
                    isActive
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
                    !candidate.name && "italic",
                  )}
                >
                  {candidate.name || "untitled"}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={openNewView}
            className={cn(TAB_CLASS, "border-transparent text-primary hover:border-primary/40")}
          >
            + New View
          </button>
        </div>

        <span className="ml-auto pb-2 tabular-nums">
          {summary ? (
            <>
              <span className="font-medium text-foreground">{summary.label}</span>
              {summary.cells > 1 ? ` · ${summary.cells.toLocaleString()} cells` : ""}
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Database className="size-3.5" />
              {relation ? (
                <>edits write back via UPDATE "{relation.primaryKey}" · double-click or F2 to edit</>
              ) : (
                <>view · read-only · double-click a view tab to name it</>
              )}
            </span>
          )}
        </span>
      </footer>
    </div>
  );
}

export default App;
