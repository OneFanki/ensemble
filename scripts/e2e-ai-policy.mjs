#!/usr/bin/env node
/**
 * End-to-end check of the per-origin AI permission in the daily profile.
 *
 * The claim: an AI client connected to the real endpoint can read a page the
 * user is signed in to, but cannot click or type there until the user allows the
 * origin — and can always operate an identity page, because that is the product.
 *
 * Five things have to hold, and each is a separate assertion:
 *
 * 1. A daily-profile page refuses every input tool, and the refusal is a decision
 *    (the page's own click counter never moves).
 * 2. Reading and screenshotting the same page still works.
 * 3. An identity page is operable without any grant.
 * 4. Granting the origin through the toolbar switch makes the daily page
 *    operable; revoking it closes the door again.
 * 5. An identity-less tab the AI opens itself lands in a clean session, not in
 *    the user's profile.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow } from "./lib/e2e-cdp.mjs";
import { openRail } from "./lib/e2e-nav.mjs";

const PAGE_PORT = await freePort();
const MCP_PORT = await freePort();
const DEBUG_PORT = "0";
const TOKEN = "e2e-ai-policy-token-123456";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-ai-policy-"));

/**
 * A page that records how many times its button was clicked.
 *
 * The click counter is the falsifiable half: a refusal that still delivered the
 * click would show up here, and no amount of error text would hide it.
 */
const page = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>运营后台</title></head>
<body>
<h1>运营后台</h1>
<p id="hits">0</p>
<button id="publish" type="button" onclick="
  const el = document.getElementById('hits');
  el.textContent = String(Number(el.textContent) + 1);
