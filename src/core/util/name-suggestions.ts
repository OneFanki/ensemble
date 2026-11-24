/**
 * 「名字对不上时给建议」的纯函数。
 *
 * 调用方凭印象写出的工具名或参数名，和真实名字往往只差一点：少了中间的
 * `browser`、把 `save` 写成 `update`、把 `names` 写成 `name`。一句「没有这个
 * 名字」只能让调用方回去翻一遍工具列表；把它最可能想要的几个名字直接摆出来，
 * 下一次调用就对得上。
 */

/** 相近到什么程度才值得建议。 */
const SUGGESTION_THRESHOLD = 0.5;

/** 两个字符串的编辑距离。 */
function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      // 索引都在范围内，`?? 0` 只是让类型收窄，不会真的取到 0。
      const up = previous[j] ?? 0;
      const diagonal = previous[j - 1] ?? 0;
      const left = current[j - 1] ?? 0;
      current[j] = Math.min(up + 1, left + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * 两个名字的相近程度，0 到 1。
 *
 * 两条线索取大者：
 *
 * - 编辑距离按名字长度归一。差一个字母的短名字比差一个字母的长名字更相近。
 * - 按下划线分词后的包含关系。`click` 是 `click_browser_element` 的简写，
 *   这种「中间少了一段」的差别在编辑距离上几乎看不出来，但词都对得上。
 */
export function nameSimilarity(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left === right) return 1;
  const byEdit = 1 - levenshtein(left, right) / Math.max(left.length, right.length);
  const leftTokens = left.split("_");
  const rightTokens = right.split("_");
  const oneWithinOther =
    leftTokens.every((token) => rightTokens.includes(token)) ||
    rightTokens.every((token) => leftTokens.includes(token));
  const byTokens = oneWithinOther ? 0.6 : 0;
  return Math.max(byEdit, byTokens);
}

/**
 * 在 `candidates` 里找出最可能是调用方想要的几个名字，最相近的排在最前。
 *
 * 太短的调用方名字不给建议：两三个字母与任何名字都「有点像」，列出来只是噪声。
 *
 * @param target 调用方写的名字
 * @param candidates 可以建议的名字（不含调用方写的那个本身）
 * @param limit 最多给几个
 * @returns 相近程度达到阈值的名字；都不相近时是空数组
 */
export function suggestNames(
  target: string,
  candidates: ReadonlyArray<string>,
  limit = 3,
): string[] {
  const needle = target.trim();
  if (needle.length < 3) return [];
  return candidates
    .filter((candidate) => candidate !== needle)
    .map((candidate) => ({ name: candidate, score: nameSimilarity(needle, candidate) }))
    .filter((item) => item.score >= SUGGESTION_THRESHOLD)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, limit))
    .map((item) => item.name);
}
