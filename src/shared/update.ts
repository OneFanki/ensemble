import type { Platform } from "./types";
import { compareVersions, normalizeVersion } from "./version";

/**
 * Update detection and delivery.
 *
 * The app checks GitHub's release API, downloads the installer itself and then
 * runs it. Doing the download in-app is what avoids the browser's
 * Mark-of-the-Web: a file fetched by the OS's own network stack gets no
 * Zone.Identifier, so SmartScreen does not treat it as "downloaded from the
 * internet". The builds are unsigned, so UAC or reputation prompts can still
 * appear; nothing here can remove those without a code-signing certificate.
 */
export const REPOSITORY_URL = "https://github.com/OneFanki/ensemble";
export const RELEASES_PAGE_URL = `${REPOSITORY_URL}/releases`;
/**
 * The release list, not just the latest entry: an install that skipped several
 * versions is told what each of them changed. `per_page=100` covers the whole
 * history on one page; the dialog's own cap is what bounds the rendering.
 */
export const RELEASES_LIST_API =
  "https://api.github.com/repos/OneFanki/ensemble/releases?per_page=100";

export type UpdateStatus = "current" | "available" | "error";

/** One downloadable file attached to a release. */
export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  /** Lower-case hex SHA-256 from GitHub's `digest` field. Absent on old assets. */
  sha256?: string;
}

export interface UpdateCheckResult {
  status: UpdateStatus;
  current: string;
  latest?: string;
  url?: string;
  publishedAt?: string;
  /**
   * Short, user-facing summary for the update dialog. Release bodies are written
   * for this purpose; the long changelog lives in CHANGELOG.md, not here.
   */
  notes?: string;
  /**
   * Every release between the current version (exclusive) and the latest one,
   * oldest first — one section per release for the update dialog. Absent when
   * already current.
   */
  releases?: ReleaseNoteSection[];
  /** How many older-than-shown releases the dialog cap left out. */
  omittedReleases?: number;
  /** The file for this OS and architecture, when the release publishes one. */
  asset?: UpdateAsset;
  /** Technical detail for the failure case; the UI shows its own localized text. */
  message?: string;
}

/** One version's worth of notes in the range summary. */
export interface ReleaseNoteSection {
  version: string;
  url?: string;
  notes?: string;
}

export interface ReleaseInfo {
  version: string;
  url: string;
  publishedAt?: string;
  notes?: string;
  /** Omitted rather than required: an older or hand-written release has none. */
  assets?: UpdateAsset[];
}

export type UpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "error";

export interface UpdateProgress {
  phase: UpdatePhase;
  /** Bytes received so far. For "ready" this is the final size. */
  received: number;
  /** Total bytes when the server reported a length. */
  total?: number;
  /** Localized detail for the error phase. */
  message?: string;
}

/** Longest summary the dialog will render; a release body is meant to be short. */
export const MAX_UPDATE_NOTES = 4_000;

const TRUSTED_HOSTS = ["github.com", "githubusercontent.com"];

/**
 * Extra origin allowed for update downloads, in `scheme://host[:port]` form.
 *
 * Only the end-to-end probe sets this so the real code path can run against a
 * local server. It never comes from a file or IPC, and every check still runs:
 * HTTPS, or exactly this one origin.
 */
function trustedOriginOverride(): string | undefined {
  // This module is also bundled into the renderer, where `process` does not
  // exist. Reading it through globalThis keeps the file free of Node types while
  // still letting the main-process probe set a loopback origin.
  const env = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  return env?.["ENSEMBLE_UPDATE_TRUSTED_ORIGIN"]?.trim();
}

/**
 * True for an HTTPS URL on GitHub's own hosts (including any subdomain of
 * githubusercontent.com, where release assets are actually served). The download
 * path refuses anything else: an update URL is code that will be executed.
 */
