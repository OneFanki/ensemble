import { compareVersions, normalizeVersion } from "./version";

/**
 * Update detection is deliberately check-only. Release builds are unsigned, so
 * electron-updater could not apply an update silently on either platform: macOS
 * refuses unsigned packages and Windows would show the same SmartScreen prompt
 * anyway. Telling the user a newer tag exists and opening its release page keeps
 * one code path for every platform.
 */
export const REPOSITORY_URL = "https://github.com/OneFanki/ensemble";
export const RELEASES_PAGE_URL = `${REPOSITORY_URL}/releases`;
export const LATEST_RELEASE_API = "https://api.github.com/repos/OneFanki/ensemble/releases/latest";

export type UpdateStatus = "current" | "available" | "error";

export interface UpdateCheckResult {
  status: UpdateStatus;
  current: string;
  latest?: string;
  url?: string;
  publishedAt?: string;
  /** Technical detail for the failure case; the UI shows its own localized text. */
  message?: string;
}

export interface ReleaseInfo {
  version: string;
  url: string;
  publishedAt?: string;
}

/**
 * Reads the subset of the GitHub release payload we rely on. Anything else —
 * a draft, a wrongly named tag, a proxy error page — yields null so the caller
 * reports "could not check" instead of inventing a version.
 */
export function parseLatestRelease(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  if (typeof payload["tag_name"] !== "string") return null;
  const version = normalizeVersion(payload["tag_name"]);
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) return null;
  const url = typeof payload["html_url"] === "string" ? payload["html_url"] : RELEASES_PAGE_URL;
  const publishedAt =
    typeof payload["published_at"] === "string" ? payload["published_at"] : undefined;
  return { version, url, ...(publishedAt ? { publishedAt } : {}) };
}

export function evaluateUpdate(
  current: string,
  release: ReleaseInfo | null,
): UpdateCheckResult {
  if (!release) return { status: "error", current };
  const newer = compareVersions(release.version, normalizeVersion(current)) > 0;
  return {
    status: newer ? "available" : "current",
    current,
    latest: release.version,
    url: release.url,
    ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
  };
}
