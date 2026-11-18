#!/usr/bin/env node
/**
 * End-to-end check of a flow's raw CDP step.
 *
 * What needs proving is not that the step works — it is that it *refuses* the
 * right things, because that whitelist is the boundary between "a flow can act
 * on its page" and "a flow can reach another identity's partition":
 *
 * 1. An allowed-tier command is accepted and the page layer sees it.
 * 2. A forbidden domain (Target / Browser / Storage) is refused with a reason,
 *    and stays refused once the optional tier is switched on.
 * 3. An optional-tier command is refused while the setting is off.
 * 4. More than two raw commands in one flow produce a note — the signal that an
 *    action is missing from the wrappers.
 * 5. A caller-supplied `timeoutMs` is what the run obeys.
 *
 * Two app runs, because one case needs the setting on: a single process cannot
 * change it — `update_settings` deliberately refuses this key, since an AI that
 * can widen its own permission tier has none.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-flow-cdp-"));
const siteId = "11111111-1111-4111-8111-111111111111";

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>原始 CDP</title></head>
<body><div id="out">none</div></body></html>`);
});
await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "原始 CDP 站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/",
      },
    ],
    identities: [],
    views: [],
    flows: [],
    bookmarks: [],
    layoutPresets: [],
  }),
);

const electron = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/**
 * Starts the app with a given value for the optional-tier switch.
 *
 * The setting is written before launch rather than changed through
 * `update_settings`: that tool refuses the key on purpose, because letting an AI
 * unlock its own tier is privilege escalation. Writing the settings file is what
 * a person does in Settings.
 */
async function withApp(flowCdpExtended, body) {
  const mcpPort = await freePort();
  const token = `e2e-flow-cdp-${Math.random().toString(36).slice(2, 10)}-token`;
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ flowCdpExtended }));
  writeFileSync(
    join(userData, "mcp.json"),
    JSON.stringify({
      enabled: true,
      port: mcpPort,
      token,
      allowWrite: true,
      allowRun: true,
      allowDelete: false,
    }),
    { mode: 0o600 },
  );

  const app = spawn(electron, [join(process.cwd(), "out", "main", "index.js")], {
    env: { ...process.env, ENSEMBLE_USER_DATA: userData, ENSEMBLE_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let appLog = "";
  app.stdout.on("data", (chunk) => (appLog += chunk));
  app.stderr.on("data", (chunk) => (appLog += chunk));

  let nextId = 1;
  const call = async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const json = await response.json();
    if (json.error) throw new Error(`${name}: ${json.error.message}`);
    if (json.result?.isError) throw new Error(`${name}: ${json.result.content[0].text}`);
    const text = json.result.content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Still starting.
    }
    await wait(400);
  }
  check(
    `app started with the switch ${flowCdpExtended ? "on" : "off"}`,
    ready,
    ready ? undefined : appLog.slice(-600),
  );
  if (!ready) throw new Error("MCP never came up");

  let flowSeq = 0;
  /**
   * Saves a flow and runs it on a fresh page.
   *
   * No `id` is sent: `save_flow` treats a supplied id as an update and refuses
   * when the flow does not exist yet. Creating one and using the id it returns is
   * the path a caller takes on a fresh workspace.
   */
  const runSteps = async (steps, timeoutMs) => {
    const saved = await call("save_flow", {
      siteId,
      name: `原始 CDP 检查 ${(flowSeq += 1)}`,
      description: "",
      params: [],
      steps,
    });
    const tab = await call("open_browser_tab", { url: PAGE_URL });
    const tabId = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
    await wait(600);
    return call("run_flow", { id: saved.id, tabId, ...(timeoutMs ? { timeoutMs } : {}) });
  };

  try {
    await body({ call, runSteps });
  } finally {
    app.kill();
    await wait(1_200);
  }
}

