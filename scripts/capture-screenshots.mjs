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
import { freePort, waitForDebugPort } from "./lib/e2e-ports.mjs";
import { openNav } from "./lib/e2e-nav.mjs";

const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };
const OUTPUT_DIR = "docs/screenshots";
// Ask the OS: a fixed number can be reserved by Hyper-V after a reboot, and the
// failure reads as "the window never appeared" rather than as a port problem.
const PAGE_PORT = await freePort();

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

/**
 * Four role consoles for the hero shot: the whole product is "same system,
 * different identities see different things", so the four cells of the 2×2
 * view each render a different role's console — menus, cards, table rows and
 * action buttons all differ, and every page carries its identity badge in the
 * identity colour the running dock uses for the same account.
 */
const ROLE_PAGES = {
  admin: {
    accent: "#d9a13c",
    zh: {
      role: "管理员 · 主账号",
      heading: "用户管理",
      menu: ["总览", "用户管理", "订单", "财务", "系统设置"],
      cards: [
        ["用户总数", "1,284"],
        ["今日活跃", "356"],
        ["本月收入", "¥86,400"],
        ["异常登录", "2"],
      ],
      columns: ["用户", "角色", "状态", ""],
      rows: [
        ["李明 · 运营", "成员", "启用", "ok"],
        ["王芳 · 市场", "成员", "启用", "ok"],
        ["赵强 · 实习", "访客", "停用", "bad"],
        ["陈静 · 财务", "审核", "启用", "ok"],
      ],
      primary: "新增用户",
      rowActions: ["编辑", "删除"],
      rowDanger: "删除",
    },
    en: {
      role: "Admin · primary",
      heading: "Users",
      menu: ["Overview", "Users", "Orders", "Billing", "System"],
      cards: [
        ["Total users", "1,284"],
        ["Active today", "356"],
        ["Revenue MTD", "$86,400"],
        ["Suspicious logins", "2"],
      ],
      columns: ["User", "Role", "Status", ""],
      rows: [
        ["Li Ming · Ops", "Member", "Active", "ok"],
        ["Wang Fang · Growth", "Member", "Active", "ok"],
        ["Zhao Qiang · Intern", "Guest", "Disabled", "bad"],
        ["Chen Jing · Finance", "Reviewer", "Active", "ok"],
      ],
      primary: "New user",
      rowActions: ["Edit", "Delete"],
      rowDanger: "Delete",
    },
  },
  member: {
    accent: "#2f9e8f",
    zh: {
      role: "成员 · 子账号",
      heading: "我的订单",
      menu: ["总览", "我的订单", "个人设置"],
      cards: [
        ["我的订单", "32"],
        ["进行中", "5"],
        ["本月提成", "¥4,280"],
        ["好评率", "98%"],
      ],
      columns: ["订单号", "金额", "状态"],
      rows: [
        ["ORD-10241", "¥1,280", "进行中", "warn"],
        ["ORD-10233", "¥860", "已完成", "ok"],
        ["ORD-10218", "¥2,400", "已完成", "ok"],
        ["ORD-10196", "¥540", "已取消", "bad"],
      ],
      primary: "导出明细",
      notice: "部分字段仅管理员可见",
    },
    en: {
      role: "Member",
      heading: "My orders",
      menu: ["Overview", "My orders", "Profile"],
      cards: [
        ["My orders", "32"],
        ["In progress", "5"],
        ["Commission MTD", "$4,280"],
        ["Approval rate", "98%"],
      ],
      columns: ["Order", "Amount", "Status"],
      rows: [
        ["ORD-10241", "$1,280", "In progress", "warn"],
        ["ORD-10233", "$860", "Completed", "ok"],
        ["ORD-10218", "$2,400", "Completed", "ok"],
        ["ORD-10196", "$540", "Cancelled", "bad"],
      ],
      primary: "Export",
      notice: "Some fields are only visible to admins",
    },
  },
  review: {
    accent: "#d05070",
    zh: {
      role: "审核员",
      heading: "审核队列",
      menu: ["审核队列", "申诉处理"],
      cards: [
        ["待审核", "12"],
        ["今日已审", "34"],
        ["平均耗时", "4.2 分钟"],
        ["申诉中", "3"],
      ],
      columns: ["条目", "提交人", "操作"],
      rows: [
        ["新专辑《回响》封面", "星辰传媒", "ok"],
        ["单曲《夜航》歌词", "蓝鲸文化", "ok"],
        ["厂牌主页改版", "南山出版", "warn"],
        ["活动海报 #4471", "远声唱片", "warn"],
      ],
    },
    en: {
      role: "Reviewer",
      heading: "Review queue",
      menu: ["Review queue", "Appeals"],
      cards: [
        ["Pending", "12"],
        ["Reviewed today", "34"],
        ["Avg. time", "4.2 min"],
        ["Appeals", "3"],
      ],
      columns: ["Item", "Submitter", "Action"],
      rows: [
        ["Album cover “Echo”", "Starline Media", "ok"],
        ["Lyrics “Night Flight”", "Blue Whale", "ok"],
        ["Label site revamp", "Nanshan Press", "warn"],
        ["Poster #4471", "Yuansheng", "warn"],
      ],
    },
  },
  guest: {
    accent: "#7d6ee0",
    zh: {
      role: "访客",
      heading: "总览",
      menu: ["总览"],
      cards: [
        ["用户总数", "——"],
        ["今日活跃", "——"],
        ["本月收入", "——"],
        ["异常登录", "——"],
      ],
      columns: ["用户", "角色", "状态"],
      rows: [
        ["******", "成员", "只读", "muted"],
        ["******", "成员", "只读", "muted"],
        ["******", "审核", "只读", "muted"],
        ["******", "访客", "只读", "muted"],
      ],
      notice: "当前为只读身份，数据已脱敏",
    },
    en: {
      role: "Guest",
      heading: "Overview",
      menu: ["Overview"],
      cards: [
        ["Total users", "——"],
        ["Active today", "——"],
        ["Revenue MTD", "——"],
        ["Suspicious logins", "——"],
      ],
      columns: ["User", "Role", "Status"],
      rows: [
        ["******", "Member", "Read-only", "muted"],
        ["******", "Member", "Read-only", "muted"],
        ["******", "Reviewer", "Read-only", "muted"],
        ["******", "Guest", "Read-only", "muted"],
      ],
      notice: "Read-only identity — data is masked",
    },
  },
};

