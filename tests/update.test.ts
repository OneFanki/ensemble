import { describe, expect, it } from "vitest";
import {
  RELEASES_PAGE_URL,
  evaluateUpdate,
  parseLatestRelease,
  parseSha256,
  pickUpdateAsset,
  selectUpdateNotes,
} from "@shared/update";

describe("latest release parsing", () => {
  it("accepts a normal release payload and strips the tag prefix", () => {
    expect(
      parseLatestRelease({
        tag_name: "v0.2.1",
        html_url: "https://github.com/OneFanki/ensemble/releases/tag/v0.2.1",
        published_at: "2026-10-20T00:00:00Z",
      }),
    ).toEqual({
      version: "0.2.1",
      url: "https://github.com/OneFanki/ensemble/releases/tag/v0.2.1",
      publishedAt: "2026-10-20T00:00:00Z",
    });
  });

  it("falls back to the releases page when html_url is missing", () => {
    const parsed = parseLatestRelease({ tag_name: "v1.0.0" });
    expect(parsed?.url).toBe(RELEASES_PAGE_URL);
  });

  it("rejects payloads that do not name a plausible version", () => {
    // A proxy error page, an unexpected schema, or a tag like "nightly" must
    // surface as "could not check", never as a made-up version.
    expect(parseLatestRelease(null)).toBeNull();
    expect(parseLatestRelease({})).toBeNull();
    expect(parseLatestRelease({ tag_name: 42 })).toBeNull();
    expect(parseLatestRelease({ tag_name: "nightly" })).toBeNull();
    expect(parseLatestRelease({ tag_name: "v2" })).toBeNull();
  });
});

describe("update evaluation", () => {
  it("reports a newer release as available", () => {
    const result = evaluateUpdate("0.1.0", {
      version: "0.10.0",
      url: "https://example.test/v0.10.0",
    });
    // String comparison would call 0.10.0 older than 0.9.0; numeric segments
    // are what GitHub release ordering actually means.
    expect(result.status).toBe("available");
    expect(result.latest).toBe("0.10.0");
    expect(result.url).toBe("https://example.test/v0.10.0");
  });

  it("treats an equal or older release as current", () => {
    expect(evaluateUpdate("0.2.0", { version: "0.2.0", url: "u" }).status).toBe("current");
    expect(evaluateUpdate("0.2.0", { version: "0.1.9", url: "u" }).status).toBe("current");
  });

  it("compares with fewer segments as zero", () => {
    expect(evaluateUpdate("1.2", { version: "1.2.0", url: "u" }).status).toBe("current");
    expect(evaluateUpdate("1.2", { version: "1.2.1", url: "u" }).status).toBe("available");
  });

  it("degrades to an error result when the payload did not parse", () => {
    expect(evaluateUpdate("0.1.0", null)).toEqual({ status: "error", current: "0.1.0" });
  });
});

