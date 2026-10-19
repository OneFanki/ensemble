/**
 * There is no separate "environment kind" field: a name like
 * "订单服务-生产环境" already carries the risk signal, and asking users to tag
 * every environment twice was pure form noise. Only production-like names get
 * the extra launch confirmation.
 */
export function isProductionName(name: string | undefined): boolean {
  if (!name) return false;
  const value = name.trim().toLowerCase();
  if (value.includes("生产")) return true;
  return /(^|[\s._\-/])(prod|production|live)([\s._\-/]|$)/.test(value);
}