/**
 * One role console, sized for the cell it lives in: the 2×2 grid gives each
 * page roughly 570×370, so the layout is a narrow sidebar, a 2×2 card grid and
 * a three-to-four column table — no horizontal scroll, nothing clipped. Every
 * page carries its identity badge in the same colour the running dock uses for
 * that account, which is what makes the four cells read as four accounts.
 */
function renderRole(role, lang) {
  const page = ROLE_PAGES[role][lang];
  const t = lang === "en" ? "Back office" : "后台系统";

  const menuItems = page.menu
    .map(
      (item, index) =>
        `<a class="${index === (role === "review" ? 0 : 1) ? "on" : ""}">${index === 0 ? "◈" : "▫"} ${item}</a>`,
    )
    .join("");

  const cards = page.cards
    .map(
      ([label, value]) =>
        `<div class="card"><span class="card-label">${label}</span><span class="card-value">${value}</span></div>`,
    )
    .join("");

  // Each role's table has its own shape, built per role so the columns stay
  // readable at this width.
  const status = (text, tone) => `<span class="status ${tone}"><i></i>${text}</span>`;
  let rows = "";
  if (role === "admin") {
    const actions = `<span class="row-actions"><button class="mini">${page.rowActions[0]}</button><button class="mini danger">${page.rowActions[1]}</button></span>`;
    rows = page.rows
      .map(
        ([who, kind, state, tone]) =>
          `<tr><td>${who}</td><td>${kind}</td><td>${status(state, tone)}</td><td>${actions}</td></tr>`,
      )
      .join("");
  } else if (role === "member") {
    rows = page.rows
      .map(
        ([order, amount, state, tone]) =>
          `<tr><td class="mono">${order}</td><td class="mono">${amount}</td><td>${status(state, tone)}</td></tr>`,
      )
      .join("");
  } else if (role === "review") {
    const actions = `<span class="row-actions"><button class="mini ok">${lang === "en" ? "Approve" : "通过"}</button><button class="mini danger">${lang === "en" ? "Reject" : "驳回"}</button></span>`;
    rows = page.rows
      .map(([item, by]) => `<tr><td>${item}</td><td>${by}</td><td>${actions}</td></tr>`)
      .join("");
  } else {
    rows = page.rows
      .map(([who, kind, state, tone]) => `<tr><td>${who}</td><td>${kind}</td><td>${status(state, tone)}</td></tr>`)
      .join("");
  }

  const notice = page.notice ? `<div class="notice"><i>ⓘ</i>${page.notice}</div>` : "";
  const primary = page.primary
    ? `<div class="head-actions"><button class="primary">${page.primary}</button></div>`
    : "";

  return `<!doctype html><html lang="${lang === "en" ? "en" : "zh-CN"}"><head><meta charset="utf-8"><title>${page.role} · ${t}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
*{box-sizing:border-box}
body{font:11px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#12161c;color:#e6ecf3;display:flex;height:100vh;overflow:hidden}
aside{width:92px;flex:none;background:#161b22;border-right:1px solid #232b35;padding:10px 7px;display:flex;flex-direction:column;gap:2px}
.brand{font-size:11px;font-weight:600;letter-spacing:.3px;padding:1px 7px 10px;color:#e6ecf3;white-space:nowrap}
.menu{display:flex;flex-direction:column;gap:2px}
aside a{color:#8b99a9;text-decoration:none;font-size:10.5px;padding:6px 8px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
aside a.on{background:color-mix(in srgb,{{ACCENT}} 16%,transparent);color:{{ACCENT}};font-weight:600}
main{flex:1;min-width:0;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #232b35}
header h1{font-size:13px;font-weight:600;margin:0}
.head-actions{display:flex;gap:6px;margin-left:auto}
.primary{background:{{ACCENT}};color:#141414;border:0;border-radius:6px;padding:4px 11px;font-size:10.5px;font-weight:600}
.badge{display:flex;align-items:center;gap:6px;background:#1a212a;border:1px solid #2a3340;border-radius:999px;padding:3px 10px 3px 7px;font-size:10.5px;color:#c8d2dd;flex:none;margin-left:${page.primary ? "0" : "auto"}}
.content{padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow:hidden}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.card{background:#1a2029;border:1px solid #242d38;border-radius:8px;padding:8px 11px;display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}
.card-label{font-size:10px;color:#8b99a9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-value{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.notice{display:flex;align-items:center;gap:6px;background:color-mix(in srgb,{{ACCENT}} 10%,#1a2029);border:1px solid color-mix(in srgb,{{ACCENT}} 30%,transparent);border-radius:7px;padding:6px 10px;font-size:10.5px;color:#c8d2dd}
.notice i{font-style:normal;color:{{ACCENT}}}
.table{background:#1a2029;border:1px solid #242d38;border-radius:8px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:11px}
th{text-align:left;font-weight:500;color:#8b99a9;padding:6px 10px;border-bottom:1px solid #242d38;font-size:10px;white-space:nowrap}
td{padding:6px 10px;border-bottom:1px solid #1d242e;color:#c8d2dd;white-space:nowrap}
tr:last-child td{border-bottom:none}
.mono{font-variant-numeric:tabular-nums}
.status{display:inline-flex;align-items:center;gap:5px}
.status i{width:6px;height:6px;border-radius:50%;flex:none}
.status.ok i{background:#4caf7d}.status.warn i{background:#d9a13c}.status.bad i{background:#d05070}.status.muted i{background:#5b6672}
.status.muted{color:#8b99a9}
.row-actions{display:inline-flex;gap:5px}
.mini{background:#232b35;color:#c8d2dd;border:0;border-radius:5px;padding:2px 8px;font-size:10px}
.mini.danger{color:#e08598}
.mini.ok{color:#6cc49a}
</style></head><body>
<aside><div class="brand">${t}</div><nav class="menu">${menuItems}</nav></aside>
<main><header><h1>${page.heading}</h1>${primary}<span class="badge"><i></i>${page.role}</span></header>
<div class="content">
<div class="cards">${cards}</div>
${notice}
<div class="table"><table><thead><tr>${page.columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
</div></main></body></html>`.replaceAll("{{ACCENT}}", ROLE_PAGES[role].accent);
}


