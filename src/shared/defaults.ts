import type { AppSettings } from "@shared/types";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  locale: "zh",
  lastView: "identities",
  // Off by default: an upgrade that suddenly opens several browsers on first
  // launch looks like a malfunction, and it slows startup down.
  restoreLastScene: false,
  overlayEnabled: true,
  // Desktop UA by default: a background check should look like the user's own
  // browser, not like a crawler.
  headlessCheckUa: "desktop",
  focusLabelEnabled: true,
  launchIntervalMs: 0,
  layout: "2x2",
  autoFillOnLaunch: true,
  closeToTray: true,
  onboardingVersion: 0,
  // A quiet background check keeps users on current builds without nagging:
  // only a newer version with published notes produces a prompt, and postponing
  // one version silences it until the next.
  autoCheckUpdates: true,
};

export const ROLE_COLORS = ["amber", "teal", "violet", "rose", "blue", "slate"] as const;

export const MAX_IDENTITIES_PER_SCENE = 8;
