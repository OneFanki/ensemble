/**
 * What a `<webview>` is allowed to become.
 *
 * `<webview>` puts the embedder's own process in the position of creating a
 * renderer, so every protection the app relies on has to be re-established by
 * hand for each guest: attributes the page writes are honoured, and Electron's
 * defaults for a guest are not the same as the defaults this app chose for
 * itself. `will-attach-webview` is the last point where they can be forced,
 * which is why the whole decision lives in one testable function instead of
 * being spread through the attach handler.
 *
 * The rule is allow-list, not deny-list: unknown attributes are dropped rather
 * than inspected, so an Electron release that adds a new privilege-bearing
 * attribute cannot silently grant it to a remote page.
 */

/** The subset of `WebPreferences` a guest can influence. */
export interface GuestPreferencesLike {
  preload?: string;
  nodeIntegration?: boolean;
  nodeIntegrationInSubFrames?: boolean;
  contextIsolation?: boolean;
  sandbox?: boolean;
  webviewTag?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  /** Kept so a caller can read the partition the node asked for. */
  partition?: string;
}

export interface GuestAttachDecision {
  /** Attachment may proceed. */
  ok: boolean;
  /** Why it was refused; for the log, never shown to the page. */
  reason?: string;
}

/**
 * Attributes a guest may keep. Everything else is removed before attach.
 *
 * `allowpopups` stays on purpose: without it Chromium refuses `window.open`
 * before main ever hears about it, so the surface could not turn a popup into
 * an app tab — the whole routing model depends on the request arriving. The
 * safety comes one step later, where every `setWindowOpenHandler` answer is
 * `deny` and the URL is opened as an app tab instead of a native window.
 */
const ALLOWED_PARAMS = new Set(["src", "partition", "useragent", "allowpopups"]);

/**
 * Partitions a guest may join.
 *
 * The app's own renderer is what writes the attribute, but a partition is a
 * storage boundary: a guest pointed at `persist:something-else` would read
 * cookies this surface never meant to share, so the value is checked rather
 * than trusted.
 */
export function guestPartitionAllowed(partition: string | undefined): boolean {
  // Absent means "whatever the default is", which the manager always sets to a
  // partition of its own. An empty string is different: Chromium reads it as
  // the default session, i.e. the app's own — never allowed for a guest.
  if (partition === undefined) return true;
  return partition.startsWith("persist:embedded-") || partition.startsWith("embedded-clean-");
}

/**
 * Schemes a guest may load.
 *
 * `about:blank` is the initial state of every new tab, so it has to pass.
 * Everything else is either a remote page or refused: a `file:` or `data:`
 * guest would put local content inside a surface the app treats as untrusted
 * remote pages, and `javascript:` in `src` is a navigation primitive rather
 * than a document.
 */
export function guestSrcAllowed(raw: string): boolean {
  const value = (raw ?? "").trim();
  if (!value) return true; // an empty src is Electron's own about:blank
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Forces a guest's preferences to the hardened set and drops everything else.
 *
 * Mutates `preferences` and `params` in place because that is the contract of
 * `will-attach-webview`; the return value only says whether to attach at all.
 * Called for every guest, including ones whose attributes look harmless — the
 * point is that the decision does not depend on them.
 */
export function hardenGuestPreferences(
  preferences: GuestPreferencesLike,
  params: Record<string, string>,
): GuestAttachDecision {
  const src = params["src"] ?? "";
  if (!guestSrcAllowed(src)) {
    return { ok: false, reason: `协议不允许：${src.slice(0, 32)}` };
  }
  if (!guestPartitionAllowed(params["partition"] ?? preferences.partition)) {
    return { ok: false, reason: `分区不允许：${String(params["partition"] ?? preferences.partition)}` };
  }

  // Attributes the page wrote are dropped wholesale, then the allowed ones are
  // copied back. Reading each known-dangerous key and deleting it is the
  // approach that breaks the first time Electron adds another one.
  for (const key of Object.keys(params)) {
    if (!ALLOWED_PARAMS.has(key)) delete params[key];
  }

  // A guest never runs app code. `preload` is the one field that would turn a
  // remote page into a privileged context, so it is removed from both places
  // it can arrive.
  delete preferences.preload;
  delete params["preload"];

  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webviewTag = false;
  preferences.webSecurity = true;
  preferences.allowRunningInsecureContent = false;

  // A guest that could itself embed guests would escape the partition rules
  // the manager applies to the surface it owns.
  delete params["webpreferences"];
  delete params["nodeintegration"];
  delete params["nodeintegrationinsubframes"];
  delete params["allowrunninginsecurecontent"];
  delete params["disablewebsecurity"];
  delete params["webviewtag"];

  return { ok: true };
}
