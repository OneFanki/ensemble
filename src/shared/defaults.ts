import type { AppSettings } from "@shared/types";
import { DEFAULT_NEW_TAB_BACKDROP } from "./newtab";
import { DEFAULT_SEARCH_ENGINE_ID } from "./search";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  locale: "zh",
  // The browser is the default page: it is where the work happens, and every
  // other page is a management view the user returns from.
  lastView: "browser",
  // Off by default: an upgrade that suddenly opens several browsers on first
  // launch looks like a malfunction, and it slows startup down.
  restoreLastView: false,
  overlayEnabled: true,
  // Desktop UA by default: a background check should look like the user's own
  // browser, not like a crawler.
  headlessCheckUa: "desktop",
  focusLabelEnabled: true,
  launchIntervalMs: 0,
  layout: "2x2",
  // The built-in surface is the default: it keeps every account in one window,
  // which is the whole point. Switching to external is one click in the title bar.
  launchTarget: "embedded",
  autoFillOnLaunch: true,
  // 100% is what a site expects; the setting exists for high-DPI screens and
  // small laptops, not as something to tune up front.
  browserZoom: 100,
  // Bing by default: reachable from networks where Google is not, which for a
  // work tool matters more than index quality.
  searchEngineId: DEFAULT_SEARCH_ENGINE_ID,
  customSearchEngines: [],
  newTabBackground: DEFAULT_NEW_TAB_BACKDROP,
  newTabBookmarks: true,
  closeToTray: true,
  onboardingVersion: 0,
  // A quiet background check keeps users on current builds without nagging:
  // only a newer version with published notes produces a prompt, and postponing
  // one version silences it until the next.
  autoCheckUpdates: true,
};

export const ROLE_COLORS = ["amber", "teal", "violet", "rose", "blue", "slate"] as const;

export const MAX_IDENTITIES_PER_SCENE = 8;
