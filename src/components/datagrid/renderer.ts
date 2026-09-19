/**
 * Canvas renderer.
 *
 * Pure-ish: given a fully-resolved {@link RenderInput} it paints one frame and
 * returns the time it took (ms). It never reads React state — the component
 * snapshots everything into a plain object first. Drawing is limited to the
 * visible row/column ranges (plus one row/col of overscan), so cost is bounded
 * by viewport size, not dataset size.
 */

import { defaultAlign, formatCell, isEmptyValue, resolveValue } from "./format";
import type { Axis } from "./layout";
import {
  BODY_FONT,
  CELL_PADDING_X,
  GUTTER_FONT,
  HEADER_FONT,
  NUMERIC_FONT,
  type GridMetrics,
  type GridTheme,
} from "./theme";
import { normalizeSelection, type CellAddress, type ColumnDef, type SelectionRange, type SortState } from "./types";

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
  columns: readonly ColumnDef<any>[];
  rows: readonly any[];
  colAxis: Axis;
  rowAxis: Axis;
  selection: SelectionRange;
  sort: SortState | null;
  hover: CellAddress;
  resizeCol: number;
  editing: CellAddress | null;
  theme: GridTheme;
  metrics: GridMetrics;
}

const HOVER_STYLE_ALPHA = 0.5;
const SELECTION_ALPHA = 0.12;
const HEADER_ACTIVE_ALPHA = 0.35;
const ELLIPSIS = "\u2026";

/** Snap a CSS-pixel coordinate to a crisp 1px line under the active transform. */
function crisp(value: number, dpr: number): number {
  if (dpr >= 2) return Math.round(value * dpr) / dpr;
  return Math.round(value) + 0.5;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0 || text.length === 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  if (ctx.measureText(ELLIPSIS).width > maxWidth) return "";

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const candidate = text.slice(0, mid) + ELLIPSIS;
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? "" : text.slice(0, lo) + ELLIPSIS;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSortArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: "asc" | "desc",
  color: string,
): void {
  const size = 4;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (direction === "asc") {
    ctx.moveTo(x, y + size);
    ctx.lineTo(x + size * 2, y + size);
    ctx.lineTo(x + size, y - size + 1);
  } else {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size * 2, y - size);
    ctx.lineTo(x + size, y + size - 1);
  }
  ctx.closePath();
  ctx.fill();
}

