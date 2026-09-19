import * as React from "react";
import { Moon, Search, Sun } from "lucide-react";

import {
  CanvasDataGrid,
  createOrders,
  orderColumns,
  searchableFields,
  type SelectionRange,
} from "@/components/datagrid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./index.css";

const ROW_COUNT = 50_000;

function useDarkMode() {
  const [dark, setDark] = React.useState(() =>
    typeof document === "undefined" ? false : document.documentElement.classList.contains("dark"),
  );
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return [dark, setDark] as const;
}

interface SelectionSummary {
  label: string;
  cells: number;
}

function summarize(selection: SelectionRange, headers: readonly string[]): SelectionSummary {
  const rowMin = Math.min(selection.anchorRow, selection.focusRow);
  const rowMax = Math.max(selection.anchorRow, selection.focusRow);
  const colMin = Math.min(selection.anchorCol, selection.focusCol);
  const colMax = Math.max(selection.anchorCol, selection.focusCol);
  const rows = rowMax - rowMin + 1;
  const cols = colMax - colMin + 1;
  const header = headers[colMin] ?? "—";
  const label = cols === 1 && rows === 1 ? `${header} · row ${rowMin + 1}` : `${header} · rows ${rowMin + 1}–${rowMax + 1}`;
  return { label, cells: rows * cols };
}

export function App() {
  const rows = React.useMemo(() => createOrders(ROW_COUNT), []);
  const columns = React.useMemo(() => orderColumns, []);
  const [query, setQuery] = React.useState("");
  const [dark, setDark] = useDarkMode();
  const [selection, setSelection] = React.useState<SelectionRange | null>(null);
  const [frameMs, setFrameMs] = React.useState(0);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => searchableFields.some((field) => String(row[field]).toLowerCase().includes(needle)));
  }, [rows, query]);

  const headers = React.useMemo(() => columns.map((c) => c.header), [columns]);
  const summary = React.useMemo(() => (selection ? summarize(selection, headers) : null), [selection, headers]);

  const handleStats = React.useCallback((ms: number) => setFrameMs(ms), []);
  const handleSelection = React.useCallback((next: SelectionRange) => setSelection(next), []);

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold tracking-tight">Sprintsheet</h1>
          <p className="text-xs text-muted-foreground">
            Canvas-rendered data grid · {ROW_COUNT.toLocaleString()} rows × {columns.length} columns
          </p>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter rows…"
            className="h-9 w-52 pl-8 sm:w-64"
            spellCheck={false}
          />
        </div>

        <div className="hidden items-center gap-4 text-xs text-muted-foreground md:flex">
          <span className="tabular-nums">{filtered.length.toLocaleString()} rows</span>
          <span className="tabular-nums">{frameMs.toFixed(1)} ms/frame</span>
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

      <main className="min-h-0 flex-1 p-3 sm:p-4">
        <div className="h-full overflow-hidden rounded-xl border bg-card shadow-sm">
          <CanvasDataGrid
            rows={filtered}
            columns={columns}
            onStats={handleStats}
            onSelectionChange={handleSelection}
            className="h-full"
          />
        </div>
      </main>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
        {summary ? (
          <span className="tabular-nums">
            <span className="font-medium text-foreground">{summary.label}</span>
            {summary.cells > 1 ? ` · ${summary.cells.toLocaleString()} cells` : ""}
          </span>
        ) : (
          <span>Arrow keys to move · type to edit</span>
        )}
        <span className="ml-auto hidden sm:inline">
          Double-click to edit · drag headers to resize · click headers to sort · ⌘/Ctrl+C and ⌘/Ctrl+V
        </span>
      </footer>
    </div>
  );
}

export default App;
