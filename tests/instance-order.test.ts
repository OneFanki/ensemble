import { describe, expect, it } from "vitest";
import { reorderInstanceBlock } from "../src/main/embedded/browser";

/**
 * Account-bar chip dragging.
 *
 * The rail lists instances; the dragged chip moves the instance's whole page
 * block beside the target's block in the flat tab array. That array is the one
 * source of order for every view — the strip reads it per instance, the rail
 * takes each instance's first page — so the contract to pin is that a block
 * move reshuffles instances while every per-instance page order survives, and
 * that drags that mean nothing (self, unknown target) change nothing.
 */

interface Row {
  id: string;
  instanceId: string;
}

function row(id: string, instanceId: string): Row {
  return { id, instanceId };
}

/** The rail's order: each instance's first page in array order. */
function railOrder(tabs: Row[]): string[] {
  const seen: string[] = [];
  for (const tab of tabs) {
    if (!seen.includes(tab.instanceId)) seen.push(tab.instanceId);
  }
  return seen;
}

describe("reorderInstanceBlock", () => {
  const fixture = [
    row("a1", "A"),
    row("a2", "A"),
    row("b1", "B"),
    row("c1", "C"),
  ];

  it("moves the whole block before the target's first page", () => {
    const next = reorderInstanceBlock(fixture, "C", "A", "before");
    expect(next).toEqual([row("c1", "C"), row("a1", "A"), row("a2", "A"), row("b1", "B")]);
    expect(railOrder(next!)).toEqual(["C", "A", "B"]);
  });

  it("moves the block after the target's last page, keeping the page order inside both", () => {
    const next = reorderInstanceBlock(fixture, "C", "A", "after");
    expect(next).toEqual([row("a1", "A"), row("a2", "A"), row("c1", "C"), row("b1", "B")]);
    expect(railOrder(next!)).toEqual(["A", "C", "B"]);
  });

  it("works when instances interleave in the flat array", () => {
    // Open A, open B, open another page of A: the array interleaves, and the
    // move still lands the dragged block beside the anchor's pages without
    // reordering anything within an instance.
    const interleaved = [row("a1", "A"), row("b1", "B"), row("a2", "A"), row("b2", "B")];
    const next = reorderInstanceBlock(interleaved, "A", "B", "after");
    expect(railOrder(next!)).toEqual(["B", "A"]);
    expect(next!.filter((tab) => tab.instanceId === "A").map((tab) => tab.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(next!.filter((tab) => tab.instanceId === "B").map((tab) => tab.id)).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("changes nothing for a drag onto itself or an unknown target", () => {
    expect(reorderInstanceBlock(fixture, "A", "A", "before")).toBeNull();
    expect(reorderInstanceBlock(fixture, "A", "Z", "before")).toBeNull();
    expect(reorderInstanceBlock(fixture, "Z", "A", "before")).toBeNull();
    // The input array is never mutated either way.
    expect(fixture.map((tab) => tab.id)).toEqual(["a1", "a2", "b1", "c1"]);
  });
});
