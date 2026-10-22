import type { AppSettings } from "@shared/types";

/** Bump when the step list changes so existing installs see the new tour once. */
export const TOUR_VERSION = 1;

export type TourView = "browser" | "sites" | "identities" | "views";

export interface TourStep {
  id: string;
  /** Switch to this view before measuring the target. */
  view?: TourView;
  target: string;
  titleKey: string;
  bodyKey: string;
  placement?: "top" | "bottom" | "left" | "right";
}

/**
 * Seven steps, no settings page: the tour ends on the run dock after the view
 * explanation. Settings remains reachable through the side rail.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    target: '[data-tour="brand"]',
    titleKey: "app.tourWelcomeTitle",
    bodyKey: "app.tourWelcomeBody",
    placement: "bottom",
  },
  {
    id: "site-switcher",
    target: '[data-tour="site-switcher"]',
    titleKey: "app.tourSiteSwitcherTitle",
    bodyKey: "app.tourSiteSwitcherBody",
    placement: "bottom",
  },
  {
    id: "side-nav",
    target: '[data-tour="side-nav"]',
    titleKey: "app.tourSideNavTitle",
    bodyKey: "app.tourSideNavBody",
    placement: "right",
  },
  {
    id: "new-site",
    view: "sites",
    target: '[data-tour="new-site"]',
    titleKey: "app.tourNewSiteTitle",
    bodyKey: "app.tourNewSiteBody",
    placement: "bottom",
  },
  {
    id: "new-identity",
    view: "identities",
    target: '[data-tour="new-identity"]',
    titleKey: "app.tourNewIdentityTitle",
    bodyKey: "app.tourNewIdentityBody",
    placement: "bottom",
  },
  {
    id: "new-view",
    view: "views",
    target: '[data-tour="new-view"]',
    titleKey: "app.tourNewViewTitle",
    bodyKey: "app.tourNewViewBody",
    placement: "bottom",
  },
  {
    id: "run-dock",
    target: '[data-tour="run-dock"]',
    titleKey: "app.tourRunDockTitle",
    bodyKey: "app.tourRunDockBody",
    placement: "left",
  },
];

export function shouldAutoStartTour(settings: Pick<AppSettings, "onboardingVersion">): boolean {
  return (settings.onboardingVersion ?? 0) < TOUR_VERSION;
}
