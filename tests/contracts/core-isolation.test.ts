import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const CORE_DIR = join(process.cwd(), "src", "core");

function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      entries.push(full);
    }
  }
  return entries;
}

describe("core layer isolation contract", () => {
  it("never imports electron inside src/core", () => {
    const offenders: string[] = [];
    for (const file of walk(CORE_DIR)) {
      const source = readFileSync(file, "utf8");
      const hasImport =
        /from\s+["']electron["']/.test(source) ||
        /require\(\s*["']electron["']\s*\)/.test(source) ||
        /from\s+["']electron\//.test(source);
      if (hasImport) offenders.push(relative(process.cwd(), file));
    }
    expect(offenders, `core must stay runnable under plain Node: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps the renderer free of node built-ins and electron", () => {
    const rendererDir = join(process.cwd(), "src", "renderer");
    const offenders: string[] = [];
    for (const file of walk(rendererDir)) {
      const source = readFileSync(file, "utf8");
      if (/from\s+["']node:/.test(source) || /from\s+["']electron["']/.test(source)) {
        offenders.push(relative(process.cwd(), file));
      }
    }
    expect(offenders, `renderer must talk to the main process via IPC only: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });
});
