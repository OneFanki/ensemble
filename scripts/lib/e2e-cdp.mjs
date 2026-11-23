/**
 * The CDP client every e2e script drives the app's renderer through.
 *
 * ## Why this exists
 *
 * These suites test Ensemble's own window — tab strip geometry, drag handlers,
 * toast placement, the console overlay — none of which is reachable from the MCP
 * tool surface, because those tools drive *pages*, not the app's chrome. So a
 * suite opens a WebSocket straight to the renderer's debug target and evaluates
 * JavaScript in it.
 *
 * That client was copied into 45 scripts. A hash comparison found 29 byte-identical
 * copies, 5 that differed only in a variable name, and 8 more in three small
 * groups — one implementation written out ten times. Every copy needed the same
 * fixes forever, and a change to how a target is found had to be made 45 times.
 *
 * ## What this is not
 *
 * It is not a Playwright substitute, and it is not a way to drive pages. Pages in
 * the app are driven by `Input.dispatch*` through `src/main/embedded/cdp.ts`,
 * which is what makes their clicks real. This client runs assertions inside the
 * *test harness's own window*, where a synthetic `el.click()` is exactly right:
 * the subject under test is a Vue component, and it does not consult `isTrusted`.
 *
 * ## Usage
 *
 * ```js
 * import { connectToWindow, attachToWindow } from "./lib/e2e-cdp.mjs";
 *
 * const { app, client, appLog } = await attachToWindow({ userData, args: [...] });
 * await client.evaluate(`document.querySelector('[data-rail-entry="sites"]')?.click()`);
 * ```
 *
 * To reach one of the app's own pages, use the shared navigation in
 * `./e2e-nav.mjs` rather than spelling the selectors out again.
 */

/** Reads a target's WebSocket URL from the debugging port the app wrote. */
export async function findRendererTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  // Only the app window itself. The approval and focus-label windows load the
  // same index.html with a hash, and a suite that latches onto one of those
  // gets "Execution context was destroyed" seconds later when that auxiliary
  // window tears down — an error that used to look like a renderer crash, and
  // whose suite-specific pattern (suites whose first evaluate ran before the
  // auxiliary window closed) read as flakiness nobody could pin.
  return list.find(
    (item) =>
      item.type === "page" &&
      item.url.includes("index.html") &&
      !item.url.includes("index.html#") &&
      !item.url.startsWith("devtools"),
  );
}

/**
 * Opens a CDP session against one target URL.
 *
 * The three members are the whole surface the suites use (`evaluate` for almost
 * everything, `send` for the rare raw command, `close` on the way out), so this
 * stays a thin client rather than growing into an automation framework.
 *
 * Error handling: a protocol-level `error` reply rejects the call. Copies that
 * silently resolved `undefined` on error made a failed evaluate look like a page
 * that returned nothing, which is the least debuggable shape a test failure can
 * take.
 */
export async function connectToWindow(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id === undefined) return; // An event, not a reply.
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) {
      // `data` carries the protocol's own detail (e.g. which parameter failed
      // validation); dropping it turned a one-line fix into a blind hunt.
      const data =
        typeof message.error.data === "string"
          ? message.error.data
          : message.error.data !== undefined
            ? JSON.stringify(message.error.data)
            : "";
      const text = message.error.message ?? "CDP error";
      call.reject(new Error(data ? `${text}: ${data}` : text));
    } else call.resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`无法连接调试目标：${url}`)), {
      once: true,
    });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    /**
     * Runs an expression in the page and returns its value.
     *
     * `awaitPromise` is on: several suites return an async IIFE so they can wait
     * a frame between two steps, and without it the call would resolve to an
     * empty object instead of the awaited result.
     *
     * `includeCommandLineAPI` is what puts `require` in scope when the target is
     * the main process — a suite that has to minimise the window or read a
     * `BrowserWindow` cannot do it from the renderer, and without this flag the
     * expression dies with "require is not defined". It costs nothing for the
     * renderer targets, which have no `require` either way.
     */
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        includeCommandLineAPI: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            "evaluate failed",
        );
      }
      return result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Waits for the app to open its debug port and connect to its window.
 *
 * The window is not there the instant the process starts: Electron spawns, the
 * renderer loads `index.html`, and only then does the port list a page target.
 * Every copy of this loop used 100 attempts at 250ms; the attempts are a parameter
 * here because a suite that deliberately starts a slow configuration needs longer.
 *
 * A target in the list is not a usable page. The debug target registers before
 * the navigation commits, and an evaluate that lands in that pre-commit context
 * dies with "Execution context was destroyed" when the real page replaces it —
 * which took down whichever suite happened to evaluate first, in a pattern that
 * shifted with machine load and looked like renderer crashes. So a candidate
 * connection has to survive one probe round trip against the app's own document
 * before it counts as the window.
 */
export async function waitForWindow({
  userData,
  waitForDebugPort,
  timeoutAttempts = 100,
  intervalMs = 250,
}) {
  let lastError;
  for (let attempt = 0; attempt < timeoutAttempts; attempt += 1) {
    await new Promise((done) => setTimeout(done, intervalMs));
    let client;
    try {
      const target = await findRendererTarget(await waitForDebugPort(userData));
      if (!target) continue;
      client = await connectToWindow(target.webSocketDebuggerUrl);
      const ready = await client.evaluate(
        `document.readyState === "complete" && Boolean(document.querySelector("#app"))`,
      );
      // The probe answered: this context is the committed page's and it will
      // not be swapped again, so the suite's own first evaluate is safe here.
      if (ready) return client;
    } catch (error) {
      // The port file is written before the page target exists, and a fetch
      // against a port nobody is listening on throws. So does a probe that was
      // destroyed mid-flight by the commit — both are the normal first few
      // attempts, not a failure.
      lastError = error;
    }
    client?.close();
  }
  throw new Error(`应用窗口没有出现：${lastError?.message ?? "超时"}`);
}
