/**
 * Built-in backdrops for the new-tab surface.
 *
 * Kept as data, not stylesheet rules, for two reasons: the picker draws its
 * swatches from the same values the surface uses (so they cannot drift), and
 * the choice is a plain settings string that survives export/import.
 *
 * Every preset has to work in both themes and stay quiet enough that a search
 * box on top of it is still the thing you look at. A photograph would not: it
 * competes with the text and has to be fetched, and this surface has to render
 * instantly, offline, before any network call.
 *
 * These are deliberately *very* faint. The earlier set put a teal glow at up to
 * 16% and a violet one at 18% in opposite corners, which on a full-window
 * surface read as a coloured wash — the first thing you noticed on a page whose
 * only content is a search box. A backdrop competes with nothing if you have to
 * look for it.
 */
export interface NewTabBackdrop {
  id: string;
  /** i18n key for the picker label. */
  labelKey: string;
  /** Full `background` value of the surface. */
  css: string;
  /** Small square in the picker; a compressed version of the same mood. */
  swatch: string;
}

export const NEW_TAB_BACKDROPS: NewTabBackdrop[] = [
  {
    id: "aurora",
    labelKey: "app.newTabBgAurora",
    // Two wide, low-contrast lights that only tint the far corners. Enough to
    // stop the surface reading as a blank rectangle, not enough to be a colour.
    css: "radial-gradient(70% 55% at 14% 6%, rgba(45, 212, 191, 0.055), transparent 70%), radial-gradient(65% 55% at 88% 94%, rgba(139, 92, 246, 0.06), transparent 70%), var(--bg)",
    swatch: "linear-gradient(135deg, #20292b 0%, #1e2227 50%, #262233 100%)",
  },
  {
    id: "dusk",
    labelKey: "app.newTabBgDusk",
    css: "radial-gradient(70% 55% at 82% 4%, rgba(251, 146, 60, 0.055), transparent 70%), radial-gradient(70% 60% at 10% 96%, rgba(244, 63, 94, 0.05), transparent 70%), var(--bg)",
    swatch: "linear-gradient(135deg, #2b2420 0%, #1e2227 55%, #2b2022 100%)",
  },
  {
    id: "night",
    labelKey: "app.newTabBgNight",
    css: "radial-gradient(80% 65% at 50% -8%, rgba(59, 130, 246, 0.07), transparent 70%), radial-gradient(60% 50% at 50% 108%, rgba(30, 64, 175, 0.07), transparent 70%), var(--bg)",
    swatch: "linear-gradient(160deg, #1d2431 0%, #1b1f24 55%, #1b202b 100%)",
  },
  {
    id: "grid",
    labelKey: "app.newTabBgGrid",
    // 24px graph paper: one line every cell, faded at the edges with a mask so
    // it reads as a texture rather than a table.
    css: "linear-gradient(var(--line-soft) 1px, transparent 1px) 0 0 / 24px 24px, linear-gradient(90deg, var(--line-soft) 1px, transparent 1px) 0 0 / 24px 24px, var(--bg)",
    swatch:
      "repeating-linear-gradient(0deg, rgba(148, 163, 184, 0.22) 0 1px, transparent 1px 6px), repeating-linear-gradient(90deg, rgba(148, 163, 184, 0.22) 0 1px, transparent 1px 6px), #101317",
  },
  {
    id: "plain",
    labelKey: "app.newTabBgPlain",
    css: "var(--bg)",
    swatch: "var(--bg-elevated)",
  },
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
