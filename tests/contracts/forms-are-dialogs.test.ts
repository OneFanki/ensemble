import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  name: path.slice(path.lastIndexOf("\\") + 1),
  text: readFileSync(path, "utf8"),
}));

/**
 * A component's template, with every `<Modal>` block cut out.
 *
 * What is left is markup that sits directly in the page, which is where the
 * rule applies: a form inside a dialog is the fix, not the offence.
 */
function bareTemplate(text: string): string {
  const start = text.indexOf("<template>");
  if (start < 0) return "";
  return text
    .slice(start)
    .replace(/<Modal\b[\s\S]*?<\/Modal>/g, "");
}

/** The `<form …>` opening tags still standing in the bare template. */
function bareForms(text: string): string[] {
  return [...bareTemplate(text).matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
}

describe("forms are dialogs contract", () => {
  /*
   * The rule this locks: a form that appears on demand in the page body pushes
   * the list it belongs to, and an inline editor has no single place to close
   * from. Both showed up as real bugs — the profile form stayed open after a
   * successful save with the typed name still in it, and every inline rename
   * reflowed the row under the pointer.
   *
   * A `<form>` outside a dialog is still fine when it is always there and
   * submits one value: an address bar, a search box, the address list's add
   * field. What is forbidden is a form that *materialises* — the page's "create"
   * or "edit" affordance appearing between the header and the list.
   */
  it("no page body reveals a form on demand", () => {
    const offenders = components.flatMap(({ name, text }) =>
      bareForms(text)
        .filter((tag) => /\sv-if=/.test(tag))
        .map((tag) => `${name}: ${tag}`),
    );
    expect(offenders).toEqual([]);
  });

  it("a create or edit form is never inline, even when always rendered", () => {
    // The other half: a form permanently in the page that edits a listed row is
    // just an inline editor that happens not to be hidden. Only the browser's
    // own one-value surfaces may carry a bare form.
    const allowed = new Set([
      "AiPolicyEditor.vue", // the address list's add field, one value + a button
      "BrowserPage.vue", // the address bar
      "NewTabPage.vue", // the search box
    ]);
    const offenders = components
      .filter(({ name, text }) => bareForms(text).length > 0 && !allowed.has(name))
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("rows do not turn into inputs in place", () => {
    // The row-level variant: an input rendered conditionally inside a list row,
    // which is the shape that reflowed the row and lost focus on blur.
    const offenders = components
      .filter(({ text }) =>
        /v-if="(?:editingId|editingTagId|renamingViewId)/.test(bareTemplate(text)),
      )
      .map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});
