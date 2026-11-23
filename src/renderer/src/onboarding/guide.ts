import { GUIDE_VERSION } from "@shared/guide";
import type { AppSettings } from "@shared/types";

export { GUIDE_VERSION };

/**
 * The in-app guide: what this app is for, and the shortest path to using it.
 *
 * This is both the first-run experience and the handbook. It is a sequence of
 * pages, each one a full-width panel with a looping diagram on the left and a
 * few sentences on the right. The shape is deliberate: the previous version was
 * a two-column dialog with a table of contents, which read as documentation —
 * correct, but dull, and it made the product look smaller than it is. A person
 * opening this app for the first time is deciding whether it is worth their
 * afternoon; a page that looks like a settings screen answers "no".
 *
 * ## Order of the story
 *
 * The order is the order a new user needs it, which is not the order of the
 * feature list:
 *
 * 1. **It is a browser.** Not a dashboard, not a test runner. That has to land
 *    first or everything after it sounds like a special-purpose tool.
 * 2. **Every tab is isolated, so several accounts can be present at once.** This
 *    is the one idea the whole product rests on.
 * 3. **Accounts sign in with one click.** The account is the concrete thing a
 *    new user can act on; the vocabulary lesson it replaced read as setup
 *    instructions and got skipped.
 * 4. **Side-by-side comparison of one system across roles.** Why isolation
 *    matters — the thing you actually came to do.
 * 5. **The AI connects over MCP** and drives these pages.
 * 6. **What the AI can do**, including the part people do not expect: it keeps
 *    working with the UI shut.
 * 7. **Developer tools**: device emulation and the performance monitor.
 * 8. **Where to find this again.**
 *
 * An earlier version led with "create a site, add accounts, launch". That is the
 * setup cost of the product, not its purpose, and it made the app look like a
 * multi-account browser with an assistant bolted on.
 *
 * ## Text budget
 *
 * A page gets a headline, one paragraph, and at most three short bullets. If a
 * page needs more than that, the feature belongs in the section list at the end
 * rather than in the sequence — the sequence is read once, standing up, and
 * anything longer gets skipped.
 */
/** Which diagram a page draws. One component per id, resolved in the dialog. */
export type GuideScene =
  | "isolation"
  | "accounts"
  | "compare"
  | "mcp"
  | "aiActs"
  | "headless"
  | "devtools"
  | "reopen";

/** One page of the tour. */
export interface GuidePage {
  id: GuideScene;
  titleKey: string;
  bodyKey: string;
  /**
   * Short bullets shown under the paragraph. Optional: a page whose idea is one
   * sentence should not be padded to three.
   */
  bullets?: Array<{ titleKey: string; hintKey?: string }>;
}

export const GUIDE_PAGES: GuidePage[] = [
  {
    id: "isolation",
    titleKey: "app.guidePageIsolationTitle",
    bodyKey: "app.guidePageIsolationBody",
    bullets: [
      { titleKey: "app.guidePageIsolationBullet1" },
      { titleKey: "app.guidePageIsolationBullet2" },
    ],
  },
  {
    id: "accounts",
    titleKey: "app.guidePageAccountsTitle",
    bodyKey: "app.guidePageAccountsBody",
    bullets: [
      { titleKey: "app.guidePageAccountsBullet1" },
      { titleKey: "app.guidePageAccountsBullet2" },
    ],
  },
  {
    id: "compare",
    titleKey: "app.guidePageCompareTitle",
    bodyKey: "app.guidePageCompareBody",
    bullets: [{ titleKey: "app.guidePageCompareBullet1" }],
  },
  {
    id: "mcp",
    titleKey: "app.guidePageMcpTitle",
    bodyKey: "app.guidePageMcpBody",
    bullets: [
      { titleKey: "app.guidePageMcpBullet1" },
      { titleKey: "app.guidePageMcpBullet2" },
    ],
  },
  {
    id: "aiActs",
    titleKey: "app.guidePageActsTitle",
    bodyKey: "app.guidePageActsBody",
    bullets: [
      { titleKey: "app.guidePageActsBullet1" },
      { titleKey: "app.guidePageActsBullet2" },
      { titleKey: "app.guidePageActsBullet3" },
    ],
  },
  {
    id: "headless",
    titleKey: "app.guidePageHeadlessTitle",
    bodyKey: "app.guidePageHeadlessBody",
    bullets: [
      { titleKey: "app.guidePageHeadlessBullet1" },
      { titleKey: "app.guidePageHeadlessBullet2" },
    ],
  },
  {
    id: "devtools",
    titleKey: "app.guidePageDevtoolsTitle",
    bodyKey: "app.guidePageDevtoolsBody",
    bullets: [
      { titleKey: "app.guidePageDevtoolsBullet1" },
      { titleKey: "app.guidePageDevtoolsBullet2" },
    ],
  },
  {
    id: "reopen",
    titleKey: "app.guidePageReopenTitle",
    bodyKey: "app.guidePageReopenBody",
  },
];

/** Marks the guide as read, so the title-bar dot goes away. */
export function guideIsUnread(settings: Pick<AppSettings, "guideVersion">): boolean {
  return (settings.guideVersion ?? 0) < GUIDE_VERSION;
}
