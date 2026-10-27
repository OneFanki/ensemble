import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keyboard handlers must act on the keyDown half of a press only.
 *
 * `before-input-event` fires twice per physical key press — once for keyDown and
 * again for keyUp. A toggle written without that check flips twice, and because
 * the keyUp is delivered to whichever webContents has focus *by then*, the two
 * halves can land in different handlers: F12 opened DevTools from the page's
 * handler, the panel took focus, and the same press's keyUp reached the panel's
 * handler (which also toggled) and closed it again. The toolbar button never
 * showed the bug because it has no keystroke to finish.
 *
 * The rule is mechanical and easy to forget when adding a shortcut, so it is
 * checked here rather than left to the E2E that only covers the DevTools case.
 */
const FILES = [join(process.cwd(), "src/main/index.ts"), join(process.cwd(), "src/main/embedded/browser.ts")];

function normalised(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** Every `before-input-event` callback body, brace-matched from its opening `{`. */
function handlers(source: string): string[] {
  const found: string[] = [];
  const marker = '"before-input-event"';
  let index = source.indexOf(marker);
  while (index >= 0) {
    const start = source.indexOf("{", source.indexOf("=>", index));
    if (start < 0) break;
    let depth = 0;
    let end = start;
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
    found.push(source.slice(start, end));
    index = source.indexOf(marker, end);
  }
  return found;
}

describe("keyboard shortcuts act on keyDown only", () => {
  it("guards every before-input-event handler against keyUp and auto-repeat", () => {
    const offenders: string[] = [];
    let total = 0;
    for (const file of FILES) {
      for (const body of handlers(normalised(file))) {
        total += 1;
        const guardsKeyUp = body.includes('input.type !== "keyDown"');
        // Zoom shortcuts legitimately repeat while the key is held; toggles must
        // not. Only a handler that toggles something is required to check it.
        const toggles = body.includes("openDevTools") || body.includes("closeDevTools");
        const guardsRepeat = body.includes("isAutoRepeat");
        if (!guardsKeyUp || (toggles && !guardsRepeat)) {
          offenders.push(`${file.replace(process.cwd(), "")}: ${body.slice(0, 90).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(total).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
