#!/usr/bin/env node
/**
 * Smoke test for the packaged Windows build: starts the unpacked app with a
 * throwaway profile and checks the MCP endpoint actually answers there.
 *
 * `ENSEMBLE_UNPACKED` points at a different build output. The default is the
 * one `pnpm dist` writes, but building a second version while a copy of the
 * packaged app is running leaves that directory locked, so a parallel build
 * goes elsewhere and the smoke test is told where.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 49821;
const TOKEN = "packaged-smoke-token-1234567890";
const userData = mkdtempSync(join(tmpdir(), "ensemble-packaged-"));
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
  }),
  { mode: 0o600 },
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", onboardingVersion: 1 }),
);

const exe = resolve(process.env.ENSEMBLE_UNPACKED ?? "release/win-unpacked/Ensemble.exe");
const app = spawn(exe, [`--user-data-dir=${userData}`], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
app.stdout.on("data", (chunk) => (log += chunk));
app.stderr.on("data", (chunk) => (log += chunk));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return response.json();
}

try {
  let up = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await wait(500);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) {
        up = true;
        break;
      }
    } catch {
      // still starting
    }
  }
  console.log("endpoint up:", up);
  if (!up) throw new Error("MCP endpoint never answered");

  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  console.log("initialize:", init.result?.serverInfo);

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = list.result?.tools ?? [];
  console.log("tool count:", tools.length);
  const names = tools.map((tool) => tool.name);
  const required = [
    "create_site",
    "create_identities",
    "open_browser_tab",
    "read_browser_page",
    "type_browser_text",
    "create_view",
    "open_browser_view",
    // The tools added for "everything a human can arrange, an AI can arrange".
    "move_browser_tab",
    "set_tab_page",
    "save_tag",
    "delete_tag",
    "export_accounts",
    "preview_accounts",
    "import_accounts",
    // Targeting elements the way a person reads them, and waiting page-side.
    "fill_browser_form",
    "wait_browser",
    // Worked-out sequences become a reusable asset instead of a lost session.
    "list_flows",
    "save_flow",
    "run_flow",
    "delete_flow",
  ];
  console.log(
    "missing:",
    required.filter((name) => !names.includes(name)),
  );
  const typeProps = Object.keys(
    tools.find((tool) => tool.name === "type_browser_text")?.inputSchema?.properties ?? {},
  );
  console.log("type_browser_text accepts a label:", typeProps.includes("label"));
  const waitSchema = tools.find((tool) => tool.name === "wait_browser")?.inputSchema?.properties;
  console.log(
    "wait_browser conditions:",
    (waitSchema?.condition?.enum ?? []).join("/") || "none",
  );
  const batch = tools.find((tool) => tool.name === "create_identities");
  const itemProps = Object.keys(batch?.inputSchema?.properties?.identities?.items?.properties ?? {});
  console.log("create_identities item fields:", itemProps.join(", "));
  const siteProps = Object.keys(tools.find((tool) => tool.name === "create_site")?.inputSchema?.properties ?? {});
  console.log("create_site has password:", siteProps.includes("password"));

  // A real write through the packaged app, then read it back.
  const site = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "create_site",
      arguments: { name: "冒烟站点", baseUrl: "http://127.0.0.1:3999", password: "smoke-secret" },
    },
  });
  const sitePayload = JSON.parse(site.result.content[0].text);
  console.log("create_site ok:", Boolean(sitePayload.id), "no echo:", !JSON.stringify(sitePayload).includes("smoke-secret"));

  const batchCall = await rpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "create_identities",
      arguments: {
        siteId: sitePayload.id,
        identities: [
          {
            name: "租户 A",
            username: "a@example.test",
            password: "a-secret",
            extraFields: [{ label: "租户名", value: "租户 A" }],
          },
        ],
      },
    },
  });
  const created = JSON.parse(batchCall.result.content[0].text);
  console.log(
    "batch keeps extraFields:",
    created.created?.[0]?.extraFields?.[0]?.value === "租户 A",
    "failures:",
    created.failures?.length,
  );

  // Account bundles go through real file IO in the main process; a packaged
  // build resolves `userData` differently, so the path is worth checking here.
  const exported = await rpc({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "export_accounts",
      arguments: {
        siteIds: [sitePayload.id],
        identityIds: [created.created[0].id],
        passphrase: "smoke-share-passphrase",
      },
    },
  });
  const bundle = JSON.parse(exported.result.content[0].text);
  console.log(
    "export_accounts ok:",
    Boolean(bundle?.path) && bundle?.counts?.accounts === 1,
    "path:",
    bundle?.path,
  );
  if (bundle?.path) {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(bundle.path, "utf8");
    console.log(
      "bundle has no plaintext:",
      !text.includes("a-secret") && !text.includes("smoke-share-passphrase"),
    );
    const preview = await rpc({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "preview_accounts", arguments: { path: bundle.path } },
    });
    const previewed = JSON.parse(preview.result.content[0].text);
    console.log("preview_accounts ok:", previewed?.accounts === 1 && previewed?.hasSecrets === true);

    const imported = await rpc({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "import_accounts",
        arguments: { path: bundle.path, passphrase: "smoke-share-passphrase" },
      },
    });
    const merged = JSON.parse(imported.result.content[0].text);
    console.log(
      "import_accounts merges in place:",
      merged?.accountsAdded === 0 && merged?.accountsUpdated === 1,
    );
  }

  // The audit log lives next to the throwaway profile, never in the real one.
  const { readFileSync } = await import("node:fs");
  try {
    const audit = readFileSync(join(userData, "mcp-audit.log"), "utf8");
    console.log(
      "audit log has no secrets:",
      !audit.includes("a-secret") && !audit.includes("smoke-share-passphrase"),
    );
  } catch {
    console.log("audit log missing");
  }
} catch (error) {
  console.log("SMOKE ERROR", String(error));
  console.log("app log tail:", log.slice(-800));
  process.exitCode = 1;
} finally {
  app.kill();
  await wait(1500);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
}
