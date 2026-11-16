import { describe, expect, it } from "vitest";
import { extractReleaseNotes } from "../scripts/release-notes.mjs";

const markdown = `# Changelog

## [未发布]

- unreleased work

## [0.4.0] - 2026-10-21

### 中文

- 新功能 A

### English

- Feature A

## [0.3.0] - 2026-10-20

- older work
`;

describe("release notes extraction", () => {
  it("returns the body of the requested version", () => {
    const notes = extractReleaseNotes(markdown, "0.4.0");
    expect(notes).toContain("新功能 A");
    expect(notes).toContain("Feature A");
  });

  it("stops at the next version so entries never bleed together", () => {
    const notes = extractReleaseNotes(markdown, "0.4.0");
    expect(notes).not.toContain("older work");
    expect(notes).not.toContain("unreleased work");
  });

  it("matches the version exactly, not as a prefix", () => {
    expect(extractReleaseNotes(markdown, "0.3")).toBeUndefined();
    expect(extractReleaseNotes(markdown, "0.4")).toBeUndefined();
  });

  it("returns undefined for a version that has no section", () => {
    expect(extractReleaseNotes(markdown, "9.9.9")).toBeUndefined();
  });

  it("treats an empty section as missing", () => {
    expect(extractReleaseNotes("## [1.0.0]\n\n## [0.9.0]\n- x\n", "1.0.0")).toBeUndefined();
  });

  it("works on the real changelog for every released version", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const real = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
    for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
      const notes = extractReleaseNotes(real, version);
      expect(notes, `${version} must have release notes`).toBeDefined();
      // Both languages, so a release is readable for either audience.
      expect(notes).toContain("### 中文");
      expect(notes).toContain("### English");
    }
  });

  it("groups a release by kind, in the order readers scan for", async () => {
    // A flat list of thirty-odd bullets is unreadable: the two or three things a
    // release is actually about disappear among the fixed bugs. So sections are
    // grouped, and the order is fixed — additions first (that is what people
    // upgrade for), then changes, then fixes, then polish.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const real = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
    const notes = extractReleaseNotes(real, "2.2.0") ?? "";

    const groups = (locale: "### 中文" | "### English", names: string[]) => {
      const start = notes.indexOf(locale);
      expect(start, `${locale} missing`).toBeGreaterThanOrEqual(0);
      // Stop at the other locale, or its headings bleed into this slice and the
      // assertion would compare two languages' worth of groups at once.
      const other = locale === "### 中文" ? "### English" : "";
      const end = other ? notes.indexOf(other, start) : -1;
      const body = notes.slice(start, end === -1 ? undefined : end);
      const found = [...body.matchAll(/^#### (.+)$/gm)].map((m) => m[1]?.trim() ?? "");
      expect(found, `${locale} groups`).toEqual(names);
    };

    groups("### 中文", ["新增", "修改", "修复", "优化"]);
    groups("### English", ["Added", "Changed", "Fixed", "Improved"]);

    // Each group must actually hold entries, or the heading is decoration.
    for (const marker of ["#### 新增", "#### 修改", "#### 修复", "#### 优化"]) {
      const from = notes.indexOf(marker);
      const to = notes.indexOf("\n#### ", from + 1);
      const slice = notes.slice(from, to === -1 ? undefined : to);
      expect(slice.split("\n").filter((line) => line.startsWith("- ")).length).toBeGreaterThan(0);
    }
  });
});
