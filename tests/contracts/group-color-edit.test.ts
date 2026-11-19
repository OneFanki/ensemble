import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  join(process.cwd(), "src/renderer/src/components/SiteGroupsEditor.vue"),
  "utf8",
);

/** Body of one function, from its declaration to the next one. */
function body(start: string, end: string): string {
  const from = page.indexOf(start);
  expect(from, `${start} must exist`).toBeGreaterThanOrEqual(0);
  return page.slice(from, page.indexOf(end, from));
}

describe("site group editing contract", () => {
  it("saves the colour chosen in the composer instead of echoing the stored one", () => {
    // The bug this locks: edit mode only ever sent `color: group.color`, so a
    // group's colour was unreachable after creation even though the data layer
    // (`WorkspaceService.saveSiteGroup`) already accepted a new one.
    const submit = body("async function submit", "const draggedId");
    expect(submit).not.toMatch(/color:\s*group\.color/);
    expect(submit).toMatch(/color:\s*draft\.color/);
  });

  it("offers the colour swatches in the composer", () => {
    expect(page.match(/v-for="color in GROUP_COLORS"/g)?.length).toBe(1);
    expect(page).toMatch(/data-group-color/);
  });

  it("writes both fields on every submit, so a colour-only edit lands", () => {
    // The row has one composer for create and edit; nothing about it is allowed to
    // short-circuit on "the name did not change", which is what silently dropped
    // colour-only edits before.
    const submit = body("async function submit", "const draggedId");
    expect(submit).toMatch(/name,\s*\n?\s*color:\s*draft\.color/);
  });

  it("keeps the pending colour out of the row until the composer is saved", () => {
    // The row draws the stored colour. A preview rendered straight into the list
    // would make closing the composer look like it saved something.
    expect(page).toMatch(/:style="\{ '--tag': `var\(--role-\$\{group\.color\}\)` \}"/);
  });

  it("closes only after a successful write", () => {
    const submit = body("async function submit", "const draggedId");
    // `run` answers `undefined` on a rejection, so the guard must come before
    // the assignment that closes the composer.
    const guard = submit.indexOf("saved === undefined");
    const close = submit.indexOf("composer.value = null");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(guard);
  });

  it("presents create and edit as one composer, never as row inputs", () => {
    // AGENTS.md rule 22: a two-value composer does not need a modal. What it
    // must not become is a row that turns into inputs — that reflowed the list
    // under the pointer and is the bug this shape exists to avoid.
    expect(page).toMatch(/<form v-if="composer"/);
    expect(page).toMatch(/data-group-composer/);
    expect(page).not.toMatch(/editingGroupId/);
  });
});
