import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The active tab and the toolbar are one surface.
 *
 * Painting the tab strip as its own band (a grey row above a white toolbar) is
 * what makes a window look like a web app that happens to draw tabs. The tab
 * takes the toolbar's colour and loses its bottom edge, so the two read as a
 * single surface with notches cut out of it — the arrangement every browser uses.
 *
 * Two things have to hold together and neither is visible from the markup:
 *
 * 1. Both colours come from the same token. Writing `var(--chrome)` in the tab
 *    rule and `var(--surface)` in the toolbar rule gives the same colour today
 *    and silently diverges the first time either token moves.
 * 2. The strip and the toolbar heights are tokens, not literals, because the
 *    native window buttons are positioned by the main process at the strip's
 *    height. A CSS-only change to 40px would leave the buttons floating in the
 *    middle of the strip.
 */
const TOKENS = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "styles", "tokens.css"),
  "utf8",
);
const BROWSER = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "components", "BrowserPage.vue"),
  "utf8",
);
const MAIN = readFileSync(join(process.cwd(), "src", "main", "index.ts"), "utf8");
const SETTINGS = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "components", "SettingsPage.vue"),
  "utf8",
);
const SETTING_GROUP = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "components", "ui", "SettingGroup.vue"),
  "utf8",
);
const RAIL = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "components", "AccountRail.vue"),
  "utf8",
);

/** One CSS rule's body, by selector. */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(0);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  expect(close).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

describe("the active tab and the toolbar share one surface", () => {
  it("paints the active tab and the toolbar from the same token", () => {
    const tab = ruleBody(BROWSER, ".tab.active");
    const toolbar = ruleBody(BROWSER, ".toolbar");
    expect(tab).toMatch(/background:\s*var\(--chrome\)/);
    expect(toolbar).toMatch(/background:\s*var\(--chrome\)/);
  });

  it("draws the strip in the frame colour, so the tab reads as a notch", () => {
    const strip = ruleBody(BROWSER, ".tabstrip");
    expect(strip).toMatch(/background:\s*var\(--frame\)/);
  });

  it("gives the active tab no bottom edge of its own", () => {
    const tab = ruleBody(BROWSER, ".tab.active");
    // A bottom border would draw the seam the shared colour is meant to erase.
    // (`box-shadow` with a negative y-offset is the top hairline, which is fine.)
    expect(tab).not.toMatch(/border-bottom/);
  });

  it("sizes the top row and the address row from their own tokens", () => {
    // The tab strip is the window's first row, so it takes the titlebar token —
    // it is the row the caption buttons are drawn in. The address row sits
    // beneath it and has its own height. Swapping these is what made the
    // caption buttons hang half a band too high (and, before that, what made a
    // second reservation push the app menu off the right edge).
    expect(ruleBody(BROWSER, ".tabstrip")).toMatch(/height:\s*var\(--titlebar-height\)/);
    expect(ruleBody(BROWSER, ".toolbar")).toMatch(/height:\s*var\(--address-row-height\)/);
    expect(ruleBody(BROWSER, ".toolbar")).not.toMatch(/height:\s*var\(--titlebar-height\)/);
    expect(TOKENS).toMatch(/--titlebar-height:\s*\d+px/);
    expect(TOKENS).toMatch(/--address-row-height:\s*\d+px/);
  });

  it("keeps the native window buttons level with the row that meets them", () => {
    // The OS draws the caption buttons over the client area at `TITLEBAR_HEIGHT`
    // pixels. Every row that meets the top-right corner has to name the same
    // number, and the assertion is written against the *height of those rows*,
    // not against two literals agreeing: when the values matched but the row was
    // something else, this test stayed green while the top row was 10px taller
    // than the buttons hanging over it.
    //
    // 1. Main's constant, which positions the overlay.
    // 2. The token the tab strip is sized from — the browser's first row.
    // 3. Settings' own band, so switching between the browser and settings does
    //    not move the window buttons.
    const declared = /--titlebar-height:\s*(\d+)px/.exec(TOKENS)?.[1];
    const mirrored = /const TITLEBAR_HEIGHT = (\d+);/.exec(MAIN)?.[1];
    expect(declared).toBeDefined();
    expect(mirrored).toBe(declared);

    expect(ruleBody(BROWSER, ".tabstrip")).toMatch(/height:\s*var\(--titlebar-height\)/);
    expect(ruleBody(SETTINGS, ".settings-head")).toMatch(/height:\s*var\(--titlebar-height\)/);
  });
});

/**
 * The window can always be moved by its top band.
 *
 * `-webkit-app-region: drag` is invisible in the markup and in every screenshot,
 * so losing it is silent: the window simply stops moving and nothing else looks
 * different. That is exactly what happened — `8afada5` removed the band while the
 * address row briefly occupied the top, and when `e376007` moved the tab strip
 * back up only the spacer came with it, leaving the whole top row inert.
 *
 * The assertion is on the row that meets the top edge, not on any particular
 * element inside it: whatever the strip is called, the band between the tabs and
 * the caption buttons has to declare the drag region.
 */
