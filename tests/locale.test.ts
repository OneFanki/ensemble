import { describe, expect, it } from "vitest";
import { localeFromSystemLocale, localeTag, resolveLocale } from "@shared/locale";

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
