import { ref, watch } from "vue";

/**
 * Collapsed groups for one grouped list, remembered across restarts.
 *
 * Every grouped list in the app — sites by tag, accounts by site, flows by site —
 * needs the same three things: a per-group toggle, a "collapse all" switch and a
 * memory. Copying that into three components would let the three drift apart on
 * details that are invisible in one screenshot (which ids count as collapsed,
 * whether an unknown id survives a filter change).
 *
 * Ids that are not in the current list are kept on purpose: filtering by a tag
 * hides groups without deleting them, and forgetting the state would silently
 * expand a group the user had collapsed as soon as the filter is cleared.
 */
export function useGroupCollapse(storageKey: string) {
  const collapsed = ref<Set<string>>(readCollapsed(storageKey));

  watch(
    collapsed,
    (value) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...value]));
      } catch {
        // A full quota must not break a click; the list still collapses, it just
        // forgets after a restart.
      }
    },
    { deep: false },
  );

  function isCollapsed(key: string): boolean {
    return collapsed.value.has(key);
  }

  function toggle(key: string): void {
    const next = new Set(collapsed.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed.value = next;
  }

  /** True when every group on screen is already collapsed. */
  function allCollapsed(keys: readonly string[]): boolean {
    return keys.length > 0 && keys.every((key) => collapsed.value.has(key));
  }

  /**
   * One switch for the whole page: collapse everything, or reopen everything.
   *
   * The direction is derived from the visible groups rather than remembered, so
   * the button always does what its label says: with one group still open it
   * collapses, and with all of them closed it expands.
   */
  function toggleAll(keys: readonly string[]): void {
    const next = new Set(collapsed.value);
    if (allCollapsed(keys)) {
      for (const key of keys) next.delete(key);
    } else {
      for (const key of keys) next.add(key);
    }
    collapsed.value = next;
  }

  return { collapsed, isCollapsed, toggle, allCollapsed, toggleAll };
}

function readCollapsed(storageKey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    // Hand-edited or from an older build: start open rather than crash the page.
    return new Set();
  }
}
