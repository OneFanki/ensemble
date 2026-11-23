import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every entrance has an exit.
 *
 * The failure this guards shipped and was reported directly: panels appeared
 * with a motion and closed with an instant unmount, because the entrance hung
 * off the panel's own CSS class (`animation: xxx-in`) while nothing kept the
 * element mounted on the way out. Half the app felt broken in one direction
 * only — the worst kind of inconsistency, because it reads as a bug rather
 * than a style.
 *
 * The rule the components now follow has two shapes, and both are allowed:
 *
 * 1. **Vue-owned** — the panel sits in a `<Transition name="x">`, the entrance
 *    is declared on `.x-enter-active`, and a `.x-leave-active` carries the exit.
 * 2. **Self-owned** — the component manages its own closing state (Modal,
 *    ConfirmDialog) and declares both an `xxx-in` and an `xxx-out` keyframe.
 *
 * What is not allowed is the old shape: an entrance keyframe declared on a
 * rule that is not an enter class, with no exit keyframe in the file.
 *
 * Guide scenes are exempt: their animations are diagram choreography (the
 * content of the page, not the lifecycle of a layer), and looping indicators
 * (`ai-breathe`, spinners) are state, not entrances. The overlay pages
 * (`overlay/`) are exempt too: their entrance animates the page load, and the
 * only way one closes is the OS window being destroyed — there is no in-page
 * exit to animate.
 */
const dirs = ["components", "components/ui"].map((dir) =>
  join(process.cwd(), "src", "renderer", "src", dir),
);

function vueFiles(): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".vue")) found.push(join(dir, name));
    }
  }
  return found;
}

/** `animation:` shorthand declarations, with the rule each one lives in. */
function animationDeclarations(css: string): Array<{ name: string; selector: string }> {
  const out: Array<{ name: string; selector: string }> = [];
  for (const block of css.split("}")) {
    const match = /animation:\s*([a-z][\w-]*)/i.exec(block);
    if (!match) continue;
    const selector = (block.split("{")[0] ?? "").trim();
    out.push({ name: match[1]!, selector });
  }
  return out;
}

describe("every entrance has an exit", () => {
  // Guide scenes draw diagram choreography: their entrances are the content of
  // the page (a fence drawing itself, a row landing in its beat), not the
  // lifecycle of a layer, and none of them unmounts mid-motion.
  const files = vueFiles().filter((path) => !path.includes("components\\guide"));

  it("keeps an exit beside every Vue-owned entrance", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const css = readFileSync(path, "utf8");
      const name = path.slice(path.lastIndexOf("\\") + 1);
      // Each Transition name used in the template must have a leave rule.
      // Bound names (`:name="…"`) are skipped: the classes they resolve to are
      // chosen at runtime and cannot be matched statically.
      for (const match of css.matchAll(/<Transition(?:Group)?\s[^>]*?\sname="([\w-]+)"/g)) {
        const transition = match[1]!;
        const leave = new RegExp(`\\.${transition}-leave-active\\s*\\{`);
        expect(leave.test(css), `${name}: <Transition name="${transition}"> has no .${transition}-leave-active`).toBe(true);
      }
      // An entrance keyframe may only be declared from an enter class, unless
      // the file also declares its exit keyframe (the self-owned shape).
      for (const { name: kf, selector } of animationDeclarations(css)) {
        if (!kf.endsWith("-in")) continue;
        const isEnterRule = /-enter-active/.test(selector);
        const hasExit = css.includes(`@keyframes ${kf.replace(/-in$/, "-out")}`);
        if (!isEnterRule && !hasExit) {
          offenders.push(`${name}: ${selector} animates ${kf} with no exit`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the enter class of a transition inside the same file", () => {
    // A Transition whose enter class exists but whose enter animation was
    // deleted degrades to an instant appearance — the inverse of the reported
    // bug, and just as unwelcome.
    const offenders: string[] = [];
    for (const path of files) {
      const css = readFileSync(path, "utf8");
      const name = path.slice(path.lastIndexOf("\\") + 1);
      for (const match of css.matchAll(/<Transition(?:Group)?\s[^>]*?\sname="([\w-]+)"/g)) {
        const transition = match[1]!;
        // The enter class may carry an animation or a transition — both are
        // real entrances; the failure is a class with neither.
        const enter = new RegExp(`\\.${transition}-enter-active\\s*\\{[^}]*(animation|transition)`);
        expect(
          enter.test(css),
          `${name}: <Transition name="${transition}"> enter class carries no motion`,
        ).toBe(true);
      }
    }
    expect(offenders).toEqual([]);
  });
});
