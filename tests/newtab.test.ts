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

  it("gives every preset a paintable background and a swatch", () => {
    for (const preset of NEW_TAB_BACKDROPS) {
      expect(preset.css.trim(), preset.id).not.toBe("");
      expect(preset.swatch.trim(), preset.id).not.toBe("");
      // A preset that points at a file would have to be fetched; the whole point
      // of these is that the surface paints before the first network call.
      expect(preset.css, preset.id).not.toMatch(/url\(/);
    }
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
});
