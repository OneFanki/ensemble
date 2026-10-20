import type { AppSettings } from "@shared/types";

/** Bump when the step list changes so existing installs see the new tour once. */
export const TOUR_VERSION = 1;

export type TourView = "environments" | "identities" | "scenes";

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
 * Seven steps, no settings page: the tour ends on the run dock after the scene
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
    id: "environment-switcher",
    target: '[data-tour="environment-switcher"]',
    titleKey: "app.tourEnvSwitcherTitle",
    bodyKey: "app.tourEnvSwitcherBody",
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
    id: "new-environment",
    view: "environments",
    target: '[data-tour="new-environment"]',
    titleKey: "app.tourNewEnvironmentTitle",
    bodyKey: "app.tourNewEnvironmentBody",
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
    id: "new-scene",
    view: "scenes",
    target: '[data-tour="new-scene"]',
    titleKey: "app.tourNewSceneTitle",
    bodyKey: "app.tourNewSceneBody",
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
