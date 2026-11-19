import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "src/renderer/src/components");

/** Every Vue component, recursively (the UI lives one level deep today). */
function walk(path: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith(".vue")) found.push(full);
  }
  return found;
}

const components = walk(dir).map((path) => ({
  // `basename`, not a hand-rolled split: a hard-coded "\\" returns -1 on Linux,
  // which silently turns the whole absolute path into the component name and
  // makes every allow-list lookup below miss.
  name: basename(path),
  text: readFileSync(path, "utf8"),
}));

function template(text: string): string {
  const start = text.indexOf("<template>");
  return start < 0 ? "" : text.slice(start);
}

/**
 * Inline editing is allowed; two specific failures are not.
 *
 * The original rule was "every create/edit form is a dialog". Two real bugs sat
 * behind it — a form that stayed open after a successful save with the typed
 * name still in it, and a row that turned into inputs under the pointer and
 * reflowed the list — but neither of those is caused by being inline. A composer
 * that sits above the list, carries its own cancel control and closes only after
 * a successful write has neither problem, and AGENTS.md rule 22 prefers exactly
 * that shape over a modal.
 *
 * So the contract now names the failures instead of the shape:
 *
 * 1. a row must not turn into inputs in place (the reflow bug), and
 * 2. an inline composer must have a place to close from (the stuck-open bug).
 */
describe("inline composers", () => {
  it("rows never turn into inputs in place", () => {
    const offenders = components
      .filter(({ text }) => /v-if="(?:editingId|editingTagId|editingGroupId|renamingViewId)/.test(template(text)))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("an inline composer that appears on demand has a cancel control", () => {
    // The judge is about composers that *materialise*: a strip that shows up
    // when the user clicks "new" needs a way back out that is not "save". A form
    // that is always there and adds one value (the AI origin list) has no such
    // state to leave, so it is out of scope.
    const offenders: string[] = [];
    for (const { name, text } of components) {
      const outside = template(text).replace(/<Modal\b[\s\S]*?<\/Modal>/g, "");
      const openings = [...outside.matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
      const conditional = openings.filter((tag) => /\sv-if=/.test(tag));
      if (conditional.length === 0) continue;
      // Everything from the first such form to the end of the template is the
      // composer's neighbourhood; both entrances keep cancel beside submit.
      const from = outside.indexOf(conditional[0]!);
      const body = outside.slice(from);
      const hasCancel = /app\.cancel|data-[a-z-]*cancel/i.test(body);
      if (!hasCancel) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
