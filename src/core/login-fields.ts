import type { Site, Identity, LoginField } from "@shared/types";

export function normalizeFieldLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * Effective extra login fields for one identity. Site fields apply to
 * everyone; an identity value overrides the same label, and an empty identity
 * value removes the inherited field.
 */
export function resolveLoginFields(
  site: Pick<Site, "extraFields">,
  identity: Pick<Identity, "extraFields">,
): LoginField[] {
  const merged = new Map<string, LoginField>();

  for (const field of site.extraFields ?? []) {
    const key = normalizeFieldLabel(field.label);
    if (!key) continue;
    merged.set(key, { label: field.label.trim(), value: field.value });
  }

  for (const field of identity.extraFields ?? []) {
    const key = normalizeFieldLabel(field.label);
    if (!key) continue;
    if (field.value.trim()) {
      // Keep the site's spelling when overriding, so the shared form
      // stays the single place that names a field.
      const existing = merged.get(key);
      merged.set(key, {
        label: existing?.label ?? field.label.trim(),
        value: field.value,
      });
    } else {
      merged.delete(key);
    }
  }

  return [...merged.values()];
}
