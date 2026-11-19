import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A page's heading says its name, and then the page starts.
 *
 * `PageHeader` grew a `note` slot and seven pages filled it in, so every screen
 * opened with a second line restating the title: "AI 记录 / AI 在页面上的操作",
 * "站点 / 管理多账号访问的站点". A subtitle that paraphrases the heading adds a
 * row of text to read on every visit and answers nothing. The one legitimate use
 * is a live figure the page cannot show anywhere else ("12 账号 · 3 运行中"), and
 * that is a number, not a sentence.
 *
 * The copy rule in AGENTS.md covers this from the other side; this is the
 * structural half. A page that really needs to say what it is for says it once,
 * in the empty state or a tooltip, where it only appears when it is needed.
 *
 * A literal `note="…"` is checked as well as a `:note` binding, because the
 * sentence is the offence either way.
 */
const root = join(process.cwd(), "src/renderer/src/components");

function walk(path: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith(".vue")) found.push(full);
  }
  return found;
}

/** The `<PageHeader …>` opening tag of every page that has one. */
function pageHeaders(text: string): string[] {
  return [...text.matchAll(/<PageHeader\b[^>]*>/g)].map((match) => match[0]);
}

const pages = walk(root).map((path) => ({
  path: relative(process.cwd(), path),
  text: readFileSync(path, "utf8"),
}));

describe("a page header carries a title, not a subtitle", () => {
  it("passes no prose note to any PageHeader", () => {
    const offenders: string[] = [];
    for (const page of pages) {
      for (const tag of pageHeaders(page.text)) {
        // `:note="…"` and `note="…"` both count; the prop is the same door.
        if (/\s(?::note|note)\s*=/.test(tag)) offenders.push(`${page.path}: ${tag.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the numeric count as a slot, which is a figure rather than a sentence", () => {
    // IdentitiesPage lost its heading when it became a floating pane: the button
    // that opens the pane already names it and the filter tabs carry the count
    // ("全部 4"), so a title plus a subtitle was two lines restating what the
    // user had just clicked and what the tabs already said.
    //
    // The rule this test protects is unchanged for the pages that still wear a
    // header: a figure may go under a title, a sentence may not. The slot is
    // therefore allowed to be empty across the app (it is, right now); what is
    // forbidden is filling it with prose.
    for (const page of pages.filter((item) => /<template #note>/.test(item.text))) {
      // Every note that exists interpolates a count message; prose would not.
      expect(page.text, page.path).toMatch(/\{\{\s*\$t\("app\.\w+Count"/);
    }
  });

  it("no longer offers a note prop, so no page can reach for one", () => {
    // The prop was removed rather than left unused: an option that exists is an
    // option the next page will fill in, and the failure is invisible in review
    // — it is one plausible-looking line. The `#note` slot stays; see above.
    const header = pages.find((page) => page.path.endsWith("ui\\PageHeader.vue") || page.path.endsWith("ui/PageHeader.vue"));
    expect(header?.text).toBeDefined();
    expect(header?.text).not.toMatch(/^\s*note\?:/m);
  });
});