const demoPage = createServer((req, res) => {
  if (req.url === "/favicon.svg") {
    res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=300" });
    res.end(FAVICON_SVG);
    return;
  }
  // Role consoles for the hero shot: /admin /member /guest /review render four
  // different views of the same system, `?l=en` switches the copy.
  const roleMatch = (req.url ?? "/").match(/^\/(admin|member|guest|review)\b/);
  if (roleMatch) {
    const lang = new URL(req.url ?? "/", `http://127.0.0.1:${PAGE_PORT}`).searchParams.get("l");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderRole(roleMatch[1], lang === "en" ? "en" : "zh"));
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
  {
    // The flat stage — no view at all — carries the same page strip a cell does.
    // Worth its own shot: this is the state a user lands in when they only ever
    // click a site, and the strip there is the thing that used to be missing.
    name: "flat-strip",
    locale: "zh",
    view: "browser",
    flatStrip: true,
  },
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
  { name: "settings", locale: "zh", view: "settings-general" },
  { name: "settings-en", locale: "en", view: "settings-general" },
  { name: "light", locale: "zh", view: "browser", theme: "light" },
  { name: "light-en", locale: "en", view: "browser", theme: "light" },
  { name: "env-menu", locale: "zh", view: "browser", clicks: [".toolbar .split-main"] },
  {
    // The app menu: the once-in-a-while list, including the launch-surface
    // switch that has no other home now that the title bar is gone.
    name: "app-menu",
    locale: "zh",
    view: "browser",
    clicks: ["[data-app-menu]"],
  },
  {
    name: "site-dialog",
    locale: "zh",
    view: "sites",
    clicks: [".page-head-actions .btn.primary"],
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
    // The message centre: three kinds of "while you were not looking" in one
    // list, each row showing what it can still do.
    name: "messages",
    locale: "zh",
    view: "messages",
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
    view: "settings-data",
  },
  {
    name: "settings-mcp",
    locale: "zh",
    view: "settings-mcp",
  },
  {
    name: "settings-about",
    locale: "zh",
    view: "settings-about",
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
  // Each identity lands on its own role console, so the hero shot's 2×2 shows
  // four different views of one system — the product's whole claim.
  const rolePaths =
    locale === "en"
      ? ["/admin?l=en", "/member?l=en", "/guest?l=en", "/review?l=en"]
      : ["/admin", "/member", "/guest", "/review"];
  const identities = demo.people.map(([name, username, role, color], index) => ({
    id: uuid(index + 2),
    siteId,
    name,
    username,
    role,
    color,
    passwordMode: "inherit",
    status: "unknown",
    startPath: rolePaths[index],
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
        autoFillOnLaunch: true,
        closeToTray: true,
        guideVersion: 1,
        autoCheckUpdates: false,
      },
      null,
      2,
    ),
  );

  /*
   * A short message history so the page is not an empty state.
   *
   * Deliberately mixed: one row per kind, with the login-capture row unread so
   * the rail badge and the toolbar bell both show something. Timestamps are
   * relative to the run, otherwise the dates in the shot drift into the past.
   */
  const minute = 60_000;
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * minute).toISOString();
  await writeFile(
    join(userData, "messages.json"),
    JSON.stringify(
      {
        messages: [
          {
            id: uuid(31),
            at: at(2),
            kind: "login-capture",
            tone: "info",
            titleKey: "app.messagesLoginCaptured",
            titleParams: { user: demo.people[1][1], site: demo.site },
            action: { type: "login-capture", token: "screenshot-token" },
            read: false,
          },
          {
            id: uuid(32),
            at: at(47),
            kind: "account",
            tone: "warning",
            titleKey: "app.messagesLoginFailed",
            titleParams: { name: demo.people[2][0], site: demo.site },
            action: { type: "identity", identityId: uuid(4), siteId },
            read: false,
          },
          {
            id: uuid(33),
            at: at(93),
            kind: "ai",
            tone: "info",
            titleKey: "app.messagesAiAction",
            titleParams: { tool: "click_browser_element", site: demo.site },
            action: { type: "tab", tabId: "screenshot-tab" },
            read: true,
          },
        ],
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

  const child = spawn(
    electronBinary,
    [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"],
    // Headless: the shot is taken over CDP, so the window never has to appear —
    // and it must not, because capturing a whole screenshot pass would otherwise
    // flash a window in front of whatever the machine's user is doing.
    { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: "ignore" },
  );

  try {
    let target;
    // `0` makes Chromium pick the port when it binds, which removes the window
    // between "this number is free" and "the app claims it".
    const port = await waitForDebugPort(userData);
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
    // Before any override, window.devicePixelRatio is the machine's real scale,
    // and the webview guests run at that same scale. Setting the host override
    // to *this* value — not to 2 — is what keeps the guests' pixels 1:1 with
    // the host composite: overriding mid-run after the guests already painted
    // leaves them magnified, and a guest's own override does not stick.
    const nativeScale = await client.evaluate(`window.devicePixelRatio`);
    const deviceScale = typeof nativeScale === "number" && nativeScale > 0 ? nativeScale : 1;
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScale,
      mobile: false,
    });
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
      // A flat strip shot wants two pages in one instance and no view at all:
      // that is the state the strip now covers, and a view would hide it.
      if (shot.flatStrip) {
        await client.evaluate(`(async () => {
          const api = window.ensemble;
          for (const view of (await api.getEmbeddedState()).views) {
            await api.closeEmbeddedView(view.id, "all");
          }
          const tabs = (await api.getEmbeddedState()).tabs;
          const keep = tabs[0];
          for (const tab of tabs) {
            if (tab.id !== keep?.id) await api.closeEmbeddedTab(tab.id);
          }
          if (keep) {
            await api.navigateEmbeddedTab(keep.id, "http://127.0.0.1:${PAGE_PORT}/console");
            await new Promise((r) => setTimeout(r, 1600));
            const again = await api.getEmbeddedState();
            const root = again.tabs.find((tab) => tab.id === keep.id);
            if (root) await api.openEmbeddedTabInInstance(root.instanceId);
            await new Promise((r) => setTimeout(r, 1200));
          }
          return true;
        })()`);
        await wait(1500);
      }
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
      // The pages are <webview> nodes in this document, so they are part of the
      // window's own pixels: a plain Page.captureScreenshot sees them. Nothing has
      // to be frozen and painted into the DOM first.
      //
      // The stage is still re-reported before the shot. A layout change above
      // (view opened, dock collapsed) moves the stage, and main places the page
      // nodes from the rect it was last given — capturing before that lands
      // leaves every cell at the old width.
      const stageReport = await client.evaluate(`(async () => {
        const stage = document.querySelector('.stage');
        if (!stage) return false;
        const box = stage.getBoundingClientRect();
        window.ensemble.setEmbeddedStage({
          x: Math.round(box.left),
          y: Math.round(box.top),
          width: Math.round(box.width),
          height: Math.round(box.height),
        });
        // One frame for the state broadcast to reach the renderer, one more for
        // the compositor to actually paint the moved nodes.
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => setTimeout(r, 600));
        const nodes = [...document.querySelectorAll('.guest-pool webview')].map((w) => ({
          src: w.getAttribute('src') ?? '',
          styleW: w.style.width,
          styleH: w.style.height,
          rectW: Math.round(w.getBoundingClientRect().width),
          dpr: window.devicePixelRatio,
        }));
        return { nodes, stageZoom: window.devicePixelRatio };
      })()`);
      console.log("  stage report:", JSON.stringify(stageReport));

      // webview guests paint at the machine's scale the host override was set
      // to (see the nativeScale note above), so no per-guest fixup is needed
      // here — only the stage re-report above, which this shot already did.
    } else {
      // The app opens on the browser page, and the sidebar only appears once
      // something beside the page is open — so the app menu is what brings the
      // navigation on screen, then the row does the navigating.
      await client.evaluate(openNav(shot.view));
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
