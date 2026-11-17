import {
  buildDomSnapshotExpression,
  buildElementPointExpression,
  buildFindByLocatorExpression,
  buildFocusExpression,
  buildVisibilityExpression,
  buildWaitExpression,
  describeTarget,
  locatorAmbiguousText,
  locatorErrorText,
  locatorNotFoundText,
  locatorStaleHandleText,
  locatorUnknownHandleText,
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

  it("carries nth through to the single-target resolver", () => {
    // The action path resolves one element: nth picks a position in the ranked
    // match list (negative counts from the end), so the page sees the number.
    const expression = buildElementPointExpression({ text: "删除", nth: -1 });
    expect(expression).toContain('"nth":-1');
  });

  it("keeps narrowing fields out of the resolver when they are not given", () => {
    // Old callers send only selector/label/text/role; the serialized target must
    // not grow keys for features they never asked about. (Quoted JSON keys are
    // asserted because the surrounding helper code also says "nth".)
    const expression = buildElementPointExpression({ text: "创建租户" });
    expect(expression).toContain('"text":"创建租户"');
    expect(expression).not.toContain('"hasText"');
    expect(expression).not.toContain('"nth"');
  });

  it("carries the match count back for the multi-match warning", () => {
    // 直连动作保持「取排名第一个」，但调用方要能从返回值知道「匹配不止一个」：
    // 这个数由页内 resolver 随命中带回，断言它进了表达式，上层 warning 链路
    // 才有数据可用。
    const expression = buildElementPointExpression({ text: "创建租户" });
    expect(expression).toContain("matchCount");
  });
});

describe("narrowed find (locator handles)", () => {
  it("embeds the narrowing fields into the find expression", () => {
    // Registration passes `first` explicitly: multiple matches are the answer,
    // not an error, and the default (use) mode is the strict handle path.
    const expression = buildFindByLocatorExpression(
      { text: "删除", hasNotText: "B" },
      { first: true },
    );
    expect(expression).toContain('"text":"删除"');
    expect(expression).toContain('"hasNotText":"B"');
    expect(expression).toContain('const mode = "first"');
  });

  it("defaults to the strict use mode", () => {
    const expression = buildFindByLocatorExpression({ text: "删除" });
    expect(expression).toContain('const mode = "use"');
    expect(expression).toContain("const trait = null");
    expect(expression).toContain("const useNth = null");
  });

  it("serialises visible and nth narrowing, including negative positions", () => {
    const expression = buildFindByLocatorExpression({
      selector: "#list > button",
      visible: false,
      nth: -1,
    });
    expect(expression).toContain('"visible":false');
    expect(expression).toContain('"nth":-1');
  });

  it("runs in use mode with a trait for handle resolution", () => {
    const expression = buildFindByLocatorExpression({ text: "删除" }, { trait: "删除 C", nth: 1 });
    expect(expression).toContain('const mode = "use"');
    expect(expression).toContain('const trait = "删除 C"');
    expect(expression).toContain("const useNth = 1");
  });

  it("keeps a narrowing substring from breaking out of the expression", () => {
    const nasty = `"); fetch("http://evil.test"); ("`;
    const expression = buildFindByLocatorExpression({ text: "x", hasText: nasty });
    expect(expression).not.toContain(nasty);
    expect(expression).toContain(JSON.stringify(nasty).slice(1, -1));
  });

  it("words the not-found and ambiguous errors as next actions", () => {
    // The wording is the contract: a model reading「匹配 N 个」must learn that
    // nth or a narrowing field is the way forward, not that the page is broken.
    expect(locatorNotFoundText("文本「删除」")).toContain("找不到");
    // 「找不到」必须交代 text 的匹配范围：排查者看到纯展示 div 没被命中时，得能
    // 自己得出「它没有自身文字」而不是「元素不存在」。
    expect(locatorNotFoundText("文本「删除」")).toContain("有自身文字");
    const ambiguous = locatorAmbiguousText("文本「删除」", 3);
    expect(ambiguous).toContain("匹配 3 个");
    expect(ambiguous).toContain("nth");
    expect(ambiguous).toContain("hasText");
    const outOfRange = locatorErrorText("nth-out-of-range", "文本「删除」", 2, 5);
    expect(outOfRange).toContain("nth=5");
    expect(outOfRange).toContain("2");
  });

  it("distinguishes a stale handle from an unknown one", () => {
    // After a navigation the fix is "find again"; a never-valid id means the
    // arguments are wrong. The two messages must not be interchangeable.
    expect(locatorStaleHandleText("el-1-ab12")).toContain("重新 find");
    const unknown = locatorUnknownHandleText("el-1-ab12");
    expect(unknown).toContain("句柄不存在");
    expect(unknown).toContain("find_browser_element");
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
