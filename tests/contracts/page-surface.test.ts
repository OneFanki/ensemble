import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The manager must not move *pages'* pixels.
 *
 * Pages are `<webview>` nodes owned by the renderer, so the browser manager
 * computes a rectangle and the renderer places the node. Anything that reaches
 * for a window's child-view tree in order to position a page belongs to the
 * carrier that no longer exists.
 *
 * One exception is deliberate and narrow: a docked DevTools panel is a native
 * `WebContentsView`, and cannot be anything else. `setDevToolsWebContents` needs
 * a webContents the embedder owns outright, and a guest is sandboxed by its
 * embedder, so a `<webview>` host never receives the `DevToolsHost` binding and
 * renders the front-end with nothing to talk to (measured; see
 * `docs/engineering/踩坑库.md`). The panel is not a page carrier — pages keep
 * going through `PageSurface`, and the assertions below pin the exception to the
 * panel alone.
 *
 * This is a wiring rule, so it is checked against the source rather than
 * exercised at runtime: a unit test cannot fabricate an Electron view tree.
 */
const BROWSER = readFileSync(join(process.cwd(), "src", "main", "embedded", "browser.ts"), "utf8");
const SURFACE = readFileSync(join(process.cwd(), "src", "main", "embedded", "surface.ts"), "utf8");

describe("the manager addresses pages through a carrier-neutral surface", () => {
  it("never positions a page through a window's child-view tree", () => {
    expect(BROWSER).not.toMatch(/tab\.view\.setVisible/);
    expect(BROWSER).not.toMatch(/tab\.view\.webContents\.setDevToolsWebContents/);
    // Exactly one native view, and it is the panel's: a second would mean a
    // page went back to being moved by main.
    expect(BROWSER.match(/new WebContentsView\(/g) ?? []).toHaveLength(1);
    expect(BROWSER.match(/contentView\.addChildView/g) ?? []).toHaveLength(1);
    expect(BROWSER.match(/contentView\.removeChildView/g) ?? []).toHaveLength(1);
  });

  it("keeps the native view confined to the DevTools panel", () => {
    // Anchored on the opening method: a `WebContentsView` created anywhere else
    // is a page that main is positioning again.
    expect(BROWSER).toMatch(
      /openDevTools\(tabId: string\): void \{[\s\S]*?new WebContentsView\([\s\S]*?contentView\.addChildView\(view\)/,
    );
  });

  it("attaches an existing panel instead of rebuilding it", () => {
    // Rebuilding on every toggle would throw away console history, which is the
    // one thing a DevTools panel is used for across a session.
    expect(BROWSER).toMatch(
      /if \(tab\.devtools\) \{\s*this\.placeDevTools\(tab\);\s*this\.emitState\(\);\s*return;/,
    );
  });

  it("has no carrier branch left to keep in sync", () => {
    // One page carrier means no "is this native?" checks: forgetting one branch
    // was how pages silently stayed parked over the console.
    expect(BROWSER).not.toContain("isNativeSurface");
    expect(BROWSER).not.toContain("NativePageSurface");
    expect(SURFACE).not.toContain("NativePageSurface");
  });

  it("exposes exactly the operations a page needs", () => {
    for (const member of ["webContents", "setBounds", "getBounds", "setVisible", "setBackgroundColor"]) {
      expect(SURFACE).toContain(`${member}`);
    }
  });

  it("makes a guest's geometry answerable without a native view", () => {
    // The renderer positions the node; `bounds` is what it was told to use, and
    // what every geometry-based check reads back.
    expect(SURFACE).toMatch(/class GuestPageSurface[\s\S]*?setBounds\(/);
    expect(SURFACE).toMatch(/class GuestPageSurface[\s\S]*?getBounds\(\)/);
  });

  it("judges the panel open from its own record, and only while it is docked", () => {
    // Handing the tools a webContents of ours makes `isDevToolsOpened()` stay
    // false for a panel that is running and visible (measured on Electron 45),
    // so the toolbar toggle would report a closed panel that is on screen.
    //
    // The second half of the rule is what the renderer needs: it draws the drag
    // seam from this flag, so a panel that exists but is parked (its page left
    // the stage, or the page is blank and never docks one) has to read as
    // closed — otherwise the seam hangs over a page with nothing beside it.
    expect(BROWSER).toMatch(
      /private devtoolsOpen\(tab: TabRecord\): boolean \{\s*return Boolean\(tab\.devtools\) &&/,
    );
    expect(BROWSER).toMatch(
      /private devtoolsOpen\(tab: TabRecord\): boolean \{[\s\S]{0,400}?cellOf\(tab\)/,
    );
  });
});
