import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The floating pane's head is a header, not a strip with a spare button.
 *
 * It used to draw a screen-reader-only title and a lone close button pinned to the
 * right corner. Nothing in the band said what the pane was, and an empty band
 * ending in "×" reads as a layout that lost its content — the user cannot tell
 * what the pane is called or why it stops there.
 *
 * Three things have to hold, and none of them is visible from a screenshot of an
 * empty workspace:
 *
 * 1. The title is drawn, not `sr-only`.
 * 2. The close control carries its own hook. Every automation helper used to find
 *    it as "the first button in the head"; when the face switch was added that
 *    became "show the launch face", so closing silently did nothing and unrelated
 *    suites failed with clicks landing on a pane that should have been gone.
 * 3. The head accepts caller controls, because what belongs there (which face of
 *    the pane is showing) is decided by whoever mounts the pane.
 */
const PANE = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "components", "ui", "FloatingPane.vue"),
  "utf8",
);

describe("the floating pane's head", () => {
  it("draws the pane's title instead of hiding it", () => {
    expect(PANE).toMatch(/<h2 class="pane-title">/);
    expect(PANE).not.toMatch(/<h2 class="sr-only">/);
    // The style has to exist for the class it is given, or the title is visible
    // markup with default browser type.
    expect(PANE).toMatch(/\.pane-title\s*\{/);
  });

  it("gives the close control its own hook", () => {
    expect(PANE).toMatch(/data-pane-close/);
    // A hook only helps if nothing depends on positional lookup any more. The
    // pane's own close button is the only one that may sit in the actions row.
    expect(PANE).toMatch(/<slot name="head"\s*\/>/);
  });

  it("lets the mounting layer put its own controls in the head", () => {
    expect(PANE).toMatch(/<slot name="head"/);
  });
});
