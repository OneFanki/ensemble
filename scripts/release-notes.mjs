/**
 * Pulls one version's section out of CHANGELOG.md so the release workflow can use
 * it as the GitHub release body.
 *
 *   node scripts/release-notes.mjs 0.4.0 notes.md
 *   node scripts/release-notes.mjs 0.4.0 -        # write to stdout
 *
 * Exits non-zero when the section is missing: a release without written notes is
 * exactly what this file exists to prevent, so the caller decides whether to fail
 * or fall back.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Body of `## [<version>]`, without the heading, up to the next `## [` heading.
 * Returns undefined for a missing or empty section.
 */
export function extractReleaseNotes(markdown, version) {
  if (!version) return undefined;
  // Anchored and exact: 0.1 must not match 0.1.0, and the heading may carry a date.
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+[^\\n]*)?\\s*$`, "m");
  const match = heading.exec(markdown);
  if (!match) return undefined;

  const rest = markdown.slice(match.index + match[0].length);
  const next = /^## \[/m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body.length > 0 ? body : undefined;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [, , version, outArg] = process.argv;
  if (!version) {
    console.error("usage: node scripts/release-notes.mjs <version> [output-file|-]");
    process.exit(2);
  }
  const changelog = resolve(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
  const notes = extractReleaseNotes(readFileSync(changelog, "utf8"), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no section for ${version}. Add "## [${version}]" first.`);
    process.exit(1);
  }
  if (outArg && outArg !== "-") {
    writeFileSync(outArg, `${notes}\n`);
  } else {
    process.stdout.write(`${notes}\n`);
  }
}
