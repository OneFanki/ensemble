/**
 * The guide version a suite must seed so the onboarding overlay stays shut.
 *
 * Every suite writes its own `settings.json`, and a seeded value below
 * `GUIDE_VERSION` makes the guide auto-open over the whole window — which then
 * silently eats clicks meant for the dock handle or for a blank page's search
 * box. Hardcoding a number there rots the moment the guide is revised (`1` was
 * fine until the guide went to `2`), so the number is read from the source of
 * truth instead.
 */
import { readFileSync } from "node:fs";

const GUIDE_SOURCE = new URL("../../src/renderer/src/onboarding/guide.ts", import.meta.url);

const parsed = Number(
  readFileSync(GUIDE_SOURCE, "utf8").match(/GUIDE_VERSION\s*=\s*(\d+)/)?.[1],
);

/**
 * Current `GUIDE_VERSION`, so seeding it reads as "the user has seen the guide".
 * The fallback is deliberately above any plausible version rather than below it:
 * a suite that cannot read the constant should not pop the guide open mid-run.
 */
export const GUIDE_SEEN = Number.isFinite(parsed) && parsed > 0 ? parsed : 999;
