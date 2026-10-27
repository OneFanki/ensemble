import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Parking a page off-screen depends on knowing the *window* size.
 *
 * `parkedViewBounds` puts a page's left edge at the window's right edge. The
 * stage is narrower than the window — it starts right of the navigation rail —
 * so using the stage width as the fallback parks the page with its left edge
 * exactly where the run dock begins, and the page paints over the dock.
 *
 * That is what users saw: a ~98px band of page content down the right edge
 * (`windowWidth - railWidth - collapsedDockWidth` = 1320 - 52 - 46 = 1222, the
 * exact x the parked page was given). The trigger is a window that cannot be
 * measured at that moment — hidden to the tray — so the fallback ran.
 *
 * The pure geometry is pinned in `embedded.test.ts`; what was missing is that
 * the fallback feeding it must never be the stage. A shape assertion on the
 * source is the only way to catch that without a real tray-hidden window.
 */
const SOURCE = readFileSync(join(process.cwd(), "src", "main", "embedded", "browser.ts"), "utf8");

/** The body of `hostContentSize`, brace-matched from its opening line. */
function hostContentSizeBody(source: string): string {
  const signature = source.indexOf("private hostContentSize(");
  expect(signature).toBeGreaterThan(0);
  // The return type is an inline object, so the body starts after `} {` — the
  // closing brace of the type plus the opening brace of the function. Matching
  // `) {` instead lands on the first `if (...) {` inside the function.
  const marker = source.indexOf("} {", signature);
  expect(marker).toBeGreaterThan(0);
  const open = marker + 2;
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return source.slice(open, end);
}

describe("parking geometry is fed the window size", () => {
  it("never falls back to the stage when the window cannot be measured", () => {
    const body = hostContentSizeBody(SOURCE);
    // The regression was `const stage = this.stage ?? this.lastStage;` and then
    // using `stage.width`. Neither name may appear in the fallback path.
    expect(body).not.toMatch(/this\.lastStage/);
    expect(body).not.toMatch(/this\.stage\b/);
  });

  it("remembers the last measured window size instead of guessing", () => {
    const body = hostContentSizeBody(SOURCE);
    expect(body).toMatch(/lastContentSize/);
    // Storing on read is what makes the remembered value the real one. The
    // object literal keeps this from matching the field declaration.
    expect(body).toMatch(/this\.lastContentSize\s*=\s*\{\s*width:/);
  });
});
