import type { AppSettings, BrowserProfile } from "@shared/types";
import {
  EMBEDDED_CLEAN_PROFILE_ID,
  EMBEDDED_DEFAULT_PROFILE_ID,
  PERF_SAMPLE_INTERVAL_DEFAULT_MS,
  PERF_WINDOW_DEFAULT_MS,
} from "./embedded";
import { DEFAULT_NEW_TAB_BACKDROP } from "./newtab";
import { DEFAULT_SEARCH_ENGINE_ID } from "./search";

/**
 * The two profiles the app ships with.
 *
 * A plain array rather than only defaults on `AppSettings`, because the loader
 * needs to re-insert these into a settings file that was written before profiles
 * existed — or that lost one to a hand edit. Deleting "default" would leave no
 * landing place for a bookmark, so it is not offered.
 */
export const BUILTIN_PROFILES: BrowserProfile[] = [
  {
    id: EMBEDDED_DEFAULT_PROFILE_ID,
    name: "默认档案",
    retention: "persist",
    builtin: true,
  },
  {
    id: EMBEDDED_CLEAN_PROFILE_ID,
    name: "干净会话",
    retention: "ephemeral",
    builtin: true,
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  // Follow the OS. A hardcoded default is a hardcoded opinion, and the app has
  // no business deciding which language its user reads.
  locale: "system",
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
  /*
   * No layout by default.
   *
   * Both entry points that use this — "create view" and batch launch — start
   * with one page, and a 2×2 meant that page sat in a quarter of the stage
   * beside three empty cells. The default should be the neutral one: the user
   * picks a layout when they are arranging several accounts, not before they
   * have any.
   */
  layout: "free",
  // Nothing has been chosen yet, so the factory value above stays authoritative.
  layoutExplicit: false,
  autoFillOnLaunch: true,
  // Submitting is what turns a filled form into a signed-in session; leaving it
  // off parks every launch one click short of useful.
  autoSubmitLogin: true,
  // 100% is what a site expects; the setting exists for high-DPI screens and
  // small laptops, not as something to tune up front.
  browserZoom: 100,
  // Two profiles to start: the everyday one holding real logins, and a
  // throwaway. Everything else the user adds themselves — most people only ever
  // need the first.
  profiles: BUILTIN_PROFILES.map((profile) => ({ ...profile })),
  defaultProfileId: EMBEDDED_DEFAULT_PROFILE_ID,
  // Adaptive: pages fill their cell. A fixed default would be a layout opinion
  // applied to every account at once, which is exactly what a first launch
  // cannot know.
  browserViewport: null,
  // Five readings a second and a twenty-second chart: fine enough that a 200ms
  // stutter has a visible shape, wide enough to show a burst rather than one
  // sample. Both are adjustable in settings for the other two cases — a slow
  // climb wants a longer window, a one-off hitch wants a finer interval.
  perfWindowMs: PERF_WINDOW_DEFAULT_MS,
  perfSampleIntervalMs: PERF_SAMPLE_INTERVAL_DEFAULT_MS,
  // Bing by default: reachable from networks where Google is not, which for a
  // work tool matters more than index quality.
  searchEngineId: DEFAULT_SEARCH_ENGINE_ID,
  customSearchEngines: [],
  newTabBackground: DEFAULT_NEW_TAB_BACKDROP,
  newTabBookmarks: true,
  closeToTray: true,
  // Unread on a fresh install: the dot on the title bar is how the guide is
  // discovered in the first place.
  guideVersion: 0,
  // A quiet background check keeps users on current builds without nagging:
  // only a newer version with published notes produces a prompt, and postponing
  // one version silences it until the next.
  autoCheckUpdates: true,
  // Follow the OS. A browser does, and so does everything else on the machine —
  // a user who turned on Clash expects the app to be covered by it without
  // configuring the proxy twice.
  proxyMode: "system",
  proxyBypass: "localhost, 127.0.0.1, ::1",
};

export const ROLE_COLORS = ["amber", "teal", "violet", "rose", "blue", "slate"] as const;

export const MAX_IDENTITIES_PER_SCENE = 8;
