#!/usr/bin/env node
/**
 * End-to-end checks for HTTP authentication challenges.
 *
 * Each step was a defect or a claim before the change: with no `login` handler
 * the app rendered the raw 401 page with nowhere to type.
 *
 * 1. Opening a basic-auth page shows the sign-in dialog, not the 401 body.
 * 2. Wrong credentials re-ask (the server challenges again), right credentials
 *    let the page through.
 * 3. The answered protection space is cached for the session: another page on
 *    the same origin opens without a second dialog.
 * 4. Dismissing the dialog answers the challenge with nothing — the 401 page
 *    shows, and no credentials are cached for that space.
 *
 * Everything runs headless: a real window is parked outside every display.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const AUTH_PORT = await freePort();
const SECOND_PORT = await freePort();
const CREDENTIALS = { user: "tester", pass: "s3cret" };
const EXPECTED = `Basic ${Buffer.from(`${CREDENTIALS.user}:${CREDENTIALS.pass}`).toString("base64")}`;

let challenges = 0;
/** URLs that made it through with valid credentials, recorded server-side. */
const served = new Set();

/** One realm per origin, so the cancel check cannot hit the cached first one. */
function protectedServer(port, realm) {
  const server = createServer((req, res) => {
    if ((req.headers.authorization ?? "") !== EXPECTED) {
      challenges += 1;
      res.writeHead(401, { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"` });
      res.end("<html><body><h1>401 Authorization Required</h1></body></html>");
      return;
    }
    served.add(req.url ?? "/");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><body><h1 id="ok">${req.url}</h1></body></html>`);
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", done));
}

await protectedServer(AUTH_PORT, "Protected area");
await protectedServer(SECOND_PORT, "Second area");

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-http-auth-"));
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    call(message.result);
  });
  await new Promise((done) => socket.addEventListener("open", done));
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

async function waitFor(client, expression, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return true;
    await wait(150);
  }
  return false;
}

/** Fills the dialog and clicks sign in. */
async function answerDialog(client, user, pass) {
  await client.evaluate(`(async () => {
    const inputs = [...document.querySelectorAll('.auth-form input')];
    const set = (input, value) => {
      if (!input) throw new Error('dialog input not found');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(inputs.find((el) => el.type === 'text'), ${JSON.stringify(user)});
    set(inputs.find((el) => el.type === 'password'), ${JSON.stringify(pass)});
    await new Promise((r) => setTimeout(r, 100));
    document.querySelector('.auth-form .btn.primary')?.click();
    return true;
  })()`);
}

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      // The window has not opened its debugging port yet.
    }
  }
  check("app window appeared", Boolean(target), target ? undefined : appLog.slice(-600));
  if (!target) throw new Error("no renderer target");

  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3000);

  // --- 1. The dialog appears instead of the 401 page ------------------------
  await client.evaluate(`window.ensemble.openEmbeddedTab({ url: "http://127.0.0.1:${AUTH_PORT}/one" }); true`);
  check(
    "a basic-auth page opens the sign-in dialog",
    await waitFor(client, "Boolean(document.querySelector('.auth-form'))"),
  );
  const dialogInfo = await client.evaluate(`(() => {
    const title = document.querySelector('.auth-form')?.closest('.content')?.querySelector('.title');
    return {
      title: title?.textContent?.trim() ?? "",
      // Chromium lower-cases the scheme it reports ("basic").
      hasMeta: /basic/i.test(document.querySelector('.auth-form .auth-meta')?.textContent ?? ""),
    };
  })()`);
  check(
    "the dialog names the host and the auth scheme",
    dialogInfo.title.includes("127.0.0.1") && dialogInfo.hasMeta,
    dialogInfo,
  );

  // --- 2. Wrong credentials re-ask, right ones let the page through --------
  await answerDialog(client, CREDENTIALS.user, "wrong");
  await wait(600);
  const reasked = await waitFor(client, "Boolean(document.querySelector('.auth-form'))");
  check("wrong credentials make the server re-challenge", reasked, { challenges });

  await answerDialog(client, CREDENTIALS.user, CREDENTIALS.pass);
  const dialogGone = await waitFor(client, "!Boolean(document.querySelector('.auth-form'))");
  await wait(400);
  check(
    "correct credentials close the dialog and load the page",
    dialogGone && served.has("/one"),
    { served: [...served] },
  );

  // --- 3. The answered space is cached for the session ---------------------
  const beforeThird = challenges;
  await client.evaluate(`window.ensemble.openEmbeddedTab({ url: "http://127.0.0.1:${AUTH_PORT}/two" }); true`);
  await wait(1200);
  const noSecondDialog = await client.evaluate(
    "!Boolean(document.querySelector('.auth-form'))",
  );
  check(
    "the same protection space does not ask twice",
    noSecondDialog && challenges === beforeThird && served.has("/two"),
    { challenges, beforeThird, served: [...served] },
  );

  // --- 4. Dismissing answers with nothing and shows the 401 ----------------
  const beforeCancel = challenges;
  await client.evaluate(`window.ensemble.openEmbeddedTab({ url: "http://127.0.0.1:${SECOND_PORT}/deny" }); true`);
  await waitFor(client, "Boolean(document.querySelector('.auth-form'))");
  await client.evaluate(`(() => {
    const ghost = [...document.querySelectorAll('.auth-form .btn')].find((el) => !el.classList.contains('primary'));
    ghost?.click();
    return true;
  })()`);
  await wait(400);
  const dismissed = await client.evaluate("!Boolean(document.querySelector('.auth-form'))");
  // The dismissed navigation's resources challenged while the dialog was up
  // (they queue behind it); after the dismissal the count must stop growing —
  // no dialog again, no credentials, just the 401.
  const afterDismiss = challenges;
  await wait(1200);
  check(
    "dismissing stops asking and never caches the space",
    dismissed && challenges === afterDismiss,
    { challenges, beforeCancel, afterDismiss },
  );

  client.close();
} catch (error) {
  check("suite completed without throwing", false, String(error));
} finally {
  app.kill();
  await wait(400);
  rmSync(userData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
