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
- custom scrollbars (drag / click-to-jump) synced to the canvas with zero
  React renders per scroll frame
- frozen column header + row-number gutter
- cell / range selection, marquee drag, row select, select-all
- three-point selection model (`anchor` / `extent` / `focus`): the rectangle is
  the bounding box of anchor + extent, and the active cell may sit anywhere
  inside it; after a pointer gesture anchor/extent are normalised to the
  top-left/bottom-right corners
- keyboard navigation — arrows (+`Shift` to extend), `PageUp/Down`,
  `Home`/`End`; `Enter`/`Tab` cycle the active cell inside the selection and
  wrap (`Enter` column-major, `Tab` row-major)
- inline editing (double-click, `F2`, or just start typing) with type coercion
- click-to-sort headers, drag-to-resize columns
- `⌘/Ctrl+C` / `⌘/Ctrl+V` of TSV ranges
- reads shadcn/Tailwind theme tokens and follows dark mode

### Architecture

The document is a **headless model**, independent of React and the canvas:

- `spreadsheet.ts` — `SpreadsheetState` (rows/view/columns/widths/sort/selection/
  editing) plus a pure `reduce(state, command)` and an observable
  `SpreadsheetModel` wrapper. Every interaction is a `Command`
  (`move`, `scan`, `beginEdit`, `commitEdit`, `sortColumn`, `paste`, …); results
  are `Effect`s (`reveal`, `focusGrid`, `edited`) that the view plays back.
- `CanvasDataGrid.tsx` — thin view: builds the model once, subscribes with
  `useSyncExternalStore`, dispatches commands from DOM events and turns effects
  into scrolling / focus / callbacks. It owns only presentational state
  (scroll offsets, hover, in-progress resize).

Supporting pure modules: `layout.ts` (axis maths + virtualization), `renderer.ts`
(canvas paint), `format.ts` (value resolution + `Intl` formatting), `theme.ts`
(CSS-var bridge), `navigation.ts` (Enter/Tab scan), `scrollbar.ts` (thumb
geometry). Because the model is pure it is exhaustively unit-testable — see
`__tests__/spreadsheet.test.ts`. Run everything with `bun test` and
`bunx tsc --noEmit`.
