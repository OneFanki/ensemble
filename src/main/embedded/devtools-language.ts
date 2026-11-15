import { type BrowserWindow, type WebContents, WebContentsView } from "electron";
import { withDeadline } from "@shared/async";

/**
 * Writes the DevTools UI language into Electron's DevTools preferences.
 *
 * The language is not a localStorage preference. With a host attached, DevTools
 * reads it as a synced setting from the embedder's pref service, and only the
 * front-end can reach that service through `InspectorFrontendHost`. An
 * unattached document gets a stub whose writes go nowhere — the trick of loading
 * a throwaway front-end and setting localStorage looks like it works in a bare
 * stub, but the real panel never reads it.
 *
 * So this opens a real (host-bound) front-end in an off-screen view, writes the
 * two preferences, verifies the read-back, and closes it. The caller then opens
 * its own panel; the preference is already in place, so that panel starts in the
 * requested language without the one-time language bar.
 *
 * Returns whether the preference was actually written. A false leaves the
 * caller free to retry on the next open.
 */
export async function primeDevToolsFrontendLanguage(input: {
  host: BrowserWindow;
  contents: WebContents;
  language: "zh" | "en";
}): Promise<boolean> {
  const { host, contents, language } = input;
  const primer = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  primer.setBackgroundColor("#101317");
  // Off-screen but with a real box: a 0×0 front-end never initialises far
  // enough to expose the preference API.
  primer.setBounds({ x: -10_000, y: 0, width: 800, height: 600 });
  host.contentView.addChildView(primer);
  const stored = JSON.stringify(language);
  let written = false;
  try {
    const loaded = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 4_000);
      primer.webContents.once("did-finish-load", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    contents.setDevToolsWebContents(primer.webContents);
    contents.openDevTools({ mode: "detach" });
    await loaded;
    const result = (await withDeadline(
      primer.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = Date.now();
      const attempt = () => {
        try {
          if (window.InspectorFrontendHost?.setPreference) {
            InspectorFrontendHost.setPreference("language", ${JSON.stringify(stored)});
            InspectorFrontendHost.setPreference("disable-locale-info-bar", "true");
            InspectorFrontendHost.getPreference("language", (value) => {
              resolve({ ok: value === ${JSON.stringify(stored)}, value });
            });
            return;
          }
        } catch (error) {
          resolve({ ok: false, reason: String(error) });
          return;
        }
        if (Date.now() - started > 3_000) {
          resolve({ ok: false, reason: "front-end host not ready" });
          return;
        }
        setTimeout(attempt, 50);
      };
      attempt();
    })`), 6_000, "devtools language preference")) as { ok?: boolean } | undefined;
    written = result?.ok === true;
  } catch {
    // An unprimed front-end still opens; the language bar is cosmetic.
  } finally {
    try {
      contents.closeDevTools();
    } catch {
      // The page navigated out from under the primer.
    }
    try {
      host.contentView.removeChildView(primer);
    } catch {
      // Already detached with its parent.
    }
    if (!primer.webContents.isDestroyed()) primer.webContents.close();
    // Closing the primer is asynchronous; opening the real front-end in the
    // same tick races the old renderer's teardown.
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return written;
}
