import { describe, expect, it } from "vitest";
import {
  interpolate,
  interpolateStep,
  resolveParams,
  summarizeStep,
  validateFlow,
  validateStep,
  type FlowParam,
  type FlowStep,
} from "@shared/flows";

/**
 * Flow definitions are written by a model and then executed against a live page.
 * These tests cover the two places that can silently ruin a run: a step that
 * looks valid but has nothing to act on, and a variable name that only fails
 * halfway through.
 */
describe("step validation", () => {
  it("names the missing field instead of saying the step is invalid", () => {
    // The message is read by an AI that has to fix the step; "invalid step" is
    // not a repairable instruction.
    expect(validateStep({ action: "fill", label: "用户名" }, 1)).toEqual([
      "第 2 步（fill）需要 value",
    ]);
  });

  it("requires a target for actions that act on an element", () => {
    for (const action of ["fill", "click", "select", "read"] as const) {
      const problems = validateStep({ action }, 0);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join(" ")).toContain("第 1 步");
    }
  });

  it("accepts a click by button text alone", () => {
    expect(validateStep({ action: "click", text: "创建租户" }, 0)).toEqual([]);
  });

  it("rejects a key a flow cannot press", () => {
    expect(validateStep({ action: "press", key: "F13" }, 0).join(" ")).toContain("不支持按键 F13");
    expect(validateStep({ action: "press", key: "Enter" }, 0)).toEqual([]);
  });

  it("requires the compared text when a wait compares text", () => {
    const problems = validateStep({ action: "wait", condition: "text" }, 0);
    expect(problems.join(" ")).toContain("需要 expect");
    // …but a visibility wait needs a target instead, not an expected string.
    expect(validateStep({ action: "wait", condition: "visible", label: "创建租户" }, 0)).toEqual(
      [],
    );
  });

  it("requires a variable name for read", () => {
    expect(validateStep({ action: "read", label: "订单号" }, 0).join(" ")).toContain("需要 as");
    expect(validateStep({ action: "read", label: "订单号", as: "orderNo" }, 0)).toEqual([]);
    expect(validateStep({ action: "read", label: "订单号", as: "1bad" }, 0).join(" ")).toContain(
      "只能",
    );
  });

  it("rejects an unknown action", () => {
    const problems = validateStep({ action: "scroll" as FlowStep["action"] }, 0);
    expect(problems.join(" ")).toContain("不认识");
  });
});

describe("flow validation", () => {
  const params: FlowParam[] = [
    { name: "tenant", label: "租户名", required: true },
    { name: "password", label: "初始密码", secret: true },
  ];

  it("accepts a flow that references its declared parameters", () => {
    expect(
      validateFlow({
        params,
        steps: [
          { action: "fill", label: "租户名称", value: "{{tenant}}" },
          { action: "fill", label: "初始密码", value: "{{password}}" },
          { action: "click", text: "创建租户" },
        ],
      }),
    ).toEqual([]);
  });

  it("catches a reference to a parameter that was never declared", () => {
    const problems = validateFlow({
      params,
      steps: [{ action: "fill", label: "租户名称", value: "{{tenat}}" }],
    });
    // A typo would otherwise substitute nothing and create a tenant named ""
    // — the kind of failure that only shows up in the tested system's data.
    expect(problems.join(" ")).toContain("{{tenat}}");
  });

  it("lets a later step use a variable an earlier read captured", () => {
    expect(
      validateFlow({
        params: [],
        steps: [
          { action: "read", label: "订单号", as: "orderNo" },
          { action: "fill", label: "订单号", value: "{{orderNo}}" },
        ],
      }),
    ).toEqual([]);
  });

  it("rejects a variable used before the step that defines it", () => {
    const problems = validateFlow({
      params: [],
      steps: [
        { action: "fill", label: "订单号", value: "{{orderNo}}" },
        { action: "read", label: "订单号", as: "orderNo" },
      ],
    });
    expect(problems.join(" ")).toContain("{{orderNo}}");
  });

  it("rejects duplicate parameter names", () => {
    const problems = validateFlow({
      params: [
        { name: "a", label: "A" },
        { name: "a", label: "另一个 A" },
      ],
      steps: [{ action: "click", text: "确定" }],
    });
    expect(problems.join(" ")).toContain("重复");
  });

  it("rejects an empty flow", () => {
    expect(validateFlow({ params: [], steps: [] }).join(" ")).toContain("至少要有一步");
  });
});

describe("interpolation", () => {
  it("substitutes every reference", () => {
    expect(interpolate("{{a}}-{{b}}", { a: "x", b: "y" })).toBe("x-y");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(interpolate("{{ tenant }}", { tenant: "客户 A" })).toBe("客户 A");
  });

  it("throws on an unknown name instead of leaving the placeholder", () => {
    // Silently leaving `{{x}}` would type the literal braces into the page.
    expect(() => interpolate("{{x}}", {})).toThrow(/未定义的变量：x/);
  });

  it("only rewrites string fields of a step", () => {
    const step: FlowStep = {
      action: "fill",
      label: "{{field}}",
      value: "{{value}}",
      timeoutMs: 5000,
      exact: true,
    };
    const filled = interpolateStep(step, { field: "用户名", value: "admin" });
    expect(filled.label).toBe("用户名");
    expect(filled.value).toBe("admin");
    expect(filled.timeoutMs).toBe(5000);
    expect(filled.exact).toBe(true);
  });
});

describe("parameter resolution", () => {
  const params: FlowParam[] = [
    { name: "tenant", label: "租户名", required: true },
    { name: "region", label: "区域", default: "cn" },
    { name: "password", label: "密码", secret: true },
  ];

  it("applies defaults and reports which names are secret", () => {
    const { values, secretNames } = resolveParams(params, { tenant: "客户 A" });
    expect(values).toEqual({ tenant: "客户 A", region: "cn", password: "" });
    expect(secretNames).toEqual(["password"]);
  });

  it("reports a missing required parameter by its display label", () => {
    expect(() => resolveParams(params, {})).toThrow(/缺少参数：租户名/);
  });

  it("rejects a parameter the flow does not declare", () => {
    // Otherwise a typo falls back to the default and the run quietly uses the
    // wrong value.
    expect(() => resolveParams(params, { tenat: "x", tenant: "y" })).toThrow(/未声明的参数：tenat/);
  });
});

describe("step summaries", () => {
  it("describes each action in one line", () => {
    expect(summarizeStep({ action: "fill", label: "租户名称", value: "{{t}}" })).toEqual({
      action: "fill",
      target: "租户名称",
      detail: "{{t}}",
    });
    expect(summarizeStep({ action: "click", text: "创建租户" }).target).toBe("创建租户");
    expect(summarizeStep({ action: "wait", condition: "text", expect: "创建成功" }).detail).toBe(
      "创建成功",
    );
    expect(summarizeStep({ action: "read", label: "订单号", as: "orderNo" }).detail).toBe(
      "→ orderNo",
    );
  });
});
