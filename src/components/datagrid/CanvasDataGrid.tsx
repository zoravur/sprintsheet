/**
 * <CanvasDataGrid /> — a virtualized spreadsheet datatable painted on a single
 * 2D canvas.
 *
 * Design notes:
 *  - React owns *semantic* state (selection, sort, column widths, the open
 *    editor). It never re-renders per scroll frame.
 *  - The canvas repaints imperatively inside a single rAF, reading a snapshot
 *    that is refreshed after every React render. So a scroll or a drag only
 *    costs one canvas paint, not a reconciliation.
 *  - Native scrollbars are reused: a spacer element gives the scroller its
 *    range, and the canvas is a sibling overlay sized to the content viewport
 *    (excluding scrollbars). Wheel events are forwarded to the scroller.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

import { compareValues, defaultAlign, parseEditedValue, resolveValue } from "./format";
import { Axis } from "./layout";
import { drawGrid, RESIZE_HANDLE_PX } from "./renderer";
import { computeThumb, dragScroll, thumbToScroll } from "./scrollbar";
import { getGridTheme, refreshGridTheme, type GridMetrics, type GridTheme } from "./theme";
import {
  EMPTY_SELECTION,
  normalizeSelection,
  type CellAddress,
  type CellValue,
  type ColumnDef,
  type SelectionRange,
  type SortState,
} from "./types";

export interface CanvasDataGridProps<Row> {
  rows: readonly Row[];
  columns: readonly ColumnDef<Row>[];
  rowHeight?: number;
  headerHeight?: number;
  gutterWidth?: number;
  className?: string;
  /** Fired after an inline edit or paste mutates a row. */
  onCellEdit?: (info: {
    row: Row;
    rowIndex: number;
    column: ColumnDef<Row>;
    value: CellValue;
    previous: CellValue;
  }) => void;
  onSelectionChange?: (selection: SelectionRange) => void;
  /** Throttled (~5/s) report of frame cost + which rows/cols are on screen. */
  onStats?: (stats: GridStats) => void;
}

