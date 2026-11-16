import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_PAGES, GUIDE_VERSION } from "../../src/renderer/src/onboarding/guide";
import { messages } from "../../src/renderer/src/i18n/messages";

/**
 * The guide has to describe the app that exists.
 *
 * Docs drift is usually invisible: prose that names a control nobody can find
 * renders fine, passes every check, and leaves the reader hunting. The guide had
 * exactly that — it told people to allow a page's origin "with the shield button
 * in the toolbar", and that button had been merged into the AI entry. The
 * sentence survived because nothing was checking it.
 *
 * These are consistency checks between the guide's own parts and between the
 * guide and the message table. They cannot prove the prose is true — that is
 * what the code review behind the copy is for — but they catch the mechanical
 * failures: a page whose keys do not exist, copy that points at a missing
 * control, and a page order that has drifted back to the old story.
 */
const GUIDE_VUE = readFileSync(
  join(process.cwd(), "src", "renderer", "src", "components", "GuideDialog.vue"),
  "utf8",
);

/** Every string directly under a locale's `app` namespace. */
function appStrings(locale: "zh" | "en"): Record<string, string> {
  const app = (messages[locale] as { app: Record<string, unknown> }).app;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(app)) {
    if (typeof value === "string") out[`app.${key}`] = value;
  }
  return out;
}

