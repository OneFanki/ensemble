/**
 * How the app's UI language is chosen.
 *
 * `"system"` is the default because a hardcoded language is a hardcoded opinion:
 * a Chinese user gets Chinese for free, and an English user is not silently
 * given a translated界面 they never asked for. Picking a language in settings
 * stores it explicitly and stops following the OS.
 */
export type LocaleSetting = "system" | "zh" | "en";
export type Locale = "zh" | "en";

/** Maps a system locale tag such as "zh-CN" or "en-US" onto a supported one. */
export function localeFromSystemLocale(systemLocale: string | undefined): Locale {
  return typeof systemLocale === "string" && systemLocale.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
}

/**
 * The language to actually render.
 *
 * `systemLocale` is what the OS reports; it is passed in rather than read here so
 * this module stays free of Electron (the core layer and the renderer both use
 * it, and `src/core` may not import Electron).
 */
export function resolveLocale(setting: LocaleSetting, systemLocale: string | undefined): Locale {
  if (setting === "zh" || setting === "en") return setting;
  return localeFromSystemLocale(systemLocale);
}

/** The tag handed to Chromium (`--lang`) and to the DevTools front-end. */
export function localeTag(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en-US";
}