">投放</button>
<label>备注 <input id="note" name="note" type="text" /></label>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/ops`;
const ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

const now = new Date().toISOString();
const siteId = uuid(1);
const identityId = uuid(2);

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "运营后台",
        baseUrl: ORIGIN,
        loginPath: "/ops",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [
      {
        id: identityId,
        siteId,
        name: "运营账号",
        username: "ops@example.test",
        role: "运营",
        color: "teal",
        passwordMode: "inherit",
        status: "unknown",
        startPath: "/ops",
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
);
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
    aiOrigins: [],
  }),
  { mode: 0o600 },
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/** One MCP call; returns the parsed payload plus whether it was refused. */
async function call(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  const text = json.result?.content?.[0]?.text ?? "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { isError: Boolean(json.result?.isError), payload, text };
}

async function waitForMcp() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // still starting
    }
    await wait(400);
  }
  return false;
}

async function connectRenderer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      const target = list.find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools"),
      );
      if (target) return connectToWindow(target.webSocketDebuggerUrl);
    } catch {
      // the window has not opened its debugging port yet
    }
  }
  return undefined;
}

try {
  const ready = await waitForMcp();
  check("app started", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP endpoint never came up");

  const client = await connectRenderer();
  check("renderer reachable", Boolean(client));
  // The account rail starts collapsed; this suite reads its AI dots.
  await client.evaluate(openRail());
  await wait(400);

  /**
   * Reads the click counter inside the embedded page itself.
   *
   * Retried rather than read once: the counter can be asked for in the same
   * turn the tab was opened, and the guest target only appears in `/json/list`
   * once the page has an execution context. A single attempt returned -1 for a
   * page that was simply still attaching, which then read as "the page never
   * loaded" in three different assertions.
   */
  async function hits(tabId) {
    const deadline = Date.now() + 4_000;
    do {
      const pageClient = await findPageTarget();
      if (pageClient) {
        const value = await pageClient.evaluate(
          `Number(document.getElementById('hits')?.textContent ?? -1)`,
        );
        pageClient.close();
        const number = Number(value);
        if (number >= 0) return number;
      }
      await wait(150);
    } while (Date.now() < deadline);
    return -1;
  }

  async function findPageTarget() {
    const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
    // A page embedded as a `<webview>` shows up as a guest target rather than a
    // top-level `page`. Both are accepted: the assertion is about the page's own
    // DOM, not about which carrier is displaying it.
    const target = list.find(
      (item) =>
        (item.type === "page" || item.type === "webview" || item.type === "iframe") &&
        item.url.startsWith(`${ORIGIN}/`),
    );
    return target ? connectToWindow(target.webSocketDebuggerUrl) : undefined;
  }

  // --- A daily-profile page, opened the way a person opens one ---
  const daily = await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} });
    const state = await window.ensemble.getEmbeddedState();
    const tab = state.tabs.find((item) => item.url.includes('/ops') && !item.clean);
    return tab ? { id: tab.id, clean: tab.clean ?? false } : null;
  })()`);
  check("a bookmark-style open lands in the daily profile", Boolean(daily?.id) && !daily?.clean, daily);
  const dailyTabId = daily?.id ?? "";

  const beforeRead = await hits(dailyTabId);
  check("the page is loaded and its counter readable", beforeRead === 0, { beforeRead });

  const clickDenied = await call("click_browser_element", { tabId: dailyTabId, text: "投放" });
  check(
    "clicking a daily-profile page is refused",
    clickDenied.isError && clickDenied.text.includes("只读"),
    clickDenied.text.slice(0, 120),
  );

  const typeDenied = await call("type_browser_text", {
    tabId: dailyTabId,
    label: "备注",
    text: "hello",
  });
  check(
    "typing into a daily-profile page is refused",
    typeDenied.isError && typeDenied.text.includes("只读"),
    typeDenied.text.slice(0, 120),
  );

  await wait(300);
  const afterDenied = await hits(dailyTabId);
  check(
    "the refusal never reached the page",
    afterDenied === beforeRead,
    { beforeRead, afterDenied },
  );

  const readOk = await call("read_browser_page", { tabId: dailyTabId });
  check(
    "reading a daily-profile page still works",
    !readOk.isError && Array.isArray(readOk.payload?.nodes),
    readOk.isError ? readOk.text.slice(0, 120) : { nodes: readOk.payload?.nodes?.length },
  );

  const shotOk = await call("screenshot_browser_tab", { tabId: dailyTabId });
  check(
    "screenshotting a daily-profile page still works",
    !shotOk.isError && Boolean(shotOk.payload?.path),
    shotOk.isError ? shotOk.text.slice(0, 120) : shotOk.payload,
  );

  // --- An identity page: operable with no grant ---
  const identityTab = await call("open_browser_tab", { identityId, url: PAGE_URL });
  check("an identity tab opens", !identityTab.isError, identityTab.text.slice(0, 120));
  const identityTabId = identityTab.payload?.id ?? "";
  await wait(1200);
  const identityClick = await call("click_browser_element", {
    tabId: identityTabId,
    text: "投放",
  });
  check(
    "an identity page can be operated without any grant",
    !identityClick.isError,
    identityClick.isError ? identityClick.text.slice(0, 160) : undefined,
  );

  // --- The AI's own identity-less tab is a clean session ---
  const scratch = await call("open_browser_tab", { url: PAGE_URL });
  check("an AI-opened identity-less tab", !scratch.isError, scratch.text.slice(0, 120));
  const scratchId = scratch.payload?.id ?? "";
  await wait(1200);
  const scratchClick = await call("click_browser_element", { tabId: scratchId, text: "投放" });
  check(
    "an AI-opened identity-less tab is its own clean session, not the daily profile",
    !scratchClick.isError,
    scratchClick.isError ? scratchClick.text.slice(0, 160) : undefined,
  );

  // --- The toolbar panel grants and revokes ---
  // Navigate the existing daily tab to the origin, then drive the real controls.
  // The permission question now lives inside the AI panel, so opening the panel
  // is part of the gesture a user performs.
  await client.evaluate(
    `window.ensemble.activateEmbeddedTab(${JSON.stringify(dailyTabId)})`,
  );
  const panelOpen = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const button = document.querySelector('[data-ai-panel]');
      if (button) {
        button.click();
        await wait(500);
        const gate = document.querySelector('[data-ai-gate]');
        return {
          found: true,
          panel: Boolean(document.querySelector('[data-ai-panel-body]')),
          gate: gate?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
          allow: Boolean(document.querySelector('[data-ai-allow-origin]')),
        };
      }
      await wait(300);
    }
    return { found: false };
  })()`);
  check(
    "the AI panel appears in the toolbar and names the page's origin",
    panelOpen?.found === true &&
      panelOpen?.panel === true &&
      panelOpen?.allow === true &&
      String(panelOpen?.gate ?? "").includes(ORIGIN),
    panelOpen,
  );

  const granted = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    document.querySelector('[data-ai-allow-origin]')?.click();
    await wait(900);
    const status = await window.ensemble.mcpStatus();
    return { origins: status.aiOrigins };
  })()`);
  check("the panel grants the page's origin", granted?.origins?.includes(ORIGIN), granted);

  // Close the panel: it hangs over the toolbar's right end, where the next
  // assertions read the bell and the app menu.
  await client.evaluate(`(document.querySelector('[data-ai-panel]')?.click(), true)`);

  const afterGrant = await call("click_browser_element", { tabId: dailyTabId, text: "投放" });
  check(
    "a granted origin can be operated",
    !afterGrant.isError,
    afterGrant.isError ? afterGrant.text.slice(0, 160) : undefined,
  );
  await wait(300);
  const hitsAfterGrant = await hits(dailyTabId);
  check(
    "the granted click really reached the page",
    hitsAfterGrant === beforeRead + 1,
    { beforeRead, hitsAfterGrant },
  );

  await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    document.querySelector('[data-ai-panel]')?.click();
    await wait(400);
    document.querySelector('[data-ai-allow-origin]')?.click();
    await wait(900);
    document.querySelector('[data-ai-panel]')?.click();
    return true;
  })()`);
  const revoked = await call("click_browser_element", { tabId: dailyTabId, text: "投放" });
  check(
    "revoking the origin closes the door again",
    revoked.isError && revoked.text.includes("只读"),
    revoked.text.slice(0, 120),
  );

  // --- The audit log names the origin, not just the tool ---
  const audit = readFileSync(join(userData, "mcp-audit.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  const clickLines = audit.filter((line) => line.tool === "click_browser_element");
  check(
    "the audit log records the origin of each AI action",
    clickLines.length > 0 && clickLines.every((line) => line.origin === ORIGIN),
    clickLines.map((line) => ({ origin: line.origin, ok: line.ok })),
  );
  check(
    "the audit log records the refused attempt as refused",
    clickLines.some((line) => line.ok === false && String(line.error ?? "").includes("只读")),
    clickLines.map((line) => line.ok),
  );

  // --- AI activity is a log of its own, not news in the message centre ---
  //
  // The two lists used to be one: every call wrote a `kind: "ai"` row beside
  // login captures, through the same 500-row cap, so a run of tool calls could
  // push real notifications out of the list they were meant to be read in.
  const activityFile = join(userData, "ai-activity.json");
  const activity = existsSync(activityFile)
    ? JSON.parse(readFileSync(activityFile, "utf8")).records ?? []
    : [];
  check(
    "AI calls are recorded in their own log",
    activity.length > 0 && activity.some((row) => row.tool === "click_browser_element"),
    { records: activity.length },
  );
  check(
    "the log names the site the call touched",
    activity.every((row) => typeof row.origin === "string" && row.origin === ORIGIN),
    activity.map((row) => row.origin),
  );
  check(
    "no AI row reached the message centre",
    // The file may not exist at all — nothing in this run produces a message,
    // and "zero AI rows" is what that means. Reading it unconditionally turned
    // the best possible outcome into an ENOENT.
    !existsSync(join(userData, "messages.json")) ||
      !readFileSync(join(userData, "messages.json"), "utf8").includes('"kind": "ai"'),
  );


  // --- The rail reports AI activity, so the user sees it without the log ---
  //
  // The count badge is retired: the rail's chip carries a state dot now —
  // breathing while the AI is acting, steady when it acted within the last
  // half hour, and nothing otherwise. What the badge answered ("did the AI
  // touch this instance, and when?") the dot still answers, per instance; the
  // exact per-action numbers live in the audit log and the unit tests that
  // map log timestamps to states. A third, untouched instance is opened here
  // as the control for "no activity, no dot".
  const dots = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const api = window.ensemble;
    await api.openEmbeddedTab({});
    await wait(1200);
    const state = await api.getEmbeddedState();
    const instanceOf = (tabId) => state.tabs.find((t) => t.id === tabId)?.instanceId ?? null;
    const dailyInstance = instanceOf(${JSON.stringify(dailyTabId)});
    const identityInstance = instanceOf(${JSON.stringify(identityTabId)});
    const untouchedInstance = instanceOf(state.tabs.find((t) => t.id === state.activeTabId)?.id ?? "");
    const dotOf = (instanceId) =>
      document
        .querySelector('[data-instance-chip="' + instanceId + '"]')
        ?.querySelector('[data-ai-dot]')
        ?.getAttribute('data-ai-dot') ?? null;
    const before = {
      daily: dotOf(dailyInstance),
      identity: dotOf(identityInstance),
      untouched: dotOf(untouchedInstance),
      chips: document.querySelectorAll('[data-instance-chip]').length,
    };

    // The dot explains itself with the drawn tooltip, not a native title.
    //
    // The label hangs off the whole chip, not off the badge: the badge is a 6px
    // corner mark with pointer-events none, so a pointerenter dispatched at it
    // would never reach a listener. The chip's label carries three things — the
    // state sentence, a dot in the state's colour, and the whole account name.
    const chip = document.querySelector('[data-instance-chip="' + dailyInstance + '"]');
    const dot = chip?.querySelector('[data-ai-dot]');
    chip?.dispatchEvent(new PointerEvent('pointerenter'));
    await wait(800);
    const tip = document.querySelector('.app-tooltip');
    const tipBox = tip?.getBoundingClientRect();
    const tipRead = {
      nativeTitle: chip?.getAttribute('title') ?? null,
      visible: tip?.classList.contains('visible') ?? false,
      tipText: tip?.textContent?.trim() ?? '',
      // The label repeats the state as a leading dot in the same colour.
      hasDot: Boolean(tip?.querySelector('.app-tooltip-dot')),
      // The chip truncates a long name; the label is where the rest of it lives.
      hasDetail: Boolean(tip?.querySelector('.app-tooltip-detail')),
      insideWindow: tipBox
        ? tipBox.left >= 0 &&
          tipBox.right <= window.innerWidth &&
          tipBox.top >= 0 &&
          tipBox.bottom <= window.innerHeight
        : false,
      pointerEvents: tip ? getComputedStyle(tip).pointerEvents : null,
    };
    chip?.dispatchEvent(new PointerEvent('pointerleave'));
    await wait(300);
    return { before, tipRead, dotPointerEvents: dot ? getComputedStyle(dot).pointerEvents : null, tipClosed: !document.querySelector('.app-tooltip.visible') };
  })()`);
  check(
    "the chip of the instance the AI acted on carries a dot",
    dots?.before?.daily === "active" || dots?.before?.daily === "recent",
    dots?.before,
  );
  // The dot and the audit log must agree. This is the check that answers the
  // question the dot exists for — "is this state real?" — and it is also what
  // proves the state is per instance rather than per origin: the audit lines
  // carry the tab id, and only instances whose tabs were touched may show a
  // dot. Refusals recorded an activity too, so the daily instance (two refused
  // clicks, a granted click, a refused type) and the identity instance (one
  // granted click) both read as acted-on.
  const loggedForDaily = audit.filter((line) => line.tabId === dailyTabId).length;
  const loggedForIdentity = audit.filter((line) => line.tabId === identityTabId).length;
  check(
    "the dot agrees with the audit log: activity means a dot",
    (loggedForDaily > 0) === Boolean(dots?.before?.daily) &&
      (loggedForIdentity > 0) === Boolean(dots?.before?.identity),
    { dots: dots?.before, loggedForDaily, loggedForIdentity },
  );
  check(
    "an instance the AI never touched carries no dot",
    dots?.before?.untouched === null && (dots?.before?.chips ?? 0) >= 3,
    dots?.before,
  );
  check(
    "the dot explains itself with a drawn tooltip, not a native title",
    dots?.tipRead?.nativeTitle === null &&
      dots?.tipRead?.visible === true &&
      /AI (正在操作|最近操作)/.test(String(dots?.tipRead?.tipText)) &&
      dots?.tipRead?.hasDot === true &&
      dots?.tipRead?.hasDetail === true &&
      dots?.tipRead?.pointerEvents === "none",
    dots?.tipRead,
  );
  // The badge itself takes no pointer: a 6px corner mark cannot be hovered
  // reliably, which is why the label hangs off the chip instead.
  check(
    "the status dot itself takes no pointer",
    dots?.dotPointerEvents === "none",
    { dotPointerEvents: dots?.dotPointerEvents },
  );
  // The rail sits on the window's top row, so the tooltip has the whole window
  // to open into; a hint clipped by the window edge is not a hint.
  check(
    "the tooltip opens inside the window and closes on leave",
    dots?.tipRead?.insideWindow === true && dots?.tipClosed === true,
    dots?.tipRead,
  );

  client?.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  page.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
