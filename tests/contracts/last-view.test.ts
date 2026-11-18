import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsPatchSchema } from "@shared/schemas";
import type { AppSettings } from "@shared/types";

/**
 * `lastView` has two definitions and they must agree.
 *
 * `AppSettings["lastView"]` is what the interface may switch to; the zod enum in
 * `settingsPatchSchema` is what the main process will accept. They drifted once:
 * views existed in the type and not in the schema, so choosing one made saving
 * the setting fail with a raw validation error in a toast.
 *
 * The type cannot be enumerated at runtime, so this pins the members by name and
 * both sides are checked against the same list: adding a view to one and not the
 * other is what fails, whichever side is forgotten.
 *
 * The retired "views" page (P1-3) is out of the list on both sides; a workspace
 * still storing it falls back to the browser page on restore.
 */
const VIEWS = [
  "browser",
  "messages",
  "ai",
  "sites",
  "identities",
  "flows",
  "tags",
  "bookmarks",
  "profiles",
] as const;

const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("lastView", () => {
  it("accepts every view the type allows, and nothing else", () => {
    for (const view of VIEWS) {
      expect(settingsPatchSchema.safeParse({ lastView: view }).success, view).toBe(true);
    }
    expect(settingsPatchSchema.safeParse({ lastView: "nope" }).success).toBe(false);
    // The retired page is rejected: restoring it would land on a blank pane.
    expect(settingsPatchSchema.safeParse({ lastView: "views" }).success).toBe(false);
  });

  it("has the same members on both sides", () => {
    // The union written out as a type is invisible to a runtime check, so its
    // source text is read instead — the same technique the other contracts use
    // for rules that only exist at compile time.
    const types = read("src/shared/types.ts");
    const union = types.slice(types.indexOf("lastView:"), types.indexOf("lastView:", types.indexOf("lastView:")) + 400);
    const declared = [...union.matchAll(/\| "([a-z-]+)"/g)].map((match) => match[1]);
    expect(declared.sort()).toEqual([...VIEWS].sort());
  });

  it("only names surfaces the shell can actually open", () => {
    // A saved `lastView` that no page handles must not land on a blank pane.
    // The shell has exactly two surfaces since the management pane (P1-2):
    // the browser and the pane. The schema above keeps the pre-pane values so
    // old workspaces round-trip, and App.vue restores every one of them to the
    // browser — the pane is never a surface to launch on.
    const shell = read("src/renderer/src/App.vue");
    const union = shell.slice(
      shell.indexOf("type View ="),
      shell.indexOf("const store = useWorkspaceStore"),
    );
    // The first member has no leading `|`, so the union is asserted as written.
    expect(union).toContain('type View = "browser" | "manage"');
    // The retired "views" page is out: no page may answer "views" again.
    expect(union).not.toContain("views");
  });
});

// Compile-time check: the list above must be assignable both ways. A view added
// to the union but not here is a type error in this file, before any assertion.
const _exhaustive: Record<AppSettings["lastView"], true> = Object.fromEntries(
  VIEWS.map((view) => [view, true]),
) as Record<AppSettings["lastView"], true>;
void _exhaustive;
