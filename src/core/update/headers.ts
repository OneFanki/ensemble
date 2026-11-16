/**
 * Normalises the response headers Electron's `net.request` hands back.
 *
 * It lives in core (no Electron import) so the shape bug it fixes can be tested
 * directly. The type claims `Record<string, string[]>`, but at runtime a header
 * carrying a single value arrives as a plain string. Iterating a string yields
 * its characters, so `content-length: "104171323"` was appended as
 * "1, 0, 4, 1, 7, …"; `Number()` turned that into NaN, `downloadUpdateAsset` saw
 * no total size, and the update dialog's progress bar sat at 0% for the whole
 * download before jumping straight to "ready". That is what an upgrade from
 * 2.1.0 looked like: no progress, then a sudden prompt to install.
 */
export function toResponseHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, values] of Object.entries(raw)) {
    // A single value is a string, not a one-element array.
    const list = Array.isArray(values) ? values : [values];
    for (const value of list) {
      // The host type allows undefined for headers that were not sent at all.
      if (typeof value !== "string") continue;
      headers.append(name, value);
    }
  }
  return headers;
}
