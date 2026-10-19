import type { AppSettings } from "@shared/types";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  locale: "zh",
  lastView: "identities",
  layout: "2x2",
  autoFillOnLaunch: true,
};

export const ROLE_COLORS = ["amber", "teal", "violet", "rose", "blue", "slate"] as const;

export const LAYOUTS = ["1x1", "2x1", "2x2", "3x1"] as const;

export const MAX_IDENTITIES_PER_SCENE = 8;
