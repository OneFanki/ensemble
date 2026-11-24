import { describe, expect, it } from "vitest";
import { nameSimilarity, suggestNames } from "../src/core/util/name-suggestions";

const TOOLS = [
  "close_browser_tab",
  "close_browser_view",
  "click_browser_element",
  "hover_browser_element",
  "save_flow",
  "list_flows",
  "run_flow",
  "read_browser_page",
  "set_browser_layout",
  "open_browser_tab",
];

describe("suggestNames", () => {
  it("finds the tool a shortened name was aiming at", () => {
    // The word in the middle is the one a caller drops; the edit distance
    // barely notices, the words do.
    expect(suggestNames("close_tab", TOOLS)).toContain("close_browser_tab");
    expect(suggestNames("click", TOOLS)).toContain("click_browser_element");
  });

  it("finds the tool behind a wrong verb", () => {
    // There is no update_flow: a flow is saved whole. The caller should be
    // pointed at save_flow rather than at a bare "no such tool".
    expect(suggestNames("update_flow", TOOLS)[0]).toBe("save_flow");
  });

  it("puts the closest name first and respects the limit", () => {
    expect(suggestNames("open_browser_tab", TOOLS, 1)).toEqual(["close_browser_tab"]);
    expect(suggestNames("open_browser_tab", TOOLS, 2)).toHaveLength(2);
  });

  it("finds the argument behind a near miss", () => {
    expect(suggestNames("name", ["names", "selector", "tabId"])).toEqual(["names"]);
    expect(suggestNames("slector", ["names", "selector", "tabId"])).toEqual(["selector"]);
  });

  it("suggests nothing when no name is close", () => {
    expect(suggestNames("frobnicate", TOOLS)).toEqual([]);
    expect(suggestNames("launch_view", TOOLS)).toEqual([]);
  });

  it("does not suggest the name itself or answer a name too short to mean anything", () => {
    expect(suggestNames("save_flow", TOOLS)).not.toContain("save_flow");
    expect(suggestNames("go", TOOLS)).toEqual([]);
    expect(suggestNames("   ", TOOLS)).toEqual([]);
  });
});

describe("nameSimilarity", () => {
  it("is 1 for the same name and shrinks as names grow apart", () => {
    expect(nameSimilarity("read_browser_page", "read_browser_page")).toBe(1);
    expect(nameSimilarity("wait_browser_condition", "wait_browserr")).toBeGreaterThan(
      nameSimilarity("wait_browser_condition", "wait_for_page"),
    );
  });

  it("treats a one-letter difference as a near miss, not as a different name", () => {
    expect(nameSimilarity("names", "name")).toBeGreaterThanOrEqual(0.5);
    expect(nameSimilarity("list_tabs", "list_browser_tabs")).toBeGreaterThanOrEqual(0.5);
  });
});