describe("the guide describes the app that exists", () => {
  it("has a key for every page, bullet and scene label", () => {
    for (const locale of ["zh", "en"] as const) {
      const strings = appStrings(locale);
      for (const page of GUIDE_PAGES) {
        expect(strings[page.titleKey], `${locale}: ${page.titleKey}`).toBeTypeOf("string");
        expect(strings[page.bodyKey], `${locale}: ${page.bodyKey}`).toBeTypeOf("string");
        for (const bullet of page.bullets ?? []) {
          expect(strings[bullet.titleKey], `${locale}: ${bullet.titleKey}`).toBeTypeOf("string");
        }
      }
      // The scenes are components, so their labels are not reachable from the
      // page data — they are checked by name here, which is what fails when one
      // is renamed without touching the scene that draws it.
      for (const key of [
        "guideSceneIsolationAlt",
        "guideSceneSystemsAlt",
        "guideSceneCompareAlt",
        "guideSceneMcpAlt",
        "guideSceneActsAlt",
        "guideSceneHeadlessAlt",
        "guideSceneDevtoolsAlt",
        "guideSceneReopenAlt",
      ]) {
        expect(strings[`app.${key}`], `${locale}: ${key}`).toBeTypeOf("string");
      }
    }
  });

  it("does not point at the shield button that no longer exists", () => {
    // The shield was merged into the AI entry; the guide kept telling people to
    // use it. Fixing the copy once is not enough — the phrase must be gone in
    // both languages, because either one can be reintroduced by an edit.
    for (const locale of ["zh", "en"] as const) {
      for (const [key, value] of Object.entries(appStrings(locale))) {
        expect(value, `${locale}: ${key}`).not.toMatch(/盾牌/);
        expect(value, `${locale}: ${key}`).not.toMatch(/shield button/i);
      }
    }
  });

  it("names the AI entry where it actually is", () => {
    // The entry sits at the right end of the toolbar, not in a status bar.
    const zh = appStrings("zh");
    const en = appStrings("en");
    expect(zh["app.guidePageReopenBody"]).toContain("工具栏");
    expect(zh["app.guidePageReopenBody"]).not.toMatch(/底栏/);
    expect(en["app.guidePageReopenBody"]).toContain("toolbar");
    expect(en["app.guidePageReopenBody"]).not.toMatch(/status bar/i);
  });

  it("starts from 'it is a browser', not from site setup", () => {
    // The order is the argument. An earlier revision opened on "create a site",
    // which is the setup cost of the product rather than what it is; a later
    // edit that moves a site page to the front would undo the rewrite silently.
    const ids = GUIDE_PAGES.map((page) => page.id);
    expect(ids[0]).toBe("isolation");
    expect(ids.indexOf("twoSystems")).toBeLessThan(ids.indexOf("mcp"));
    expect(ids.indexOf("compare")).toBeLessThan(ids.indexOf("mcp"));
  });

  it("gives the headless and developer pages their own beat", () => {
    // Both were missing from the previous guide and are the reasons this product
    // is not just a multi-account browser: the AI keeps working with no window,
    // and the developer panels are docked beside the page.
    const ids = GUIDE_PAGES.map((page) => page.id);
    expect(ids).toContain("headless");
    expect(ids).toContain("devtools");
  });

  it("mounts a scene for every page id", () => {
    // `SCENES` is a `Record<GuideScene, …>`, so TypeScript catches a missing id —
    // this catches the other direction: a page added to the data with no scene
    // resolved here would render an empty stage.
    for (const page of GUIDE_PAGES) {
      expect(GUIDE_VUE, `scene for ${page.id}`).toContain(`Scene`);
      expect(GUIDE_VUE).toMatch(new RegExp(`${page.id}:\\s*Scene`));
    }
  });

  it("keeps each page's body within a readable measure", () => {
    // A page is read standing up. Past ~220 characters the paragraph stops being
    // glanced at and starts being scrolled, which is the failure this layout
    // exists to avoid.
    for (const locale of ["zh", "en"] as const) {
      const strings = appStrings(locale);
      for (const page of GUIDE_PAGES) {
        const body = strings[page.bodyKey] ?? "";
        expect(body.length, `${locale}: ${page.bodyKey} is ${body.length} chars`).toBeLessThan(320);
      }
    }
  });

  it("bumps the version when the content changes", () => {
    // Read-on-open means a stale `guideVersion` in someone's settings is the only
    // thing keeping them from seeing the rewrite.
    expect(GUIDE_VERSION).toBeGreaterThanOrEqual(4);
  });

  it("plays each diagram's entrance once instead of looping the whole scene", () => {
    // The failure this guards is subtle and was shipped: every animation used
    // `infinite`, so each scene rebuilt itself from `opacity: 0` every cycle.
    // A still screenshot looked perfect; on screen the illustration blanked out
    // every few seconds. Only elements that mean "still happening" may loop, and
    // they are listed by name here so a new scene has to think about it.
    const sceneDir = join(process.cwd(), "src", "renderer", "src", "components", "guide");
    const scenes = readdirSync(sceneDir).filter((f) => f.endsWith(".vue"));
    expect(scenes.length).toBeGreaterThanOrEqual(8);

    /** The selectors allowed to loop, per scene file, and why. */
    const LOOPS: Record<string, string[]> = {
      // A heartbeat: the point of the page is that work continues.
      "SceneHeadless.vue": ["trace-pulse"],
      // Traffic on an established connection never stops.
      "SceneMcp.vue": ["packet", "spark"],
      // Three actions taking turns is the content, not the entrance.
      "SceneAiActs.vue": ["beat", "scan", "read-tag", "cursor", "click-ring"],
    };

    for (const file of scenes) {
      const css = readFileSync(join(sceneDir, file), "utf8");
      const allowed = LOOPS[file] ?? [];
      // Split on rule boundaries so each `animation-*`/`animation:` declaration can
      // be attributed to the selector that owns it.
      for (const block of css.split("}")) {
        if (!/animation[^;]*infinite/.test(block)) continue;
        const selector = block.split("{")[0]?.trim() ?? "";
        const looping = allowed.some((name) => selector.includes(name));
        expect(looping, `${file}: "${selector}" loops but is not a listed continuous motion`).toBe(
          true,
        );
      }
    }
  });

  it("lets the dialog own the stage size for every scene", () => {
    // Scene root styles used to set `width: 100%; height: auto`, which made the
    // eight pages sit at different heights and left the shorter diagrams floating
    // in their half. Sizing now lives in GuideDialog's `:deep(.scene)` rule; a
    // scene that reintroduces its own width will break the shared stage again.
    expect(GUIDE_VUE).toContain(":deep(.scene)");
    const sceneDir = join(process.cwd(), "src", "renderer", "src", "components", "guide");
    for (const file of readdirSync(sceneDir).filter((f) => f.endsWith(".vue"))) {
      const css = readFileSync(join(sceneDir, file), "utf8");
      const root = /\.scene\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
      expect(root, `${file}: .scene should not set width`).not.toMatch(/width\s*:/);
    }
  });
});
