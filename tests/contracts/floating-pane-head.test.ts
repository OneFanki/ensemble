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

/**
 * The head's controls must not move when the face changes.
 *
 * The write actions (new account / new site) used to live here and only appeared
 * on the edit face. The face switch shares the same right-aligned row, so
 * switching to edit shoved the switch left by the width of two buttons — the
 * control under the user's pointer moved out from under it. They now live in the
 * page's own action row, and the head carries the switch alone.
 */
const MANAGE = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "components", "ManageLayer.vue"),
  "utf8",
);

describe("the pane head does not reflow between faces", () => {
  it("keeps the write actions out of the head", () => {
    // The head slot must not contain either creation door: they are conditional
    // on the face, which is what made the row change width.
    const headStart = MANAGE.indexOf('<template #head>');
    expect(headStart, "the head slot must exist").toBeGreaterThan(-1);
    const headEnd = MANAGE.indexOf("</template>", headStart);
    const head = MANAGE.slice(headStart, headEnd);
    expect(head).not.toMatch(/data-new-account/);
    expect(head).not.toMatch(/data-new-site/);
  });

  it("keeps the face switch in the head, and it is the only control", () => {
    const headStart = MANAGE.indexOf('<template #head>');
    const headEnd = MANAGE.indexOf("</template>", headStart);
    const head = MANAGE.slice(headStart, headEnd);
    expect(head).toMatch(/data-mode-use/);
    expect(head).toMatch(/data-mode-edit/);
  });
});

/**
 * The pane is glass, and it leaves as well as it arrives.
 *
 * Both were asked for together and both are easy to lose silently: a blur can be
 * dropped without any visual error (the pane just becomes opaque again), and an
 * enter-only `animation` looks correct on open while close snaps shut in one
 * frame. Neither is caught by a screenshot of a fresh open.
 */
describe("the pane's surface and its exit", () => {
  it("blurs the page behind it instead of painting an opaque sheet", () => {
    expect(PANE).toMatch(/backdrop-filter:\s*blur\(/);
    // The -webkit- spelling is still required: Electron's Chromium accepts both,
    // but a stylesheet that only carries the unprefixed one is silently inert on
    // some builds.
    expect(PANE).toMatch(/-webkit-backdrop-filter:\s*blur\(/);
    // The tint must stay translucent, or the blur is invisible work.
    expect(PANE).toMatch(/background:\s*color-mix\(in srgb, var\(--content\) 90%, transparent\)/);
  });

  it("animates both directions, not just the entrance", () => {
    // A `Transition` with a leave rule is what makes close animate; an
    // `animation:` on the pane alone can never play backwards.
    expect(PANE).toMatch(/<Transition name="floating-pane"/);
    expect(PANE).toMatch(/\.floating-pane-leave-active\s*\{/);
    expect(PANE).toMatch(/\.floating-pane-leave-to\s*\{/);
  });
});
