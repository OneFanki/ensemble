import { instanceFreezeState } from "@shared/instance-freeze";
import { describe, expect, it } from "vitest";

/**
 * 实例行冻结标识的三态映射。
 *
 * 验收与 AI 三态点同一形状：映射规则在 shared，单测直接断言输入→输出，
 * 渲染层只负责把状态画出来。全部休眠 → full、部分休眠 → partial、
 * 全醒或无页 → awake（无标）。
 */
describe("instanceFreezeState", () => {
  it("marks a fully sleeping instance as full", () => {
    expect(instanceFreezeState([{ sleeping: true }, { sleeping: true }])).toBe("full");
    expect(instanceFreezeState([{ sleeping: true }])).toBe("full");
  });

  it("marks a partly sleeping instance as partial", () => {
    expect(instanceFreezeState([{ sleeping: true }, { sleeping: false }])).toBe("partial");
  });

  it("marks a fully awake instance as awake", () => {
    expect(instanceFreezeState([{ sleeping: false }])).toBe("awake");
    expect(instanceFreezeState([{ sleeping: false }, {}])).toBe("awake");
  });

  it("treats an instance with no pages as awake", () => {
    // 关闭过程中的瞬间：没有页面就没有可标的状态。
    expect(instanceFreezeState([])).toBe("awake");
  });
});
