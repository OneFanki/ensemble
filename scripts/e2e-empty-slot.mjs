#!/usr/bin/env node
/**
 * End-to-end check of the empty slot's "add a page here" button.
 *
 * An empty slot has to look like a place a page belongs and put the new page in
 * that exact cell, focused — otherwise the follow-up ("type an address") starts
 * from the wrong tab.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-slot-"));
const port = 9755 + Math.floor(Math.random() * 50);
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "空槽位站点",
        baseUrl: "http://127.0.0.1:3997",
        loginPath: "/",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", onboardingVersion: 1 }),
);

const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
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

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools"),
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

  const created = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.createEmbeddedView({ layoutId: "2x1", name: "空槽位验证" });
    await new Promise((r) => setTimeout(r, 700));
    return {
      viewId: state.activeViewId,
      slots: state.views[0]?.slotTabs,
      bodies: document.querySelectorAll('.slot-empty').length,
      buttons: [...document.querySelectorAll('.slot-add')].map((el) => el.textContent.trim()),
      indexes: [...document.querySelectorAll('.slot-empty-index')].map((el) => el.textContent.trim()),
      emptyHeaders: document.querySelectorAll('.slot-header.empty').length,
    };
  })()`);
  check("view created with two empty slots", created?.slots?.length === 2, created);
  check("the stage draws one dashed cell per empty slot", created?.bodies === 2, created);
  check("each empty cell offers an add button", created?.buttons?.length === 2, created?.buttons);
  check(
    "an empty cell has no header band; its number sits inside the cell",
    created?.emptyHeaders === 0 && created?.indexes?.join(",") === "1,2",
    created,
  );

  // Click the second cell's button: the page must land in slot 2, not slot 1.
  const clicked = await client.evaluate(`(async () => {
    const before = await window.ensemble.getEmbeddedState();
    const buttons = [...document.querySelectorAll('.slot-add')];
    buttons[1]?.click();
    await new Promise((r) => setTimeout(r, 1500));
    const state = await window.ensemble.getEmbeddedState();
    const view = state.views.find((item) => item.id === state.activeViewId);
    return {
      slots: view?.slotTabs,
      focused: view?.focusedTabId,
      active: state.activeTabId,
      // Relative to the launch page that is still on the surface.
      tabs: state.tabs.length - before.tabs.length,
      address: document.querySelector('.address input')?.value ?? null,
    };
  })()`);
  check("clicking the second empty cell creates one page", clicked?.tabs === 1, clicked);
  check(
    "the page is pinned to the cell that was clicked",
    clicked?.slots?.[0] === null && Boolean(clicked?.slots?.[1]),
    clicked?.slots,
  );
  check(
    "the new page takes focus",
    clicked?.focused === clicked?.slots?.[1] && clicked?.active === clicked?.slots?.[1],
    { focused: clicked?.focused, active: clicked?.active },
  );
  check("a blank page leaves the address bar empty", clicked?.address === "", clicked?.address);

  const titles = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const row = document.querySelector('.dock .tab-row .tab-label')?.textContent?.trim();
    return { row, label: state.tabs[0]?.label, title: state.tabs[0]?.title };
  })()`);
  check(
    "the dock falls back to the tab label until the page reports a title",
    titles?.row === "新标签页" && titles?.row === titles?.label,
    titles,
  );

  client.close();
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
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
