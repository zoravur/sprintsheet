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
- frozen column header + row-number gutter
- cell / range selection, marquee drag, row select, select-all
- keyboard navigation (arrows, `Shift+Arrows`, `PageUp/Down`, `Home`/`End`, `Tab`)
- inline editing (double-click, `F2`, or just start typing) with type coercion
- click-to-sort headers, drag-to-resize columns
- `⌘/Ctrl+C` / `⌘/Ctrl+V` of TSV ranges
- reads shadcn/Tailwind theme tokens and follows dark mode

Modules: `layout.ts` (axis maths + virtualization), `renderer.ts` (canvas paint),
`format.ts` (value resolution + `Intl` formatting), `theme.ts` (CSS-var bridge),
`CanvasDataGrid.tsx` (React glue + interactions). Run the checks with
`bun test` and `bunx tsc --noEmit`.
