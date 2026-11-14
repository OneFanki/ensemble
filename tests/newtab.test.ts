import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_NEW_TAB_BACKDROP, NEW_TAB_BACKDROPS, newTabBackdrop } from "../src/shared/newtab";
import { messages } from "../src/renderer/src/i18n/messages";

describe("newTabBackdrop", () => {
  it("returns the requested preset", () => {
    for (const preset of NEW_TAB_BACKDROPS) {
      expect(newTabBackdrop(preset.id).id).toBe(preset.id);
    }
  });

  it("falls back to the default for unknown, empty and missing ids", () => {
    // A workspace exported by an older build, or one hand-edited, must still
    // paint: this runs while the page renders, so throwing would blank the tab.
    for (const id of [undefined, "", "no-such-backdrop", "AURORA"]) {
      expect(newTabBackdrop(id).id).toBe(DEFAULT_NEW_TAB_BACKDROP);
    }
  });
});

describe("backdrop presets", () => {
  it("has unique ids", () => {
    const ids = NEW_TAB_BACKDROPS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships the default preset", () => {
    expect(NEW_TAB_BACKDROPS.some((item) => item.id === DEFAULT_NEW_TAB_BACKDROP)).toBe(true);
  });

  it("names every preset in both locales", () => {
    const zh = messages.zh.app as Record<string, string>;
    const en = messages.en.app as Record<string, string>;
    for (const preset of NEW_TAB_BACKDROPS) {
      const key = preset.labelKey.replace(/^app\./, "");
      expect(zh[key], `zh.${key}`).toBeTruthy();
      expect(en[key], `en.${key}`).toBeTruthy();
    }
  });

  /*
   * The paint is in the stylesheet, so this is the test that keeps a preset from
   * becoming a name with no picture behind it. It also pins the light theme: a
   * preset that only defines its dark value is the exact bug this redesign fixed
   * — five dark swatches in a white picker and a dark wash under a light
   * headline. Both themes, every id, no exceptions.
   *
   * A file read rather than a render because these rules are plain CSS in a
   * scoped block: there is nothing to instantiate, and the failure mode (a
   * preset added to the list but not to the sheet) is a source-level mistake.
   */
  it("paints every preset in both themes", () => {
    const sheet = readFileSync(
      new URL("../src/renderer/src/components/NewTabPage.vue", import.meta.url),
      "utf8",
    );
    for (const preset of NEW_TAB_BACKDROPS) {
      const dark = `.nt-swatch[data-backdrop="${preset.id}"]`;
      const light = `:root[data-theme="light"] .nt-swatch[data-backdrop="${preset.id}"]`;
      expect(sheet, `${preset.id} (dark)`).toContain(dark);
      /*
       * Every preset needs its own light value, except one whose paint is
       * `var(--bg)` and therefore already resolves per theme — restating that
       * would be a rule that says nothing. The exception is checked, not
       * assumed: a preset that merely forgot its light block keeps the dark
       * colours in both themes, which is the bug this test exists for.
       */
      const darkBlock = sheet.slice(
        sheet.indexOf(dark),
        sheet.indexOf("}", sheet.indexOf(dark)),
      );
      const themeIndependent = /--nt-paint:\s*var\(--bg\);/.test(darkBlock);
      if (!themeIndependent) {
        expect(sheet, `${preset.id} (light)`).toContain(light);
      }
    }
  });

  it("keeps the paint free of fetched assets", () => {
    // Every backdrop has to paint before the first network call; a `url()` would
    // turn the new-tab surface into something that can flash empty.
    const sheet = readFileSync(
      new URL("../src/renderer/src/components/NewTabPage.vue", import.meta.url),
      "utf8",
    );
    const block = sheet.slice(sheet.indexOf("--nt-paint:"), sheet.lastIndexOf("--nt-paint:"));
    expect(block).not.toMatch(/url\(/);
  });
});
