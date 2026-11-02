import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";
import { messages, type Locale } from "../src/renderer/src/i18n/messages";

/** Every `.vue` / `.ts` file under a directory, recursively. */
function walkSources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walkSources(full));
    else if (full.endsWith(".vue") || full.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * Every message is compiled the first time it is translated, and a compile
 * error throws instead of falling back to the key. That makes a bad string a
 * rendering failure rather than a cosmetic one: a literal `{{变量}}` inside a
 * message is parsed as a nested placeholder, so the component that shows it
 * renders nothing but its backdrop — which is exactly how the flow editor
 * shipped broken once. Running every string through the compiler is the only
 * check that catches it before a user opens that page.
 *
 * `messages` is imported directly (not through the app's i18n module) so this
 * runs in the node test environment without a DOM.
 */
const LOCALES: Locale[] = ["zh", "en"];

const i18n = createI18n({
  legacy: false,
  locale: "zh",
  fallbackLocale: "zh",
  messages,
});

/** Leaf keys of a message tree, as dot paths (`app.flowStepValue`). */
function leafKeys(tree: unknown, prefix = ""): string[] {
  if (typeof tree === "string") return [prefix];
  if (!tree || typeof tree !== "object") return [];
  return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
    leafKeys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("messages", () => {
  for (const locale of LOCALES) {
    it(`compiles every ${locale} message`, () => {
      const keys = leafKeys(messages[locale]);
      expect(keys.length).toBeGreaterThan(100);
      // Translation is cached per locale; the test must not leave the shared
      // instance on whichever locale it happened to check last.
      const previous = i18n.global.locale.value;
      i18n.global.locale.value = locale;
      try {
        const broken: string[] = [];
        for (const key of keys) {
          try {
            i18n.global.t(key);
          } catch (error) {
            broken.push(`${key}: ${(error as Error).message.split("\n")[0]}`);
          }
        }
        expect(broken).toEqual([]);
      } finally {
        i18n.global.locale.value = previous;
      }
    });
  }

  it("has the same keys in both languages", () => {
    // A key present in one locale only falls back silently at runtime, which
    // shows up as a missing translation rather than the bug it is.
    const zh = new Set(leafKeys(messages.zh));
    const en = new Set(leafKeys(messages.en));
    expect([...zh].filter((key) => !en.has(key)).sort()).toEqual([]);
    expect([...en].filter((key) => !zh.has(key)).sort()).toEqual([]);
  });

  it("leaves no empty message", () => {
    // An empty string renders as a blank label, which reads as a missing
    // control rather than a missing translation.
    for (const locale of LOCALES) {
      const empty = leafKeys(messages[locale]).filter((key) => {
        const tree = messages[locale] as Record<string, unknown>;
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tree);
        return !String(value ?? "").trim();
      });
      expect(empty).toEqual([]);
    }
  });

  it("keeps literal braces literal instead of parsing them as a placeholder", () => {
    // The flow template syntax is `{{name}}`; a message that wants to *show*
    // that has to escape it, or it becomes a nested placeholder and the page
    // fails to render. Interpolating one must give the text back verbatim.
    expect(i18n.global.t("app.flowStepValue", {}, { locale: "zh" })).toContain("{{变量}}");
    expect(i18n.global.t("app.flowAddParamFirst", {}, { locale: "en" })).toContain("{{name}}");
  });

  it("defines every key the renderer asks for", () => {
    // The other checks here all start from `messages`, so they can only notice a
    // *defined* message that is broken. A key the code calls but the table no
    // longer has is invisible to them: vue-i18n renders the key itself, so the
    // user sees `app.copyToken` on a button. That is how the AI access panel
    // shipped a raw key on a button and another as a details summary (1.1.0)
    // while every existing assertion stayed green.
    const defined = new Set(leafKeys(messages.zh));
    const root = join(process.cwd(), "src", "renderer", "src");
    const missing: string[] = [];
    for (const file of walkSources(root)) {
      const source = readFileSync(file, "utf8");
      // `$t("key")` / `t("key")` / `tr("key")`, literal keys only. Keys built
      // from a template literal cannot be resolved statically and are excluded
      // on purpose rather than guessed at.
      for (const match of source.matchAll(/(?:\$t|\btr|\bt)\(\s*["']([a-zA-Z0-9_.]+)["']/g)) {
        const key = match[1]!;
        if (!defined.has(key)) missing.push(`${relative(process.cwd(), file)}: ${key}`);
      }
    }
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  it("keeps user-facing copy free of design history and rationale", () => {
    // The rule in AGENTS.md: copy answers "what is this / what happens if I
    // click it", never "what it used to be" or "why we chose this". A line like
    // "it no longer limits which accounts you see" shipped on the sites page and
    // is meaningless to anyone who never saw the old behaviour — it reads as the
    // product arguing with itself.
    //
    // Code comments and docs are the right home for both, so only the message
    // table is checked. The patterns are deliberately narrow: "不再保存" or "no
    // longer resolves" are legitimate *states*, and a check that flagged them
    // would be switched off within a week. Each entry names a phrase that only
    // makes sense when the reader remembers the old version.
    const patterns: Array<{ re: RegExp; why: string }> = [
      { re: /不再(是|限定|把|只看|需要)/, why: "「不再是/不再限定」在对比旧行为" },
      { re: /(以前|原来|过去)(的|是|会)/, why: "「以前/原来…」讲述历史" },
      { re: /而不是/, why: "「…而不是…」解释设计取舍" },
      { re: /(已|被)废弃/, why: "「已废弃」是版本注记" },
      { re: /迁移自|升级自/, why: "迁移说明属于 CHANGELOG" },
      { re: /\bno longer (a|an|the) /i, why: "\"no longer a …\" compares against the old behaviour" },
      { re: /\b(formerly|used to be|deprecated)\b/i, why: "version notes belong in CHANGELOG" },
    ];
    const offenders: string[] = [];
    for (const locale of LOCALES) {
      for (const key of leafKeys(messages[locale])) {
        const value = key
          .split(".")
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)?.[part],
            messages[locale] as Record<string, unknown>,
          );
        const text = String(value ?? "");
        for (const { re, why } of patterns) {
          if (re.test(text)) offenders.push(`${locale}.${key}: ${why} — ${text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

