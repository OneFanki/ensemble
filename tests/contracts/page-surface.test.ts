import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The browser manager must not depend on the carrier it is displaying through.
 *
 * Pages are being moved from a main-process `WebContentsView` to a renderer
 * `<webview>`. The manager does not care which: it talks to a `PageSurface`.
 * That abstraction only holds if the manager never reaches for the native view
 * directly — one `host.contentView.addChildView(tab.view)` left behind is
 * enough to crash on the first guest, because a guest has no child view.
 *
 * This is a wiring rule, so it is checked against the source rather than
 * exercised at runtime: a unit test cannot fabricate an Electron view tree.
 */
const BROWSER = readFileSync(join(process.cwd(), "src", "main", "embedded", "browser.ts"), "utf8");
const SURFACE = readFileSync(join(process.cwd(), "src", "main", "embedded", "surface.ts"), "utf8");

describe("pages are addressed through a carrier-neutral surface", () => {
  it("keeps native-view operations inside the adapter", () => {
    // `setBounds`/`getBounds` are part of the surface interface, so the manager
    // calling them is correct. What must not leak out is anything that only
    // exists on a native view: the child-view tree, DevTools hosting, and
    // visibility toggling on a view that a guest does not have.
    expect(BROWSER).not.toMatch(/contentView\.addChildView\(tab\.view\)/);
    expect(BROWSER).not.toMatch(/tab\.view\.setVisible/);
    expect(BROWSER).not.toMatch(/tab\.view\.webContents\.setDevToolsWebContents/);
    // The two remaining native calls are guarded by a type check, which is the
    // only place the manager is allowed to know the difference.
    const guarded = BROWSER.match(/isNativeSurface\(tab\.view\)/g) ?? [];
    expect(guarded.length).toBeGreaterThanOrEqual(2);
  });

  it("exposes exactly the operations a page needs", () => {
    for (const member of ["webContents", "setBounds", "getBounds", "setVisible", "setBackgroundColor"]) {
      expect(SURFACE).toContain(`${member}`);
    }
  });

  it("makes a guest's geometry answerable without a native view", () => {
    // `viewIsOnScreen` and the screenshot paths ask for bounds; a guest answers
    // with what the renderer laid out, so those checks keep working.
    expect(SURFACE).toMatch(/class GuestPageSurface[\s\S]*?reportBounds/);
    expect(SURFACE).toMatch(/class GuestPageSurface[\s\S]*?getBounds\(\)/);
  });
});
