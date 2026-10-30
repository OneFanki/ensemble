import type { AppSettings } from "@shared/types";

/**
 * The in-app guide: what this app is for, and the shortest path to using it.
 *
 * Separate from the guided tour (`tourSteps.ts`) on purpose, because they answer
 * different questions and fail in different ways:
 *
 * - The tour points at live controls on the real UI, so it can never be shown to
 *   someone who is not already in the app, and a person who clicks through it
 *   without reading learns only where things are.
 * - This guide is a page of its own: a few short sentences and one diagram of
 *   the minimum path, readable in a minute, and possible to come back to without
 *   walking through anything.
 *
 * The tour is still the first-run experience — it is the only thing that gets a
 * brand-new user from an empty workspace to a first launch. This page is what
 * answers "what is this and what is the least I have to do", and it is what the
 * tour's last step points at.
 *
 * ## Why the first screen is only two things
 *
 * The core path and the AI path are the two things that decide whether the app
 * makes sense at all: without the first, nothing can be tried; without the
 * second, a user does by hand what the product exists to automate. Everything
 * else (what a view is for, tags, flows, the run dock) is optional and lives
 * behind the section list, because a wall of features on first open reads as
 * "this is complicated" rather than "this is capable".
 */
export const GUIDE_VERSION = 1;

/** One section of the guide; `core` sections are shown on the first screen. */
export interface GuideSection {
  id: "path" | "ai" | "views" | "tabs" | "tags" | "flows" | "browser";
  /** Grouping in the side list; only "core" is open by default. */
  group: "core" | "optional";
  titleKey: string;
  bodyKey: string;
}

/**
 * The minimum path, as steps rather than prose.
 *
 * Rendered as a numbered diagram, so this list is the diagram's data — one entry
 * per box. Kept to three because a fourth step turns "the shortest path" into a
 * procedure, and the whole point is that it can be memorised.
 */
export interface GuidePathStep {
  /** Title the user sees in the box. */
  titleKey: string;
  /** One line under it. */
  hintKey: string;
}

export const GUIDE_PATH_STEPS: GuidePathStep[] = [
  { titleKey: "app.guideStepSite", hintKey: "app.guideStepSiteHint" },
  { titleKey: "app.guideStepAccount", hintKey: "app.guideStepAccountHint" },
  { titleKey: "app.guideStepLaunch", hintKey: "app.guideStepLaunchHint" },
];

export const GUIDE_SECTIONS: GuideSection[] = [
  { id: "path", group: "core", titleKey: "app.guidePathTitle", bodyKey: "app.guidePathBody" },
  { id: "ai", group: "core", titleKey: "app.guideAiTitle", bodyKey: "app.guideAiBody" },
  { id: "views", group: "optional", titleKey: "app.guideViewsTitle", bodyKey: "app.guideViewsBody" },
  { id: "tabs", group: "optional", titleKey: "app.guideTabsTitle", bodyKey: "app.guideTabsBody" },
  { id: "tags", group: "optional", titleKey: "app.guideTagsTitle", bodyKey: "app.guideTagsBody" },
  { id: "flows", group: "optional", titleKey: "app.guideFlowsTitle", bodyKey: "app.guideFlowsBody" },
  {
    id: "browser",
    group: "optional",
    titleKey: "app.guideBrowserTitle",
    bodyKey: "app.guideBrowserBody",
  },
];

/** Marks the guide as read, so the title-bar dot goes away. */
export function guideIsUnread(settings: Pick<AppSettings, "guideVersion">): boolean {
  return (settings.guideVersion ?? 0) < GUIDE_VERSION;
}
