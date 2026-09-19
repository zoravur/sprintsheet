import { describe, expect, test } from "bun:test";

async function gridSource(): Promise<string> {
  return Bun.file(new URL("../CanvasDataGrid.tsx", import.meta.url)).text();
}

/**
 * Regression guard for a real bug: the grid used to translate keys in TWO
 * places — the editor `<input>` and the wrapper. Committing an edit clears the
 * `editing` state synchronously, so once the input's handler had run, the same
 * event bubbled to the wrapper's handler with its `if (editing) return` guard
 * no longer tripping, and the navigation executed a *second* time. Pressing
 * Tab while editing therefore jumped two cells and skipped one.
 *
 * The fix was structural (a single handler), so the guard is structural too. It
 * is not behavioural — catching that needs a DOM test — but it fails loudly the
 * moment a second keydown handler is added back alongside the first.
 */
describe("keydown handling lives in exactly one place", () => {
  test("CanvasDataGrid binds onKeyDown exactly once", async () => {
    const bindings = (await gridSource()).match(/onKeyDown=/g) ?? [];
    expect(bindings.length).toBe(1);
  });

  test("the inline editor does not bind its own keys", async () => {
    const source = await gridSource();
    // Match the JSX element (newline after the tag), not the word in comments.
    const start = source.indexOf("<input\n");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("/>", start));
    expect(block).not.toContain("onKeyDown");
  });
});
