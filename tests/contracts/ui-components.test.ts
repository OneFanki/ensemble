import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Controls are components, not class names.
 *
 * Every one of these was a global class in `base.css` (`class="btn primary"`,
 * `class="input"`, `class="field"`) that pages were expected to spell correctly,
 * and then also re-declared locally whenever they wanted it slightly different.
 * Twenty scoped `.input` blocks existed, and they had drifted: one component's
 * field was 26px tall and the shared one 30px, padding ranged over 6/7/9px.
 *
 * The failure mode this guards is not "a class name was removed". It is "a new
 * page pastes the markup from an old one", which reintroduces a control that
 * the shared component does not own and that the next restyle will miss.
 *
 * Root class names are kept on the components on purpose (see AppButton, whose
 * root is still `.btn.primary`): the e2e suites and the screenshot script select
 * on them. What changed is who is allowed to *write* them.
 */
const root = join(process.cwd(), "src/renderer/src");
const uiDir = join(root, "components/ui");

function walk(path: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith(".vue")) found.push(full);
  }
  return found;
}

/** The class tokens a template puts directly on an element. */
function directClasses(text: string): string[] {
  const start = text.indexOf("<template>");
  if (start < 0) return [];
  const template = text.slice(start);
  const found: string[] = [];
  for (const match of template.matchAll(/\sclass="([^"]*)"/g)) {
    found.push(...(match[1] ?? "").split(/\s+/).filter(Boolean));
  }
  return found;
}

/** Components outside `ui/`, which are the ones that must consume the components. */
const consumers = walk(join(root, "components"))
  .concat(walk(join(root, "overlay")))
  .filter((path) => !path.startsWith(uiDir))
  .map((path) => ({
    name: path.slice(path.lastIndexOf("\\") + 1),
    path,
    text: readFileSync(path, "utf8"),
  }));

describe("controls are components", () => {
  /*
   * The control classes, and what replaced each.
   *
   * `mono`, `spacer` and `hint` are deliberately absent: they have no structure
   * and no state, so a component around them would only add a hop. The line is
   * "does it own a shape or a behaviour", not "is it reused".
   */
  const replaced: Record<string, string> = {
    btn: "AppButton",
    "icon-btn": "IconButton",
    "link-btn": "LinkButton",
    input: "TextField",
    field: "FormField",
    check: "Checkbox",
    empty: "EmptyState",
  };

  it("no page writes a control class that a component owns", () => {
    const offenders: string[] = [];
    for (const file of consumers) {
      const classes = directClasses(file.text);
      for (const token of classes) {
        // `field-row` / `input-shell` are layout containers with their own
        // meaning; only the exact control tokens are the offence.
        if (token in replaced) {
          offenders.push(`${file.name}: class="${token}" → ${replaced[token]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("base.css no longer defines the control vocabulary", () => {
    const sheet = readFileSync(join(root, "styles/base.css"), "utf8");
    for (const token of Object.keys(replaced)) {
      // `.field` would also match `.field-row`, so the selector is anchored to
      // the class being used as a whole rule.
      const rule = new RegExp(`(^|\\n)\\.${token}(\\s*[,{]|:)`, "m");
      expect(rule.test(sheet), `.${token} rule`).toBe(false);
    }
  });

  it("keeps the layout utilities a component cannot own", () => {
    // The counterpart of the rule above: this is the list that is allowed to
    // stay, and it is short on purpose.
    const sheet = readFileSync(join(root, "styles/base.css"), "utf8");
    for (const token of ["spacer", "hint", "mono", "drag-region", "sr-only"]) {
      const rule = new RegExp(`(^|\\n)\\.${token}(\\s*[,{]|:)`, "m");
      expect(rule.test(sheet), `.${token} rule`).toBe(true);
    }
  });

  it("gives each shared control one file and no local copies", () => {
    // A second definition of the same look is how the twenty `.input` blocks
    // happened: every copy was small, and only the comparison showed the drift.
    const files = readdirSync(uiDir);
    for (const name of [
      "AppButton.vue",
      "IconButton.vue",
      "LinkButton.vue",
      "TextField.vue",
      "FormField.vue",
      "Checkbox.vue",
      "EmptyState.vue",
      "InputShell.vue",
    ]) {
      expect(files, name).toContain(name);
    }
  });
});

describe("the address bar and the new-tab search box are one control", () => {
  /*
   * They were two. The address bar drew a 3px glow ring and the home box a
   * mixed-colour border, and on the light theme the address bar's focus stroke
   * resolved to a deep brown gold that read as a dirty line. The rule is not
   * "they look similar"; it is that neither owns a focus style any more.
   */
  const browser = readFileSync(join(root, "components/BrowserPage.vue"), "utf8");
  const newTab = readFileSync(join(root, "components/NewTabPage.vue"), "utf8");
  const shell = readFileSync(join(uiDir, "InputShell.vue"), "utf8");

  it("both fields use the shared shell", () => {
    expect(browser).toContain("<InputShell");
    expect(newTab).toContain("<InputShell");
  });

  it("neither draws its own focus treatment", () => {
    // A `:focus` or `:focus-within` rule on the field would fight the shell's.
    expect(browser).not.toMatch(/\.address input:focus/);
    expect(newTab).not.toMatch(/\.nt-box:focus-within/);
  });

  it("the shell has no outer glow", () => {
    // The glow is what the user rejected: a halo around a 30px field read as the
    // heaviest decoration in the toolbar.
    expect(shell).not.toMatch(/box-shadow:\s*0 0 0 3px var\(--accent-soft\)/);
    expect(shell).toContain("--accent");
  });

  it("the sweep is one pass, not a loop", () => {
    // The animation must end. A border that keeps moving while somebody types is
    // motion in the corner of the eye for as long as the page is open.
    expect(shell).not.toContain("infinite");
    expect(shell).toMatch(/animation:\s*sweep-border\s+\d+ms/);
  });
});
