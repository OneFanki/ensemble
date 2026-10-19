export function normalizeBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}`;
}

export function joinUrl(baseUrl: string, targetPath = "/"): string {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/^https?:\/\//i.test(targetPath)) {
    return targetPath;
  }
  const path = targetPath.startsWith("/") ? targetPath : `/${targetPath}`;
  return `${normalized}${path}`;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    return undefined;
  } catch {
    return undefined;
  }
}
