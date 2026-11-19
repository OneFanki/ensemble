/**
 * Which raw CDP commands a flow may run, and why the list is short.
 *
 * The action layer exists so that every page interaction goes through
 * `Input.dispatch*` — real events, `isTrusted: true`, framework handlers firing.
 * A flow that could run any CDP command would have a second, weaker way to do
 * the same things, and the first time somebody used `Runtime.evaluate` to click
 * a button the page would start ignoring it in ways nobody could trace back.
 *
 * So the escape hatch is deliberately narrow. It exists for the cases the
 * wrappers genuinely cannot express — setting a file input, answering a dialog,
 * a `Network` observation nobody wrapped yet — not as a general-purpose
 * back door.
 *
 * Three tiers, and the boundary is a security one, not a convenience one:
 *
 * - **可用（allow）**: commands that act on this page the way a person would.
 *   Worst case they do something odd to one page.
 * - **可选（gated）**: commands that change how the page behaves or what it can
 *   reach. Nothing here crosses a partition, but each one either alters page
 *   semantics or reads traffic. Off unless the setting turns them on.
 * - **禁止（deny）**: commands that reach *other* targets or the whole process.
 *   `Target.*` can attach to a page in another identity's partition, which is
 *   the one thing this app exists to keep separate. `Storage.*` and
 *   `Network.setCookie` write another partition's cookies the same way.
 *   `Browser.setDownloadBehavior` rewrites the whole browser's download path —
 *   the exact behaviour that got Playwright rejected in ADR 0001.
 *
 * A denied command is not "hidden from the docs": it is refused at run time,
 * with a message that says which tier it is in and why.
 */

export type CdpTier = "allow" | "gated" | "deny";

interface CdpRule {
  /** Prefixes that fall in this tier. `*` matches everything under the domain. */
  match: string[];
  tier: CdpTier;
  /** Why, in one sentence. Shown to the caller when a command is refused. */
  reason: string;
}

/*
 * Ordered: the first rule whose prefix matches wins, so a narrow exception can
 * sit above a broad domain rule.
 *
 * `Page.handleJavaScriptDialog` and `Page.captureScreenshot` are the two
 * exceptions inside `Page.*`: the first is how a dialog gets answered (there is
 * no input event that reaches browser chrome), the second is a read that costs a
 * frame. Everything else under `Page.*` navigates or reloads, which the `wait`
 * and `navigate` steps already express with the right waiting behaviour — a raw
 * `Page.navigate` would skip `whenReady` and the next step would run against the
 * old document.
 */
const RULES: CdpRule[] = [
  // --- deny: reaches past this page ------------------------------------------
  {
    match: ["Target.", "Browser.", "Storage.", "Page.setWebLifecycleState", "Page.close", "Page.crash"],
    tier: "deny",
    reason: "能影响其它标签页、其它分区或整个浏览器进程",
  },
  {
    match: ["Network.setCookie", "Network.setCookies", "Network.clearBrowserCookies"],
    tier: "deny",
    reason: "直接改写指定分区的 cookie，绕过账号隔离",
  },
  {
    match: ["Runtime.addBinding"],
    tier: "deny",
    reason: "新增的绑定会成为页面把数据推给主进程的第二条通道，绕开凭据与审计规则",
  },
  // --- gated: changes page behaviour ----------------------------------------
  {
    match: ["Network.", "Fetch.", "Emulation.", "Performance.", "Security.", "DOMStorage.", "IndexedDB.", "CacheStorage."],
    tier: "gated",
    reason: "会改变页面行为或读取其流量，需在设置里显式开启",
  },
  // --- allow: acts on this page like a person -------------------------------
  {
    match: ["Input.", "DOM.setFileInputFiles", "Page.handleJavaScriptDialog", "Page.captureScreenshot"],
    tier: "allow",
    reason: "等价于真人操作或一次只读采集",
  },
];

/** Domains a flow's raw step may never touch, whatever the setting says. */
export const FORBIDDEN_CDP_DOMAINS = ["Target.", "Browser.", "Storage."] as const;

/** The tier a command falls into. Unknown commands are refused as `deny`. */
export function cdpTier(method: string): { tier: CdpTier; reason: string } {
  const name = method.trim();
  for (const rule of RULES) {
    if (rule.match.some((prefix) => name.startsWith(prefix))) {
      return { tier: rule.tier, reason: rule.reason };
    }
  }
  // Anything not named is refused. The list is short on purpose: a command that
  // matters gets added with a reason, rather than arriving by default.
  return { tier: "deny", reason: "不在允许清单里；需要的话先在 coverage 文档里登记理由" };
}

/**
 * Checks a command against the tiers and the current setting.
 *
 * `gatedAllowed` comes from the settings, and it only unlocks the middle tier —
 * `deny` is not a setting. That asymmetry is the whole design: a user who turns
 * on network observation has not agreed to cross-partition access.
 */
export function checkCdpCommand(
  method: string,
  options: { gatedAllowed: boolean },
): { ok: true } | { ok: false; reason: string } {
  const { tier, reason } = cdpTier(method);
  if (tier === "allow") return { ok: true };
  if (tier === "gated") {
    if (options.gatedAllowed) return { ok: true };
    return {
      ok: false,
      reason: `${method} 属于可选档（${reason}）。要在流程里用它，先在设置里开启「允许流程使用网络与设备模拟命令」`,
    };
  }
  return { ok: false, reason: `${method} 被禁止：${reason}` };
}
