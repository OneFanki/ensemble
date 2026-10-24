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
    // Two off-centre glows: teal toward the top left, violet toward the bottom
    // right. Dashed out toward the edges so the middle stays a calm plateau for
    // the search box.
    css: "radial-gradient(90% 70% at 18% 8%, rgba(45, 212, 191, 0.16), transparent 62%), radial-gradient(80% 70% at 84% 92%, rgba(139, 92, 246, 0.18), transparent 60%), var(--bg)",
    swatch: "linear-gradient(135deg, #0f2f2c 0%, #101317 45%, #241a3d 100%)",
  },
  {
    id: "dusk",
    labelKey: "app.newTabBgDusk",
    css: "radial-gradient(85% 65% at 78% 6%, rgba(251, 146, 60, 0.16), transparent 62%), radial-gradient(90% 75% at 12% 96%, rgba(244, 63, 94, 0.14), transparent 58%), var(--bg)",
    swatch: "linear-gradient(135deg, #3a2416 0%, #101317 50%, #3a1620 100%)",
  },
  {
    id: "night",
    labelKey: "app.newTabBgNight",
    css: "radial-gradient(95% 85% at 50% -10%, rgba(59, 130, 246, 0.20), transparent 65%), radial-gradient(70% 60% at 50% 110%, rgba(30, 64, 175, 0.22), transparent 60%), var(--bg)",
    swatch: "linear-gradient(160deg, #16233d 0%, #0d1117 55%, #131c30 100%)",
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
