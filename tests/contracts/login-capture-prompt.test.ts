import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the "save this login?" path.
 *
 * Two things went wrong here, and both were visible only by using it:
 *
 * - Clicking **Save account** opened a browser window. The save handler called
 *   `launchIdentity` "to prove the password was stored". A user who asked for an
 *   account to be stored did not ask for a window, and the window appearing on
 *   its own reads as an unrequested action.
 * - The prompt could not be dismissed while a dialog was open. It is a fixed
 *   child of `<body>`, and a modal sets `body { pointer-events: none }`, so the
 *   bar stayed visible and clickable-looking while swallowing every press.
 *
 * Read as source text on purpose: these are wiring rules (which call exists in
 * which handler), not behaviour a unit test can execute without a full window.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

const app = read("src/renderer/src/App.vue");

/** The body of `saveIdentity`, braces balanced from its opening line. */
function saveIdentityBody(): string {
  const start = app.indexOf("async function saveIdentity(");
  expect(start, "saveIdentity must exist").toBeGreaterThan(-1);
  const open = app.indexOf("{", app.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < app.length; index += 1) {
    const char = app[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return app.slice(open, index + 1);
    }
  }
  throw new Error("unbalanced saveIdentity body");
}

describe("saving a captured login", () => {
  it("stores the account and launches nothing", () => {
    // The regression: `store.launchIdentity(...)` sat at the end of this
    // handler, so pressing "save account" also opened a browser window.
    const body = saveIdentityBody();
    expect(body).not.toContain("launchIdentity");
    expect(body).not.toContain("launchView");
    // And it still releases the capture, or the prompt would outlive the save.
    expect(body).toContain("clearLoginCapture");
  });

  it("hides the prompt while a dialog is open", () => {
    // A modal sets `body { pointer-events: none }`; the prompt lives outside the
    // dialog portal, so it stayed on screen but could not be clicked.
    expect(app).toContain("capturePromptVisible");
    expect(app).toContain("!captureCovered.value");
    // The guide opens itself on a first run; suppressing the prompt under it hid
    // a new user's very first captured login until they dismissed the intro.
    expect(app).toContain("captureCovered");
    const coveredBlock = app.slice(app.indexOf("const captureCovered"));
    expect(coveredBlock.slice(0, coveredBlock.indexOf(");"))).not.toContain("guideOpen");
    // The template must render from that computed, not from the raw pending
    // list — otherwise the fix exists and nothing uses it.
    expect(app).toContain('v-if="capturePromptVisible"');
    expect(app).not.toContain('v-if="captureVisible && store.pendingLogins.length"');
  });

  it("keeps the capture when the prompt is merely hidden", () => {
    // Hiding is a visibility decision; the pending list and the message centre
    // are the record. Losing the capture on a dismissal is what made this path
    // unrecoverable before.
    const body = saveIdentityBody();
    expect(body).not.toContain("dismissLoginCapture");
    expect(app).toContain("store.dismissLoginCapture");
  });
});
