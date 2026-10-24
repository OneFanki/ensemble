import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_DAILY_PARTITION,
  embeddedCleanPartition,
  embeddedTabPartition,
} from "@shared/embedded";

const browser = readFileSync(join(process.cwd(), "src/main/embedded/browser.ts"), "utf8");

describe("daily profile and clean session contract", () => {
  /*
   * These are the two properties that make the distinction real. Each one is a
   * single token in `shared/embedded.ts`, which is exactly why a guard is worth
   * having: a careless edit there silently merges the two worlds again.
   */
  it("keeps the daily profile persistent", () => {
    expect(EMBEDDED_DAILY_PARTITION.startsWith("persist:")).toBe(true);
  });

  it("keeps a clean session out of the disk", () => {
    // A `persist:` prefix is what writes a partition to userData. Without it
    // Electron keeps the session in memory, so quitting really ends it.
    expect(embeddedCleanPartition("instance-1").startsWith("persist:")).toBe(false);
  });

  it("gives every clean instance its own session", () => {
    expect(embeddedTabPartition({ instanceId: "a", clean: true })).not.toBe(
      embeddedTabPartition({ instanceId: "b", clean: true }),
    );
  });

  it("never routes an identity page into either shared world", () => {
    const identity = embeddedTabPartition({ identityId: "id-1", instanceId: "i1" });
    expect(identity).not.toBe(EMBEDDED_DAILY_PARTITION);
    expect(identity).not.toBe(embeddedCleanPartition("i1"));
  });

  /*
   * The browser is where these decisions are actually applied, and it has to
   * apply them in two places: when the view is created and when an icon is
   * fetched. The icon path is easy to miss — it would then fetch through the
   * app's default session and show a signed-out page's icon.
   */
  it("derives the partition from the tab rather than copying it", () => {
    expect(browser).toMatch(/private partitionOf\(tab: TabRecord\): string/);
    expect(browser).toMatch(/session\s*\.fromPartition\(/);
    expect(browser).toMatch(/this\.partitionOf\(tab\)/);
  });

  it("lets a popup inherit its opener's clean session", () => {
    expect(browser).toMatch(/this\.cleanInstances\.has\(parent\.instanceId\)/);
  });

  it("forgets the clean marker when the last page of an instance closes", () => {
    // Otherwise the set grows for the lifetime of the process and a later page
    // reusing that instance id would silently land in a throwaway session.
    expect(browser).toMatch(/this\.cleanInstances\.delete\(tab\.instanceId\)/);
  });
});

describe("bookmark model contract", () => {
  const types = readFileSync(join(process.cwd(), "src/shared/types.ts"), "utf8");

  /*
   * A bookmark carrying a site id or a login path would collapse the distinction
   * this whole change is about: the two objects have to stay different shapes,
   * not just be explained differently in the UI.
   */
  it("keeps a bookmark free of site and credential fields", () => {
    const start = types.indexOf("export interface Bookmark {");
    const end = types.indexOf("}", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const block = types.slice(start, end);
    for (const forbidden of ["siteId", "loginPath", "username", "password", "engineId"]) {
      expect(block).not.toContain(forbidden);
    }
  });

  it("routes every bookmark write through one URL check", () => {
    const service = readFileSync(join(process.cwd(), "src/core/service.ts"), "utf8");
    // `safeExternalUrl` is the single place that decides what a bookmark may
    // point at; a second inline regex would eventually disagree with it.
    expect(service).toMatch(/const normalized = safeExternalUrl\(/);
    expect(service).toMatch(/书签地址必须是 http\(s\) 链接/);
  });
});

describe("AI origin gate contract", () => {
  const server = readFileSync(join(process.cwd(), "src/main/mcp/server.ts"), "utf8");
  const policy = readFileSync(join(process.cwd(), "src/shared/ai-policy.ts"), "utf8");

  /*
   * Every tool that presses, types or runs code has to declare the page it acts
   * on. Two tools sharing one gate is the whole reason the gate is a single call
   * site — but a tool that simply forgets to declare `inputTarget` slips past it.
   */
  it("declares an input target on every tool that sends input", () => {
    const inputTools = [
      "click_browser_element",
      "type_browser_text",
      "fill_browser_form",
      "fill_browser_login",
      "evaluate_browser_page",
      "run_flow",
    ];
    for (const name of inputTools) {
      const start = server.indexOf(`name: "${name}"`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      // Up to the next tool definition: enough to see whether this one declared it.
      const next = server.indexOf("name: \"", start + 10);
      const block = server.slice(start, next > 0 ? next : undefined);
      expect(block, `${name} must declare inputTarget`).toContain("inputTarget:");
    }
  });

  it("gates before the tool runs, not after", () => {
    // The refusal must happen above `tool.run`, otherwise a denied click would
    // already have been delivered and the error text would be a lie.
    const gateCall = server.indexOf("this.originDenial(");
    const runCall = server.indexOf("await tool.run(", gateCall);
    expect(gateCall).toBeGreaterThan(0);
    expect(runCall).toBeGreaterThan(gateCall);
  });

  it("keeps the daily profile read-only by default", () => {
    // An empty default allow list is the policy; a non-empty one would mean a
    // fresh install lets the AI drive a signed-in session.
    expect(policy).toMatch(/if \(page\.identityId\) return undefined;/);
    expect(policy).toMatch(/if \(page\.clean\) return undefined;/);
    expect(policy).toMatch(/return "daily-origin-unauthorized";/);
  });

  it("sends an AI's own identity-less tab to a clean session, never the profile", () => {
    const main = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");
    const start = main.indexOf("createTab: async (input) => {");
    const block = main.slice(start, start + 1200);
    expect(block).toContain("...(input.identityId ? {} : { clean: true })");
  });
});
