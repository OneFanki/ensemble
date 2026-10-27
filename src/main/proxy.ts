import type { AppSettings } from "@shared/types";
import { resolveProxyRules } from "@shared/proxy";
import { session } from "electron";

/**
 * Applies the saved proxy settings to every network path the app has.
 *
 * Two consumers, one setting:
 *
 * - `session.defaultSession` serves the update check and download, and any
 *   request made by renderer code. This is where "the progress bar never moves"
 *   came from: Electron's `fetch` in the main process uses Chromium's network
 *   stack but *not* the Windows proxy unless a session proxy is configured, so a
 *   user behind Clash saw the download stall with no error.
 * - The partitions the built-in browser creates are configured separately by
 *   `EmbeddedBrowser`, which calls {@link applyProxyToSession} on each one.
 *
 * `net.fetch` in the main process shares `session.defaultSession`'s proxy, so
 * routing update traffic through it (see `main/index.ts`) is what makes this
 * setting cover updates as well as pages.
 */
export interface ProxyState {
  /** Chromium's `proxyRules`, for logging and the settings page. */
  rules: string;
  /** Human-readable description of what is in force. */
  description: string;
}

/** Applies rules to one session; returns what was applied, for logging. */
export async function applyProxyToSession(
  target: Electron.Session,
  settings: Pick<AppSettings, "proxyMode" | "proxyUrl" | "proxyBypass">,
): Promise<ProxyState> {
  const resolved = resolveProxyRules(settings);
  await target.setProxy({
    // Chromium treats an empty `proxyRules` as "direct" only when the mode says
    // so; "system" is expressed by using the system configuration explicitly.
    mode: resolved.ignoreSystem ? "fixed_servers" : "system",
    ...(resolved.ignoreSystem ? { proxyRules: resolved.rules } : {}),
    proxyBypassRules: resolved.bypass,
  });
  const description =
    settings.proxyMode === "system"
      ? "跟随系统代理"
      : settings.proxyMode === "off"
        ? "直连，不使用代理"
        : resolved.rules
          ? resolved.rules
          : "手动代理地址无效";
  return { rules: resolved.rules, description };
}

/**
 * Applies the settings to the default session.
 *
 * Called once at startup and again whenever the settings change, because
 * Chromium holds the rules per session: changing the stored value without
 * re-applying would only take effect for sessions created afterwards.
 */
export async function applyProxyToDefaultSession(
  settings: Pick<AppSettings, "proxyMode" | "proxyUrl" | "proxyBypass">,
): Promise<ProxyState> {
  return applyProxyToSession(session.defaultSession, settings);
}