export function drawGrid(input: RenderInput): void {
  const { ctx, width, height, dpr, theme, metrics } = input;
  const { headerHeight, gutterWidth } = metrics;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const bodyX = gutterWidth;
  const bodyY = headerHeight;
  const bodyW = Math.max(0, width - gutterWidth);
  const bodyH = Math.max(0, height - headerHeight);

  if (input.columns.length === 0 || input.rows.length === 0) {
    ctx.fillStyle = theme.mutedForeground;
    ctx.font = BODY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(input.columns.length === 0 ? "No columns" : "No rows", bodyX + bodyW / 2, bodyY + bodyH / 2);
    ctx.textAlign = "left";
    drawHeaders(input, bodyX, bodyY, bodyW, bodyH);
    return;
  }

  const rect = normalizeSelection(input.selection);
  const rowRange = input.rowAxis.visibleRange(input.scrollY, bodyH, 1);
  const colRange = input.colAxis.visibleRange(input.scrollX, bodyW, 1);

  ctx.save();
  ctx.beginPath();
  ctx.rect(bodyX, bodyY, bodyW, bodyH);
  ctx.clip();

  // --- Row hover highlight (behind everything else) ---
  if (input.hover.row >= 0 && input.hover.row < input.rowAxis.count) {
    const y = bodyY + input.rowAxis.offsetOf(input.hover.row) - input.scrollY;
    ctx.globalAlpha = HOVER_STYLE_ALPHA;
    ctx.fillStyle = theme.accent;
    ctx.fillRect(bodyX, y, bodyW, input.rowAxis.sizeOf(input.hover.row));
    ctx.globalAlpha = 1;
  }

  // --- Selection fill (one rect for the whole range; canvas clips it) ---
  const sx0 = bodyX + input.colAxis.offsetOf(rect.colMin) - input.scrollX;
  const sx1 = bodyX + input.colAxis.offsetOf(rect.colMax + 1) - input.scrollX;
  const sy0 = bodyY + input.rowAxis.offsetOf(rect.rowMin) - input.scrollY;
  const sy1 = bodyY + input.rowAxis.offsetOf(rect.rowMax + 1) - input.scrollY;
  ctx.globalAlpha = SELECTION_ALPHA;
  ctx.fillStyle = theme.primary;
  ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
  ctx.globalAlpha = 1;

  // --- Grid lines ---
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = colRange.start; c <= colRange.end; c++) {
    const x = crisp(bodyX + input.colAxis.offsetOf(c) - input.scrollX, dpr);
    ctx.moveTo(x, bodyY);
    ctx.lineTo(x, bodyY + bodyH);
  }
  for (let r = rowRange.start; r <= rowRange.end; r++) {
    const y = crisp(bodyY + input.rowAxis.offsetOf(r) - input.scrollY, dpr);
    ctx.moveTo(bodyX, y);
    ctx.lineTo(bodyX + bodyW, y);
  }
  ctx.stroke();

  // --- Cell text ---
  ctx.textBaseline = "middle";
  const editingRow = input.editing?.row ?? -1;
  const editingCol = input.editing?.col ?? -1;

  for (let c = colRange.start; c < colRange.end; c++) {
    const col = input.columns[c];
    if (!col) continue;
    const colLeft = bodyX + input.colAxis.offsetOf(c) - input.scrollX;
    const colWidth = input.colAxis.sizeOf(c);
    const align = col.align ?? defaultAlign(col.type);
    const numeric = align === "right";
    const avail = colWidth - CELL_PADDING_X * 2;
    const isBadge = col.type === "badge";

    for (let r = rowRange.start; r < rowRange.end; r++) {
      const row = input.rows[r];
      if (row === undefined) continue;
      // The cell under the editor is hidden so the DOM input shows through.
      if (r === editingRow && c === editingCol) continue;

      const rowTop = bodyY + input.rowAxis.offsetOf(r) - input.scrollY;
      const rowH = input.rowAxis.sizeOf(r);
      const value = resolveValue(col, row, r);
      const text = formatCell(col, value, row, r);

      if (isBadge && text.length > 0) {
        ctx.font = BODY_FONT;
        const textWidth = ctx.measureText(text).width;
        const pillW = Math.min(colWidth - CELL_PADDING_X, textWidth + 16);
        const pillH = Math.min(rowH - 8, 20);
        const pillX = colLeft + (colWidth - pillW) / 2;
        const pillY = rowTop + (rowH - pillH) / 2;
        ctx.fillStyle = theme.accent;
        roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
        ctx.fill();
        ctx.fillStyle = theme.accentForeground;
        ctx.textAlign = "left";
        ctx.fillText(fitText(ctx, text, pillW - 12), pillX + 6, rowTop + rowH / 2);
        continue;
      }

      ctx.font = numeric ? NUMERIC_FONT : BODY_FONT;
      if (isEmptyValue(value)) {
        ctx.fillStyle = theme.mutedForeground;
      } else {
        ctx.fillStyle = theme.foreground;
      }

      if (align === "right") {
        ctx.textAlign = "right";
        ctx.fillText(fitText(ctx, text, avail), colLeft + colWidth - CELL_PADDING_X, rowTop + rowH / 2);
      } else if (align === "center") {
        ctx.textAlign = "center";
        ctx.fillText(fitText(ctx, text, avail), colLeft + colWidth / 2, rowTop + rowH / 2);
      } else {
        ctx.textAlign = "left";
        ctx.fillText(fitText(ctx, text, avail), colLeft + CELL_PADDING_X, rowTop + rowH / 2);
      }
    }
  }

  // --- Selection outline + fill handle ---
  const clampX0 = Math.max(sx0, bodyX);
  const clampY0 = Math.max(sy0, bodyY);
  const clampX1 = Math.min(sx1, bodyX + bodyW);
  const clampY1 = Math.min(sy1, bodyY + bodyH);
  if (clampX1 > clampX0 && clampY1 > clampY0) {
    ctx.strokeStyle = theme.primary;
    ctx.lineWidth = 2;
    ctx.strokeRect(clampX0 + 1, clampY0 + 1, clampX1 - clampX0 - 2, clampY1 - clampY0 - 2);
    if (input.editing === null) {
      ctx.fillStyle = theme.primary;
      ctx.fillRect(clampX1 - 4, clampY1 - 4, 6, 6);
    }
  }

  ctx.restore();

  drawHeaders(input, bodyX, bodyY, bodyW, bodyH);
}

