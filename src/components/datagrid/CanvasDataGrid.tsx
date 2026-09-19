/**
 * <CanvasDataGrid /> — a canvas view over the headless {@link SpreadsheetModel}.
 *
 * The component owns *no* document state. It:
 *  1. creates a `SpreadsheetModel` and subscribes with `useSyncExternalStore`;
 *  2. turns DOM events into {@link Command}s and dispatches them;
 *  3. turns the returned {@link Effect}s (reveal / focusGrid / edited) into view
 *     side effects (scrolling, DOM focus, callbacks);
 *  4. paints the model state to a single 2D canvas inside one rAF.
 *
 * Scroll offsets, hover and column-resize-in-progress stay here because they are
 * presentation, not document state.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

import { Axis } from "./layout";
import { drawGrid, RESIZE_HANDLE_PX } from "./renderer";
import { computeThumb, dragScroll, thumbToScroll } from "./scrollbar";
import { SpreadsheetModel, type Command, type Effect } from "./spreadsheet";
import { getGridTheme, refreshGridTheme, type GridMetrics, type GridTheme } from "./theme";
import { normalizeSelection, type CellAddress, type ColumnDef, type SelectionRange, type SortState } from "./types";

export interface GridStats {
  /** How long the last canvas paint took, in ms. */
  frameMs: number;
  /** Inclusive bounds of the rows currently drawn. */
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

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
    value: unknown;
    previous: unknown;
  }) => void;
  onSelectionChange?: (selection: SelectionRange) => void;
  /** Throttled (~5/s) report of frame cost + which rows/cols are on screen. */
  onStats?: (stats: GridStats) => void;
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
  // ---- model --------------------------------------------------------------
  const modelRef = React.useRef<SpreadsheetModel<Row> | null>(null);
  if (modelRef.current === null) {
    modelRef.current = new SpreadsheetModel<Row>(rows as Row[], columns as ColumnDef<Row>[]);
  }
  const model = modelRef.current;
  const state = React.useSyncExternalStore(model.subscribe, model.getState);

  // Push prop changes into the model (guarded so mount doesn't churn).
  React.useEffect(() => {
    if (model.getState().rows !== rows) model.dispatch({ type: "setRows", rows: rows as Row[] });
  }, [model, rows]);
  React.useEffect(() => {
    if (model.getState().columns !== columns) model.dispatch({ type: "setColumns", columns: columns as ColumnDef<Row>[] });
  }, [model, columns]);

  // ---- presentational state ----------------------------------------------
  const [hover, setHover] = React.useState<CellAddress>(NO_HOVER);
  const [resizeCol, setResizeCol] = React.useState(-1);
  const [scrollState, setScrollState] = React.useState({ x: 0, y: 0 });

  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const editorRef = React.useRef<HTMLInputElement>(null);
  const ctxRef = React.useRef<CanvasRenderingContext2D | null>(null);

  const sizeRef = React.useRef({ w: 0, h: 0, dpr: 1 });
  const scrollRef = React.useRef({ x: 0, y: 0 });
  const themeRef = React.useRef<GridTheme>(getGridTheme());
  const metricsRef = React.useRef<GridMetrics>({ rowHeight, headerHeight, gutterWidth });
  const hoverRef = React.useRef<CellAddress>(NO_HOVER);
  const resizeColRef = React.useRef(-1);
  const dragRef = React.useRef(false);
  const dragAnchorRef = React.useRef<CellAddress>({ row: 0, col: 0 });
  const resizeSessionRef = React.useRef<ResizeSession | null>(null);
  const pendingSortRef = React.useRef(-1);
  const lastStatsRef = React.useRef(0);
  const onStatsRef = React.useRef(onStats);
  const onCellEditRef = React.useRef(onCellEdit);
  const onSelectionChangeRef = React.useRef(onSelectionChange);
  const snapshotRef = React.useRef<Snapshot>({
    columns: state.columns as readonly ColumnDef<any>[],
    rows: state.view as readonly any[],
    colAxis: Axis.variable(state.widths),
    rowAxis: Axis.uniform(state.view.length, rowHeight),
    selection: state.selection,
    sort: state.sort,
    hover: NO_HOVER,
    resizeCol: -1,
    editing: null,
  });

  onStatsRef.current = onStats;
  onCellEditRef.current = onCellEdit;
  onSelectionChangeRef.current = onSelectionChange;
  metricsRef.current = { rowHeight, headerHeight, gutterWidth };

  // ---- derived layout -----------------------------------------------------
  const colAxis = React.useMemo(() => Axis.variable(state.widths), [state.widths]);
  const rowAxis = React.useMemo(() => Axis.uniform(state.view.length, rowHeight), [state.view.length, rowHeight]);

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
    const bodyH = Math.max(0, sizeRef.current.h - metricsRef.current.headerHeight);
    const bodyW = Math.max(0, sizeRef.current.w - metricsRef.current.gutterWidth);
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
  }, []);

  const scheduleDraw = React.useCallback(() => {
    if (rafRef.current !== 0) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawRef.current();
    });
  }, []);

  const syncScroll = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scrollRef.current.x = scroller.scrollLeft;
    scrollRef.current.y = scroller.scrollTop;
    if (model.getState().editing) setScrollState({ x: scroller.scrollLeft, y: scroller.scrollTop });
    scheduleDraw();
  }, [model, scheduleDraw]);

  // Refresh the draw snapshot after every render, then queue a paint.
  React.useLayoutEffect(() => {
    snapshotRef.current = {
      columns: state.columns as readonly ColumnDef<any>[],
      rows: state.view as readonly any[],
      colAxis,
      rowAxis,
      selection: state.selection,
      sort: state.sort,
      hover,
      resizeCol: resizeColRef.current,
      editing: state.editing ? { row: state.editing.row, col: state.editing.col } : null,
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

  // ---- geometry helpers ---------------------------------------------------
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const cellAt = (x: number, y: number): CellAddress => ({
    row: rowAxis.indexAt(scrollRef.current.y + (y - headerHeight)),
    col: colAxis.indexAt(scrollRef.current.x + (x - gutterWidth)),
  });

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

  // ---- command dispatch + effects ----------------------------------------
  const applyEffects = (effects: Effect<Row>[], options?: { refocus?: boolean }) => {
    const refocus = options?.refocus ?? true;
    for (const effect of effects) {
      switch (effect.type) {
        case "reveal":
          ensureVisible(effect.row, effect.col);
          break;
        case "focusGrid":
          if (refocus) requestAnimationFrame(() => wrapperRef.current?.focus());
          break;
        case "edited":
          onCellEditRef.current?.({
            row: effect.row,
            rowIndex: effect.rowIndex,
            column: effect.column,
            value: effect.value,
            previous: effect.previous,
          });
          break;
      }
    }
  };

  const run = (command: Command<Row>, options?: { refocus?: boolean }) => {
    applyEffects(model.dispatch(command), options);
  };

  // ---- custom scrollbars --------------------------------------------------
  const vThumbRef = React.useRef<HTMLDivElement>(null);
  const hThumbRef = React.useRef<HTMLDivElement>(null);
  const vBarRef = React.useRef({ thumb: 0, travel: 1, maxScroll: 0 });
  const hBarRef = React.useRef({ thumb: 0, travel: 1, maxScroll: 0 });

  const updateScrollbars = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

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

  // ---- wheel forwarding ---------------------------------------------------
  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
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

  // ---- selection-change notification --------------------------------------
  const prevSelectionRef = React.useRef<SelectionRange | null>(null);
  React.useEffect(() => {
    if (prevSelectionRef.current === state.selection) return;
    prevSelectionRef.current = state.selection;
    onSelectionChangeRef.current?.(state.selection);
  }, [state.selection]);

  // ---- editing editor focus ----------------------------------------------
  const editingKey = state.editing ? `${state.editing.row}:${state.editing.col}` : null;
  React.useEffect(() => {
    if (!editingKey) return;
    const input = editorRef.current;
    if (!input) return;
    input.focus();
    if (model.getState().editing?.selectAll) input.select();
    else {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingKey]);

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
      run({ type: "selectRow", row: rowAxis.indexAt(scrollRef.current.y + (y - headerHeight)) });
      return;
    }

    // Corner: select everything.
    if (x < gutterWidth && y < headerHeight) {
      run({ type: "selectAll" });
      return;
    }

    // Body: collapse to the pressed cell and begin a marquee. Any open edit is
    // committed by the model as part of `selectCell`.
    const cell = cellAt(x, y);
    dragAnchorRef.current = cell;
    dragRef.current = true;
    run({ type: "selectCell", row: cell.row, col: cell.col });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const resize = resizeSessionRef.current;
    if (resize) {
      const width = resize.startWidth + (event.clientX - resize.startX);
      run({ type: "setColumnWidth", col: resize.col, width });
      return;
    }

    const { x, y } = localPoint(event);

    if (dragRef.current) {
      if (x < gutterWidth || y < headerHeight) return;
      const cell = cellAt(x, y);
      const anchor = dragAnchorRef.current;
      run({ type: "selectRange", anchor, extent: cell, focus: anchor });
      return;
    }

    const row = y >= headerHeight ? rowAxis.indexAt(scrollRef.current.y + (y - headerHeight)) : -1;
    const col = x >= gutterWidth ? colAxis.indexAt(scrollRef.current.x + (x - gutterWidth)) : -1;
    if (row !== hover.row || col !== hover.col) {
      const next = { row, col };
      hoverRef.current = next;
      setHover(next);
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (resizeSessionRef.current) {
      resizeSessionRef.current = null;
      resizeColRef.current = -1;
      setResizeCol(-1);
      scheduleDraw();
    }
    if (dragRef.current) {
      // The gesture is over — anchor and extent are interchangeable, so
      // normalise anchor to the top-left and extent to the bottom-right.
      const sel = model.getState().selection;
      const rect = normalizeSelection(sel);
      run({
        type: "selectRange",
        anchor: { row: rect.rowMin, col: rect.colMin },
        extent: { row: rect.rowMax, col: rect.colMax },
        focus: { row: sel.focusRow, col: sel.focusCol },
      });
    }
    dragRef.current = false;
    if (pendingSortRef.current >= 0) {
      const col = state.columns[pendingSortRef.current];
      pendingSortRef.current = -1;
      if (col) run({ type: "sortColumn", columnId: col.id });
    }
    canvasRef.current?.releasePointerCapture(event.pointerId);
  };

  const handlePointerLeave = () => {
    if (dragRef.current) return;
    if (hoverRef.current.row === -1 && hoverRef.current.col === -1) return;
    hoverRef.current = NO_HOVER;
    setHover(NO_HOVER);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(event);
    if (x < gutterWidth || y < headerHeight) return;
    const cell = cellAt(x, y);
    run({ type: "selectCell", row: cell.row, col: cell.col });
    run({ type: "beginEdit", seed: null, selectAll: true });
  };

  const clampCol = (i: number) => Math.max(0, Math.min(state.columns.length - 1, i));

  // ---- keyboard -----------------------------------------------------------
  const selectionToTsv = (): string => {
    const rect = normalizeSelection(model.getState().selection);
    const view = model.getState().view;
    const lines: string[] = [];
    for (let r = rect.rowMin; r <= Math.min(rect.rowMax, view.length - 1); r++) {
      const cells: string[] = [];
      for (let c = rect.colMin; c <= rect.colMax; c++) {
        const column = state.columns[c];
        const row = view[r];
        if (!column || row === undefined) {
          cells.push("");
          continue;
        }
        const value = column.getValue
          ? column.getValue(row, r)
          : column.field
            ? ((row as Record<string, unknown>)[column.field] as unknown)
            : null;
        cells.push(value === null || value === undefined ? "" : String(value));
      }
      lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  };

  /**
   * Translate a key event into a command, or `null` to let the browser/field
   * keep it. While editing, the field owns text entry, the arrow keys and
   * Delete/Backspace — everything else maps to a command, and the model commits
   * the edit before applying it.
   *
   * There is deliberately exactly ONE keydown handler in this component (the
   * wrapper's `handleKeyDown`). An earlier version also handled keys on the
   * editor field; because committing clears `editing` synchronously, the same
   * event then bubbled here with the guard no longer tripping, so the
   * navigation ran a second time — pressing Tab while editing skipped a cell.
   * Adding a second handler brings that back.
   */
  const commandForKeyDown = (event: React.KeyboardEvent): Command<Row> | null => {
    const editing = model.getState().editing !== null;
    const mod = event.ctrlKey || event.metaKey;
    const extend = event.shiftKey;
    const sel = model.getState().selection;
    const pageRows = Math.max(1, Math.floor((sizeRef.current.h - headerHeight) / rowHeight) - 1);
    const lastRow = state.view.length - 1;
    const lastCol = state.columns.length - 1;

    switch (event.key) {
      case "ArrowUp":
        return editing ? null : { type: "move", dr: -1, dc: 0, extend };
      case "ArrowDown":
        return editing ? null : { type: "move", dr: 1, dc: 0, extend };
      case "ArrowLeft":
        return editing ? null : { type: "move", dr: 0, dc: -1, extend };
      case "ArrowRight":
        return editing ? null : { type: "move", dr: 0, dc: 1, extend };
      case "PageUp":
        return { type: "move", dr: -pageRows, dc: 0, extend };
      case "PageDown":
        return { type: "move", dr: pageRows, dc: 0, extend };
      case "Home":
        return { type: "moveTo", row: mod ? 0 : sel.focusRow, col: 0, extend };
      case "End":
        return { type: "moveTo", row: mod ? lastRow : sel.focusRow, col: lastCol, extend };
      case "Tab":
        return { type: "scan", axis: "h", forward: !extend };
      case "Enter":
        return { type: "scan", axis: "v", forward: !extend };
      case "Escape":
        return editing ? { type: "cancelEdit" } : null;
      case "F2":
        return editing ? null : { type: "beginEdit", seed: null, selectAll: true };
      case "Delete":
      case "Backspace":
        return editing ? null : { type: "clearCells" };
      default:
        if (event.key.length === 1 && !mod && !event.altKey) {
          return editing ? null : { type: "beginEdit", seed: event.key, selectAll: false };
        }
        return null;
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (state.view.length === 0 || state.columns.length === 0) return;
    const editing = model.getState().editing !== null;
    const mod = event.ctrlKey || event.metaKey;

    // Clipboard / select-all: while editing the field handles these natively.
    if (mod && (event.key === "c" || event.key === "C")) {
      if (editing) return;
      event.preventDefault();
      void navigator.clipboard?.writeText(selectionToTsv());
      return;
    }
    if (mod && (event.key === "v" || event.key === "V")) {
      if (editing) return;
      event.preventDefault();
      void (async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) run({ type: "paste", text });
        } catch {
          /* clipboard permission denied — ignore */
        }
      })();
      return;
    }
    if (mod && (event.key === "a" || event.key === "A")) {
      if (editing) return;
      event.preventDefault();
      run({ type: "selectAll" });
      return;
    }

    const command = commandForKeyDown(event);
    if (!command) return; // the field / browser keeps this key
    event.preventDefault();
    run(command);
  };

  // ---- editor overlay position -------------------------------------------
  const editor = state.editing;
  const editorStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!editor) return undefined;
    const column = state.columns[editor.col];
    const align = column?.align ?? (column && ["number", "integer", "currency", "percent"].includes(column.type ?? "") ? "right" : "left");
    return {
      left: gutterWidth + colAxis.offsetOf(editor.col) - scrollState.x,
      top: headerHeight + rowAxis.offsetOf(editor.row) - scrollState.y,
      width: colAxis.sizeOf(editor.col),
      height: rowAxis.sizeOf(editor.row),
      padding: "0 9px",
      textAlign: align as React.CSSProperties["textAlign"],
    };
  }, [editor, state.columns, colAxis, rowAxis, scrollState, gutterWidth, headerHeight]);

  const contentWidth = gutterWidth + colAxis.total;
  const contentHeight = headerHeight + rowAxis.total;

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      role="grid"
      aria-rowcount={state.view.length}
      aria-colcount={state.columns.length}
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

      {editor && editorStyle ? (
        /* No onKeyDown here on purpose: keys are handled once, on the wrapper. */
        <input
          ref={editorRef}
          value={editor.text}
          onChange={(event) => run({ type: "setEditText", text: event.target.value })}
          onBlur={() => run({ type: "commitEdit" }, { refocus: false })}
          spellCheck={false}
          className="absolute z-20 box-border select-text rounded-[3px] border-2 border-ring bg-background text-[13px] leading-none text-foreground shadow-sm outline-none"
          style={editorStyle}
        />
      ) : null}

      <div
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
