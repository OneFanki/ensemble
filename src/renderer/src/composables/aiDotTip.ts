/**
 * What the AI dot means, in words.
 *
 * The dot itself is a 6px circle on a corner; on its own it says "something",
 * not *what*. The rail and the tab strip both draw it, and both explain it on
 * hover, so the mapping from state to sentence lives here instead of being
 * written twice with two chances to drift.
 *
 * The time is part of the sentence rather than a decoration: "the AI is acting"
 * and "the AI acted twenty minutes ago" call for different reactions, and the
 * clock is the only thing that tells them apart once the breathing animation
 * has stopped.
 */
import { aiDotState } from "@shared/ai-dot";
import { useI18n } from "vue-i18n";

export interface AiDotTip {
  /** The state the dot is drawing; the tooltip repeats it as a leading dot. */
  state: "active" | "recent";
  /** One line: the state, with the last action's time when it is not "now". */
  text: string;
  /** The dot's paint, so the label's dot matches the one being explained. */
  color: string;
}

export function useAiDotTip(): {
  /** `null` when there is no dot to explain (idle, or an unreadable timestamp). */
  tipOf: (lastActionAtMs: number | undefined, now: number) => AiDotTip | null;
} {
  const { t, locale } = useI18n();

  function tipOf(lastActionAtMs: number | undefined, now: number): AiDotTip | null {
    const state = aiDotState(lastActionAtMs, now);
    if (state === "idle" || lastActionAtMs === undefined) return null;
    const date = new Date(lastActionAtMs);
    if (Number.isNaN(date.getTime())) return null;

    // The app's locale, not the system's: a user reading English copy should not
    // get a 24-hour Chinese-style timestamp two lines above it.
    const tag = locale.value === "zh" ? "zh-CN" : "en-US";
    const sameDay = new Date().toDateString() === date.toDateString();
    const time = sameDay
      ? date.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleString(tag, {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });

    return {
      state,
      text: state === "active" ? t("app.aiDotActive") : t("app.aiDotRecent", { time }),
      // `--accent` for both: the two states differ in motion, not in hue. A
      // second colour would claim "recent" is a different kind of event, and
      // the user would have to learn two meanings for one feature.
      color: "var(--accent)",
    };
  }

  return { tipOf };
}