function drawHeaders(
  input: RenderInput,
  bodyX: number,
  bodyY: number,
  bodyW: number,
  bodyH: number,
): void {
  const { ctx, theme, metrics, dpr } = input;
  const { headerHeight, gutterWidth } = metrics;
  const rect = normalizeSelection(input.selection);
  const activeRow = input.selection.focusRow;

  // ---------- Column headers (frozen to the top) ----------
  ctx.save();
  ctx.beginPath();
  ctx.rect(bodyX, 0, bodyW, headerHeight);
  ctx.clip();
  ctx.font = HEADER_FONT;
  ctx.textBaseline = "middle";

  const colRange = input.colAxis.visibleRange(input.scrollX, bodyW, 1);
  for (let c = colRange.start; c < colRange.end; c++) {
    const col = input.columns[c];
    if (!col) continue;
    const colLeft = bodyX + input.colAxis.offsetOf(c) - input.scrollX;
    const colWidth = input.colAxis.sizeOf(c);
    const isActive = c >= rect.colMin && c <= rect.colMax;

    if (isActive || c === input.hover.col) {
      ctx.globalAlpha = c === input.hover.col ? HOVER_STYLE_ALPHA : HEADER_ACTIVE_ALPHA;
      ctx.fillStyle = theme.accent;
      ctx.fillRect(colLeft, 0, colWidth, headerHeight);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = theme.mutedForeground;
    ctx.textAlign = "left";
    const sorted = input.sort?.columnId === col.id;
    const sortPad = sorted ? 14 : 0;
    const label = fitText(ctx, col.header.toUpperCase(), colWidth - CELL_PADDING_X * 2 - sortPad);
    ctx.fillText(label, colLeft + CELL_PADDING_X, headerHeight / 2);

    if (sorted && input.sort) {
      const labelWidth = ctx.measureText(label).width;
      drawSortArrow(ctx, colLeft + CELL_PADDING_X + labelWidth + 6, headerHeight / 2, input.sort.direction, theme.foreground);
    }

    // Resize affordance.
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x = crisp(colLeft, dpr);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, headerHeight);
    ctx.stroke();

    if (c === input.resizeCol) {
      ctx.strokeStyle = theme.primary;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const rx = crisp(colLeft + colWidth, dpr);
      ctx.moveTo(rx, 0);
      ctx.lineTo(rx, headerHeight);
      ctx.stroke();
    }
  }
  ctx.restore();

  // ---------- Row gutter (frozen to the left) ----------
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, bodyY, gutterWidth, bodyH);
  ctx.clip();
  ctx.font = GUTTER_FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";

  const rowRange = input.rowAxis.visibleRange(input.scrollY, bodyH, 1);
  for (let r = rowRange.start; r < rowRange.end; r++) {
    const rowTop = bodyY + input.rowAxis.offsetOf(r) - input.scrollY;
    const rowH = input.rowAxis.sizeOf(r);
    const isActive = r >= rect.rowMin && r <= rect.rowMax;

    if (isActive || r === input.hover.row) {
      ctx.globalAlpha = r === input.hover.row ? HOVER_STYLE_ALPHA : HEADER_ACTIVE_ALPHA;
      ctx.fillStyle = theme.accent;
      ctx.fillRect(0, rowTop, gutterWidth, rowH);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = isActive ? theme.foreground : theme.mutedForeground;
    ctx.fillText(String(r + 1), gutterWidth - CELL_PADDING_X, rowTop + rowH / 2);

    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const y = crisp(rowTop, dpr);
    ctx.moveTo(0, y);
    ctx.lineTo(gutterWidth, y);
    ctx.stroke();
  }
  ctx.restore();

  // ---------- Corner + frozen separators ----------
  ctx.fillStyle = theme.muted;
  ctx.fillRect(0, 0, gutterWidth, headerHeight);

  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gy = crisp(bodyY, dpr);
  ctx.moveTo(0, gy);
  ctx.lineTo(bodyX + bodyW, gy);

  const gx = crisp(bodyX, dpr);
  ctx.moveTo(gx, 0);
  ctx.lineTo(gx, bodyY + bodyH);
  ctx.stroke();

  // Active-cell marker in the corner gutter.
  ctx.font = HEADER_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = theme.mutedForeground;
  ctx.fillText(String(activeRow + 1), gutterWidth / 2, headerHeight / 2);
}

/** Re-export so the component can compute grab areas without duplicating maths. */
export const RESIZE_HANDLE_PX = 6;
