/**
 * Environment types are free text: teams name them "测试", "预发", "项目-联调"
 * and anything else that fits. These helpers only recognize the two behaviors
 * that matter — production warnings and the badge text — and leave everything
 * else untouched.
 */
export function isProductionKind(kind: string | undefined): boolean {
  if (!kind) return false;
  const value = kind.trim().toLowerCase();
  return value === "prod" || value === "production" || value.includes("生产");
}

export function isStagingKind(kind: string | undefined): boolean {
  if (!kind) return false;
  const value = kind.trim().toLowerCase();
  return value === "staging" || value === "stage" || value.includes("预发");
}

/** Short badge for the title bar and cards. */
export function environmentBadge(kind: string | undefined): string {
  if (!kind?.trim()) return "—";
  const value = kind.trim();
  const lower = value.toLowerCase();
  if (lower === "local" || lower === "本地") return "LOCAL";
  if (lower === "staging" || lower === "stage") return "STG";
  if (lower === "prod" || lower === "production") return "PROD";
  return value;
}

/** Accent color token for an environment dot. */
export function environmentTone(kind: string | undefined): "red" | "blue" | "accent" {
  if (isProductionKind(kind)) return "red";
  if (isStagingKind(kind)) return "blue";
  return "accent";
}
