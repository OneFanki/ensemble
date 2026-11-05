/**
 * Free port allocation for the e2e suites.
 *
 * Hardcoding a port was the original practice and it fails intermittently in two
 * ways that both look like an unrelated bug:
 *
 * 1. **The port is reserved.** After some Windows reboots Hyper-V claims a block
 *    of the dynamic range, and a fixed port inside it dies with `EACCES` before
 *    the app even starts. Nothing in the output says "port"; it reads as a
 *    startup failure.
 * 2. **Two suites pick the same number.** Several suites shared `9791` and
 *    `3989`. Running them one after another hides it, so the collision only
 *    surfaces when a full pass is parallelised or a killed run leaves a listener
 *    behind — and then the failure is a timeout with no obvious cause.
 *
 * Asking the OS returns a port that is free *right now*, which is the strongest
 * guarantee available without coordinating between processes.
 *
 * Each caller must take a fresh port per listener: two `freePort()` calls return
 * two different numbers, and reusing one number for two servers reintroduces the
 * collision this exists to prevent.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

/** A port the OS reports as free at this instant. */
export function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    // `0` is the kernel's "pick one for me"; the assigned port is read back
    // before the socket closes, which is the only moment it is guaranteed to be
    // reported.
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no port assigned"))));
    });
  });
}

/**
 * Reads back the debug port Electron chose when started with
 * `--remote-debugging-port=0`.
 *
 * `freePort()` has a race that shows up exactly where it hurts: the number is
 * free when probed, the socket closes, and several seconds pass before the app
 * binds it — long enough for another process to take it. The failure is
 * `EADDRINUSE` inside Chromium ("Cannot start http server for devtools"), which
 * then reads as "the app window never appeared".
 *
 * Passing `0` removes the race entirely: Chromium picks a port *when it binds*
 * and writes the result to `DevToolsActivePort` in the user-data directory. The
 * only cost is that the test has to wait for that file instead of knowing the
 * number up front.
 */
const published = new Map();

export async function waitForDebugPort(userDataDir, timeoutMs = 20_000) {
  const cached = published.get(userDataDir);
  if (cached) return cached;
  const file = join(userDataDir, "DevToolsActivePort");
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const [first] = (await readFile(file, "utf8")).split(/\r?\n/);
      const port = Number.parseInt(first ?? "", 10);
      if (Number.isInteger(port) && port > 0 && (await responds(port))) {
        // The file appears before the HTTP endpoint necessarily answers, so the
        // version document is read once: without it the first `/json/list` after
        // a cold start is refused, which reads as "the app window never
        // appeared". Caching keeps a polling loop from paying this check again.
        published.set(userDataDir, port);
        return port;
      }
    } catch {
      // The file is written once the endpoint is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`DevTools never published a port in ${userDataDir}`);
}

async function responds(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}
