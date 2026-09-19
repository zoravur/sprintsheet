/**
 * Scrollbar geometry.
 *
 * Kept pure so the thumb maths can be unit-tested without a DOM. All values are
 * CSS pixels; `viewport` is the visible length of the scroll axis, `content` is
 * the full scrollable length.
 */

export interface ThumbMetrics {
  /** Length of the thumb along the axis. */
  thumb: number;
  /** Range the thumb's leading edge can occupy (viewport - thumb). */
  travel: number;
  /** Maximum scroll offset (content - viewport). */
  maxScroll: number;
  /** Thumb offset from the start of the track. */
  position: number;
}

export function computeThumb(viewport: number, content: number, scroll: number, minThumb: number): ThumbMetrics {
  const safeViewport = Math.max(0, viewport);
  const safeContent = Math.max(safeViewport, content);
  const maxScroll = safeContent - safeViewport;

  if (maxScroll <= 0) {
    return { thumb: safeViewport, travel: 0, maxScroll: 0, position: 0 };
  }

  const proportional = (safeViewport / safeContent) * safeViewport;
  const thumb = Math.min(safeViewport, Math.max(minThumb, proportional));
  const travel = Math.max(0, safeViewport - thumb);
  const clampedScroll = Math.max(0, Math.min(maxScroll, scroll));
  const position = travel === 0 ? 0 : (clampedScroll / maxScroll) * travel;

  return { thumb, travel, maxScroll, position };
}

/** Convert a thumb travel offset into a scroll offset. */
export function thumbToScroll(position: number, travel: number, maxScroll: number): number {
  if (travel <= 0 || maxScroll <= 0) return 0;
  const clamped = Math.max(0, Math.min(travel, position));
  return (clamped / travel) * maxScroll;
}

/** Apply a drag delta (px) to a starting scroll offset. */
export function dragScroll(startScroll: number, delta: number, travel: number, maxScroll: number): number {
  if (travel <= 0 || maxScroll <= 0) return startScroll;
  const next = startScroll + (delta / travel) * maxScroll;
  return Math.max(0, Math.min(maxScroll, next));
}
