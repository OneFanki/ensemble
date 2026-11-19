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
    expect(ipc).toMatch(/siteGroupMove: "site-group:move"/);
    expect(ipc).toMatch(/bookmarkFolderMove: "bookmark:folder-move"/);
  });

  it("exposes every channel through the preload bridge", () => {
    expect(preload).toMatch(
      /moveSite: \(id, toIndex\) => ipcRenderer\.invoke\(IPC\.siteMove, id, toIndex\)/,
    );
    expect(preload).toMatch(
      /moveSiteGroup: \(id, toIndex\) => ipcRenderer\.invoke\(IPC\.siteGroupMove, id, toIndex\)/,
    );
    expect(preload).toMatch(
      /moveBookmarkFolder: \(id, toIndex\) =>\s*ipcRenderer\.invoke\(IPC\.bookmarkFolderMove, id, toIndex\)/,
    );
  });

  it("registers a main-process handler that broadcasts and returns the snapshot", () => {
    for (const channel of ["siteMove", "siteGroupMove", "bookmarkFolderMove"]) {
      expect(main).toMatch(
        new RegExp(
          `handle\\(IPC\\.${channel}, \\(id: string, toIndex: number\\) => \\{[\\s\\S]*?broadcastWorkspace\\(\\);[\\s\\S]*?return workspace\\.snapshot\\(\\);`,
        ),
      );
    }
  });

  it("applies the returned snapshot in the store", () => {
    for (const method of ["moveSite", "moveSiteGroup", "moveBookmarkFolder"]) {
      expect(store).toMatch(new RegExp(`function ${method}\\(`));
      expect(store).toMatch(new RegExp(`window\\.ensemble\\.${method}\\(`));
    }
  });

  it("wires the pages to the store instead of reordering locally", () => {
    // The group editor is the one place groups are reordered; both entrances
    // (the account page's inline panel and the settings tab) render it, so
    // there is one implementation rather than two.
    const editor = read("src/renderer/src/components/SiteGroupsEditor.vue");
    expect(editor).toMatch(/store\.moveSiteGroup\(/);
    expect(read("src/renderer/src/components/BookmarksPage.vue")).toMatch(
      /workspace\.moveBookmarkFolder\(/,
    );
  });

  it("no page carries a second site or group reorder implementation", () => {
    // Sites have no list of their own any more: they are the sections of the
    // account page. The only group reorder is the one the editor owns.
    const accountPage = read("src/renderer/src/components/IdentitiesPage.vue");
    expect(accountPage).not.toMatch(/store\.moveSiteGroup\(/);
    expect(accountPage).not.toMatch(/onSiteDrag/);
  });
});
