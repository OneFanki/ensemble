/**
 * README screenshot generator.
 *
 * Boots the built app against throwaway user-data directories seeded with neutral
 * demo data, drives it over CDP, and writes PNGs to docs/screenshots/. Running it
 * after a UI change keeps the README images current without manual cropping.
 *
 *   pnpm build && node scripts/capture-screenshots.mjs
 *   node scripts/capture-screenshots.mjs --only settings
 *
 * Requires a prior `pnpm build` (uses out/ through the local Electron binary).
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const OUTPUT_DIR = "docs/screenshots";

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

const electronBinary = process.platform === "win32"
  ? resolve("node_modules/electron/dist/electron.exe")
  : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

const DEMO = {
  zh: {
    environmentId: "11111111-1111-4111-8111-111111111111",
    environment: {
      name: "订单服务-测试环境",
    },
    extraEnvironments: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "支付服务-联调",
        baseUrl: "http://localhost:8080",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "会员服务-预发",
        baseUrl: "https://staging.example.test",
      },
    ],
    identities: [
      ["管理员 · 主账号", "admin@example.test", "admin", "amber"],
      ["审核员", "reviewer@example.test", "reviewer", "teal"],
      ["运营", "operator@example.test", "operator", "violet"],
      ["只读账号", "viewer@example.test", "viewer", "slate"],
    ],
    scene: "权限矩阵 · 主流程",
  },
  en: {
    environmentId: "11111111-1111-4111-8111-111111111111",
    environment: {
      name: "Order service — test",
    },
    extraEnvironments: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Payments — integration",
        baseUrl: "http://localhost:8080",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Membership — staging",
        baseUrl: "https://staging.example.test",
      },
    ],
    identities: [
      ["Admin · primary", "admin@example.test", "admin", "amber"],
      ["Reviewer", "reviewer@example.test", "reviewer", "teal"],
      ["Operator", "operator@example.test", "operator", "violet"],
      ["Read-only", "viewer@example.test", "viewer", "slate"],
    ],
    scene: "Permission matrix · main flow",
  },
};

const SHOTS = [
  { name: "environments", locale: "zh", view: "environments" },
  { name: "environments-en", locale: "en", view: "environments" },
  { name: "identities", locale: "zh", view: "identities" },
  { name: "identities-en", locale: "en", view: "identities" },
  { name: "scenes", locale: "zh", view: "scenes" },
  { name: "scenes-en", locale: "en", view: "scenes" },
  { name: "settings", locale: "zh", view: "settings" },
  { name: "settings-en", locale: "en", view: "settings" },
  { name: "light", locale: "zh", view: "identities", theme: "light" },
  { name: "light-en", locale: "en", view: "identities", theme: "light" },
  { name: "env-menu", locale: "zh", view: "identities", clicks: [".env-switch"] },
  {
    name: "env-dialog",
    locale: "zh",
    view: "environments",
    clicks: [".head-actions .btn.primary"],
  },
  {
    name: "env-dialog-hover",
    locale: "zh",
    view: "environments",
    clicks: [".head-actions .btn.primary"],
    hover: ".foot .btn.primary",
  },
  {
    name: "settings-data",
    locale: "zh",
    view: "settings",
    clicks: ['[role="tab"]:nth-child(4)'],
  },
  {
    name: "settings-mcp",
    locale: "zh",
    view: "settings",
    clicks: ['[role="tab"]:nth-child(5)'],
  },
  {
    name: "layout-editor",
    locale: "zh",
    view: "scenes",
    clicks: [".link-btn"],
  },
];

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

async function seed(userData, locale, theme = "dark") {
  const demo = DEMO[locale];
  const now = new Date().toISOString();
  await mkdir(join(userData, "profiles"), { recursive: true });

  const identities = demo.identities.map(([name, username, role, color], index) => ({
    id: uuid(index + 2),
    environmentId: demo.environmentId,
    name,
    username,
    role,
    color,
    passwordMode: "inherit",
    status: "unknown",
    startPath: "/",
    createdAt: now,
    updatedAt: now,
  }));

  await writeFile(
    join(userData, "workspace.json"),
    JSON.stringify(
      {
        version: 1,
        environments: [
          {
            id: demo.environmentId,
            name: demo.environment.name,
            baseUrl: "http://localhost:5173",
            loginPath: "/login",
            authCheckPath: "/api/me",
            autoSubmit: false,
            extraFields: [{ label: locale === "zh" ? "租户名" : "tenant", value: "acme" }],
            createdAt: now,
            updatedAt: now,
          },
          ...demo.extraEnvironments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            baseUrl: environment.baseUrl,
            loginPath: "/login",
            autoSubmit: false,
            createdAt: now,
            updatedAt: now,
          })),
        ],
        identities,
        scenes: [
          {
            id: uuid(6),
            environmentId: demo.environmentId,
            name: demo.scene,
            identityIds: identities.slice(0, 3).map((identity) => identity.id),
            layoutId: "3x1",
            slotAssignments: {},
            paths: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
        instances: [],
        manualEngines: [],
        layoutPresets: [],
      },
      null,
      2,
    ),
  );

  await writeFile(
    join(userData, "settings.json"),
    JSON.stringify(
      {
        theme,
        locale,
        lastView: "identities",
        layout: "2x2",
        autoFillOnLaunch: true,
        closeToTray: true,
      },
      null,
      2,
    ),
  );

  // AI access off by default so the README screenshots never expose a working
  // token; the settings section still renders the disabled state.
  await writeFile(
    join(userData, "mcp.json"),
    JSON.stringify(
      {
        enabled: false,
        port: 47821,
        token: "screenshot-token-not-valid",
        allowWrite: true,
        allowRun: true,
        allowDelete: false,
      },
      null,
      2,
    ),
  );
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

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
  await new Promise((resolvePromise) => socket.addEventListener("open", resolvePromise));
  return {
    send(method, params = {}) {
      return new Promise((resolvePromise) => {
        const id = ++nextId;
        pending.set(id, resolvePromise);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    evaluate(expression) {
      return this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    },
    close() {
      socket.close();
    },
  };
}

async function capture(shot) {
  const userData = await mkdtemp(join(tmpdir(), `ensemble-shot-${shot.name}-`));
  await seed(userData, shot.locale, shot.theme);

  const port = 9900 + Math.floor(Math.random() * 90);
  const child = spawn(
    electronBinary,
    [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
    { stdio: "ignore" },
  );

  try {
    let target;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((item) => item.type === "page" && !item.url.startsWith("devtools"));
        if (target) break;
      } catch {
        // The window has not opened its debugging port yet.
      }
    }
    if (!target) throw new Error(`${shot.name}: the app window never appeared`);

    const client = await connect(target.webSocketDebuggerUrl);
    await wait(3000);
    await client.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, mobile: false });
    await wait(700);

    if (shot.view !== "identities") {
      await client.evaluate(
        `(() => { const el = document.querySelector('[data-nav="${shot.view}"]'); if (el) el.click(); return Boolean(el); })()`,
      );
      await wait(900);
    }

    for (const selector of shot.clicks ?? []) {
      await client.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return Boolean(el); })()`,
      );
      await wait(700);
    }

    // Hover states are part of the UI too, and a gray "primary" button on hover
    // was exactly the kind of regression a static screenshot would miss.
    if (shot.hover) {
      const rect = await client.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(shot.hover)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (rect?.result?.value) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(rect.result.value.x),
          y: Math.round(rect.result.value.y),
        });
        await wait(400);
      }
    }

    // Long pages (settings) need a scroll target instead of a taller viewport so
    // the layout stays at the size users actually see.
    if (shot.scrollTo) {
      await client.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(shot.scrollTo)}); if (!el) return false; el.scrollIntoView({ block: "start" }); return true; })()`,
      );
      await wait(700);
    }

    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const path = join(OUTPUT_DIR, `${shot.name}.png`);
    await writeFile(path, Buffer.from(screenshot.data, "base64"));
    console.log(`captured ${path}`);
    client.close();
  } finally {
    child.kill();
    await wait(700);
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

if (!existsSync(electronBinary)) {
  console.error(`Electron binary not found at ${electronBinary}. Run pnpm install first.`);
  process.exit(1);
}
if (!existsSync("out/main/index.js")) {
  console.error("out/ is missing. Run `pnpm build` before capturing screenshots.");
  process.exit(1);
}

await mkdir(OUTPUT_DIR, { recursive: true });
for (const shot of SHOTS) {
  if (only && shot.name !== only) continue;
  await capture(shot);
}
