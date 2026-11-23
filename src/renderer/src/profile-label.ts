import { EMBEDDED_CLEAN_PROFILE_ID, EMBEDDED_DEFAULT_PROFILE_ID } from "@shared/embedded";
import type { BrowserProfile } from "@shared/types";

/**
 * What a stored profile row is called on screen.
 *
 * Built-ins are labelled from the message table, not from their stored name:
 * the stored string is data, and an install that predates a vocabulary change
 * still holds the old words in its settings file. Renaming a user's stored row
 * to follow the vocabulary would be rewriting their data; relabelling the two
 * built-ins at draw time costs nothing and every surface reads the same words.
 * A user row keeps its own name — that is the name they chose.
 */
export function profileLabel(profile: BrowserProfile, t: (key: string) => string): string {
  if (!profile.builtin) return profile.name;
  if (profile.id === EMBEDDED_DEFAULT_PROFILE_ID) return t("app.dailyProfile");
  if (profile.id === EMBEDDED_CLEAN_PROFILE_ID) return t("app.cleanSession");
  return profile.name;
}
