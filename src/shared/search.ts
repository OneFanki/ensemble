import { normalizeEmbeddedUrl } from "./embedded";

/**
 * What a search engine looks like to the chrome.
 *
 * `urlTemplate` holds `%s` where the encoded query goes, the same convention
 * Chromium uses for its own search engines. It is data, not code: the new-tab
 * surface renders whatever the user added without a branch per engine.
 */
export interface SearchEngine {
  id: string;
  name: string;
  urlTemplate: string;
  /** Built-in engines cannot be removed; custom ones can. */
  builtin?: boolean;
}

/**
 * Built-in engines.
 *
 * Bing is the default: it is reachable without an account in mainland networks
 * while Google is not, and the app is used for day-to-day work rather than for
 * search quality experiments. The rest are one click away in the new tab.
 */
export const SEARCH_ENGINES: SearchEngine[] = [
  { id: "bing", name: "Bing", urlTemplate: "https://www.bing.com/search?q=%s", builtin: true },
  {
    id: "google",
    name: "Google",
    urlTemplate: "https://www.google.com/search?q=%s",
    builtin: true,
  },
  { id: "baidu", name: "百度", urlTemplate: "https://www.baidu.com/s?wd=%s", builtin: true },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    urlTemplate: "https://duckduckgo.com/?q=%s",
    builtin: true,
  },
];

export const DEFAULT_SEARCH_ENGINE_ID = "bing";

/**
 * True when a typed string is meant as an address rather than as words.
 *
 * This is the one decision a browser's address field has to get right, and both
 * ways of getting it wrong are annoying: searching for `localhost:3000` never
 * finds the dev server, and opening a phrase as a hostname shows an error page.
 * The rules are therefore narrow and boring — explicit scheme, localhost, IPv4,
 * bracketed IPv6, or a dotted host with an optional port and path. Anything with
 * whitespace is words.
 */
export function looksLikeAddress(input: string): boolean {
  const value = input.trim();
  if (!value || /\s/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return true;
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(value)) return true;
  if (/^\[[0-9a-f:.]+\](?::\d+)?(?:[/?#].*)?$/i.test(value)) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/.test(value)) return true;
  // A dotted host: at least two labels, no slash before the first dot, optional
  // port and path. `.test` and `.local` pass, which is what an intranet uses.
  if (/^[^\s/?#:]+(?:\.[^\s/?#:]+)+(?::\d+)?(?:[/?#].*)?$/.test(value)) return true;
  return false;
}

/**
 * Turns what the user typed into something the embedded surface may load.
 *
 * Addresses are normalized through the same gate the IPC uses (http/https only),
 * so a string classified as an address can never sneak `file:` in. Everything
 * else goes to the selected engine.
 */
export function resolveBrowserInput(
  input: string,
  engine: Pick<SearchEngine, "urlTemplate">,
): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (looksLikeAddress(value)) return normalizeEmbeddedUrl(value);
  if (!engine.urlTemplate.includes("%s")) return undefined;
  return engine.urlTemplate.replace("%s", encodeURIComponent(value));
}

/** Whether a template is usable as a custom engine (needs exactly one `%s`). */
export function isValidEngineTemplate(template: string): boolean {
  const value = template.trim();
  if (!value.includes("%s")) return false;
  return /^https?:\/\//i.test(value);
}

/** Builds the URL a custom engine would load for a query; used by the form test. */
export function enginePreview(template: string, query: string): string | undefined {
  if (!isValidEngineTemplate(template)) return undefined;
  return template.trim().replace("%s", encodeURIComponent(query));
}
