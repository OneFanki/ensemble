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

  it("sizes the strip and the toolbar from tokens", () => {
    expect(ruleBody(BROWSER, ".tabstrip")).toMatch(/height:\s*var\(--titlebar-height\)/);
    expect(ruleBody(BROWSER, ".toolbar")).toMatch(/height:\s*var\(--toolbar-height\)/);
    expect(TOKENS).toMatch(/--titlebar-height:\s*\d+px/);
    expect(TOKENS).toMatch(/--toolbar-height:\s*\d+px/);
  });

  it("keeps the native window buttons level with the strip", () => {
    // The overlay is drawn at a fixed pixel height over the strip; if the two
    // disagree the buttons either float above the band or overlap the tabs.
    const declared = /--titlebar-height:\s*(\d+)px/.exec(TOKENS)?.[1];
    const mirrored = /const TITLEBAR_HEIGHT = (\d+);/.exec(MAIN)?.[1];
    expect(declared).toBeDefined();
    expect(mirrored).toBe(declared);
  });
});
