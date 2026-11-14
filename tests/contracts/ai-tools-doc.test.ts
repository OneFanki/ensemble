import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The AI tool capability matrix, kept honest.
 *
 * `docs/engineering/ai-tools.md` is the only place a person can find out what a
 * tool costs, which ones pass the origin gate, and what a timeout means. That
 * makes it the exact kind of document that rots: a tool gets added, the table
 * does not, and six months later the table is a list of things that used to be
 * true. There is no reviewer who would notice, because the drift is invisible
 * from either side alone.
 *
 * So the table and the source are compared mechanically. Adding a tool without a
 * row fails here; deleting one while leaving its row also fails.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

interface ToolEntry {
  name: string;
  kind: string;
}

/**
 * Every tool defined in the server, in declaration order.
 *
 * Parsed from the source because that is what actually ships. The `tools()` list
 * is a literal array of object literals; a `name:` followed by a `kind:` inside
 * the same entry is the shape every one of them has.
 */
function toolsInSource(): ToolEntry[] {
  const source = read("src/main/mcp/server.ts");
  const entries: ToolEntry[] = [];
  // Split on the indentation that starts one entry in the array. Every tool
  // object begins with `      {` and nothing else in the file uses that.
  for (const block of source.split(/\n {6}\{\n/).slice(1)) {
    const name = block.match(/^ {8}name: "([a-z0-9_]+)"/);
    if (!name) continue;
    const kind = block.match(/\n {8}kind: "(read|write|run|danger)"/);
    if (!kind) continue;
    entries.push({ name: name[1]!, kind: kind[1]! });
  }
  return entries;
}

interface DocRow {
  names: string[];
  kind: string;
}

/**
 * The rows of the capability table.
 *
 * Scoped to the matrix section on purpose: section 0 has a legend whose first
 * cell holds `read` / `write` / `run` / `danger`, and reading that as a tool
 * list would make every assertion here compare against the legend.
 *
 * A row can carry several names that share every other column —
 * `` | `list_sites` / `list_site_tags` / … | read | … | `` — and a row whose
 * names differ in kind spells them out in order (`write / write / read`).
 */
function docRows(): DocRow[] {
  const doc = read("docs/engineering/ai-tools.md");
  const start = doc.indexOf("## 1. 总表");
  const end = doc.indexOf("## 2.", start);
  expect(start, "the matrix section is missing").toBeGreaterThan(-1);
  const section = doc.slice(start, end === -1 ? undefined : end);

  const rows: DocRow[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const names = [...(cells[1] ?? "").matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1]!);
    if (names.length === 0) continue;
    rows.push({ names, kind: cells[2] ?? "" });
  }
  return rows;
}

/** Every tool name the document lists as a row. */
function toolsInDoc(): Set<string> {
  return new Set(docRows().flatMap((row) => row.names));
}

describe("the AI tool matrix matches the code", () => {
  it("finds the tools it is supposed to be checking", () => {
    // If the parser stops matching (a reformat, a different indent), every
    // assertion below would pass vacuously against an empty set. This is the
    // guard against a green suite that checks nothing.
    const tools = toolsInSource();
    expect(tools.length).toBeGreaterThan(50);
    for (const kind of ["read", "write", "run", "danger"]) {
      expect(tools.some((tool) => tool.kind === kind)).toBe(true);
    }
  });

  it("documents every tool", () => {
    const documented = toolsInDoc();
    const missing = toolsInSource()
      .map((tool) => tool.name)
      .filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  it("does not document tools that no longer exist", () => {
    // A retired name left in the table is worse than a missing one: it reads as
    // a capability the product still has.
    const defined = new Set(toolsInSource().map((tool) => tool.name));
    const stale = [...toolsInDoc()].filter((name) => !defined.has(name));
    expect(stale).toEqual([]);
  });

  it("names the kind of every tool in the table", () => {
    // The kind column is what a reader uses to decide whether a tool needs the
    // write permission, so a row without one is not a row. Where a row groups
    // tools of different kinds, it spells them out in the same order as the
    // names — and that order is checked too, because a mismatched list is how
    // this column would quietly become decorative.
    const kinds = new Map<string, string>();
    for (const row of docRows()) {
      const listed = row.kind.split("/").map((part) => part.trim());
      const names = row.names;
      if (listed.length === 1) {
        for (const name of names) kinds.set(name, listed[0]!);
        continue;
      }
      expect(
        listed.length,
        `${names.join(", ")}: ${names.length} names, ${listed.length} kinds`,
      ).toBe(names.length);
      for (const [index, name] of names.entries()) kinds.set(name, listed[index]!);
    }
    const mismatches = toolsInSource()
      .filter((tool) => kinds.get(tool.name) !== tool.kind)
      .map((tool) => `${tool.name}: doc ${kinds.get(tool.name) ?? "—"}, code ${tool.kind}`);
    expect(mismatches).toEqual([]);
  });
});
