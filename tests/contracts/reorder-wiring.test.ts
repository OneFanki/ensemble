import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every reorder crosses four layers, and forgetting one is silent: the list
 * still renders and the drag still highlights, only the drop does nothing.
 * These assertions name each layer so a missing wire fails here, not in the UI.
 *
 * Sites are no longer reorderable from the interface: they list in name order,
 * which needs no stored sequence. The channel and the store method stay — the
 * ordering capability is still a real one, and removing it would mean a data
 * migration for a list nobody reorders by hand any more. What changed is that
 * the account page must *not* grow a drag handle again without this file
 * changing with it.
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

  it("wires bookmark folders to the store instead of reordering locally", () => {
    // Bookmarks are the one list left with a drag handle, and it reaches the
    // store rather than splicing its own copy.
    expect(read("src/renderer/src/components/BookmarksPage.vue")).toMatch(
      /workspace\.moveBookmarkFolder\(/,
    );
  });

  it("lists sites by name, with no drag handle left behind", () => {
    /*
     * A site costs one row in the left column and users look for it by name, so
     * name order is the order they expect. Dragging meant a stored sequence
     * nobody could predict — two sites created minutes apart sat in creation
     * order — and it also required a grip, drop targets and a "where did it go"
     * after every drag.
     *
     * The guard is two-sided on purpose: the list must sort, and the old drag
     * affordance must not creep back alongside it. A handle next to a sorted list
     * is a control that does nothing.
     */
    const accountPage = read("src/renderer/src/components/IdentitiesPage.vue");
    expect(accountPage).toMatch(/\.sort\(\(a, b\) =>/);
    expect(accountPage).toMatch(/localeCompare/);
    expect(accountPage).not.toMatch(/class="group-grip"/);
    expect(accountPage).not.toMatch(/onSiteDragStart/);
    expect(accountPage).not.toMatch(/draggable="true"/);
  });
});
