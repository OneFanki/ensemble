#!/usr/bin/env node
/**
 * Tab muting and the AI's default-mute contract.
 *
 * The visible half is a speaker control on the tab; the invisible half is that
 * an AI page operation mutes unless the person asked for sound. Both run
 * through the real MCP endpoint and the real tab strip.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-audio-"));
const mcpPort = await freePort();
const pagePort = await freePort();
const TOKEN = "e2e-tab-audio-token-1234567890";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>音频测试</title></head>
<body><h1>音频测试</h1><p>tab-audio</p>
<audio id="tone" loop src="/tone.wav"></audio>
<button id="play" onclick="document.getElementById('tone').play()">播放</button>
</body></html>`;

/** A one-second 440Hz tone; enough for Chromium to report the page audible. */
function toneWav(seconds = 1, frequency = 440, rate = 8000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * 0.2 * 32767);
    data.writeInt16LE(value, 44 + index * 2);
  }
  return data;
}
const TONE = toneWav();

const pageServer = createServer((req, res) => {
  if (req.url?.startsWith("/tone.wav")) {
    res.writeHead(200, { "content-type": "audio/wav", "content-length": TONE.length });
    res.end(TONE);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
await new Promise((done) => pageServer.listen(pagePort, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${pagePort}/`;

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [],
    views: [],
    flows: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
    bookmarks: [],
    bookmarkFolders: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({
    theme: "dark",
    locale: "zh",
    lastView: "browser",
    guideVersion: GUIDE_SEEN,
  }),
);
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: mcpPort,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: true,
    aiMode: "allow-all",
    aiOrigins: [],
  }),
);

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

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

async function mcp(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
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
  if (json.error) throw new Error(json.error.message ?? "mcp error");
  if (json.result?.isError) {
    throw new Error(json.result.content?.[0]?.text ?? `${name} failed`);
  }
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

async function waitForMcp() {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      await mcp("list_browser_tabs");
      return true;
    } catch {
      await wait(300);
    }
  }
  return false;
}

try {
  let client;
  try {
    client = await waitForWindow({ userData, waitForDebugPort });
  } catch (error) {
    // The app's own log is the only thing that explains a window that
    // never came up; without it this reads as "the debug port was slow".
    check("app window appeared", false, appLog.slice(-600));
    throw error;
  }
  check("app window appeared", true);
  await wait(2500);

  check("MCP endpoint answers", await waitForMcp());
  const opened = await mcp("open_browser_tab", { url: BASE, label: "音频测试" });
  const tabId = opened?.id;
  check("an AI-created tab is muted from the start", opened?.muted === true && Boolean(tabId), {
    tabId,
    muted: opened?.muted,
  });

  const tabState = async () =>
    client.evaluate(
      `(async () => (await window.ensemble.getEmbeddedState()).tabs.find((tab) => tab.id === ${JSON.stringify(tabId)}) ?? null)()`,
    );
  const tabAudio = async () =>
    client.evaluate(
      `document.querySelector('[data-tab-id="${tabId}"] [data-audio]')?.dataset.audio ?? null`,
    );

  /** Starts the page's tone through the page target, with a user gesture. */
  async function playTone() {
    const debugPort = await waitForDebugPort(userData);
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = list.find((item) => item.url.startsWith(BASE));
    if (!target) return false;
    const page = await connectToWindow(target.webSocketDebuggerUrl);
    try {
      const result = await page.send("Runtime.evaluate", {
        expression: "document.getElementById('tone').play()",
        userGesture: true,
        awaitPromise: true,
        returnByValue: true,
      });
      return !result?.exceptionDetails;
    } finally {
      page.close();
    }
  }

  const initial = await tabState();
  check(
    "the tab strip shows the muted speaker",
    initial?.muted === true && (await tabAudio()) === "muted",
    { state: initial, audio: await tabAudio() },
  );

  // The user asks for sound; later AI reads must not undo that.
  await client.evaluate(
    `document.querySelector('[data-tab-id="${tabId}"] [data-audio]')?.click()`,
  );
  await wait(900);
  const afterUserUnmute = await tabState();
  check(
    "clicking the speaker unmutes the tab and removes the muted mark",
    afterUserUnmute?.muted !== true && (await tabAudio()) === null,
    { state: afterUserUnmute, audio: await tabAudio() },
  );

  const played = await playTone();
  await wait(700);
  const audible = await tabState();
  check(
    "a page that is making sound shows the speaker",
    played === true && audible?.audible === true && (await tabAudio()) === "audible",
    { played, state: audible, audio: await tabAudio() },
  );

  await mcp("read_browser_page", { tabId });
  await wait(500);
  const afterAiRead = await tabState();
  check(
    "an AI read does not re-mute a tab the user unmuted",
    afterAiRead?.muted !== true,
    afterAiRead,
  );

  // Explicit AI mute still wins, and survives a reload.
  await mcp("set_browser_muted", { tabId, muted: true });
  await wait(500);
  const afterAiMute = await tabState();
  check(
    "the AI can mute explicitly",
    afterAiMute?.muted === true && (await tabAudio()) === "muted",
    { state: afterAiMute, audio: await tabAudio() },
  );

  await mcp("navigate_browser_tab", { tabId, url: BASE });
  await wait(1200);
  const afterReload = await tabState();
  check(
    "mute survives a reload",
    afterReload?.muted === true && (await tabAudio()) === "muted",
    { state: afterReload, audio: await tabAudio() },
  );

  // A fresh tab: AI unmute followed by an AI read must auto-mute again, because
  // no person asked for sound on this one.
  const fresh = await mcp("open_browser_tab", { url: BASE, label: "自动静音" });
  const freshId = fresh?.id;
  await mcp("set_browser_muted", { tabId: freshId, muted: false });
  await wait(400);
  const freshBefore = await client.evaluate(
    `(async () => (await window.ensemble.getEmbeddedState()).tabs.find((tab) => tab.id === ${JSON.stringify(freshId)}) ?? null)()`,
  );
  await mcp("read_browser_page", { tabId: freshId });
  await wait(500);
  const freshAfter = await client.evaluate(
    `(async () => (await window.ensemble.getEmbeddedState()).tabs.find((tab) => tab.id === ${JSON.stringify(freshId)}) ?? null)()`,
  );
  check(
    "an AI operation re-mutes a tab nobody unmuted",
    freshBefore?.muted !== true && freshAfter?.muted === true,
    { before: freshBefore, after: freshAfter },
  );

  /*
   * The default profile's session partition has a legacy name that contains
   * "clean". An AI reading that string concluded the page was a throwaway
   * session, so MCP must report the semantic profile and never the partition.
   */
  const defaultTab = await client.evaluate(
    `window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(BASE)}, viewId: null })`,
  );
  await wait(700);
  const listed = (await mcp("list_browser_tabs")).tabs.find(
    (tab) => tab.id === defaultTab?.id,
  );
  check(
    "a default-profile tab reports its profile and no storage partition",
    listed?.profileId === "default" &&
      listed?.clean !== true &&
      !Object.prototype.hasOwnProperty.call(listed ?? {}, "partition"),
    listed,
  );

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  pageServer.close();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
