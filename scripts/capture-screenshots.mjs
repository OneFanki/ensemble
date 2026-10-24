#!/usr/bin/env node
/**
 * Captures the README screenshots from the real built app.
 *
 *   pnpm build && node scripts/capture-screenshots.mjs
 *   node scripts/capture-screenshots.mjs --only browser
 *
 * Requires a prior `pnpm build` (uses out/ through the local Electron binary).
 * Each shot gets its own throwaway userData directory seeded with the same
 * representative workspace, so a shot never depends on another one's leftovers.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const OUTPUT_DIR = "docs/screenshots";
const PAGE_PORT = 3999;

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

/**
 * A local page for the built-in browser shots. It has to be a real server: the
 * whole point of the browser page is that native views paint over the stage.
 *
 * It also serves an icon: the dock's icon strip and the page rows read their
 * favicon from here, and a screenshot full of placeholder globes would not show
 * the thing those rows are for.
 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="8" fill="#2f6fae"/>
<path d="M9 22V10h4l3 7 3-7h4v12h-3v-8l-3 7h-1l-3-7v8z" fill="#fff"/>
</svg>`;

const demoPage = createServer((req, res) => {
  if (req.url === "/favicon.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=300" });
    res.end(FAVICON_SVG);
    return;
  }
  const who = decodeURIComponent((req.url ?? "/").split("/")[1] || "console");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${who} · 控制台</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
body{font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:18px 22px;background:#0f1419;color:#dbe3ec}
h1{font-size:16px;margin:0 0 10px;padding-bottom:10px;border-bottom:1px solid #26313d;font-weight:500}
nav a{color:#6ea8dc;margin-right:14px;text-decoration:none;font-size:12px}
ul{list-style:none;padding:0;margin:16px 0 0}
li{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1c2530;color:#9babbd}
li b{color:#dbe3ec;font-weight:500}
.row{display:flex;gap:8px;margin-top:18px}
button{background:#2f6fae;color:#fff;border:0;border-radius:5px;padding:6px 12px;font-size:12px}
button.ghost{background:#1c2530;color:#9babbd}
</style></head><body>
<h1>${who}</h1>
<nav><a href="/console">控制台</a><a href="/orders">订单</a><a href="/docs">接口文档</a></nav>
<ul><li><span>今日订单</span><b>128</b></li><li><span>待审核</span><b>4</b></li><li><span>异常</span><b>0</b></li></ul>
<div class="row"><button>删除用户</button><button class="ghost">导出</button></div>
</body></html>`);
});
await new Promise((r) => demoPage.listen(PAGE_PORT, "127.0.0.1", r));

const DEMO = {
  zh: {
    site: "后台系统 · 本地",
    second: "后台系统 · 测试",
    tag: "后台系统",
    // Extra tags give the tag page something to show: one unused tag is the
    // case the page is meant to surface.
    extraTags: [
      ["生产环境", "amber"],
      ["只读账号", "violet"],
    ],
    people: [
      ["管理员 · 主账号", "admin@example.test", "管理员", "amber"],
      ["成员 · 子账号", "member@example.test", "成员", "teal"],
      ["访客", "guest@example.test", "只读", "violet"],
      ["审核员", "review@example.test", "审核", "rose"],
    ],
    view: "权限矩阵 · 主流程",
    flow: {
      name: "创建租户",
      description: "打开租户管理，按参数建一个租户，备注里带上页面上的订单号",
      params: [
        { name: "tenant", label: "租户名", required: true },
        { name: "kind", label: "套餐", default: "标准版" },
      ],
      steps: [
        { action: "navigate", url: "/console" },
        { action: "wait", condition: "visible", text: "创建租户", timeoutMs: 8000 },
        { action: "read", text: "ORD-", as: "order" },
        { action: "fill", label: "租户名称", value: "{{tenant}}" },
        { action: "select", label: "套餐", option: "{{kind}}" },
        { action: "fill", label: "备注", value: "订单 {{order}}" },
        { action: "click", text: "创建租户" },
        { action: "wait", condition: "text", expect: "{{tenant}}" },
      ],
    },
  },
  en: {
    site: "Back office — local",
    second: "Back office — staging",
    tag: "Back office",
    extraTags: [
      ["Production", "amber"],
      ["Read-only", "violet"],
    ],
    people: [
      ["Admin · primary", "admin@example.test", "Admin", "amber"],
      ["Member", "member@example.test", "Member", "teal"],
      ["Guest", "guest@example.test", "Read-only", "violet"],
      ["Reviewer", "review@example.test", "Reviewer", "rose"],
    ],
    view: "Permission matrix · main flow",
    flow: {
      name: "Create tenant",
      description: "Open tenant management, create one tenant from parameters, note the order number from the page",
      params: [
        { name: "tenant", label: "Tenant name", required: true },
        { name: "kind", label: "Plan", default: "Standard" },
      ],
      steps: [
        { action: "navigate", url: "/console" },
        { action: "wait", condition: "visible", text: "Create tenant", timeoutMs: 8000 },
        { action: "read", text: "ORD-", as: "order" },
        { action: "fill", label: "Tenant name", value: "{{tenant}}" },
        { action: "select", label: "Plan", option: "{{kind}}" },
        { action: "fill", label: "Note", value: "Order {{order}}" },
        { action: "click", text: "Create tenant" },
        { action: "wait", condition: "text", expect: "{{tenant}}" },
      ],
    },
  },
};

const SHOTS = [
  { name: "browser", locale: "zh", view: "browser" },
  { name: "browser-en", locale: "en", view: "browser" },
  { name: "slot-tabs", locale: "zh", view: "browser", popup: true },
  { name: "new-tab", locale: "zh", view: "browser", blankTab: true },
  {
    // The collapsed dock keeps one icon per running instance; the shot proves
    // the strip is still usable when the panel is out of the way.
    name: "dock-collapsed",
    locale: "zh",
    view: "browser",
    collapsedDock: true,
  },
  { name: "sites", locale: "zh", view: "sites" },
  { name: "sites-en", locale: "en", view: "sites" },
  { name: "identities", locale: "zh", view: "identities" },
  { name: "identities-en", locale: "en", view: "identities" },
  { name: "views", locale: "zh", view: "views" },
  { name: "views-en", locale: "en", view: "views" },
  { name: "settings", locale: "zh", view: "settings" },
  { name: "settings-en", locale: "en", view: "settings" },
  { name: "light", locale: "zh", view: "browser", theme: "light" },
  { name: "light-en", locale: "en", view: "browser", theme: "light" },
  { name: "env-menu", locale: "zh", view: "browser", clicks: [".split-more"] },
  {
    name: "site-dialog",
    locale: "zh",
    view: "sites",
    clicks: [".head-actions .btn.primary"],
  },
  {
    name: "identity-dialog",
    locale: "zh",
    view: "identities",
    clicks: [".id-card .card-actions .edit"],
  },
  {
    name: "identity-reference",
    locale: "zh",
    view: "identities",
    clicks: [".id-card .card-actions .edit"],
    script: `(() => { const seg = [...document.querySelectorAll('.seg')].find((el) => el.textContent.includes('引用')); seg?.click(); return Boolean(seg); })()`,
  },
  {
    // Tags are a page of their own in the rail now, not a Settings tab.
    name: "tags",
    locale: "zh",
    view: "tags",
  },
  {
    // Same reason as tags: flows are an asset people browse, not a setting.
    name: "flows",
    locale: "zh",
    view: "flows",
  },
  {
    name: "flows-edit",
    locale: "zh",
    view: "flows",
    clicks: [".detail-actions .icon-btn"],
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
    name: "settings-about",
    locale: "zh",
    view: "settings",
    clicks: ['[role="tab"]:nth-child(6)'],
  },
  {
    name: "layout-editor",
    locale: "zh",
    view: "views",
    clicks: [".link-btn"],
  },
];

function uuid(index) {
  return `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-8${String(index).repeat(3)}-${String(index).repeat(12)}`;
}

/** Writes a workspace in the current schema; the app reads it on startup. */
async function seed(userData, locale, theme = "dark") {
  const demo = DEMO[locale];
  const now = new Date().toISOString();
  await mkdir(join(userData, "profiles"), { recursive: true });

  const siteId = uuid(1);
  const secondId = uuid(9);
  const identities = demo.people.map(([name, username, role, color], index) => ({
    id: uuid(index + 2),
    siteId,
    name,
    username,
    role,
    color,
    passwordMode: "inherit",
    status: "unknown",
    startPath: "/",
    // Spread the two extra tags across accounts so the filter strip and the tag
    // page show real usage instead of a row of zeros.
    tagIds: index === 1 ? [uuid(11)] : index === 2 ? [uuid(12)] : [],
    createdAt: now,
    updatedAt: now,
  }));

  await writeFile(
    join(userData, "workspace.json"),
    JSON.stringify(
      {
        version: 2,
        tags: [
          { id: uuid(8), name: demo.tag, color: "blue" },
          ...demo.extraTags.map(([name, color], index) => ({
            id: uuid(11 + index),
            name,
            color,
          })),
        ],
        sites: [
          {
            id: siteId,
            name: demo.site,
            baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
            loginPath: "/console",
            authCheckPath: "/api/me",
            autoSubmit: false,
            tagIds: [uuid(8)],
            extraFields: [{ label: locale === "zh" ? "租户名" : "tenant", value: "acme" }],
            createdAt: now,
            updatedAt: now,
          },
          {
            id: secondId,
            name: demo.second,
            baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
            loginPath: "/console",
            autoSubmit: false,
            tagIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        identities: [
          ...identities,
          // One account on the second site so the reference picker has a source
          // to offer; it is filtered out of the first site's identity list.
          {
            id: uuid(7),
            siteId: secondId,
            name: demo.people[0][0],
            username: demo.people[0][1],
            role: demo.people[0][2],
            color: demo.people[0][3],
            passwordMode: "inherit",
            status: "unknown",
            startPath: "/",
            createdAt: now,
            updatedAt: now,
          },
        ],
        views: [
          {
            id: uuid(6),
            siteId,
            name: demo.view,
            identityIds: identities.map((identity) => identity.id),
            layoutId: "2x2",
            slotAssignments: {},
            paths: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
        // A saved flow so the rail's Flows page is not an empty state in the
        // docs. Same shape `save_flow` writes.
        flows: [
          {
            id: uuid(5),
            siteId,
            name: demo.flow.name,
            description: demo.flow.description,
            params: demo.flow.params,
            steps: demo.flow.steps,
            createdAt: now,
            updatedAt: now,
          },
        ],
        instances: [],
        manualEngines: [],
        layoutPresets: [],
        // Bookmarks are what a new tab shows, so the shot needs real ones. Kept
        // on the local demo server: a screenshot must not depend on the network,
        // and their tiles fall back to the coloured initial on purpose.
        bookmarks: [
          {
            id: uuid(20),
            name: demo.site,
            url: `http://127.0.0.1:${PAGE_PORT}/console`,
            order: 0,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: uuid(21),
            name: locale === "zh" ? "接口文档" : "API docs",
            url: `http://127.0.0.1:${PAGE_PORT}/docs`,
            order: 1,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: uuid(22),
            name: locale === "zh" ? "发布流水线" : "Release pipeline",
            url: `http://127.0.0.1:${PAGE_PORT}/builds`,
            order: 2,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: uuid(23),
            name: locale === "zh" ? "监控面板" : "Dashboards",
            url: `http://127.0.0.1:${PAGE_PORT}/metrics`,
            order: 3,
            createdAt: now,
            updatedAt: now,
          },
        ],
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
        lastView: "browser",
        layout: "2x2",
        autoFillOnLaunch: true,
        closeToTray: true,
        onboardingVersion: 1,
        autoCheckUpdates: false,
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
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result?.result?.value;
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
    // Headless: the shot is taken over CDP, so the window never has to appear —
    // and it must not, because capturing a whole screenshot pass would otherwise
    // flash a window in front of whatever the machine's user is doing.
    { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: "ignore" },
  );

  try {
    let target;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await wait(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        // The built-in surface lives in the main window; its pages are also
        // "page" targets, so pick the one with the app's own URL.
        target = list.find(
          (item) =>
            item.type === "page" &&
            !item.url.startsWith("devtools") &&
            item.url.includes("index.html") &&
            !item.url.includes("#"),
        );
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

    // Manage the browser page's tabs so the browser shot shows a full 2×2 view.
    if (shot.view === "browser") {
      await client.evaluate(
        `(async () => {
           const api = window.ensemble;
           const snap = await api.getWorkspace();
           const view = snap.views[0];
           // A new-tab shot is about the surface, not the grid; opening the view
           // would add four dock rows behind a page nobody can see.
           if (view && !${shot.blankTab ? "true" : "false"}) await api.openEmbeddedView(view.id);
           return true;
         })()`,
      );
      await wait(2500);
      // A blank tab is what the new-tab surface lives on: it is drawn by the
      // app, because the main process keeps a blank page's native view parked.
      if (shot.blankTab) {
        await client.evaluate(`(async () => {
          const api = window.ensemble;
          // Exactly one loose page: launch already opens one, and a second would
          // be a duplicate "new tab" row in the dock for no reason.
          for (const tab of (await api.getEmbeddedState()).tabs) {
            if (!tab.viewId) await api.closeEmbeddedTab(tab.id);
          }
          // Loose tab, so it gets the whole stage instead of one cell of a view.
          await api.openEmbeddedTab({ viewId: null });
          await new Promise((r) => setTimeout(r, 900));
          return true;
        })()`);
        await wait(1200);
      }
      // An instance can hold several pages without taking extra cells. Opening
      // one from the page itself is the only way to produce that state here.
      if (shot.popup) {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const pageTarget = list.find(
          (item) => item.type === "page" && item.url.startsWith(`http://127.0.0.1:${PAGE_PORT}`),
        );
        if (pageTarget) {
          const pageClient = await connect(pageTarget.webSocketDebuggerUrl);
          await pageClient.evaluate(`(() => { window.open('/second', '_blank'); return true; })()`);
          pageClient.close();
          await wait(1800);
        }
      }
      // Collapse before freezing: the frozen images are placed at the stage
      // rectangle measured at capture time, so collapsing afterwards would
      // leave them at their old width and show a dead band beside the strip.
      if (shot.collapsedDock) {
        // One view is a single group, and a strip with one group cannot show
        // its group boundaries. Open a second container and a loose page so the
        // shot shows what the strip is actually for.
        await client.evaluate(`(async () => {
          const api = window.ensemble;
          const created = await api.createEmbeddedView({ layoutId: "1x1", name: "第二组" });
          await api.openEmbeddedTabInSlot(created.activeViewId, 0);
          await new Promise((r) => setTimeout(r, 700));
          await api.openEmbeddedTab({ viewId: null, url: "http://127.0.0.1:${PAGE_PORT}/docs" });
          await new Promise((r) => setTimeout(r, 1200));
          return true;
        })()`);
        await client.evaluate(`(() => {
          document.querySelector('.dock-head .collapse-btn')?.click();
          return true;
        })()`);
        await wait(700);
      }
      // Re-report the stage after any layout change above. The freeze uses the
      // main process's last known stage rect, and a wide-to-strip transition
      // reports asynchronously; capturing before it lands paints every cell at
      // the old width and leaves a dead band on the right.
      await client.evaluate(`(async () => {
        const stage = document.querySelector('.stage');
        if (!stage) return false;
        const box = stage.getBoundingClientRect();
        await window.ensemble.setEmbeddedStage({
          x: Math.round(box.left),
          y: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
        await new Promise((r) => setTimeout(r, 400));
        return true;
      })()`);
      // Native views are not part of the window's own pixels, so a plain
      // screenshot leaves the stage black. Freeze each page and paint the images
      // into the DOM instead — the same mechanism the app uses for its overlays.
      await client.evaluate(
        `(async () => {
           const api = window.ensemble;
           const stage = document.querySelector('.stage');
           if (!stage) return false;
           const slots = await api.freezeEmbedded();
           const box = stage.getBoundingClientRect();
           api.setEmbeddedStage(null);
           for (const slot of slots) {
             const img = document.createElement('img');
             img.src = slot.dataUrl;
             Object.assign(img.style, {
               position: 'absolute',
               left: (slot.rect.x - Math.round(box.left)) + 'px',
               top: (slot.rect.y - Math.round(box.top)) + 'px',
               width: slot.rect.width + 'px',
               height: slot.rect.height + 'px',
             });
             stage.appendChild(img);
           }
           return slots.length;
         })()`,
      );
      await wait(1200);
    } else {
      // The app opens on the browser page, so every other shot has to navigate
      // there explicitly — including identities, which used to be the default.
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

    if (shot.script) {
      await client.evaluate(shot.script);
      await wait(600);
    }

    // Hover states are part of the UI too, and a gray "primary" button on hover
    // was exactly the kind of regression a static screenshot would miss.
    if (shot.hover) {
      const rect = await client.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(shot.hover)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      if (rect) {
        await client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(rect.x),
          y: Math.round(rect.y),
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
demoPage.close();
