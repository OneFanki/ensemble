import type { LoginField } from "@shared/types";

export function normalizeFieldLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Effective extra login fields for one account.
 *
 * A field beyond username and password is an account fact — the tenant a person
 * belongs to, their company code — so accounts are the only place these live.
 * Sites used to carry a copy that applied to everyone, which made a login recipe
 * look like it owned credentials and left the site form collecting values no
 * visitor could have supplied. Files written by those builds are migrated in
 * `sanitizeWorkspace`, where each site field is copied onto its accounts.
 *
 * A row with an empty value is dropped here rather than kept blank: the form
 * leaves a fresh row behind while the user is still typing, and clearing a value
 * means "no such field" — not "send an empty string to the page".
 */
export function resolveLoginFields(identity: Pick<{ extraFields?: LoginField[] }, "extraFields">): LoginField[] {
  const result: LoginField[] = [];
  const seen = new Set<string>();
  for (const field of identity.extraFields ?? []) {
    const key = normalizeFieldLabel(field.label);
    if (!key || seen.has(key)) continue;
    const value = field.value.trim();
    if (!value) continue;
    seen.add(key);
    result.push({ label: field.label.trim(), value });
  }
  return result;
}
