#!/usr/bin/env node
/**
 * End-to-end check of site tags through MCP against the real app.
 *
 * Creates two tags, three sites, attaches tags, then verifies the site list is
 * grouped as expected and that deleting a tag leaves the sites intact.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_PORT = 49779;
const TOKEN = "site-tags-e2e-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-tags-e2e-"));

mkdirSync(userData, { recursive: true });
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
  env: { ...process.env, ENSEMBLE_USER_DATA: userData },
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
  check("app started", ready, ready ? undefined : log.slice(-600));
  if (ready) {
    const backend = await call("save_site_tag", { name: "后台系统", color: "teal" });
    const frontend = await call("save_site_tag", { name: "前台", color: "blue" });
    check("tags created", Boolean(backend.id && frontend.id), {
      backend: backend.id,
      frontend: frontend.id,
    });

    const a = await call("create_site", {
      name: "后台-本地",
      baseUrl: "http://127.0.0.1:3001",
      tagIds: [backend.id],
    });
    const b = await call("create_site", {
      name: "前台-本地",
      baseUrl: "http://127.0.0.1:3002",
      tagIds: [frontend.id],
    });
    const c = await call("create_site", {
      name: "未分组站点",
      baseUrl: "http://127.0.0.1:3003",
    });
    check("three sites created", [a.id, b.id, c.id].every(Boolean));

    const listed = await call("list_sites", {});
    const byName = Object.fromEntries(listed.map((site) => [site.name, site.tags]));
    check("tag names are resolved on the site list", byName["后台-本地"]?.includes("后台系统"), byName);
    check("a site can carry a different tag", byName["前台-本地"]?.includes("前台"), byName);
    check("untagged sites list no tags", (byName["未分组站点"] ?? []).length === 0, byName);

    // A site can hold more than one tag.
    await call("update_site", {
      id: a.id,
      name: "后台-本地",
      baseUrl: "http://127.0.0.1:3001",
      tagIds: [backend.id, frontend.id],
    });
    const afterMulti = await call("list_sites", {});
    const multi = afterMulti.find((site) => site.id === a.id);
    check("a site can carry several tags", multi.tags.length === 2, multi.tags);

    // Deleting a tag must leave the sites intact.
    await call("delete_site_tag", { id: backend.id, confirm: true });
    const remaining = await call("list_site_tags");
    check("tag deleted", remaining.length === 1, remaining.map((tag) => tag.name));

    const sitesAfter = await call("list_sites", {});
    check("sites survive tag deletion", sitesAfter.length === 3, sitesAfter.length);
    const survivor = sitesAfter.find((site) => site.id === a.id);
    check(
      "the deleted tag is gone from the site, the other remains",
      survivor.tags.length === 1 && survivor.tags[0] === "前台",
      survivor.tags,
    );

    const identities = await call("list_identities", {});
    check("identities unaffected", identities.length === 0);
  }
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
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
