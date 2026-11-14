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

describe("tag editing contract", () => {
  it("saves the colour chosen in the dialog instead of echoing the stored one", () => {
    // The bug this locks: edit mode only ever sent `color: tag.color`, so a
    // tag's colour was unreachable after creation even though the data layer
    // (`WorkspaceService.saveTag`) already accepted a new one.
    const submit = body("async function submit", "async function removeTag");
    expect(submit).not.toMatch(/color:\s*tag\.color/);
    expect(submit).toMatch(/color:\s*draft\.color/);
  });

  it("offers the colour swatches in the dialog", () => {
    expect(page.match(/v-for="color in TAG_COLORS"/g)?.length).toBe(1);
    expect(page).toMatch(/data-tag-color/);
  });

  it("writes both fields on every submit, so a colour-only edit lands", () => {
    // The row has one dialog for create and edit; nothing about it is allowed to
    // short-circuit on "the name did not change", which is what silently dropped
    // colour-only edits before.
    const submit = body("async function submit", "async function removeTag");
    expect(submit).toMatch(/name,\s*\n?\s*color:\s*draft\.color/);
  });

  it("keeps the pending colour out of the row until the dialog is saved", () => {
    // The row draws the stored colour. A preview rendered straight into the list
    // would make closing the dialog look like it saved something.
    expect(page).toMatch(/:style="\{ '--tag': `var\(--role-\$\{tag\.color\}\)` \}"/);
  });

  it("closes only after a successful write", () => {
    const submit = body("async function submit", "async function removeTag");
    // `run` answers `undefined` on a rejection, so the guard must come before
    // the assignment that closes the dialog.
    const guard = submit.indexOf("saved === undefined");
    const close = submit.indexOf("dialog.value = null");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(guard);
  });

  it("has no inline form in the page body", () => {
    // The rule this page is the reason for: a form that appears in the layout
    // pushes the list it belongs to, and the one under the create row stayed
    // open after a successful save.
    expect(page).not.toMatch(/<form[^>]*class="create"/);
    expect(page).not.toMatch(/editingTagId/);
  });
});
