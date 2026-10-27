import type { AppSettings, ProxyMode } from "./types";

/**
 * Turns the proxy settings into the one string Chromium understands.
 *
 * Two network stacks are in play and only one of them is configurable here:
 * pages and update downloads go through Electron's session, which follows these
 * rules, while nothing in the app uses a raw socket. Keeping the mapping in a
 * pure function means the rules can be asserted without launching a browser —
 * a wrong rule here shows up as "the update bar never moves", which is exactly
 * the kind of bug that is hard to notice until a release is waiting.
 *
 * `proxyMode: "system"` resolves to an empty rule and lets Chromium read the OS
 * settings itself, which is what covers Clash, Proxifier and the Windows proxy
 * panel. "off" is not the same thing: it tells Chromium to ignore the system
 * proxy, which is what a user needs when a test environment is only reachable
 * directly.
 */
export interface ProxyRules {
  /**
   * Chromium's `proxyRules`: `http=host:port;https=host:port` style. An empty
   * string means "direct" and is only used with `ignoreSystem: true`.
   */
  rules: string;
  /** `proxyBypassRules`: comma-separated hosts/patterns. */
  bypass: string;
  /** Meaningful only with an empty {@link rules}. */
  ignoreSystem: boolean;
}

/** Hosts every mode bypasses: the whole point of the app is local test sites. */
const LOCAL_BYPASS = ["localhost", "127.0.0.1", "::1", "<local>"];

/**
 * Parses a user-entered proxy URL into Chromium's `host:port` form.
 *
 * Returns undefined for anything unusable — including a missing port — rather
 * than inventing a default, because an unexpected port silently sending
 * traffic elsewhere is worse than not proxying at all.
 */
export function proxyEndpoint(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (!/^(https?|socks[45]?):$/i.test(parsed.protocol)) return undefined;
    if (!parsed.hostname || !parsed.port) return undefined;
    // `hostname` keeps an IPv6 literal bracketed already (`[::1]`), which is the
    // form a proxy rule wants — adding a second pair would produce `[[::1]]`.
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return undefined;
  }
}

/**
 * The bypass list for one mode.
 *
 * Localhost is always present. A user-supplied list can add to it but cannot
 * remove it: an environment at 127.0.0.1 that suddenly went through a proxy
 * would fail to load, and the setting that caused it would be three screens away.
 */
export function proxyBypassRules(extra: string | undefined): string {
  const user = (extra ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([...LOCAL_BYPASS, ...user])].join(",");
}

/**
 * Resolves the saved settings into rules for Chromium.
 *
 * `mode` is passed separately from `settings` so a caller can preview a mode
 * without saving it (the settings page does exactly that).
 */
export function resolveProxyRules(
  settings: Pick<AppSettings, "proxyMode" | "proxyUrl" | "proxyBypass">,
  mode: ProxyMode = settings.proxyMode,
): ProxyRules {
  const bypass = proxyBypassRules(settings.proxyBypass);
  if (mode === "off") return { rules: "", bypass, ignoreSystem: true };
  if (mode === "system") return { rules: "", bypass, ignoreSystem: false };
  const endpoint = proxyEndpoint(settings.proxyUrl);
  // "manual" with an unusable address must not fall back to direct: the user
  // asked for a proxy, and pretending they did not would hide their typo.
  // Chromium treats an empty rule plus `ignoreSystem: false` as "system" only
  // when told to, so an invalid manual entry is proxied to nowhere — the update
  // check then fails loudly instead of silently bypassing the proxy.
  if (!endpoint) return { rules: "http=127.0.0.1:1;https=127.0.0.1:1", bypass, ignoreSystem: true };
  return {
    rules: `http=${endpoint};https=${endpoint}`,
    bypass,
    ignoreSystem: true,
  };
}

/**
 * Whether the manual address can actually be used.
 *
 * The settings page disables saving on this, and the main process logs it, so
 * the "proxied to nowhere" case above only happens for a corrupted file.
 */
export function isProxyUrlUsable(url: string | undefined): boolean {
  return proxyEndpoint(url) !== undefined;
}
