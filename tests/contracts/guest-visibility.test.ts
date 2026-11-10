import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards which guest node is allowed to paint.
 *
 * The bug this exists for: `isOnStage` compared `instanceId`, so every page of
 * the focused instance reported "on stage". Two guest nodes then carried
 * `opacity: 1` in the same rectangle, and the placeholder `about:blank` that
 * every instance starts with was one of them — it sat on top of the real page
 * and the window showed an empty new tab until a reload shuffled the layers.
 * Reported as "the saved account sits on a blank page until I refresh".
 *
 * Source-text assertions because the rule lives inside a Pinia store closure;
 * what has to hold is the *shape* of the comparison, and that is readable here.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");
const store = read("src/renderer/src/stores/embedded.ts");

function isOnStageBody(): string {
  const start = store.indexOf("function isOnStage(");
  expect(start, "isOnStage must exist").toBeGreaterThan(-1);
  const open = store.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < store.length; index += 1) {
    const char = store[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return store.slice(open, index + 1);
    }
  }
  throw new Error("unbalanced isOnStage body");
}

describe("which guest node is on stage", () => {
  it("shows exactly the active page in flat mode", () => {
    const body = isOnStageBody();
    // The active page is named by id. Comparing `instanceId` here is the bug:
    // it made every page of the instance claim the same rectangle.
    expect(body).toContain("state.value.activeTabId");
    expect(body).not.toContain("tab.instanceId === focused.instanceId");
  });

  it("only draws a view's pages while that view is the one on stage", () => {
    // A page of an off-stage view still has a slot table entry; without this
    // check it kept painting over whatever was actually on screen.
    const body = isOnStageBody();
    expect(body).toContain("activeViewId");
  });

  it("honours a cell's pinned page", () => {
    // Splitting one instance across two cells pins a different page per cell;
    // ignoring that would show the active page twice.
    expect(isOnStageBody()).toContain("slotPages");
  });
});
