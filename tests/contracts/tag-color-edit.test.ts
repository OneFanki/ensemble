import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "src/renderer/src/components/TagsPage.vue"), "utf8");

/** Body of one function, from its declaration to the next one. */
function body(start: string, end: string): string {
  const from = page.indexOf(start);
  expect(from, `${start} must exist`).toBeGreaterThanOrEqual(0);
  return page.slice(from, page.indexOf(end, from));
}

describe("tag colour editing contract", () => {
  it("saves the colour chosen in edit mode instead of echoing the stored one", () => {
    // The bug this locks: edit mode only ever sent `color: tag.color`, so a
    // tag's colour was unreachable after creation even though the data layer
    // (`WorkspaceService.saveTag`) already accepted a new one.
    const commit = body("async function commitEditTag", "function cancelEditTag");
    expect(commit).not.toMatch(/color:\s*tag\.color/);
    expect(commit).toMatch(/saveTag\(\{[^}]*\bcolor\b[^}]*\}\)/);
    expect(commit).toMatch(/editTagColor\.value/);
  });

  it("offers the same swatches in edit mode as in the create row", () => {
    // One v-for per row type: the create row and the inline edit row.
    expect(page.match(/v-for="color in TAG_COLORS"/g)?.length).toBe(2);
  });

  it("keeps the name input from blurring when a swatch is clicked", () => {
    // Without `mousedown.prevent` the blur commits the edit and unmounts the
    // swatches before the click lands, so the colour can never be picked.
    expect(page).toMatch(/@mousedown\.prevent/);
  });

  it("previews the pending colour on the row dot", () => {
    expect(page).toMatch(/editingTagId === tag\.id \? editTagColor : tag\.color/);
  });

  it("treats a colour-only change as a real edit", () => {
    const commit = body("async function commitEditTag", "function cancelEditTag");
    expect(commit).toMatch(/name === tag\.name && color === tag\.color/);
  });

  it("drops a previewed colour when the edit is cancelled", () => {
    const cancel = body("function cancelEditTag", "async function removeTag");
    expect(cancel).toMatch(/editingTagId\.value = null/);
    expect(cancel).not.toMatch(/saveTag/);
  });
});
