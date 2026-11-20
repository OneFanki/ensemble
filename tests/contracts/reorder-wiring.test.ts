import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every reorder crosses four layers, and forgetting one is silent: the list
 * still renders and the drag still highlights, only the drop does nothing.
 * These assertions name each layer so a missing wire fails here, not in the UI.
 */
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const ipc = read("src/shared/ipc.ts");
const preload = read("src/preload/index.ts");
const main = read("src/main/index.ts");
const store = read("src/renderer/src/stores/workspace.ts");

describe("reorder wiring contract", () => {
  it("declares one channel per reorderable list", () => {
    expect(ipc).toMatch(/siteMove: "site:move"/);
    expect(ipc).toMatch(/bookmarkFolderMove: "bookmark:folder-move"/);
  });

  it("exposes every channel through the preload bridge", () => {
    expect(preload).toMatch(
      /moveSite: \(id, toIndex\) => ipcRenderer\.invoke\(IPC\.siteMove, id, toIndex\)/,
    );
    expect(preload).toMatch(
      /moveBookmarkFolder: \(id, toIndex\) =>\s*ipcRenderer\.invoke\(IPC\.bookmarkFolderMove, id, toIndex\)/,
    );
  });

  it("registers a main-process handler that broadcasts and returns the snapshot", () => {
    for (const channel of ["siteMove", "bookmarkFolderMove"]) {
      expect(main).toMatch(
        new RegExp(
          `handle\\(IPC\\.${channel}, \\(id: string, toIndex: number\\) => \\{[\\s\\S]*?broadcastWorkspace\\(\\);[\\s\\S]*?return workspace\\.snapshot\\(\\);`,
        ),
      );
    }
  });

  it("applies the returned snapshot in the store", () => {
    for (const method of ["moveSite", "moveBookmarkFolder"]) {
      expect(store).toMatch(new RegExp(`function ${method}\\(`));
      expect(store).toMatch(new RegExp(`window\\.ensemble\\.${method}\\(`));
    }
  });

  it("wires the pages to the store instead of reordering locally", () => {
    // Two reorderable lists are left: sites (the account page's edit face) and
    // bookmark folders. Both reach the store rather than splicing their own copy.
    expect(read("src/renderer/src/components/BookmarksPage.vue")).toMatch(
      /workspace\.moveBookmarkFolder\(/,
    );
    expect(read("src/renderer/src/components/IdentitiesPage.vue")).toMatch(/store\.moveSite\(/);
  });

  it("keeps one reorder implementation per list, and the account page owns sites", () => {
    // Sites: the account page's edit face is the only place a site row exists — a
    // site is the heading of its accounts — so the grip there is the one and only
    // site reorder. It reaches the store rather than splicing locally, which the
    // assertion above locks.
    //
    // Site groups used to be a second list here. They are gone: a site's own name
    // is the grouping, so there was nothing left to reorder above it.
    const accountPage = read("src/renderer/src/components/IdentitiesPage.vue");
    expect(accountPage).toMatch(/store\.moveSite\(/);
    // The grip lives only on the edit face: ordering is maintenance, and a tile
    // that both launches and starts a drag does the wrong thing half the time.
    expect(accountPage).toMatch(/class="group-grip"/);
  });
});
