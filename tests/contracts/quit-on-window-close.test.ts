import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");

function handlerBody(event: string): string {
  const start = source.indexOf(`app.on("${event}"`);
  expect(start, `app.on("${event}") must exist`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf("=>", start));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`Unterminated handler for ${event}`);
}

describe("quit on window close contract", () => {
  it("calls app.quit() when the last window closes", () => {
    // Registering a window-all-closed listener takes over the quit decision.
    // Waiting on service.shutdown() here leaves the process (and the portable
    // exe on Windows) alive after the window is gone.
    expect(handlerBody("window-all-closed")).toMatch(/app\.quit\(\)/);
  });

  it("guards the window close handler with a quitting flag", () => {
    expect(source).toMatch(/mainWindow\.on\("close"[\s\S]*?if \(quitting\) return;/);
    expect(source).toMatch(/event\.preventDefault\(\)/);
  });
});