describe("the top band still drags the window", () => {
  it("marks the tab strip's free stretch as a drag region", () => {
    const strip = ruleBody(BROWSER, ".tabstrip");
    expect(strip).not.toMatch(/-webkit-app-region:\s*no-drag/);
    // Either the strip itself drags, or the spacer between the last tab and the
    // caption buttons does. The spacer is the current shape; which one is used
    // must not matter to this contract, only that one of them is there.
    const stripDrags =
      /-webkit-app-region:\s*drag/.test(strip) ||
      /\.strip-drag\s*\{[^}]*-webkit-app-region:\s*drag/.test(BROWSER);
    const spacerDrags = /class="strip-drag drag-region"/.test(BROWSER);
    expect(stripDrags || spacerDrags).toBe(true);
  });
});

/**
 * A selected row has to sit on a surface it can be told apart from.
 *
 * Settings' column used to carry no background at all — it inherited the page's
 * `--content` — so on the light theme the current section was a white fill on
 * white and the state vanished (dark hid it: the same pair is #262b31 on
 * #1e2227 there, one step you can just see). The column now paints `--frame` and
 * the row paints a surface step above it.
 *
 * The assertion is about the *pair*, not about particular colours: whatever the
 * column ends up painted with must be the frame, and the row must be a surface
 * token that is not the frame. Naming the exact token would make this a change
 * detector — it moved from `--chrome` to `--selected-on-frame` when dark needed a
 * stronger step, and both were correct.
 */
describe("the selected settings section is visible", () => {
  it("sets the selected row off the column's own surface", () => {
    expect(ruleBody(SETTINGS, ".tab.active")).toMatch(/background:\s*var\(--[\w-]+\)/);
    expect(ruleBody(SETTINGS, ".tab.active")).not.toMatch(/background:\s*var\(--frame\)/);
    expect(ruleBody(SETTINGS, ".settings-nav")).toMatch(/background:\s*var\(--frame\)/);
  });

  it("keeps the row's surface one real step above the band in both themes", () => {
    // `--selected-on-frame` is the token that carries this step; it has to be
    // defined for both themes, or one of them inherits the other's value and the
    // step silently disappears.
    const defined = [...TOKENS.matchAll(/--selected-on-frame:\s*([^;]+);/g)].map((m) =>
      String(m[1] ?? "").trim(),
    );
    expect(defined).toHaveLength(2);
    for (const value of defined) expect(value).toBeTruthy();
  });

  it("reaches the window edges, so the column does not sit in a content strip", () => {
    // The page's 24px/28px insets are cancelled here and returned as the
    // column's own padding. Without both halves the band stops short of the
    // window and leaves a bare strip of content colour beside the rows.
    const nav = ruleBody(SETTINGS, ".settings-nav");
    expect(nav).toMatch(/margin:\s*calc\(-1 \* var\(--space-6\)\) 0 -24px -28px/);
    expect(nav).toMatch(/padding:\s*calc\(var\(--space-6\) \+ var\(--space-1\)\) 12px 24px 28px/);
  });

  it("insets the rows on both sides, so the fill has a right edge", () => {
    // Flush against the content pane, the selected row joined it into one white
    // shape on light: 28px of air on the left, none on the right.
    const nav = ruleBody(SETTINGS, ".settings-nav");
    expect(nav).toMatch(/padding:[^;]*\b12px\b[^;]*\b28px\b/);
  });
});

/**
 * A card's heading must be a header, not the first unstyled row.
 *
 * Every group used to open with its title 2px above the first setting and no
 * rule between them, in a size one step off the labels below. The eye had no
 * reason to read "外观" as a title — it was the same block of text as
 * "主题 [深色][浅色]" — so each card looked like a list whose first entry
 * happened to be bold. The hairline is what makes the heading the top of the
 * card rather than its first line.
 */
describe("a setting group's heading is separated from its rows", () => {
  it("draws a rule under the heading", () => {
    const head = ruleBody(SETTING_GROUP, ".setting-group-head");
    expect(head).toMatch(/border-bottom:\s*1px solid var\(--line-soft\)/);
  });

  it("sizes the heading above the row labels", () => {
    // Row labels are --fs-sm; a heading at the same size reads as another row.
    const heading = ruleBody(SETTING_GROUP, ".setting-group-head h2");
    expect(heading).toMatch(/font-size:\s*var\(--fs-md\)/);
  });

  it("does not stack a second rule under the heading", () => {
    // `SettingRow:first-of-type` drops its own border, but keeps the padding, so
    // the label is not glued to the heading's rule.
    const row = readFileSync(
      join(process.cwd(), "src", "renderer", "src", "components", "ui", "SettingRow.vue"),
      "utf8",
    );
    expect(ruleBody(row, ".setting-row:first-of-type")).toMatch(/border-top:\s*0/);
  });
});

/**
 * The account column is the page area's left neighbour, not an overlay on it.
 *
 * It is a column of running accounts: a fixed token width, its own vertical
 * scroller, and no horizontal overflow — the accounts page and the strip stay
 * to its right, and the stage's rectangle is what every page node is placed
 * from, so a column that grew into the stage would move nothing but the
 * pixels.
 */
describe("the account column", () => {
  it("is a token-width column, not a band", () => {
    const rail = ruleBody(RAIL, ".account-rail");
    expect(rail).toMatch(/flex:\s*0 0 var\(--account-rail-width\)/);
    expect(rail).toMatch(/width:\s*var\(--account-rail-width\)/);
  });

  it("scrolls vertically in the list and never sideways", () => {
    const list = ruleBody(RAIL, ".rail-list");
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(list).not.toMatch(/overflow-x:\s*auto/);
  });
});
