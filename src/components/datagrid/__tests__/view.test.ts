import { describe, expect, test } from "bun:test";

async function gridSource(): Promise<string> {
  return Bun.file(new URL("../CanvasDataGrid.tsx", import.meta.url)).text();
}

/**
 * Tripwire for a bug whose real fix was architectural.
 *
 * The grid used to answer "what does Tab do?" in two places: the editor's
 * onKeyDown (`commitEdit(); scan()`) and the wrapper's (`scan()`). Committing
 * clears `editing` synchronously, so the same event bubbled on with the
 * wrapper's `if (editing) return` guard no longer tripping, and navigated a
 * second time — Tab in edit mode jumped two cells.
 *
 * Folding edit mode into the model removed the reason for two answers: the view
 * now only says which keys the field keeps, and the model decides that a
 * navigation ends the edit. This test guards the resulting *shape* — one
 * keydown handler — which is weaker than guarding the cause. It is not
 * behavioural; a DOM test would cover that.
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