try {
  await withApp(false, async ({ runSteps }) => {
    // --- 1. the allowed tier is accepted ------------------------------------
    /*
     * `Page.handleJavaScriptDialog` is the cleanest allowed command to assert on:
     * with nothing showing it answers with a protocol error, which means the
     * command actually reached the page layer rather than being refused by the
     * tier check. A refusal would carry different wording.
     */
    const allowed = await runSteps([
      { action: "navigate", url: PAGE_URL },
      { action: "cdp", method: "Page.handleJavaScriptDialog", params: { accept: false } },
    ]);
    check(
      "an allowed-tier command is not refused by the tier check",
      !/被禁止|可选档/.test(allowed.run?.reason ?? ""),
      allowed.run?.reason,
    );

    /*
     * A raw command that answers reliably in a headless run. `Page.captureScreenshot`
     * used to be the example, but a culled guest (minimised / unseen window — pages
     * freeze now even when nobody watches) produces no compositor frames, and that
     * command's known behaviour is to never reply rather than fail. The wrapped
     * screenshot action falls back to the renderer path for exactly this reason; a
     * raw command is sent as-is. The point here is the *reporting*, so any
     * allow-tier command that returns is the honest subject.
     */
    const reported = await runSteps([
      { action: "navigate", url: PAGE_URL },
      { action: "cdp", method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 5, y: 5 } },
    ]);
    check(
      "the run reports the raw commands it used",
      reported.run?.ok === true &&
        Array.isArray(reported.run?.rawCdp) &&
        reported.run.rawCdp[0] === "Input.dispatchMouseEvent",
      { ok: reported.run?.ok, rawCdp: reported.run?.rawCdp, reason: reported.run?.reason },
    );

    // --- 2. the forbidden tier is refused -----------------------------------
    const forbidden = await runSteps([
      { action: "navigate", url: PAGE_URL },
      { action: "cdp", method: "Target.attachToTarget", params: { targetId: "x" } },
    ]);
    check(
      "a cross-partition command is refused",
      forbidden.run?.ok === false && /禁止/.test(forbidden.run?.reason ?? ""),
      forbidden.run?.reason,
    );

    const storage = await runSteps([
      { action: "navigate", url: PAGE_URL },
      { action: "cdp", method: "Storage.getCookies", params: {} },
    ]);
    check(
      "reading another partition's cookies is refused",
      storage.run?.ok === false && /禁止/.test(storage.run?.reason ?? ""),
      storage.run?.reason,
    );

    // --- 3. the optional tier needs the switch ------------------------------
    const gatedOff = await runSteps([
      { action: "navigate", url: PAGE_URL },
      { action: "cdp", method: "Emulation.setTimezoneOverride", params: { timezoneId: "UTC" } },
    ]);
    check(
      "an optional-tier command is refused while the switch is off",
      gatedOff.run?.ok === false && /可选档/.test(gatedOff.run?.reason ?? ""),
      gatedOff.run?.reason,
    );

    // --- 4. more than two raw commands is called out ------------------------
    const thrice = await runSteps([
      { action: "navigate", url: PAGE_URL },
      // Three of the same reliable command: each answers with an empty object, so
      // the count is what is being measured rather than a capture succeeding.
      { action: "cdp", method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 10, y: 10 } },
      { action: "cdp", method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 20, y: 20 } },
      { action: "cdp", method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 30, y: 30 } },
    ]);
    check(
      "three raw commands produce a note about a missing action",
      thrice.run?.ok === true &&
        Array.isArray(thrice.run?.rawCdp) &&
        thrice.run.rawCdp.length === 3 &&
        /缺一个封装动作/.test(thrice.run?.note ?? ""),
      { ok: thrice.run?.ok, rawCdp: thrice.run?.rawCdp, note: thrice.run?.note },
    );

    // --- 5. the flow timeout is the caller's, not a hardcoded two minutes ---
    /*
     * A one-second budget stops the run with a message naming it. The old code
     * ignored the value and always used two minutes, so this call would have
     * waited out the whole wait step instead.
     */
    const tooShort = await runSteps(
      [
        { action: "navigate", url: PAGE_URL },
        { action: "wait", condition: "text", expect: "never-appears", timeoutMs: 30_000 },
      ],
      1_000,
    );
    check(
      "a caller-supplied timeout is what the run obeys",
      tooShort.run?.ok === false && /流程超过 1 秒/.test(tooShort.run?.reason ?? ""),
      tooShort.run?.reason,
    );
  });

  await withApp(true, async ({ runSteps }) => {
    // --- the optional tier runs once the switch is on -----------------------
    const gatedOn = await runSteps([
      { action: "navigate", url: PAGE_URL },
      { action: "cdp", method: "Emulation.setTimezoneOverride", params: { timezoneId: "UTC" } },
    ]);
    check(
      "once the switch is on, the optional tier is accepted",
      gatedOn.run?.ok === true,
      gatedOn.run?.reason,
    );

    // ...and the forbidden tier is still refused: a user turning on network
    // observation has not agreed to cross-partition access.
    const stillForbidden = await runSteps([
      { action: "navigate", url: PAGE_URL },
      { action: "cdp", method: "Browser.setDownloadBehavior", params: { behavior: "deny" } },
    ]);
    check(
      "turning the switch on does not unlock the forbidden tier",
      stillForbidden.run?.ok === false && /禁止/.test(stillForbidden.run?.reason ?? ""),
      stillForbidden.run?.reason,
    );
  });
} catch (error) {
  check("run completed", false, String(error));
} finally {
  server.close();
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
