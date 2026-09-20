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
 * Scrolling is the browser's own: a transparent native scroll surface is layered
 * over the body, and the component only mirrors its `scrollLeft/Top` into a ref
 * to paint the canvas. The frozen header/gutter/corner stay on the canvas (behind
 * the surface), so momentum, overscroll and scroll chaining all come for free.
 * Hover and column-resize-in-progress also stay here — presentation, not document
 * state.
 */

import * as React from "react";

import { cn } from "@/lib/utils";

import { Axis } from "./layout";
import { drawGrid, RESIZE_HANDLE_PX } from "./renderer";
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
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;
    const sync = () => {
      const w = Math.max(0, wrapper.clientWidth);
      const h = Math.max(0, wrapper.clientHeight);
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
    ro.observe(wrapper);
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
    // The scroller is inset to the body, so its client box *is* the visible body.
    const bodyW = scroller.clientWidth;
    const bodyH = scroller.clientHeight;
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

  // ---- wheel over the frozen strips ---------------------------------------
  // The body scrolls natively (the scroller is the pointer target there, so the
  // browser owns momentum/overscroll). The header/gutter/corner are painted on
  // the canvas, which is *not* inside the scroller, so a wheel event landing
  // there would do nothing. Forward only those, leaving the body to the browser.
  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      if (scroller.contains(event.target as Node)) return; // native handles the body
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
  // These handlers are bound to both the canvas (which owns the frozen
  // header/gutter/corner strips) and the native scroll surface (which owns the
  // body). Only the topmost element under the pointer fires, so there is no
  // double-handling; coordinates come from `localPoint` either way.
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    wrapperRef.current?.focus();
    // Pointer capture lets the marquee/resize gestures keep tracking outside the
    // element. Touch is deliberately left uncaptured so the browser can pan the
    // scroll surface natively.
    const mouse = event.pointerType === "mouse";
    if (mouse) event.currentTarget.setPointerCapture(event.pointerId);
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

    // Body: collapse to the pressed cell. Mouse presses continue into a marquee;
    // touch just selects (so a tap works) and leaves the pan to the browser. Any
    // open edit is committed by the model as part of `selectCell`.
    const cell = cellAt(x, y);
    dragAnchorRef.current = cell;
    dragRef.current = mouse;
    run({ type: "selectCell", row: cell.row, col: cell.col });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
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

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
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
    const target = event.currentTarget;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
  };

  const handlePointerLeave = () => {
    if (dragRef.current) return;
    if (hoverRef.current.row === -1 && hoverRef.current.col === -1) return;
    hoverRef.current = NO_HOVER;
    setHover(NO_HOVER);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
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
   * keep it.
   *
   * Everything about *what a key means* lives here and in the model, never in a
   * second place. The view's only edit-specific knowledge is which keys the
   * field keeps (returned as `null`); that a navigation ends the edit is the
   * model's `ENDS_EDIT` rule. Edit mode therefore doesn't split the view into
   * two regimes, so there is exactly one keydown handler.
   *
   * That shape is what killed the old "Tab while editing skips a cell" bug.
   * Back then the editor owned "Tab = commit then scan" while the wrapper kept
   * an `if (editing) return` guard; committing clears `editing` synchronously,
   * so the same event bubbled on and navigated a second time. Deleting the
   * extra handler was a *consequence* of moving the policy into the model — the
   * principled change is what removed the bug, not the deletion.
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
      {/* Canvas sits behind: it paints the frozen header/gutter/corner strips and
          the body, and owns pointer handling for the strips. */}
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0 block touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
      />

      {/* Native scroll surface, layered on top of the body so the browser owns
          momentum, overscroll and scroll chaining. It is inset to the body
          (below the header, right of the gutter) so its scrollbars land there
          and the frozen strips stay interactive on the canvas. */}
      <div
        ref={scrollerRef}
        className="grid-scroll absolute overflow-scroll"
        style={{ left: gutterWidth, top: headerHeight, right: 0, bottom: 0 }}
        onScroll={syncScroll}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
      >
        <div style={{ width: colAxis.total, height: rowAxis.total }} aria-hidden />
      </div>

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
    </div>
  );
}
