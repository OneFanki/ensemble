#!/usr/bin/env node
/**
 * Proves a v1 workspace (environments / scenes) still opens after the rename.
 *
 * Writes a v1-shaped workspace.json into a throwaway userData dir, starts the
 * real app, and asks MCP what it sees. The point is that ids, credentials and
 * everything else survive a schema rename — not that the old schema is
 * supported forever.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_PORT = 49778;
const TOKEN = "v1-upgrade-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-v1-upgrade-"));

const stamp = "2026-01-01T00:00:00.000Z";
// Exactly the shape the released 0.4.0 wrote: environments, scenes, environmentId.
const v1Workspace = {
  version: 1,
  environments: [
    {
      id: "site-legacy-1",
      name: "旧版站点",
      baseUrl: "http://127.0.0.1:3999",
      loginPath: "/login",
      autoSubmit: false,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  identities: [
    {
      id: "identity-legacy-1",
      environmentId: "site-legacy-1",
      name: "旧版账号",
      username: "legacy-user",
      role: "管理员",
      color: "amber",
      passwordMode: "inherit",
      status: "unknown",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  scenes: [
    {
      id: "scene-legacy-1",
      environmentId: "site-legacy-1",
      name: "旧版场景",
      identityIds: ["identity-legacy-1"],
      layoutId: "1x1",
      slotAssignments: {},
      paths: {},
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  instances: [],
  manualEngines: [],
  layoutPresets: [],
};

mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, "workspace.json"), JSON.stringify(v1Workspace, null, 2));
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: true,
  }),
  { mode: 0o600 },
);

const electron = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const app = spawn(electron, [join(process.cwd(), "out", "main", "index.js")], {
  env: { ...process.env, ENSEMBLE_USER_DATA: userData, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
app.stdout.on("data", (chunk) => (log += chunk));
app.stderr.on("data", (chunk) => (log += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content[0].text}`);
  const text = json.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitForMcp() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // starting
    }
    await wait(400);
  }
  return false;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

try {
  const ready = await waitForMcp();
  check("app started on the v1 workspace", ready, ready ? undefined : log.slice(-600));
  if (ready) {
    const sites = await call("list_sites");
    check("old environment is now a site", sites.length === 1 && sites[0].id === "site-legacy-1", sites);
    const identities = await call("list_identities", {});
    check(
      "identity kept its id and moved to siteId",
      identities.length === 1 &&
        identities[0].id === "identity-legacy-1" &&
        identities[0].siteId === "site-legacy-1",
      identities,
    );
    const views = await call("list_views", {});
    check(
      "old scene is now a view on the same site",
      views.length === 1 && views[0].id === "scene-legacy-1" && views[0].siteId === "site-legacy-1",
      views,
    );
  }
} catch (error) {
  check("upgrade completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
