import { inject, provide, ref, type Ref } from "vue";

/**
 * Which folder panel is open, across one bookmark bar.
 *
 * Each folder used to own its own boolean, and that made two panels coexist:
 * moving from one root folder to the next left the first one open for its whole
 * grace period while the second opened underneath the pointer — the staircase
 * of overlapping panels people kept hitting. A single path answers it exactly:
 * a panel is open when it is on the path, so opening a sibling closes the
 * previous branch at once, while opening a child keeps its ancestors (they are
 * on the path) and closing one drops everything below it.
 *
 * The grace period survives for the case it was added for — the pointer crossing
 * the gap between a row and its own panel — because that path does not change.
 */
export interface BookmarkFlyout {
  /** Ids from a root folder down to the deepest open panel; empty when closed. */
  path: Ref<string[]>;
  /** Opens this folder and closes any branch that is not one of its ancestors. */
  open(folderId: string, ancestors: string[]): void;
  /** Closes this folder and everything under it. */
  close(folderId: string): void;
  /** Closes the whole chain — a bookmark was picked or a menu opened. */
  closeAll(): void;
}

const KEY = Symbol("bookmark-flyout");

export function provideBookmarkFlyout(): BookmarkFlyout {
  const path = ref<string[]>([]);
  const api: BookmarkFlyout = {
    path,
    open(folderId, ancestors) {
      path.value = [...ancestors, folderId];
    },
    close(folderId) {
      const index = path.value.indexOf(folderId);
      if (index < 0) return;
      path.value = path.value.slice(0, index);
    },
    closeAll() {
      path.value = [];
    },
  };
  provide(KEY, api);
  return api;
}

/** `null` outside a bar, so a folder row can still be rendered on its own. */
export function useBookmarkFlyout(): BookmarkFlyout | null {
  return inject<BookmarkFlyout | null>(KEY, null);
}
