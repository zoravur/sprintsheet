/**
 * Theme bridge.
 *
 * Tailwind/shadcn colors live in CSS custom properties as `oklch()` strings.
 * A 2D canvas context accepts those strings directly in modern browsers, so we
 * just snapshot the computed values once and cache them. When the `dark` class
 * toggles we re-snapshot — driven by a MutationObserver from the component.
 */

export interface GridTheme {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  ring: string;
  card: string;
}

const FALLBACK: GridTheme = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  muted: "#f5f5f5",
  mutedForeground: "#737373",
  border: "#e5e5e5",
  primary: "#171717",
  primaryForeground: "#fafafa",
  accent: "#f5f5f5",
  accentForeground: "#171717",
  ring: "#a3a3a3",
  card: "#ffffff",
};

export function readGridTheme(): GridTheme {
  if (typeof document === "undefined") return FALLBACK;
  const styles = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : fallback;
  };
  return {
    background: get("--background", FALLBACK.background),
    foreground: get("--foreground", FALLBACK.foreground),
    muted: get("--muted", FALLBACK.muted),
    mutedForeground: get("--muted-foreground", FALLBACK.mutedForeground),
    border: get("--border", FALLBACK.border),
    primary: get("--primary", FALLBACK.primary),
    primaryForeground: get("--primary-foreground", FALLBACK.primaryForeground),
    accent: get("--accent", FALLBACK.accent),
    accentForeground: get("--accent-foreground", FALLBACK.accentForeground),
    ring: get("--ring", FALLBACK.ring),
    card: get("--card", FALLBACK.card),
  };
}

let cachedTheme: GridTheme | null = null;

/**
 * Cached theme snapshot. Safe to call during render: only the first call hits
 * `getComputedStyle`, so a hover-driven re-render never forces a style recalc.
 */
export function getGridTheme(): GridTheme {
  if (cachedTheme === null) cachedTheme = readGridTheme();
  return cachedTheme;
}

/** Re-read the theme (e.g. after a dark-mode toggle) and return the fresh value. */
export function refreshGridTheme(): GridTheme {
  cachedTheme = readGridTheme();
  return cachedTheme;
}

/** Layout metrics + typography used by the renderer. Stored in a plain object. */
export interface GridMetrics {
  rowHeight: number;
  headerHeight: number;
  gutterWidth: number;
}

export const CELL_PADDING_X = 10;
export const BODY_FONT = '13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const HEADER_FONT = '600 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const GUTTER_FONT = '12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Numeric/date cells get tabular-style rendering via a monospaced-ish family. */
export const NUMERIC_FONT = '13px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
