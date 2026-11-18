/**
 * 实例行条目上的冻结标识三态映射。
 *
 * 单舞台下一个实例的像素是否在等，由它全部页面的休眠状态决定：全部休眠 =
 * 整个账号在后台省资源，部分休眠 = 有一半页面还醒着，全醒 = 不标。映射规则
 * 放 shared 而不是组件里，与 AI 三态点（shared/ai-dot）同一理由——单测直接
 * 断言映射，不用拉起渲染层。
 *
 * 数据源是页记录的 `sleeping` 布尔，主进程广播时已带，渲染层无需额外快照。
 */

/** 三态：全部页面冻结（灰标）/ 部分冻结（半标）/ 全醒（无标）。 */
export type InstanceFreezeState = "full" | "partial" | "awake";

/**
 * 把一个实例的全部页面映射为冻结标识状态。
 *
 * - 没有页面（实例正在关闭的瞬间）→ 全醒，不标。
 * - 全部页面 `sleeping` → full。
 * - 有页面 `sleeping` 但不是全部 → partial。
 * - 没有任何页面休眠 → awake。
 */
export function instanceFreezeState(
  pages: ReadonlyArray<{ sleeping?: boolean }>,
): InstanceFreezeState {
  if (pages.length === 0) return "awake";
  const frozen = pages.filter((page) => page.sleeping === true).length;
  if (frozen === 0) return "awake";
  return frozen === pages.length ? "full" : "partial";
}
