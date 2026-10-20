import { describe, expect, it } from "vitest";
import {
  RELEASES_PAGE_URL,
  evaluateUpdate,
  parseLatestRelease,
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
