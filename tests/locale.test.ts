import {
  LOCALE_SETTINGS,
  type LocaleSetting,
  localeFromSystemLocale,
  localeTag,
  resolveLocale,
} from "@shared/locale";
import { settingsPatchSchema } from "@shared/schemas";
import { describe, expect, it } from "vitest";

describe("locale resolution", () => {
  it("maps any Chinese system tag to zh", () => {
    expect(localeFromSystemLocale("zh-CN")).toBe("zh");
    expect(localeFromSystemLocale("zh-Hans-CN")).toBe("zh");
    expect(localeFromSystemLocale("zh_TW")).toBe("zh");
  });

  it("maps everything else to en", () => {
    expect(localeFromSystemLocale("en-US")).toBe("en");
    expect(localeFromSystemLocale("ja-JP")).toBe("en");
    expect(localeFromSystemLocale("")).toBe("en");
    expect(localeFromSystemLocale(undefined)).toBe("en");
  });

  it("follows the system when the setting says so", () => {
    expect(resolveLocale("system", "zh-CN")).toBe("zh");
    expect(resolveLocale("system", "en-GB")).toBe("en");
    expect(resolveLocale("system", "")).toBe("en");
  });

  it("lets an explicit setting override the system", () => {
    // The point of the three-way choice: a user on a Chinese OS can still run
    // the app in English, and vice versa.
    expect(resolveLocale("en", "zh-CN")).toBe("en");
    expect(resolveLocale("zh", "en-US")).toBe("zh");
  });

  it("produces the tag Chromium and the DevTools front-end expect", () => {
    expect(localeTag("zh")).toBe("zh-CN");
    expect(localeTag("en")).toBe("en-US");
  });
});

describe("settings schema locale", () => {
  it("accepts the system locale the language picker stores", () => {
    // Regression: the picker's first segment stores "system", but the settings
    // patch schema only listed zh/en, so clicking 跟随系统 surfaced the raw
    // zod issues as a toast and never saved.
    expect(settingsPatchSchema.parse({ locale: "system" }).locale).toBe("system");
  });

  it("still accepts an explicit language", () => {
    expect(settingsPatchSchema.safeParse({ locale: "zh" }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ locale: "en" }).success).toBe(true);
  });

  it("rejects a language the app cannot render", () => {
    expect(settingsPatchSchema.safeParse({ locale: "fr" }).success).toBe(false);
  });

  it("derives the type from the same list the schema validates", () => {
    // Compile-time tie: if the picker order changes, the type follows.
    const values: LocaleSetting[] = [...LOCALE_SETTINGS];
    expect(values).toContain("system");
  });
});
