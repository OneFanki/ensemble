import {
  buildDomSnapshotExpression,
  buildElementPointExpression,
  buildFocusExpression,
  buildVisibilityExpression,
  buildWaitExpression,
  describeTarget,
} from "@core/cdp/inspect";
import { describe, expect, it } from "vitest";

/**
 * These scripts run inside the page, so the parts worth testing here without a
 * DOM are the ones a unit test can actually judge: that user-supplied text
 * cannot break out of the expression, that a bare string still means "CSS
 * selector" for old callers, and that the wait expression carries the timeout
 * and condition the caller asked for.
 *
 * The resolver itself (label → control, text → button) is exercised against a
 * real component-library-shaped page in `scripts/e2e-mcp-tenant-setup.mjs`;
 * faking a DOM here would test the fake, not the page.
 */
describe("element targets", () => {
  it("treats a bare string as a CSS selector", () => {
    const expression = buildFocusExpression("#user");
    expect(expression).toContain('"selector":"#user"');
  });

  it("keeps a label from breaking out of the page expression", () => {
    // A label comes from the model, and the expression is built by string
    // concatenation. A quote or a script tag must stay data.
    const nasty = `"'); fetch("http://evil.test"); ('`;
    const expression = buildFocusExpression({ label: nasty });
    expect(expression).not.toContain(nasty);
    expect(expression).toContain(JSON.stringify(nasty).slice(1, -1));
  });

  it("describes a target the way an error message should", () => {
    expect(describeTarget("#submit")).toBe("#submit");
    expect(describeTarget({ label: "用户名" })).toBe("标签「用户名」");
    expect(describeTarget({ text: "创建租户" })).toBe("文本「创建租户」");
    expect(describeTarget({ role: "button" })).toBe("role=button");
  });

  it("carries label, role and exact through to the visibility probe", () => {
    const expression = buildVisibilityExpression({
      label: "删除用户",
      role: "button",
      exact: true,
    });
    expect(expression).toContain('"label":"删除用户"');
    expect(expression).toContain('"role":"button"');
    expect(expression).toContain('"exact":true');
  });

  it("still accepts a selector for the element point", () => {
    expect(buildElementPointExpression("button.primary")).toContain('"selector":"button.primary"');
  });
});

describe("page snapshot", () => {
  it("reports the visible label beside a control", () => {
    // The field is what the AI uses to decide what to type where; without it a
    // component-library page looks like a row of unlabelled inputs.
    expect(buildDomSnapshotExpression()).toContain("fieldLabelOf(el)");
  });

  it("prefers stable attributes over a positional path", () => {
    const expression = buildDomSnapshotExpression();
    expect(expression).toContain("data-testid");
    expect(expression).toContain('[name="');
  });
});

describe("wait expression", () => {
  it("embeds the condition and the timeout", () => {
    const expression = buildWaitExpression({
      condition: "visible",
      target: { label: "创建租户" },
      timeoutMs: 4000,
    });
    expect(expression).toContain('const condition = "visible"');
    expect(expression).toContain("4000");
    expect(expression).toContain('"label":"创建租户"');
  });

  it("treats a missing element as success when waiting for hidden", () => {
    // A toast is removed from the DOM as often as it fades out; "gone" has to
    // satisfy "hidden" or every wait for a toast to finish would time out.
    const expression = buildWaitExpression({
      condition: "hidden",
      target: "#toast",
      timeoutMs: 1000,
    });
    expect(expression).toContain("if (!found.el) return { ok: true");
  });

  it("polls for text instead of comparing once", () => {
    const expression = buildWaitExpression({
      condition: "text",
      text: "创建成功",
      timeoutMs: 3000,
    });
    expect(expression).toContain("while (Date.now() < deadline)");
    expect(expression).toContain('"创建成功"');
  });

  it("keeps the compared text out of the expression's code", () => {
    const nasty = `"` + "]; while(true){} //";
    const expression = buildWaitExpression({ condition: "text", text: nasty, timeoutMs: 1000 });
    expect(expression).toContain(JSON.stringify(nasty));
  });
});
