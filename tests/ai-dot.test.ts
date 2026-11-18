import { describe, expect, it } from "vitest";
import {
  AI_DOT_ACTIVE_WINDOW_MS,
  AI_DOT_RECENT_WINDOW_MS,
  aiDotState,
  lastActionAtByTab,
} from "../src/shared/ai-dot";

/** 任取一个稳定的时间原点，测试只关心相对差。 */
const NOW = 1_800_000_000_000;

describe("aiDotState 三态映射", () => {
  it("从未动过（undefined）→ 无标", () => {
    expect(aiDotState(undefined, NOW)).toBe("idle");
  });

  it("时间不可解析（NaN）→ 无标", () => {
    expect(aiDotState(Number.NaN, NOW)).toBe("idle");
  });

  it("正在操作：最后动作在活跃窗口内 → active（呼吸点）", () => {
    expect(aiDotState(NOW, NOW)).toBe("active");
    expect(aiDotState(NOW - 1_000, NOW)).toBe("active");
    expect(aiDotState(NOW - AI_DOT_ACTIVE_WINDOW_MS + 1, NOW)).toBe("active");
  });

  it("恰好跨过活跃窗口 → recent（常亮点）", () => {
    expect(aiDotState(NOW - AI_DOT_ACTIVE_WINDOW_MS, NOW)).toBe("recent");
    expect(aiDotState(NOW - 5 * 60 * 1000, NOW)).toBe("recent");
  });

  it("30 分钟内动过 → recent；恰好跨过 → idle", () => {
    expect(aiDotState(NOW - AI_DOT_RECENT_WINDOW_MS + 1, NOW)).toBe("recent");
    expect(aiDotState(NOW - AI_DOT_RECENT_WINDOW_MS, NOW)).toBe("idle");
    expect(aiDotState(NOW - 24 * 60 * 60 * 1000, NOW)).toBe("idle");
  });

  it("时钟轻微回拨（负 age）按正在操作处理", () => {
    expect(aiDotState(NOW + 500, NOW)).toBe("active");
  });

  it("自定义窗口用于测试与未来的策略调整", () => {
    expect(aiDotState(NOW - 100, NOW, 50, 200)).toBe("recent");
    expect(aiDotState(NOW - 100, NOW, 200, 500)).toBe("active");
  });
});

describe("lastActionAtByTab", () => {
  it("倒序列表里每个标签页取首条（最新）", () => {
    const map = lastActionAtByTab([
      { tabId: "a", at: new Date(NOW).toISOString() },
      { tabId: "b", at: new Date(NOW - 1000).toISOString() },
      { tabId: "a", at: new Date(NOW - 5000).toISOString() },
    ]);
    expect(map.get("a")).toBe(NOW);
    expect(map.get("b")).toBe(NOW - 1000);
  });

  it("不可解析的时间戳按 0 处理，不抛错", () => {
    const map = lastActionAtByTab([{ tabId: "x", at: "not-a-date" }]);
    expect(map.get("x")).toBe(0);
  });

  it("空列表 → 空 Map", () => {
    expect(lastActionAtByTab([]).size).toBe(0);
  });
});