export function isTrustedUpdateUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  // The test hook is checked before the HTTPS rule because it exists precisely
  // to stand a local HTTP server in for GitHub. It cannot be set from a file or
  // from IPC, and it only ever accepts a loopback origin.
  if (loopback) {
    const override = trustedOriginOverride();
    if (override) {
      try {
        return new URL(override).origin === url.origin;
      } catch {
        return false;
      }
    }
  }
  if (url.protocol !== "https:") return false;
  return TRUSTED_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`));
}

/** Reads `sha256:<hex>` (GitHub's digest format) into a bare lower-case hash. */
export function parseSha256(digest: unknown): string | undefined {
  if (typeof digest !== "string") return undefined;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match?.[1]?.toLowerCase();
}

/**
 * Reads the subset of the GitHub release payload we rely on. Anything else — a
 * draft, a wrongly named tag, a proxy error page — yields null so the caller
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
  const notes =
    typeof payload["body"] === "string" && payload["body"].trim().length > 0
      ? payload["body"].slice(0, MAX_UPDATE_NOTES)
      : undefined;

  const assets: UpdateAsset[] = [];
  const rawAssets = Array.isArray(payload["assets"]) ? payload["assets"] : [];
  for (const entry of rawAssets) {
    if (!entry || typeof entry !== "object") continue;
    const asset = entry as Record<string, unknown>;
    const name = typeof asset["name"] === "string" ? asset["name"] : "";
    const downloadUrl =
      typeof asset["browser_download_url"] === "string" ? asset["browser_download_url"] : "";
    const size = typeof asset["size"] === "number" ? asset["size"] : 0;
    if (!name || !isTrustedUpdateUrl(downloadUrl)) continue;
    const sha256 = parseSha256(asset["digest"]);
    assets.push({
      name,
      url: downloadUrl,
      size,
      ...(sha256 ? { sha256 } : {}),
    });
  }

  return {
    version,
    url,
    ...(publishedAt ? { publishedAt } : {}),
    ...(notes ? { notes } : {}),
    // Omitted when empty: a release with no usable assets is the same situation
    // as an older payload that never carried them, and callers only ever ask
    // for a platform match.
    ...(assets.length > 0 ? { assets } : {}),
  };
}

/**
 * Reads a `/releases` response into parsed releases, dropping entries that do
 * not parse. A single-object payload (the old `/releases/latest` shape, or the
 * end-to-end stub) is accepted as a one-element list so both endpoints flow
 * through the same code.
 */
export function parseReleasesList(raw: unknown): ReleaseInfo[] {
  if (!Array.isArray(raw)) {
    const single = parseLatestRelease(raw);
    return single ? [single] : [];
  }
  const releases: ReleaseInfo[] = [];
  for (const entry of raw) {
    const parsed = parseLatestRelease(entry);
    if (parsed) releases.push(parsed);
  }
  return releases;
}

/**
 * How many per-version sections the dialog will render. A release train skipped
 * by dozens of versions still answers "what changed", just with a bound.
 */
export const MAX_UPDATE_RELEASES = 10;

/**
 * Picks the releases between the current version (exclusive) and the newest one,
 * sorted oldest first so the dialog reads as "what accumulated since you last
 * looked".
 *
 * A version equal to or older than the installed one never appears. Releases
 * beyond the cap are dropped from the old end — the ones closest to the latest
 * version are what the user is about to install — and counted so the dialog can
 * say how much was folded away.
 */
export function selectUpdateRangeReleases(
  current: string,
  releases: readonly ReleaseInfo[],
  limit: number = MAX_UPDATE_RELEASES,
): { sections: ReleaseNoteSection[]; omitted: number } {
  const installed = normalizeVersion(current);
  const newer = releases
    .filter((release) => compareVersions(release.version, installed) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));
  const kept = newer.slice(Math.max(0, newer.length - limit));
  return {
    sections: kept.map(({ version, url, notes }) => ({ version, url, notes })),
    omitted: newer.length - kept.length,
  };
}

/**
 * Same evaluation as `evaluateUpdate`, but fed the whole release list: the
 * newest entry decides the status and asset, and every version above the
 * installed one rides along as the dialog's range summary.
 */
export function evaluateUpdateFromList(
  current: string,
  releases: readonly ReleaseInfo[],
  platform?: Platform,
  arch?: string,
): UpdateCheckResult {
  const latest = releases.reduce<ReleaseInfo | null>(
    (best, release) =>
      best === null || compareVersions(release.version, best.version) > 0 ? release : best,
    null,
  );
  const base = evaluateUpdate(current, latest, platform, arch);
  if (base.status !== "available") return base;
  const { sections, omitted } = selectUpdateRangeReleases(current, releases);
  return {
    ...base,
    ...(sections.length > 0 ? { releases: sections } : {}),
    ...(omitted > 0 ? { omittedReleases: omitted } : {}),
  };
}

/**
 * Picks the installer for this platform and architecture.
 *
 * Names come from electron-builder's `artifactName` templates, so they are
 * predictable: `Ensemble-<v>-win-x64-setup.exe`, `...-mac-<arch>.dmg`,
 * `...-linux-x64.AppImage` / `.deb`.
 */
export function pickUpdateAsset(
  assets: readonly UpdateAsset[],
  platform: Platform,
  arch: string,
): UpdateAsset | undefined {
  const normalizedArch = arch === "x64" && platform === "linux" ? "x64" : arch;
  const wanted: string[] = [];
  if (platform === "win32") {
    wanted.push(`-win-${normalizedArch}-setup.exe`);
  } else if (platform === "darwin") {
    wanted.push(`-mac-${normalizedArch}.dmg`);
  } else {
    // AppImage first: it is the only Linux package we can replace in place.
    wanted.push(`-linux-${normalizedArch}.AppImage`, `-linux-${normalizedArch}.deb`);
  }
  for (const suffix of wanted) {
    const found = assets.find((asset) => asset.name.endsWith(suffix));
    if (found) return found;
  }
  return undefined;
}

export function evaluateUpdate(
  current: string,
  release: ReleaseInfo | null,
  platform?: Platform,
  arch?: string,
): UpdateCheckResult {
  if (!release) return { status: "error", current };
  const newer = compareVersions(release.version, normalizeVersion(current)) > 0;
  const asset = platform && arch ? pickUpdateAsset(release.assets ?? [], platform, arch) : undefined;
  return {
    status: newer ? "available" : "current",
    current,
    latest: release.version,
    url: release.url,
    ...(release.publishedAt ? { publishedAt: release.publishedAt } : {}),
    ...(release.notes ? { notes: release.notes } : {}),
    ...(asset ? { asset } : {}),
  };
}

/**
 * Picks the summary section for one language.
 *
 * A release body holds a `中文` / `English` section per language, so the dialog
 * shows only the part matching the UI language. Inside a section, only the text
 * before the "full changes" heading is the summary — the detailed list belongs on
 * the release page, not in a dialog nobody reads.
 *
 * Heading depth is deliberately not fixed: the same body is correct at `##` when
 * it is read as a changelog chapter, but GitHub renders it one level deeper
 * (`### 中文`, `### English`) because it sits under the release's own title. Both
 * shapes must work, so the level is inferred from the language heading itself and
 * the summary ends at the next heading of the same or shallower depth.
 *
 * A body with no language headings is returned unchanged, which keeps
 * hand-written notes and older releases readable.
 */
export function selectUpdateNotes(notes: string | undefined, locale: "zh" | "en"): string {
  if (!notes) return "";
  const alias = locale === "zh" ? /^(中文|chinese|zh)$/i : /^(english|en)$/i;
  const lines = notes.split(/\r?\n/);
  let level = 0;
  let collecting = false;
  const picked: string[] = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const depth = heading[1]?.length ?? 0;
      const title = heading[2] ?? "";
      const isLanguageHeading = depth <= 3 && alias.test(title);
      if (isLanguageHeading) {
        // The first language heading decides the document's section depth.
        if (level === 0) level = depth;
        if (depth === level) {
          collecting = true;
          continue;
        }
      }
      if (collecting) {
        // "Full changes" style headings and any sibling section end the summary.
        if (depth <= level || /完整变更|full changes/i.test(title)) break;
      }
      continue;
    }
    if (collecting) picked.push(line);
  }
  const body = picked.join("\n").trim();
  return body.length > 0 ? body : notes.trim();
}
