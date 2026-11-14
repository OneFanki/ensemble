/**
 * What an AI client is allowed to do on one page.
 *
 * The premise of a profile with no account is that the browser holds a real,
 * long-lived login — that is what makes an assistant useful in it. The same login
 * is what makes a page's own text dangerous: a page can suggest an action, and an
 * AI that follows page text will follow an attacker's text too. So pages that
 * belong to the user's everyday browsing are gated, and the user decides how wide
 * that gate is.
 *
 * Three kinds of pages, and only one of them needs the gate:
 *
 * - an **identity** page belongs to a test account the user created for this
 *   purpose, in its own partition. Driving it is the product; it stays allowed.
 * - a **clean** session has no persistent login to protect. It stays allowed.
 * - a **profile** page is the user's own browsing, signed in for real. Governed by
 *   the address list and the mode below.
 */
import type { AiGateState } from "./types";

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

/**
 * How the stored addresses are read.
 *
 * Separated from the list itself on purpose: switching from allowlist to
 * blocklist must not throw away the addresses the user typed, or turning the
 * gate off and back on would mean re-entering every one of them. The list is
 * kept whatever the mode says, and the mode only changes how it is interpreted.
 */
export type AiDailyMode = "allowlist" | "denylist" | "allow-all" | "deny-all";

export const AI_DAILY_MODES: readonly AiDailyMode[] = [
  "allowlist",
  "denylist",
  "allow-all",
  "deny-all",
] as const;

export interface AiPolicy {
  /** How {@link listedOrigins} is applied. */
  dailyMode: AiDailyMode;
  /**
   * Origins the user named, in the order they were added.
   *
   * Kept across every mode change: in an allowlist these are what may be driven,
   * in a denylist these are what may not. The two other modes ignore it without
   * deleting it.
   */
  listedOrigins: readonly string[];
  /**
   * Addresses that came from the user or the workspace: a site's base URL, a
   * bookmark. A navigation towards one of these is a known destination rather
   * than something a page talked the AI into.
   */
  knownUrls: readonly string[];
}

export type AiWriteDenial =
  | "daily-origin-unauthorized"
  | "daily-origin-blocked"
  | "daily-denied-by-policy"
  | "unknown-origin";

/**
 * Whether the AI may send input to this page.
 *
 * A page with no usable origin (still on `about:blank`, or an error page) is
 * denied: it is not a target the user named, and there is nothing there to
 * operate on.
 *
 * The two whole-profile modes are absolute. "允许全部" is the answer for someone
 * who wants the assistant to be able to drive their own browsing and has decided
 * the risk is theirs; "全部拒绝" is the answer for someone who does not want the
 * gate reasoned about at all. Neither consults the list — the list is preserved
 * for when the user comes back to a list-based mode.
 */
export function aiWriteDenial(page: AiPageContext, policy: AiPolicy): AiWriteDenial | undefined {
  if (page.identityId) return undefined;
  if (page.clean) return undefined;
  if (!page.origin) return "unknown-origin";
  const listed = policy.listedOrigins.includes(page.origin);
  switch (policy.dailyMode) {
    case "allow-all":
      return undefined;
    case "deny-all":
      return "daily-denied-by-policy";
    case "denylist":
      return listed ? "daily-origin-blocked" : undefined;
    case "allowlist":
      return listed ? undefined : "daily-origin-unauthorized";
  }
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
 *
 * Navigation is not input, so the daily mode does not gate it: moving a page does
 * not type into the user's account. Whether the AI may then *act* there is
 * `aiWriteDenial`'s question.
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
    case "daily-denied-by-policy":
      return "AI 在非账号页面上的操作已全部关闭，请在 Ensemble 设置的「AI 接入」里调整策略。";
    case "daily-origin-blocked":
      return `来源 ${origin} 已被列入禁止名单，AI 不能在这里操作。`;
    case "daily-origin-unauthorized":
      return `来源 ${origin} 不在允许名单里，AI 默认只读。要让 AI 在这里操作，请在浏览器工具栏的 AI 面板里允许这个来源，或等它请求授权后同意。`;
  }
}

/**
 * The same decision as {@link aiWriteDenial}, grouped into the three states an
 * interface can draw.
 *
 * The panel and its badge need "can it act here", "this was refused", or "this
 * has not been decided" — not the four internal reasons. Deriving those from the
 * denial function rather than re-reading the mode is what keeps the interface
 * from claiming a permission the tool gate would refuse; the toolbar used to
 * carry its own copy of that switch, which was one refactor away from
 * disagreeing with the server.
 */
export function aiGateState(page: AiPageContext, policy: AiPolicy): AiGateState {
  switch (aiWriteDenial(page, policy)) {
    case undefined:
      return "open";
    case "daily-origin-blocked":
    case "daily-denied-by-policy":
      return "blocked";
    case "daily-origin-unauthorized":
      return "unlisted";
    case "unknown-origin":
      // Not a page the user could decide about, so it is reported as "not
      // covered" rather than as a refusal they could lift.
      return "unlisted";
  }
}

/**
 * Normalises an address a user typed into the list.
 *
 * Accepts a bare host (`example.com`), a host with a port, or a full URL, and
 * reduces it to its origin — because the origin is the unit the policy compares
 * against, and storing a path would produce an entry that never matches.
 * Returns `undefined` for anything that is not http(s), which is reported to the
 * user rather than silently stored.
 */
export function normalizeAiOrigin(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  const attempt = (candidate: string): string | undefined => {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      return parsed.origin;
    } catch {
      return undefined;
    }
  };
  if (value.includes("://")) return attempt(value);
  // A bare `example.com:8080` parses as a URL with scheme "example.com:", so a
  // scheme-less value always gets one prepended rather than being parsed as-is.
  return attempt(`https://${value}`);
}
