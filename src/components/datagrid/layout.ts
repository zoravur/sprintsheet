/**
 * Layout maths for the grid.
 *
 * `Axis` maps a 1-D index space (rows or columns) to pixel offsets and back.
 * Rows use the uniform fast path (O(1) index/offset, no allocation even for a
 * million rows); columns use the variable path backed by a prefix-sum array and
 * binary search, which keeps column resizing free while still being cheap to
 * query. Both paths share the same `visibleRange` API so the renderer never has
 * to know which one it is talking to.
 */

export interface VisibleRange {
  /** First index that should be drawn (inclusive). */
  start: number;
  /** Index one past the last that should be drawn (exclusive). */
  end: number;
}

export class Axis {
  readonly count: number;
  readonly total: number;

  private readonly uniformSize: number | null;
  private readonly offsets: Float64Array | null;

  private constructor(count: number, uniformSize: number | null, offsets: Float64Array | null, total: number) {
    this.count = count;
    this.uniformSize = uniformSize;
    this.offsets = offsets;
    this.total = total;
  }

  /** Fast O(1) axis for fixed-size tracks (e.g. rows). */
  static uniform(count: number, size: number): Axis {
    if (count < 0 || !Number.isFinite(size) || size <= 0) {
      return new Axis(0, size || 1, null, 0);
    }
    return new Axis(count, size, null, count * size);
  }

  /** Prefix-sum axis for variable-size tracks (e.g. resizable columns). */
  static variable(sizes: readonly number[]): Axis {
    const count = sizes.length;
    const offsets = new Float64Array(count + 1);
    let running = 0;
    for (let i = 0; i < count; i++) {
      running += sizes[i] ?? 0;
      offsets[i + 1] = running;
    }
    return new Axis(count, null, offsets, running);
  }

  /** Pixel size of track `i`, or 0 when out of range. */
  sizeOf(i: number): number {
    if (i < 0 || i >= this.count) return 0;
    if (this.uniformSize !== null) return this.uniformSize;
    return (this.offsets as Float64Array)[i + 1]! - (this.offsets as Float64Array)[i]!;
  }

  /** Pixel offset of the leading edge of track `i` (clamped to the ends). */
  offsetOf(i: number): number {
    if (this.uniformSize !== null) {
      const clamped = Math.max(0, Math.min(this.count, i));
      return clamped * this.uniformSize;
    }
    const clamped = Math.max(0, Math.min(this.count, i));
    return (this.offsets as Float64Array)[clamped]!;
  }

  /** Index of the track containing pixel `px` (clamped to `[0, count-1]`). */
  indexAt(px: number): number {
    if (this.count === 0) return 0;
    if (px <= 0) return 0;
    if (px >= this.total) return this.count - 1;

    if (this.uniformSize !== null) {
      return Math.min(this.count - 1, Math.floor(px / this.uniformSize));
    }

    const offsets = this.offsets as Float64Array;
    // Find the largest `i` with offsets[i] <= px.
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid + 1]! <= px) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(this.count - 1, lo);
  }

  /**
   * Inclusive-start/exclusive-end range of tracks intersecting
   * `[scroll, scroll + viewport]`, padded by `overscan` tracks on each side.
   */
  visibleRange(scroll: number, viewport: number, overscan = 0): VisibleRange {
    if (this.count === 0) return { start: 0, end: 0 };
    const start = Math.max(0, this.indexAt(scroll) - overscan);
    const end = Math.min(this.count, this.indexAt(scroll + Math.max(0, viewport)) + 1 + overscan);
    return { start, end };
  }
}

/** The cell sitting at the viewport origin, plus how far into it the scroll is. */
export interface ViewportAnchor {
  row: number;
  col: number;
  /** Sub-cell pixel offset into the origin cell (0 … cell size). */
  dx: number;
  dy: number;
}

/**
 * Record which cell is at the top-left of the viewport. Call this *before* the
 * axes change, then {@link scrollForAnchor} to pin the same cell back afterward.
 */
export function anchorAt(colAxis: Axis, rowAxis: Axis, scrollX: number, scrollY: number): ViewportAnchor {
  const col = colAxis.indexAt(scrollX);
  const row = rowAxis.indexAt(scrollY);
  return {
    row,
    col,
    dx: scrollX - colAxis.offsetOf(col),
    dy: scrollY - rowAxis.offsetOf(row),
  };
}

/**
 * Scroll offsets that put `anchor` back at the viewport origin under the current
 * axes, clamped to `[0, content - viewport]` and to the valid cell range (so a
 * column/row that no longer exists falls back to the nearest one).
 */
export function scrollForAnchor(
  anchor: ViewportAnchor,
  colAxis: Axis,
  rowAxis: Axis,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const col = Math.max(0, Math.min(colAxis.count - 1, anchor.col));
  const row = Math.max(0, Math.min(rowAxis.count - 1, anchor.row));
  const maxX = Math.max(0, colAxis.total - Math.max(0, viewportW));
  const maxY = Math.max(0, rowAxis.total - Math.max(0, viewportH));
  return {
    x: Math.max(0, Math.min(maxX, colAxis.offsetOf(col) + anchor.dx)),
    y: Math.max(0, Math.min(maxY, rowAxis.offsetOf(row) + anchor.dy)),
  };
}
