import { Readable } from "node:stream";
import { net } from "electron";
import { isTrustedUpdateUrl } from "@shared/update";

/**
 * The network call used to download an update, with every redirect hop checked.
 *
 * It exists because of one gap in Electron: `net.fetch` never fills
 * `Response.url` — it is the empty string for every request, with every redirect
 * mode — so the downloader could not ask "where did these bytes actually come
 * from?" and rejected every download as untrusted. `net.request` reports each
 * hop through its `redirect` event, which is the fact the check needs.
 *
 * A hop that leaves GitHub's hosts is never followed. The promise resolves with
 * a response whose `url` is that offending address, so the caller's existing
 * `isTrustedUpdateUrl` check produces the one message users see, instead of this
 * module inventing a second copy of it.
 *
 * Bytes stay on Chromium's network stack, so the proxy applied to the default
 * session covers update traffic the same way it covers everything else.
 */
export function createTrustedUpdateFetch(): typeof fetch {
  const trustedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      // The downloader only ever passes the asset URL string; a Request object
      // would carry its own headers and signal, which this path does not need.
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const request = net.request({ url: target, method: "GET", redirect: "manual" });
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        init?.signal?.removeEventListener("abort", onAbort);
        finish();
      };

      const headers = init?.headers;
      if (headers) {
        const entries =
          headers instanceof Headers
            ? [...headers.entries()]
            : Array.isArray(headers)
              ? headers
              : Object.entries(headers).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                );
        for (const [name, value] of entries) request.setHeader(name, value);
      }

      const onAbort = () => {
        request.abort();
        settle(() => reject(new DOMException("The operation was aborted.", "AbortError")));
      };
      if (init?.signal?.aborted) {
        onAbort();
        return;
      }
      init?.signal?.addEventListener("abort", onAbort, { once: true });

      let finalUrl = target;
      request.on("redirect", (_statusCode, _method, redirectUrl) => {
        finalUrl = redirectUrl;
        if (!isTrustedUpdateUrl(redirectUrl)) {
          // Nothing is read from a host that is not GitHub's: abort first, then
          // hand the caller an address the shared trust rule will reject.
          request.abort();
          settle(() => resolve(untrustedResponse(redirectUrl)));
          return;
        }
        request.followRedirect();
      });

      request.on("response", (response) => {
        const body = Readable.toWeb(
          response as unknown as Readable,
        ) as unknown as ReadableStream<Uint8Array>;
        const responseHeaders = new Headers();
        for (const [name, values] of Object.entries(response.headers)) {
          for (const value of values) responseHeaders.append(name, value);
        }
        const result = new Response(response.statusCode === 204 ? null : body, {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: responseHeaders,
        });
        // `Response` has no constructor argument for the effective URL; defining
        // it here is what gives the caller the hop it has to check.
        Object.defineProperty(result, "url", { value: finalUrl });
        settle(() => resolve(result));
      });

      request.on("error", (error) => {
        settle(() => reject(error));
      });

      request.end();
    });

  return trustedFetch as typeof fetch;
}

/** A response carrying only the address that violated the trust rule. */
function untrustedResponse(url: string): Response {
  const response = new Response(null, { status: 403, statusText: "Untrusted redirect" });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
