import { createI18n } from "vue-i18n";
import { messages, type Locale } from "./messages";

export type { Locale };

export const i18n = createI18n({
  legacy: false,
  locale: "zh" as Locale,
  fallbackLocale: "zh",
  messages,
});

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
}

/** Translation helper for code that runs outside a component (stores). */
export function tr(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params ?? {});
}