describe("release assets", () => {
  const asset = (name: string, digest = `sha256:${"a".repeat(64)}`) => ({
    name,
    size: 1024,
    browser_download_url: `https://github.com/OneFanki/ensemble/releases/download/v1.0.0/${name}`,
    digest,
  });

  it("keeps only assets hosted on GitHub, with their checksums", () => {
    const parsed = parseLatestRelease({
      tag_name: "v1.0.0",
      assets: [
        asset("Ensemble-1.0.0-win-x64-setup.exe"),
        {
          name: "evil.exe",
          size: 1,
          browser_download_url: "https://example.test/evil.exe",
          digest: `sha256:${"b".repeat(64)}`,
        },
        {
          name: "plain.exe",
          size: 1,
          browser_download_url: "http://github.com/OneFanki/ensemble/plain.exe",
        },
      ],
    });
    // An asset URL is code that will be executed after installation, so anything
    // off GitHub or off HTTPS is dropped at parse time, not checked later.
    expect(parsed?.assets?.map((item) => item.name)).toEqual([
      "Ensemble-1.0.0-win-x64-setup.exe",
    ]);
    expect(parsed?.assets?.[0]?.sha256).toBe("a".repeat(64));
  });

  it("omits the assets key entirely when nothing usable is published", () => {
    expect(parseLatestRelease({ tag_name: "v1.0.0", assets: [] })).not.toHaveProperty("assets");
  });

  it("picks the installer matching the platform and architecture", () => {
    const assets = [
      asset("Ensemble-1.0.0-win-x64-setup.exe"),
      asset("Ensemble-1.0.0-mac-x64.dmg"),
      asset("Ensemble-1.0.0-mac-arm64.dmg"),
      asset("Ensemble-1.0.0-linux-x64.AppImage"),
      asset("Ensemble-1.0.0-linux-x64.deb"),
    ].map((entry, index) => ({
      name: entry.name,
      url: entry.browser_download_url,
      size: entry.size,
      sha256: String(index).repeat(64).slice(0, 64),
    }));

    expect(pickUpdateAsset(assets, "win32", "x64")?.name).toBe(
      "Ensemble-1.0.0-win-x64-setup.exe",
    );
    expect(pickUpdateAsset(assets, "darwin", "arm64")?.name).toBe("Ensemble-1.0.0-mac-arm64.dmg");
    // AppImage wins on Linux: it is the only package that can be replaced in place.
    expect(pickUpdateAsset(assets, "linux", "x64")?.name).toBe(
      "Ensemble-1.0.0-linux-x64.AppImage",
    );
    expect(pickUpdateAsset(assets, "win32", "arm64")).toBeUndefined();
  });

  it("attaches the matching installer to the update result", () => {
    const parsed = parseLatestRelease({
      tag_name: "v1.0.0",
      assets: [asset("Ensemble-1.0.0-win-x64-setup.exe")],
    });
    const result = evaluateUpdate("0.9.0", parsed, "win32", "x64");
    expect(result.status).toBe("available");
    expect(result.asset?.name).toBe("Ensemble-1.0.0-win-x64-setup.exe");
  });

  it("reads GitHub's sha256:<hex> digest format only", () => {
    expect(parseSha256(`sha256:${"A".repeat(64)}`)).toBe("a".repeat(64));
    expect(parseSha256("md5:abc")).toBeUndefined();
    expect(parseSha256(undefined)).toBeUndefined();
  });
});

describe("update summary selection", () => {
  const body = [
    "## 中文",
    "- 修复 A",
    "- 新增 B",
    "",
    "#### 完整变更",
    "- 很长的细节 1",
    "- 很长的细节 2",
    "",
    "## English",
    "- Fixed A",
    "- Added B",
    "",
    "#### Full changes",
    "- Long detail 1",
  ].join("\n");

  it("shows only the summary of the section matching the UI language", () => {
    expect(selectUpdateNotes(body, "zh")).toBe("- 修复 A\n- 新增 B");
    expect(selectUpdateNotes(body, "en")).toBe("- Fixed A\n- Added B");
  });

  // GitHub renders the release body under its own title, so the same section
  // arrives one level deeper than it appears in CHANGELOG.md. Missing this made
  // the dialog fall back to the entire body — the exact thing it must not show.
  it("works when a release body arrives with deeper headings", () => {
    const rendered = body
      .split("\n")
      .map((line) => (line.startsWith("## ") ? `#${line}` : line))
      .join("\n");
    expect(selectUpdateNotes(rendered, "zh")).toBe("- 修复 A\n- 新增 B");
    expect(selectUpdateNotes(rendered, "en")).toBe("- Fixed A\n- Added B");
  });

  it("stops at the next sibling section even without a full-changes heading", () => {
    const withoutDetail = ["### 中文", "- 只有摘要", "### English", "- Summary only"].join("\n");
    expect(selectUpdateNotes(withoutDetail, "zh")).toBe("- 只有摘要");
    expect(selectUpdateNotes(withoutDetail, "en")).toBe("- Summary only");
  });

  it("returns a body without sections unchanged", () => {
    expect(selectUpdateNotes("- one change", "en")).toBe("- one change");
    expect(selectUpdateNotes(undefined, "en")).toBe("");
  });
});
