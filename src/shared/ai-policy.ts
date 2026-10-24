/**
 * What an AI client is allowed to do on one page.
 *
 * The premise of the daily profile is that the browser holds a real, long-lived
 * login — that is what makes an assistant useful in it. The same login is what
 * makes a page's own text dangerous: a page can suggest an action, and an AI
 * that follows page text will follow an attacker's text too. So pages that
 * belong to the user's everyday browsing are read-only by default, and the user
 * grants an origin explicitly.
 *
 * Three kinds of pages, and only one of them needs the gate:
 *
 * - an **identity** page belongs to a test account the user created for this
 *   purpose, in its own partition. Driving it is the product; it stays allowed.
 * - a **clean** session has no persistent login to protect. It stays allowed.
 * - a **daily** page is the user's own browsing, signed in for real. Read-only
 *   until its origin is authorized.
 */

/** The origin of a URL, or "" for anything that is not an http(s) page. */
export function aiOriginOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

export interface AiPageContext {
  identityId?: string;
  clean?: boolean;
  /** Origin of the document currently loaded. */
  origin: string;
}

export interface AiPolicy {
  /** Origins the user has explicitly let the AI operate in. */
  authorizedOrigins: readonly string[];
  /**
   * Addresses that came from the user or the workspace: a site's base URL, a
   * bookmark. A navigation towards one of these is a known destination rather
   * than something a page talked the AI into.
   */
  knownUrls: readonly string[];
}

export type AiWriteDenial = "daily-origin-unauthorized" | "unknown-origin";

/**
 * Whether the AI may send input to this page.
 *
 * A page with no usable origin (still on `about:blank`, or an error page) is
 * denied for the same reason a daily page is: it is not a target the user named,
 * and there is nothing there to operate on.
 */
export function aiWriteDenial(page: AiPageContext, policy: AiPolicy): AiWriteDenial | undefined {
  if (page.identityId) return undefined;
  if (page.clean) return undefined;
  if (!page.origin) return "unknown-origin";
  if (policy.authorizedOrigins.includes(page.origin)) return undefined;
  return "daily-origin-unauthorized";
}

/**
 * Whether the AI may navigate this page to `targetUrl`.
 *
 * The rule exists to stop one specific attack: a page's text tells the AI to go
 * somewhere, and the AI obeys. So a target is allowed when the user could
 * plausibly have meant it —
 *
 * - the tab is blank, so the first navigation is always a fresh instruction;
 * - the target is on the same origin as the page the AI was told to work on;
 * - the target is an address the workspace already knows.
 *
 * Anything else has to come from the user. Same-origin includes following real
 * links on the page, which is what the AI legitimately does most of the time.
 */
export function aiNavigationAllowed(input: {
  currentUrl: string;
  targetUrl: string;
  policy: AiPolicy;
}): boolean {
  const targetOrigin = aiOriginOf(input.targetUrl);
  if (!targetOrigin) return false;
  const currentOrigin = aiOriginOf(input.currentUrl);
  if (!currentOrigin) return true;
  if (currentOrigin === targetOrigin) return true;
  return input.policy.knownUrls.some((url) => aiOriginOf(url) === targetOrigin);
}

/** One-line explanation shown to the AI client, so it can tell the user. */
export function aiWriteDenialMessage(denial: AiWriteDenial, origin: string): string {
  switch (denial) {
    case "unknown-origin":
      return "这个标签页当前不是可操作的 http(s) 页面，不能发送输入。";
    case "daily-origin-unauthorized":
      return (
        `来源 ${origin} 在「日常档案」里，AI 默认只读。` +
        "要让 AI 在这里操作，请在浏览器工具栏的 AI 权限里允许这个来源。"
      );
  }
}
