import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the app's hover labels.
 *
 * A native `title` looks like a one-attribute shortcut and behaves like the
 * platform's tooltip: roughly a second of silence before it appears, the system
 * font at the system scale, a position the window does not control, and no way to
 * style it. Every icon button in the browser therefore goes through `v-tooltip`.
 *
 * The reason it survived as long as it did is worth recording, because the
 * reasoning behind the old rule is now false: built-in pages used to be native
 * views painted *above* the renderer, so any flyout drawn in our own layer would
 * have been hidden behind the page it belonged to. Pages now live in the
 * renderer's DOM, which removes the constraint entirely.
 *
 * This checks the two components that own the browser chrome. Not every `title`
 * is wrong — a long URL on a tab label is the right place for one, because the OS
 * truncates and copies it usefully and the label has no room to draw a flyout
 * from — so the assertions name the controls that must not have one.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

const browser = read("src/renderer/src/components/BrowserPage.vue");
const dock = read("src/renderer/src/components/RunDock.vue");
const directive = read("src/renderer/src/directives/tooltip.ts");

describe("hover labels", () => {
  it("registers the directive globally", () => {
    const main = read("src/renderer/src/main.ts");
    expect(main).toContain('directive("tooltip", vTooltip)');
  });

  it("draws one host for every label, outside every component tree", () => {
    // The host is on `<body>` because a label has to escape a scrolling dock and
    // a clipping stage. A single host also means two labels can never stack.
    expect(directive).toContain('document.createElement("div")');
    expect(directive).toContain("document.body.appendChild");
    expect(directive).toContain("app-tooltip");
  });

  it("flips and clamps so a label never leaves the window", () => {
    // A 46px icon strip at the window's right edge is the case that motivated
    // this: a label centred under its control would hang past the frame.
    expect(directive).toContain("window.innerWidth - width - EDGE");
    expect(directive).toContain("top + height > window.innerHeight - EDGE");
  });

  it("keeps the label out of the way of the pointer", () => {
    // A hoverable label under its own control steals the pointer, fires
    // `pointerleave` on the control, and flickers. This is enforced in CSS.
    const base = read("src/renderer/src/styles/base.css");
    const block = base.slice(base.indexOf(".app-tooltip {"));
    expect(block.slice(0, block.indexOf("}"))).toContain("pointer-events: none");
  });

  it("gives the browser toolbar labels through the directive", () => {
    // The icon-only controls a user has to discover. Named one by one so that
    // adding a control without a label is the thing that fails, not an unrelated
    // count drifting.
    for (const value of [
      "t('app.browserBack')",
      "t('app.browserForward')",
      "t('app.browserReload')",
      "t('app.browserFind')",
      "t('app.downloads')",
      "t('app.openConsole')",
    ]) {
      expect(browser, `${value} must be a drawn tooltip`).toContain(`v-tooltip="${value}"`);
    }
  });

  it("gives every icon-only dock control a label through the directive", () => {
    expect(dock).toContain('v-tooltip="t(\'app.browserCollapseDock\')"');
    expect(dock).toContain('v-tooltip="t(\'app.browserExpandDock\')"');
    expect(dock).toContain('v-tooltip="t(\'app.browserResizeDock\')"');
    expect(dock).toContain('v-tooltip="t(\'app.browserCloseView\')"');
    // The collapsed strip's tiles carry a computed label with a placement, since
    // they sit against the window's right edge.
    expect(dock).toContain("placement: 'top'");
  });

  it("routes the shared icon button's hint through the directive", () => {
    // One component, so this single rule covers every icon button in the
    // console's seven pages — they all build on `IconButton`.
    const button = read("src/renderer/src/components/ui/IconButton.vue");
    expect(button).toContain("v-tooltip=");
    expect(button).not.toMatch(/:title="/);
  });

  it("leaves no native title on the browser toolbar", () => {
    // Every `title` left in the toolbar would be a control whose hint the app
    // cannot draw. The two survivors below are page URLs, which is a different
    // job: the OS tooltip truncates a long URL and lets the user read it.
    const toolbar = browser.slice(browser.indexOf('<div class="toolbar">'), browser.indexOf('<div v-if="findOpen"'));
    expect(toolbar).not.toMatch(/:title="t\(/);
  });
});
