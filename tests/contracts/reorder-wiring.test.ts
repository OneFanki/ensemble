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
    expect(ipc).toMatch(/tagMove: "site-tag:move"/);
    expect(ipc).toMatch(/bookmarkFolderMove: "bookmark:folder-move"/);
  });

  it("exposes every channel through the preload bridge", () => {
    expect(preload).toMatch(
      /moveSite: \(id, toIndex\) => ipcRenderer\.invoke\(IPC\.siteMove, id, toIndex\)/,
    );
    expect(preload).toMatch(
      /moveTag: \(id, toIndex\) => ipcRenderer\.invoke\(IPC\.tagMove, id, toIndex\)/,
    );
    expect(preload).toMatch(
      /moveBookmarkFolder: \(id, toIndex\) =>\s*ipcRenderer\.invoke\(IPC\.bookmarkFolderMove, id, toIndex\)/,
    );
  });

  it("registers a main-process handler that broadcasts and returns the snapshot", () => {
    for (const channel of ["siteMove", "tagMove", "bookmarkFolderMove"]) {
      expect(main).toMatch(
        new RegExp(
          `handle\\(IPC\\.${channel}, \\(id: string, toIndex: number\\) => \\{[\\s\\S]*?broadcastWorkspace\\(\\);[\\s\\S]*?return workspace\\.snapshot\\(\\);`,
        ),
      );
    }
  });

  it("applies the returned snapshot in the store", () => {
    for (const method of ["moveSite", "moveTag", "moveBookmarkFolder"]) {
      expect(store).toMatch(new RegExp(`function ${method}\\(`));
      expect(store).toMatch(new RegExp(`window\\.ensemble\\.${method}\\(`));
    }
  });

  it("wires the pages to the store instead of reordering locally", () => {
    expect(read("src/renderer/src/components/TagsPage.vue")).toMatch(/store\.moveTag\(/);
    expect(read("src/renderer/src/components/SitesPage.vue")).toMatch(/store\.moveSite\(/);
    expect(read("src/renderer/src/components/BookmarksPage.vue")).toMatch(
      /workspace\.moveBookmarkFolder\(/,
    );
  });
});
