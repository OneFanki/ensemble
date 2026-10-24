import type { EmbeddedState, EmbeddedTab, EmbeddedView } from "@shared/embedded";
import { planTabClick, resolveSlotTabs, stageTab } from "@shared/embedded";
import { describe, expect, it } from "vitest";

function tab(id: string, viewId?: string): EmbeddedTab {
  return {
    id,
    label: id,
    url: "http://example.test/",
    title: id,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    origin: "manual",
    instanceId: id,
    active: true,
    zoom: 100,
    devtoolsOpen: false,
    ...(viewId ? { viewId } : {}),
  };
}

function view(id: string, slotTabs: (string | null)[], focusedTabId?: string): EmbeddedView {
  return {
    id,
    name: id,
    layoutId: slotTabs.length > 1 ? "2x1" : "free",
    slotTabs,
    collapsed: false,
    ...(focusedTabId ? { focusedTabId } : {}),
  };
}

function surface(): EmbeddedState {
  return {
    tabs: [tab("a", "v1"), tab("b", "v1"), tab("c", "v1"), tab("d", "v2"), tab("loose")],
    views: [view("v1", ["a", "b"], "a"), view("v2", ["d"], "d")],
    activeTabId: "a",
    activeViewId: "v1",
  };
}

describe("click rules", () => {
  it("clicking an on-stage tab only moves focus", () => {
    const plan = planTabClick(surface(), "b");
    expect(plan.activeViewId).toBe("v1");
    expect(plan.activeTabId).toBe("b");
    expect(plan.layoutChanged).toBe(false);
    expect(plan.views.find((item) => item.id === "v1")?.slotTabs).toEqual(["a", "b"]);
  });

  it("clicking an off-stage tab swaps it into the focused slot", () => {
    const plan = planTabClick(surface(), "c");
    expect(plan.activeTabId).toBe("c");
    // "a" was focused, so "c" takes slot 1 and "a" steps aside.
    expect(plan.views.find((item) => item.id === "v1")?.slotTabs).toEqual(["c", "b"]);
    expect(plan.layoutChanged).toBe(true);
  });

  it("swapping twice returns to the original arrangement", () => {
    const first = planTabClick(surface(), "c");
    const swapped: EmbeddedState = {
      tabs: surface().tabs,
      views: first.views,
      activeTabId: first.activeTabId,
      activeViewId: first.activeViewId,
    };
    // "a" is now off stage; clicking it swaps back into the same slot.
    const second = planTabClick(swapped, "a");
    expect(second.views.find((item) => item.id === "v1")?.slotTabs).toEqual(["a", "b"]);
  });

  it("clicking another view's tab switches to that view", () => {
    const plan = planTabClick(surface(), "d");
    expect(plan.activeViewId).toBe("v2");
    expect(plan.activeTabId).toBe("d");
    expect(plan.layoutChanged).toBe(false);
  });

  it("clicking a loose tab leaves the view", () => {
    const plan = planTabClick(surface(), "loose");
    expect(plan.activeTabId).toBe("loose");
    expect(plan.activeViewId).toBeUndefined();
  });

  it("falls back to the first slot when the view has no focus", () => {
    const state = surface();
    state.views = [view("v1", ["a", "b"])];
    const plan = planTabClick(state, "c");
    expect(plan.views[0]?.slotTabs).toEqual(["c", "b"]);
  });
});

describe("stageTab", () => {
  it("never stages a tab twice", () => {
    expect(stageTab(view("v", ["a", "b"]), "b")).toEqual(["a", "b"]);
  });

  it("does nothing for a view with no slots", () => {
    expect(stageTab(view("v", []), "a")).toEqual([]);
  });
});

describe("slot resolution inside a view", () => {
  it("only fills slots with tabs that belong to that view", () => {
    expect(resolveSlotTabs(["a", "b"], ["b", null], 2)).toEqual(["b", "a"]);
    // A stale id from another view is dropped rather than rendered.
    expect(resolveSlotTabs(["a"], ["gone", null], 2)).toEqual(["a", null]);
  });
});
