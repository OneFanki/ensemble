/**
 * Built-in backdrops for the new-tab surface.
 *
 * A preset is an **id and a name**, nothing else. The paint lives in the
 * stylesheet (`NewTabPage.vue`'s `.nt-bg` block) for two reasons:
 *
 *  1. It has to change with the theme. Every preset is a different picture on a
 *     near-black surface than on a near-white one — the same 5.5% teal wash that
 *     tints a dark corner is invisible on light, and the colours tuned for dark
 *     are simply wrong there. Only CSS can answer "which theme am I on" without
 *     a round trip, so the paint belongs where the theme cascade can reach it.
 *  2. The picker's swatches and the surface must be the same value. When both
 *     were strings in this file they were two independent literals that had
 *     already drifted — `plain` painted `--bg` and offered a swatch of
 *     `--bg-elevated`. Now one declaration drives both, so they cannot disagree.
 *
 * The list stays here because it is data: ids persist in settings and have to
 * survive export/import, and the order is the order of the picker.
 */
export interface NewTabBackdrop {
  id: string;
  /** i18n key for the picker label. */
  labelKey: string;
}

/** A choice that is a plain settings string, in picker order. */
export const NEW_TAB_BACKDROPS: NewTabBackdrop[] = [
  { id: "aurora", labelKey: "app.newTabBgAurora" },
  { id: "dusk", labelKey: "app.newTabBgDusk" },
  { id: "night", labelKey: "app.newTabBgNight" },
  { id: "grid", labelKey: "app.newTabBgGrid" },
  { id: "plain", labelKey: "app.newTabBgPlain" },
];

export const DEFAULT_NEW_TAB_BACKDROP = "aurora";

/** Looks a preset up, falling back to the default rather than throwing. */
export function newTabBackdrop(id: string | undefined): NewTabBackdrop {
  return (
    NEW_TAB_BACKDROPS.find((item) => item.id === id) ??
    NEW_TAB_BACKDROPS.find((item) => item.id === DEFAULT_NEW_TAB_BACKDROP) ??
    NEW_TAB_BACKDROPS[0]!
  );
}
