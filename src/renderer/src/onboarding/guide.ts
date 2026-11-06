import type { AppSettings } from "@shared/types";

/**
 * The in-app guide: what this app is for, and the shortest path to using it.
 *
 * This is both the first-run screen and the handbook. It is a page of its own:
 * a few short sentences and one diagram of the minimum path, readable in a
 * minute, and possible to come back to without walking through anything.
 *
 * It replaced a spotlight tour that pointed at live controls. That shape failed
 * twice: the controls it pointed at kept moving, and a sequence of callouts
 * teaches where a button is without ever saying what the product is for. One
 * page answers both, and there is only one introduction to keep current.
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