export interface GridStats {
  /** How long the last canvas paint took, in ms. */
  frameMs: number;
  /** Inclusive bounds of the rows currently drawn. */
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

interface Snapshot {
  columns: readonly ColumnDef<any>[];
  rows: readonly any[];
  colAxis: Axis;
  rowAxis: Axis;
  selection: SelectionRange;
  sort: SortState | null;
  hover: CellAddress;
  resizeCol: number;
  editing: CellAddress | null;
}

interface ResizeSession {
  col: number;
  startX: number;
  startWidth: number;
}

const NO_HOVER: CellAddress = { row: -1, col: -1 };

/** Thickness of the custom scrollbar strips reserved on the right/bottom. */
const SCROLLBAR = 12;
/** Smallest thumb length so a huge dataset still yields a grabbable handle. */
const MIN_THUMB = 28;

function editTextFor(col: ColumnDef<any>, value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export function CanvasDataGrid<Row>({
  rows,
  columns,
  rowHeight = 28,
  headerHeight = 34,
  gutterWidth = 56,
  className,
  onCellEdit,
  onSelectionChange,
  onStats,
}: CanvasDataGridProps<Row>) {
  // ---- derived layout -----------------------------------------------------
  const [widths, setWidths] = React.useState<number[]>(() => columns.map((c) => c.width));
  const colAxis = React.useMemo(() => Axis.variable(widths), [widths]);
  const rowAxis = React.useMemo(() => Axis.uniform(rows.length, rowHeight), [rows.length, rowHeight]);
  const metrics = React.useMemo<GridMetrics>(
    () => ({ rowHeight, headerHeight, gutterWidth }),
    [rowHeight, headerHeight, gutterWidth],
  );

  const columnSignature = columns.map((c) => `${c.id}:${c.width}`).join("|");
  React.useEffect(() => {
    setWidths((prev) => (prev.length === columns.length ? prev : columns.map((c) => c.width)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnSignature]);

  // ---- selection / sort state --------------------------------------------
  const [sort, setSort] = React.useState<SortState | null>(null);
  const [selection, setSelectionState] = React.useState<SelectionRange>(EMPTY_SELECTION);
  const [hover, setHover] = React.useState<CellAddress>(NO_HOVER);
  const [resizeCol, setResizeCol] = React.useState(-1);
  const [editing, setEditing] = React.useState<CellAddress | null>(null);
  const [editText, setEditText] = React.useState("");
  const [scrollState, setScrollState] = React.useState({ x: 0, y: 0 });

  // ---- refs ---------------------------------------------------------------
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const editorRef = React.useRef<HTMLInputElement>(null);
  const ctxRef = React.useRef<CanvasRenderingContext2D | null>(null);

  const sizeRef = React.useRef({ w: 0, h: 0, dpr: 1 });
  const scrollRef = React.useRef({ x: 0, y: 0 });
  const themeRef = React.useRef<GridTheme>(getGridTheme());
  const metricsRef = React.useRef(metrics);
  const selectionRef = React.useRef<SelectionRange>(EMPTY_SELECTION);
  const editingRef = React.useRef<CellAddress | null>(null);
  const resizeColRef = React.useRef(-1);
  const dragRef = React.useRef(false);
  const resizeSessionRef = React.useRef<ResizeSession | null>(null);
  const pendingSortRef = React.useRef(-1);
  const selectAllOnFocusRef = React.useRef(true);
  const lastStatsRef = React.useRef(0);
  const onStatsRef = React.useRef(onStats);
  const onCellEditRef = React.useRef(onCellEdit);
  const onSelectionChangeRef = React.useRef(onSelectionChange);
  const snapshotRef = React.useRef<Snapshot>({
    columns: columns as readonly ColumnDef<any>[],
    rows: rows as readonly any[],
    colAxis,
    rowAxis,
    selection,
    sort,
    hover,
    resizeCol,
    editing,
  });

  onStatsRef.current = onStats;
  onCellEditRef.current = onCellEdit;
  onSelectionChangeRef.current = onSelectionChange;

  // ---- sorted view (copies pointers only, never the rows themselves) ------
  const sortedView = React.useMemo<readonly Row[]>(() => {
    if (!sort) return rows;
    const index = columns.findIndex((c) => c.id === sort.columnId);
    const col = columns[index];
    if (!col) return rows;
    const decorated = rows.map((row, i) => ({ row, i }));
    decorated.sort((a, b) => {
      const cmp = compareValues(resolveValue(col, a.row, a.i), resolveValue(col, b.row, b.i));
      return sort.direction === "asc" ? cmp : -cmp;
    });
    return decorated.map((d) => d.row);
  }, [rows, columns, sort]);

  // keep refs in sync with the latest committed state
  React.useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  React.useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  metricsRef.current = metrics;

  // Clamp the selection when the dataset shape changes (e.g. filtering).
  React.useEffect(() => {
    setSelectionState((prev) => {
      const maxRow = Math.max(0, rows.length - 1);
      const maxCol = Math.max(0, columns.length - 1);
      const next: SelectionRange = {
        anchorRow: Math.min(prev.anchorRow, maxRow),
        anchorCol: Math.min(prev.anchorCol, maxCol),
        focusRow: Math.min(prev.focusRow, maxRow),
        focusCol: Math.min(prev.focusCol, maxCol),
      };
      if (
        next.anchorRow === prev.anchorRow &&
        next.anchorCol === prev.anchorCol &&
        next.focusRow === prev.focusRow &&
        next.focusCol === prev.focusCol
      ) {
        return prev;
      }
      selectionRef.current = next;
      return next;
    });
  }, [rows.length, columns.length]);

  // ---- imperative draw ----------------------------------------------------
  const drawRef = React.useRef<() => void>(() => {});
  const rafRef = React.useRef(0);
  const updateScrollbarsRef = React.useRef<() => void>(() => {});

  const draw = React.useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const snap = snapshotRef.current;
    const t0 = performance.now();
    drawGrid({
      ctx,
      width: sizeRef.current.w,
      height: sizeRef.current.h,
      dpr: sizeRef.current.dpr,
      scrollX: scrollRef.current.x,
      scrollY: scrollRef.current.y,
      theme: themeRef.current,
      metrics: metricsRef.current,
      columns: snap.columns,
      rows: snap.rows,
      colAxis: snap.colAxis,
      rowAxis: snap.rowAxis,
      selection: snap.selection,
      sort: snap.sort,
      hover: snap.hover,
      resizeCol: snap.resizeCol,
      editing: snap.editing,
    });
    const frameMs = performance.now() - t0;
    const bodyH = Math.max(0, sizeRef.current.h - headerHeight);
    const bodyW = Math.max(0, sizeRef.current.w - gutterWidth);
    const rows = snap.rowAxis.visibleRange(scrollRef.current.y, bodyH, 0);
    const cols = snap.colAxis.visibleRange(scrollRef.current.x, bodyW, 0);
    updateScrollbarsRef.current();
    const now = performance.now();
    if (now - lastStatsRef.current > 200) {
      lastStatsRef.current = now;
      onStatsRef.current?.({
        frameMs,
        firstRow: rows.start,
        lastRow: Math.max(rows.start, rows.end - 1),
        firstCol: cols.start,
        lastCol: Math.max(cols.start, cols.end - 1),
      });
    }
  }, [headerHeight, gutterWidth]);

  const scheduleDraw = React.useCallback(() => {
    if (rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  }, []);

  /** Pull scroll offsets out of the scroller and queue a repaint. */
  const syncScroll = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scrollRef.current.x = scroller.scrollLeft;
    scrollRef.current.y = scroller.scrollTop;
    if (editingRef.current) setScrollState({ x: scroller.scrollLeft, y: scroller.scrollTop });
    scheduleDraw();
  }, [scheduleDraw]);

  // Refresh the snapshot after every render, then queue a paint.
  React.useLayoutEffect(() => {
    snapshotRef.current = {
      columns: columns as readonly ColumnDef<any>[],
      rows: sortedView as readonly any[],
      colAxis,
      rowAxis,
      selection,
      sort,
      hover,
      resizeCol: resizeColRef.current,
      editing,
    };
    drawRef.current = draw;
    scheduleDraw();
  });

  // ---- canvas sizing ------------------------------------------------------
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    ctxRef.current = canvas.getContext("2d", { alpha: false });
  }, []);

  React.useEffect(() => {
    const scroller = scrollerRef.current;
    const canvas = canvasRef.current;
    if (!scroller || !canvas) return;
    const sync = () => {
      const w = Math.max(0, scroller.clientWidth);
      const h = Math.max(0, scroller.clientHeight);
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      sizeRef.current = { w, h, dpr };
      scheduleDraw();
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(scroller);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [scheduleDraw]);

  // ---- theme (re-read on dark-mode toggle) --------------------------------
  React.useEffect(() => {
    themeRef.current = refreshGridTheme();
    scheduleDraw();
    const observer = new MutationObserver(() => {
      themeRef.current = refreshGridTheme();
      scheduleDraw();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [scheduleDraw]);

  // ---- wheel forwarding (native scrollbars + forward wheel) ---------------
  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // let the browser pinch-zoom
      const scroller = scrollerRef.current;
      if (!scroller) return;
      event.preventDefault();
      scroller.scrollLeft += event.deltaX;
      scroller.scrollTop += event.deltaY;
      syncScroll();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [syncScroll]);

  // ---- custom scrollbars --------------------------------------------------
  // Thumbs are positioned imperatively (transform only) so a fast drag costs
  // zero React renders — the same principle as the canvas repaint.
  const vTrackRef = React.useRef<HTMLDivElement>(null);
  const hTrackRef = React.useRef<HTMLDivElement>(null);
  const vThumbRef = React.useRef<HTMLDivElement>(null);
  const hThumbRef = React.useRef<HTMLDivElement>(null);
  const vBarRef = React.useRef({ thumb: 0, travel: 1, maxScroll: 0 });
  const hBarRef = React.useRef({ thumb: 0, travel: 1, maxScroll: 0 });

  const updateScrollbars = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // Vertical.
    const v = computeThumb(scroller.clientHeight, scroller.scrollHeight, scroller.scrollTop, MIN_THUMB);
    const vBar = vBarRef.current;
    const vEl = vThumbRef.current;
    if (vEl) {
      if (vBar.thumb !== v.thumb) vEl.style.height = `${v.thumb}px`;
      vEl.style.transform = `translateY(${v.position}px)`;
      vEl.style.opacity = v.maxScroll > 0 ? "1" : "0";
    }
    vBar.thumb = v.thumb;
    vBar.travel = v.travel;
    vBar.maxScroll = v.maxScroll;

    // Horizontal.
    const h = computeThumb(scroller.clientWidth, scroller.scrollWidth, scroller.scrollLeft, MIN_THUMB);
    const hBar = hBarRef.current;
    const hEl = hThumbRef.current;
    if (hEl) {
      if (hBar.thumb !== h.thumb) hEl.style.width = `${h.thumb}px`;
      hEl.style.transform = `translateX(${h.position}px)`;
      hEl.style.opacity = h.maxScroll > 0 ? "1" : "0";
    }
    hBar.thumb = h.thumb;
    hBar.travel = h.travel;
    hBar.maxScroll = h.maxScroll;
  }, []);
  updateScrollbarsRef.current = updateScrollbars;

  const startBarDrag = (event: React.PointerEvent<HTMLDivElement>, axis: "v" | "h") => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const bar = axis === "v" ? vBarRef.current : hBarRef.current;
    if (bar.maxScroll <= 0 || bar.travel <= 0) return;
    event.preventDefault();

    const thumbEl = event.currentTarget;
    const start = axis === "v" ? event.clientY : event.clientX;
    const startScroll = axis === "v" ? scroller.scrollTop : scroller.scrollLeft;
    const { travel, maxScroll } = bar;

    thumbEl.setPointerCapture(event.pointerId);
    const move = (native: PointerEvent) => {
      const delta = (axis === "v" ? native.clientY : native.clientX) - start;
      const next = dragScroll(startScroll, delta, travel, maxScroll);
      if (axis === "v") scroller.scrollTop = next;
      else scroller.scrollLeft = next;
      syncScroll();
    };
    const end = (native: PointerEvent) => {
      thumbEl.releasePointerCapture?.(native.pointerId);
      thumbEl.removeEventListener("pointermove", move);
      thumbEl.removeEventListener("pointerup", end);
      thumbEl.removeEventListener("pointercancel", end);
    };
    thumbEl.addEventListener("pointermove", move);
    thumbEl.addEventListener("pointerup", end);
    thumbEl.addEventListener("pointercancel", end);
  };

  const jumpBar = (event: React.PointerEvent<HTMLDivElement>, axis: "v" | "h") => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const bar = axis === "v" ? vBarRef.current : hBarRef.current;
    if (bar.maxScroll <= 0 || bar.travel <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const along = axis === "v" ? event.clientY - rect.top : event.clientX - rect.left;
    const scroll = thumbToScroll(along - bar.thumb / 2, bar.travel, bar.maxScroll);
    if (axis === "v") scroller.scrollTop = scroll;
    else scroller.scrollLeft = scroll;
    syncScroll();
  };

  // ---- geometry helpers ---------------------------------------------------
  const clampRow = React.useCallback((i: number) => Math.max(0, Math.min(rows.length - 1, i)), [rows.length]);
  const clampCol = React.useCallback((i: number) => Math.max(0, Math.min(columns.length - 1, i)), [columns.length]);

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const applySelection = React.useCallback(
    (next: SelectionRange) => {
      const prev = selectionRef.current;
      if (
        prev.anchorRow === next.anchorRow &&
        prev.anchorCol === next.anchorCol &&
        prev.focusRow === next.focusRow &&
        prev.focusCol === next.focusCol
      ) {
        return;
      }
      selectionRef.current = next;
      setSelectionState(next);
      onSelectionChangeRef.current?.(next);
    },
    [],
  );

  const ensureVisible = (row: number, col: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const bodyW = scroller.clientWidth - gutterWidth;
    const bodyH = scroller.clientHeight - headerHeight;
    const left = colAxis.offsetOf(col);
    const right = left + colAxis.sizeOf(col);
    if (left < scroller.scrollLeft) scroller.scrollLeft = left;
    else if (right > scroller.scrollLeft + bodyW) scroller.scrollLeft = right - bodyW;

    const top = rowAxis.offsetOf(row);
    const bottom = top + rowAxis.sizeOf(row);
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + bodyH) scroller.scrollTop = bottom - bodyH;
    syncScroll();
  };

  // ---- editing ------------------------------------------------------------
  const beginEdit = (addr: CellAddress, seed: string | null, selectAll: boolean) => {
    const col = columns[addr.col];
    const row = sortedView[addr.row];
    if (!col || row === undefined || col.field === undefined) return;
    applySelection({ anchorRow: addr.row, anchorCol: addr.col, focusRow: addr.row, focusCol: addr.col });
    const scroller = scrollerRef.current;
    if (scroller) setScrollState({ x: scroller.scrollLeft, y: scroller.scrollTop });
    selectAllOnFocusRef.current = selectAll;
    setEditText(seed ?? editTextFor(col, resolveValue(col, row, addr.row)));
    editingRef.current = addr;
    setEditing(addr);
    scheduleDraw();
  };

  const cancelEdit = () => {
    if (!editingRef.current) return;
    editingRef.current = null;
    setEditing(null);
    scheduleDraw();
    requestAnimationFrame(() => wrapperRef.current?.focus());
  };

  const commitEdit = (move?: { dr: number; dc: number }, refocus = true) => {
    const addr = editingRef.current;
    if (!addr) {
      if (move) moveFocus(move.dr, move.dc, false);
      return;
    }
    editingRef.current = null;
    const col = columns[addr.col];
    const row = sortedView[addr.row];
    if (col && row !== undefined && col.field !== undefined) {
      const previous = resolveValue(col, row, addr.row);
      const value = parseEditedValue(col, editText);
      if (value !== previous) {
        (row as Record<string, unknown>)[col.field] = value;
        onCellEditRef.current?.({
          row,
          rowIndex: addr.row,
          column: col,
          value,
          previous,
        });
      }
    }
    setEditing(null);
    if (move) moveFocus(move.dr, move.dc, false);
    scheduleDraw();
    if (refocus) requestAnimationFrame(() => wrapperRef.current?.focus());
  };

  React.useEffect(() => {
    if (!editing) return;
    const input = editorRef.current;
    if (!input) return;
    input.focus();
    if (selectAllOnFocusRef.current) input.select();
    else {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
  }, [editing]);

  // ---- keyboard -----------------------------------------------------------
  const moveFocus = (dr: number, dc: number, extend: boolean) => {
    const sel = selectionRef.current;
    const row = clampRow(sel.focusRow + dr);
    const col = clampCol(sel.focusCol + dc);
    const next: SelectionRange = extend
      ? { anchorRow: sel.anchorRow, anchorCol: sel.anchorCol, focusRow: row, focusCol: col }
      : { anchorRow: row, anchorCol: col, focusRow: row, focusCol: col };
    applySelection(next);
    ensureVisible(row, col);
  };

  const forEachSelected = (fn: (row: number, col: number) => void) => {
    const rect = normalizeSelection(selectionRef.current);
    const rowMax = Math.min(rect.rowMax, rows.length - 1);
    const colMax = Math.min(rect.colMax, columns.length - 1);
    for (let r = rect.rowMin; r <= rowMax; r++) {
      for (let c = rect.colMin; c <= colMax; c++) fn(r, c);
    }
  };

  const clearSelection = () => {
    forEachSelected((r, c) => {
      const col = columns[c];
      const row = sortedView[r];
      if (!col || row === undefined || col.field === undefined) return;
      (row as Record<string, unknown>)[col.field] = null;
    });
    scheduleDraw();
  };

  const selectionToTsv = (): string => {
    const rect = normalizeSelection(selectionRef.current);
    const rowMax = Math.min(rect.rowMax, rows.length - 1);
    const colMax = Math.min(rect.colMax, columns.length - 1);
    const lines: string[] = [];
    for (let r = rect.rowMin; r <= rowMax; r++) {
      const cells: string[] = [];
      for (let c = rect.colMin; c <= colMax; c++) {
        const col = columns[c];
        const row = sortedView[r];
        if (!col || row === undefined) {
          cells.push("");
          continue;
        }
        const value = resolveValue(col, row, r);
        cells.push(value === null || value === undefined ? "" : String(value));
      }
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  };

  const pasteText = (text: string) => {
    const start = selectionRef.current;
    const matrix = text.replace(/\r/g, "").split("\n").map((line) => line.split("\t"));
    matrix.forEach((cells, dr) => {
      cells.forEach((cellText, dc) => {
        const r = start.focusRow + dr;
        const c = start.focusCol + dc;
        if (r >= rows.length || c >= columns.length) return;
        const col = columns[c];
        const row = sortedView[r];
        if (!col || row === undefined || col.field === undefined) return;
        (row as Record<string, unknown>)[col.field] = parseEditedValue(col, cellText);
      });
    });
    scheduleDraw();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingRef.current) return;
    if (rows.length === 0 || columns.length === 0) return;

    const sel = selectionRef.current;
    const mod = event.ctrlKey || event.metaKey;
    const pageRows = Math.max(1, Math.floor((sizeRef.current.h - headerHeight) / rowHeight) - 1);

    if (mod && (event.key === "c" || event.key === "C")) {
      event.preventDefault();
      void navigator.clipboard?.writeText(selectionToTsv());
      return;
    }
    if (mod && (event.key === "v" || event.key === "V")) {
      event.preventDefault();
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) pasteText(text);
        } catch {
          /* clipboard permission denied — ignore */
        }
      })();
      return;
    }
    if (mod && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      applySelection({ anchorRow: 0, anchorCol: 0, focusRow: rows.length - 1, focusCol: columns.length - 1 });
      return;
    }

    let handled = true;

    switch (event.key) {
      case "ArrowUp":
        moveFocus(-1, 0, event.shiftKey);
        break;
      case "ArrowDown":
        moveFocus(1, 0, event.shiftKey);
        break;
      case "ArrowLeft":
        moveFocus(0, -1, event.shiftKey);
        break;
      case "ArrowRight":
        moveFocus(0, 1, event.shiftKey);
        break;
      case "PageUp":
        moveFocus(-pageRows, 0, event.shiftKey);
        break;
      case "PageDown":
        moveFocus(pageRows, 0, event.shiftKey);
        break;
      case "Home":
        moveFocus(mod ? -sel.focusRow : 0, -sel.focusCol, event.shiftKey);
        break;
      case "End":
        moveFocus(mod ? rows.length - 1 - sel.focusRow : 0, columns.length - 1 - sel.focusCol, event.shiftKey);
        break;
      case "Tab":
        moveFocus(0, event.shiftKey ? -1 : 1, false);
        break;
      case "Enter":
      case "F2":
        beginEdit({ row: sel.focusRow, col: sel.focusCol }, null, true);
        break;
      case "Delete":
      case "Backspace":
        clearSelection();
        break;
      default:
        if (event.key.length === 1 && !mod && !event.altKey) {
          beginEdit({ row: sel.focusRow, col: sel.focusCol }, event.key, false);
        } else {
          handled = false;
        }
    }
    if (handled) event.preventDefault();
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitEdit({ dr: 1, dc: 0 });
    } else if (event.key === "Tab") {
      event.preventDefault();
      commitEdit({ dr: 0, dc: event.shiftKey ? -1 : 1 });
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  };

  // ---- pointer ------------------------------------------------------------
  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    canvasRef.current?.setPointerCapture(event.pointerId);
    wrapperRef.current?.focus();
    const { x, y } = localPoint(event);

    // Column header: resize handle or (deferred) sort.
    if (y < headerHeight && x >= gutterWidth) {
      const col = clampCol(colAxis.indexAt(scrollRef.current.x + (x - gutterWidth)));
      const rightEdge = gutterWidth + colAxis.offsetOf(col) + colAxis.sizeOf(col) - scrollRef.current.x;
      if (Math.abs(x - rightEdge) <= RESIZE_HANDLE_PX) {
        resizeSessionRef.current = { col, startX: event.clientX, startWidth: colAxis.sizeOf(col) };
        resizeColRef.current = col;
        setResizeCol(col);
        scheduleDraw();
        return;
      }
      pendingSortRef.current = col;
      return;
    }

    // Row gutter: select the whole row.
    if (x < gutterWidth && y >= headerHeight) {
      const row = clampRow(rowAxis.indexAt(scrollRef.current.y + (y - headerHeight)));
      applySelection({ anchorRow: row, anchorCol: 0, focusRow: row, focusCol: Math.max(0, columns.length - 1) });
      scheduleDraw();
      return;
    }

    // Corner: select everything.
    if (x < gutterWidth && y < headerHeight) {
      applySelection({ anchorRow: 0, anchorCol: 0, focusRow: rows.length - 1, focusCol: columns.length - 1 });
      scheduleDraw();
      return;
    }

    // Body.
    if (editingRef.current) commitEdit();
    const col = clampCol(colAxis.indexAt(scrollRef.current.x + (x - gutterWidth)));
    const row = clampRow(rowAxis.indexAt(scrollRef.current.y + (y - headerHeight)));
    applySelection({ anchorRow: row, anchorCol: col, focusRow: row, focusCol: col });
    dragRef.current = true;
    scheduleDraw();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const resize = resizeSessionRef.current;
    if (resize) {
      const col = columns[resize.col];
      const min = col?.minWidth ?? 56;
      const max = col?.maxWidth ?? 800;
      const next = Math.max(min, Math.min(max, resize.startWidth + (event.clientX - resize.startX)));
      setWidths((prev) => {
        if (prev[resize.col] === next) return prev;
        const copy = prev.slice();
        copy[resize.col] = next;
        return copy;
      });
      return;
    }

    const { x, y } = localPoint(event);

    if (dragRef.current) {
      if (x < gutterWidth || y < headerHeight) return;
      const col = clampCol(colAxis.indexAt(scrollRef.current.x + (x - gutterWidth)));
      const row = clampRow(rowAxis.indexAt(scrollRef.current.y + (y - headerHeight)));
      const sel = selectionRef.current;
      applySelection({ anchorRow: sel.anchorRow, anchorCol: sel.anchorCol, focusRow: row, focusCol: col });
      return;
    }

    const row = y >= headerHeight ? clampRow(rowAxis.indexAt(scrollRef.current.y + (y - headerHeight))) : -1;
    const col = x >= gutterWidth ? clampCol(colAxis.indexAt(scrollRef.current.x + (x - gutterWidth))) : -1;
    if (row !== hover.row || col !== hover.col) setHover({ row, col });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (resizeSessionRef.current) {
      resizeSessionRef.current = null;
      resizeColRef.current = -1;
      setResizeCol(-1);
      scheduleDraw();
    }
    dragRef.current = false;
    if (pendingSortRef.current >= 0) {
      const col = columns[pendingSortRef.current];
      pendingSortRef.current = -1;
      if (col && col.sortable !== false) {
        setSort((prev) => {
          if (!prev || prev.columnId !== col.id) return { columnId: col.id, direction: "asc" };
          if (prev.direction === "asc") return { columnId: col.id, direction: "desc" };
          return null;
        });
      }
    }
    canvasRef.current?.releasePointerCapture(event.pointerId);
  };

  const handlePointerLeave = () => {
    if (dragRef.current) return;
    setHover((prev) => (prev.row === -1 && prev.col === -1 ? prev : NO_HOVER));
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(event);
    if (x < gutterWidth || y < headerHeight) return;
    const col = clampCol(colAxis.indexAt(scrollRef.current.x + (x - gutterWidth)));
    const row = clampRow(rowAxis.indexAt(scrollRef.current.y + (y - headerHeight)));
    beginEdit({ row, col }, null, true);
  };

  // ---- editor overlay position -------------------------------------------
  const editorStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!editing) return undefined;
    const col = columns[editing.col];
    const align = col ? (col.align ?? defaultAlign(col.type)) : "left";
    return {
      left: gutterWidth + colAxis.offsetOf(editing.col) - scrollState.x,
      top: headerHeight + rowAxis.offsetOf(editing.row) - scrollState.y,
      width: colAxis.sizeOf(editing.col),
      height: rowAxis.sizeOf(editing.row),
      padding: "0 9px",
      textAlign: align,
    };
  }, [editing, columns, colAxis, rowAxis, scrollState, gutterWidth, headerHeight]);

  const contentWidth = gutterWidth + colAxis.total;
  const contentHeight = headerHeight + rowAxis.total;

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      className={cn("relative select-none overflow-hidden outline-none", className)}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={scrollerRef}
        className="absolute left-0 top-0 overflow-hidden"
        style={{ right: SCROLLBAR, bottom: SCROLLBAR }}
        onScroll={syncScroll}
      >
        <div style={{ width: contentWidth, height: contentHeight }} aria-hidden />
      </div>

      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0 block touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
      />

      {editing && editorStyle ? (
        <input
          ref={editorRef}
          value={editText}
          onChange={(event) => setEditText(event.target.value)}
          onKeyDown={handleEditorKeyDown}
          onBlur={() => commitEdit(undefined, false)}
          spellCheck={false}
          className="absolute z-20 box-border select-text rounded-[3px] border-2 border-ring bg-background text-[13px] leading-none text-foreground shadow-sm outline-none"
          style={editorStyle}
        />
      ) : null}

      <div
        ref={vTrackRef}
        className="absolute right-0 top-0 touch-none"
        style={{ width: SCROLLBAR, bottom: SCROLLBAR }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) jumpBar(event, "v");
        }}
      >
        <div
          ref={vThumbRef}
          role="scrollbar"
          aria-orientation="vertical"
          onPointerDown={(event) => startBarDrag(event, "v")}
          className="absolute left-[3px] right-[3px] top-0 cursor-grab rounded-full bg-muted-foreground/40 hover:bg-muted-foreground/60 active:cursor-grabbing"
        />
      </div>

      <div
        ref={hTrackRef}
        className="absolute bottom-0 left-0 touch-none"
        style={{ height: SCROLLBAR, right: SCROLLBAR }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) jumpBar(event, "h");
        }}
      >
        <div
          ref={hThumbRef}
          role="scrollbar"
          aria-orientation="horizontal"
          onPointerDown={(event) => startBarDrag(event, "h")}
          className="absolute bottom-[3px] left-0 top-[3px] cursor-grab rounded-full bg-muted-foreground/40 hover:bg-muted-foreground/60 active:cursor-grabbing"
        />
      </div>

      <div
        className="absolute bottom-0 right-0 bg-muted-foreground/20"
        style={{ width: SCROLLBAR, height: SCROLLBAR }}
        aria-hidden
      />
    </div>
  );
}
