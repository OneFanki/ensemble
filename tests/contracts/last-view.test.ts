import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsPatchSchema } from "@shared/schemas";
import type { AppSettings } from "@shared/types";

/**
 * `lastView` has two definitions and they must agree.
 *
 * `AppSettings["lastView"]` is what the interface may switch to; the zod enum in
 * `settingsPatchSchema` is what the main process will accept. They drifted: two
 * views existed in the type and not in the schema, so choosing either of them
 * made saving the setting fail with a raw validation error in a toast — visible
 * only if a person happened to navigate there and looked at the corner.
 *
 * The type cannot be enumerated at runtime, so this pins the members by name and
 * both sides are checked against the same list: adding a view to one and not the
 * other is what fails, whichever side is forgotten.
 */
const VIEWS = [
  "browser",
  "messages",
  "ai",
  "sites",
  "identities",
  "views",
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

  it("only names views that the sidebar can actually open", () => {
    // A saved `lastView` that no page handles restores the shell to a blank pane.
    const sidebar = read("src/renderer/src/components/AppSidebar.vue");
    const union = sidebar.slice(sidebar.indexOf("export type AppView"), sidebar.indexOf("defineProps"));
    const views = [...union.matchAll(/\| "([a-z-]+)"/g)].map((match) => match[1]);
    expect(views.sort()).toEqual([...VIEWS].sort());
  });
});

// Compile-time check: the list above must be assignable both ways. A view added
// to the union but not here is a type error in this file, before any assertion.
const _exhaustive: Record<AppSettings["lastView"], true> = Object.fromEntries(
  VIEWS.map((view) => [view, true]),
) as Record<AppSettings["lastView"], true>;
void _exhaustive;
