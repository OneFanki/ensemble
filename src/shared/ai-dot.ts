/**
 * AI 状态点的三态映射（P0-3）。
 *
 * 实例行条目上原来的「AI 操作次数」数字徽标回答不了那个真正的问题：
 * 「AI 现在在动这个账号吗？刚刚动过吗？」。三态点按最后动作的时间把答案压成
 * 三个视觉状态，映射规则放在 shared 而不是组件里，因为单测要直接断言这条映射
 * （验收标准 P0-3：操作中 → 呼吸点 / 30 分钟内动过 → 常亮点 / 其它 → 无标）。
 *
 * 数据源是 AI 活动记录（`AiActivityRecord.at`，ISO 时间戳），渲染层按实例取
 * 最新一条即可，主进程无需维护额外快照字段。
 */

/** 三态：正在操作（呼吸）/ 最近动过（常亮）/ 无标。 */
export type AiDotState = "active" | "recent" | "idle";

/** 「正在操作」的判定窗口：最后动作距今不超过这个时长就算还在操作。 */
export const AI_DOT_ACTIVE_WINDOW_MS = 10_000;

/** 「最近动过」的判定窗口：30 分钟。 */
export const AI_DOT_RECENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * 把「最后动作时间」映射为点的状态。
 *
 * - `undefined`（从未动过或时间不可解析）→ 无标。
 * - 活跃窗口内 → 呼吸点；时钟轻微回拨（负 age）按正在操作处理，避免页面间
 *   时间源抖动让点闪烁消失。
 * - 30 分钟窗口内 → 常亮点。
 * - 更早 → 无标。
 */
export function aiDotState(
  lastActionAtMs: number | undefined,
  now: number,
  activeWindowMs = AI_DOT_ACTIVE_WINDOW_MS,
  recentWindowMs = AI_DOT_RECENT_WINDOW_MS,
): AiDotState {
  if (lastActionAtMs === undefined || !Number.isFinite(lastActionAtMs)) return "idle";
  const age = now - lastActionAtMs;
  if (age < activeWindowMs) return "active";
  if (age < recentWindowMs) return "recent";
  return "idle";
}

/**
 * 从 AI 活动记录里取每个标签页的最后动作时间（毫秒）。
 *
 * 记录按时间倒序传入（列表的既有顺序），首个命中的就是最新的一条；
 * 同一标签页的更早记录直接跳过。
 */
export function lastActionAtByTab(records: ReadonlyArray<{ tabId: string; at: string }>): Map<string, number> {
  const byTab = new Map<string, number>();
  for (const record of records) {
    if (byTab.has(record.tabId)) continue;
    const at = new Date(record.at).getTime();
    byTab.set(record.tabId, Number.isNaN(at) ? 0 : at);
  }
  return byTab;
}
